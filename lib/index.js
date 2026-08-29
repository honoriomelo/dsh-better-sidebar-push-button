/**
 * dsh-better-sidebar-push-button — host half.
 *
 * Exposes two HTTP endpoints under
 *   POST /plugins/dsh-better-sidebar-push-button/check
 *   POST /plugins/dsh-better-sidebar-push-button/push
 *
 * `check` discovers the active repository's upstream (the branch's @{u} ref)
 * and reports `ahead` / `behind` commit counts so the browser half can decide
 * whether to enable the Push button. `push` runs `git push` and returns the
 * captured stdout/stderr plus the exit code so the UI can show a meaningful
 * error on failure.
 *
 * Both routes accept the standard dsh-better-sidebar scope payload
 * (`{ sessionId, cwd?, worktree? }`) and resolve the actual repository root
 * the same way the sidebar itself does — by re-asking the active session
 * (via `POST /sidebar/api/git.status`) when the caller did not include a
 * fully-resolved `root`. This keeps the plugin compatible with the existing
 * client wrapper that only knows about `sessionId` and `cwd`.
 *
 * Routes are wrapped in `ctx.effect` so the bindings are removed
 * automatically when the plugin is stopped or updated.
 *
 * @module dsh-better-sidebar-push-button
 */

const inject = ['shell', 'webServer'];

const CHECK_PATH = '/plugins/dsh-better-sidebar-push-button/check';
const PUSH_PATH = '/plugins/dsh-better-sidebar-push-button/push';

/** Per-call shell timeouts. Push can be slow on large repos or slow links. */
const CHECK_TIMEOUT_MS = 8000;
const PUSH_TIMEOUT_MS = 180000;

/** Hard cap on the body we keep in memory (chars). */
const MAX_OUTPUT_CHARS = 8000;

function trimOutput(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text || '';
  return text.substring(0, max) + '\n…[truncated]';
}

function describeFailure(result, fallback) {
  if (!result) return fallback;
  const stderrText = (result.stderr && result.stderr.text) || '';
  if (stderrText.trim()) return stderrText.trim();
  if (result.signal) return 'signal ' + result.signal;
  if (result.timedOut) return 'timed out after ' + result.timeoutMs + 'ms';
  if (typeof result.exitCode === 'number') return 'git exited with code ' + result.exitCode;
  return fallback;
}

/**
 * Run one `git -C <root> <args…>` invocation through the DSH shell service.
 * Resolves with the full ShellRunResult, rejects with an Error on a hard
 * service failure (so the caller can distinguish "shell broken" from
 * "git reported a non-zero exit"). Exit code != 0 is NOT a throw — it's a
 * normal result that the caller inspects.
 */
async function runGit(ctx, root, args, timeoutMs) {
  // ctx.shell API (@deepseek-ai/dsh-shell): `command` is a single string,
  // and ShellRunResult carries exitCode + stdout/stderr as { text, truncated }.
  const spec = ctx.shell.resolve({
    command: 'git -C ' + JSON.stringify(root) + ' ' + args.join(' '),
    workdir: root,
    timeoutMs,
  });
  return ctx.shell.run(spec);
}

async function resolveRoot(ctx, args) {
  // The browser half always sends a resolved `root` (it asks the sidebar's
  // own git.status endpoint first, just like dsh-better-sidebar-commit-ia
  // does). Accept it as-is when present so the host never has to call out
  // to /sidebar/api. As a defence-in-depth fallback, if `root` is missing
  // but a sessionId + cwd is supplied, query the sidebar's git.status the
  // same way the client does.
  if (args && typeof args.root === 'string' && args.root.trim() !== '') {
    return { root: args.root.trim() };
  }
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : '';
  if (!sessionId) {
    return { error: 'root (or sessionId) is required' };
  }
  // Fall back to a direct git discovery — no HTTP hop needed because the
  // shell service already runs in-process. We only trust a root that comes
  // back from `git rev-parse --show-toplevel`; anything else is reported
  // as "not a git repository".
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : process.cwd();
  let probe;
  try {
    probe = await runGit(ctx, cwd, ['rev-parse', '--show-toplevel'], CHECK_TIMEOUT_MS);
  } catch (e) {
    return { error: 'git discovery failed: ' + (e && e.message || e) };
  }
  if (!probe || probe.exitCode !== 0) {
    return { error: 'The current directory is not a git repository.' };
  }
  const root = (probe.stdout && probe.stdout.text || '').trim();
  if (!root) return { error: 'git rev-parse --show-toplevel returned an empty path.' };
  return { root };
}

/**
 * Inspect the current branch and its upstream. Resolves with
 *   { isRepo, branch, upstream, ahead, behind }
 * `upstream` is the @{u} ref name (e.g. `origin/main`) or '' when the
 * branch has no upstream. `ahead` / `behind` are 0 when no upstream.
 */
async function inspectUpstream(ctx, root) {
  let branchResult;
  try {
    branchResult = await runGit(ctx, root, [
      'rev-parse', '--abbrev-ref', '--symbolic-full-name', 'HEAD',
    ], CHECK_TIMEOUT_MS);
  } catch (e) {
    return { error: 'git rev-parse failed: ' + (e && e.message || e) };
  }
  if (!branchResult || branchResult.exitCode !== 0) {
    // Detached HEAD — there is no meaningful upstream, and pushing is a
    // user choice (out of scope for this plugin).
    const stderr = (branchResult && branchResult.stderr && branchResult.stderr.text) || '';
    return { isRepo: true, branch: 'HEAD', upstream: '', ahead: 0, behind: 0, detached: true, detail: stderr.trim() };
  }
  const branch = (branchResult.stdout && branchResult.stdout.text || '').trim();
  if (!branch) {
    return { isRepo: true, branch: 'HEAD', upstream: '', ahead: 0, behind: 0, detached: true };
  }

  // @{u} resolves the configured upstream. A non-zero exit means "no
  // upstream" — we must NOT treat that as a hard error, only as the
  // empty upstream case.
  let upstreamResult;
  try {
    upstreamResult = await runGit(ctx, root, [
      'rev-parse', '--abbrev-ref', '--symbolic-full-name', branch + '@{u}',
    ], CHECK_TIMEOUT_MS);
  } catch (_) {
    upstreamResult = null;
  }
  let upstream = '';
  if (upstreamResult && upstreamResult.exitCode === 0) {
    upstream = (upstreamResult.stdout && upstreamResult.stdout.text || '').trim();
  }

  if (!upstream) {
    return { isRepo: true, branch, upstream: '', ahead: 0, behind: 0 };
  }

  // Ahead / behind counts. Non-zero exit can mean "no common ancestor" or
  // a race with the upstream disappearing mid-call — surface that as a
  // transient "unknown" instead of hard-failing the check.
  let ahead = 0, behind = 0;
  let countResult;
  try {
    countResult = await runGit(ctx, root, [
      'rev-list', '--left-right', '--count', upstream + '...HEAD',
    ], CHECK_TIMEOUT_MS);
  } catch (_) {
    countResult = null;
  }
  if (countResult && countResult.exitCode === 0) {
    const text = (countResult.stdout && countResult.stdout.text || '').trim();
    // Output is "<behind>\t<ahead>" (left=upstream, right=HEAD).
    const m = /^(\d+)\s+(\d+)\s*$/.exec(text);
    if (m) {
      behind = parseInt(m[1], 10) || 0;
      ahead = parseInt(m[2], 10) || 0;
    }
  }

  return { isRepo: true, branch, upstream, ahead, behind };
}

function apply(ctx, config) {
  // The plugin is intentionally configuration-free; any future options can
  // be merged here.
  void config;

  const jsonResponse = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  // The Cordis dynamic-plugin host sandbox does NOT expose Node's `Buffer`
  // global. The DSH webServer yields `string | Uint8Array` chunks, and we
  // decode them with the host-provided TextDecoder builtin instead of
  // Buffer.from / Buffer.concat. A final empty decode() flushes any
  // pending multi-byte boundary.
  const decoder = new TextDecoder('utf-8');
  const readJson = async (req) => {
    const parts = [];
    for await (const c of req) {
      if (typeof c === 'string') {
        parts.push(c);
      } else if (c instanceof Uint8Array) {
        parts.push(decoder.decode(c, { stream: true }));
      } else {
        try { parts.push(String(c)); } catch (_) { /* ignore */ }
      }
    }
    parts.push(decoder.decode());
    const raw = parts.join('') || '{}';
    try { return JSON.parse(raw); } catch { return {}; }
  };

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: CHECK_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        let args = {};
        try { args = await readJson(req); } catch { args = {}; }
        try {
          const resolved = await resolveRoot(ctx, args);
          if (resolved.error) {
            jsonResponse(res, 200, { ok: false, error: resolved.error });
            return;
          }
          const info = await inspectUpstream(ctx, resolved.root);
          if (info.error) {
            jsonResponse(res, 200, { ok: false, error: info.error });
            return;
          }
          jsonResponse(res, 200, {
            ok: true,
            value: {
              root: resolved.root,
              branch: info.branch,
              upstream: info.upstream,
              ahead: info.ahead,
              behind: info.behind,
              // Convenience flag the client uses to set the disabled state.
              canPush: !info.detached && !!info.upstream && info.ahead > 0,
              detached: !!info.detached,
            },
          });
        } catch (e) {
          jsonResponse(res, 500, { ok: false, error: e && e.message || String(e) });
        }
      },
    });
  }, 'dsh-better-sidebar-push-button: check route');

  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: PUSH_PATH,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        let args = {};
        try { args = await readJson(req); } catch { args = {}; }
        try {
          const resolved = await resolveRoot(ctx, args);
          if (resolved.error) {
            jsonResponse(res, 200, { ok: false, error: resolved.error });
            return;
          }
          // Refuse to push if we cannot confirm there is something to push.
          // The client already gates on `canPush`; this is the server-side
          // belt-and-braces against a misbehaving caller.
          const info = await inspectUpstream(ctx, resolved.root);
          if (info.error) {
            jsonResponse(res, 200, { ok: false, error: info.error });
            return;
          }
          if (info.detached) {
            jsonResponse(res, 200, { ok: false, error: 'HEAD is detached; push is not allowed from this plugin.' });
            return;
          }
          if (!info.upstream) {
            jsonResponse(res, 200, { ok: false, error: 'No upstream configured for "' + info.branch + '". Set one with `git push --set-upstream <remote> <branch>` first.' });
            return;
          }
          if (info.ahead === 0) {
            jsonResponse(res, 200, { ok: true, value: { exitCode: 0, noop: true, stdout: 'Nothing to push (already up to date with ' + info.upstream + ').', stderr: '' } });
            return;
          }

          // Use `git push` (no force, no mirror, no --set-upstream). The
          // --progress flag gives a single-line percentage update to stderr
          // that we surface verbatim in the toast, but it does not change
          // the exit contract.
          let pushResult;
          try {
            pushResult = await runGit(ctx, resolved.root, [
              '--no-pager', 'push', '--progress',
            ], PUSH_TIMEOUT_MS);
          } catch (e) {
            jsonResponse(res, 200, { ok: false, error: 'git push failed: ' + (e && e.message || e) });
            return;
          }
          const exitCode = pushResult && typeof pushResult.exitCode === 'number' ? pushResult.exitCode : 1;
          const stdout = trimOutput((pushResult.stdout && pushResult.stdout.text) || '', MAX_OUTPUT_CHARS);
          const stderr = trimOutput((pushResult.stderr && pushResult.stderr.text) || '', MAX_OUTPUT_CHARS);
          if (exitCode !== 0) {
            jsonResponse(res, 200, {
              ok: false,
              error: describeFailure(pushResult, 'git push failed'),
              value: { exitCode, stdout, stderr, branch: info.branch, upstream: info.upstream },
            });
            return;
          }
          jsonResponse(res, 200, {
            ok: true,
            value: { exitCode, stdout, stderr, branch: info.branch, upstream: info.upstream, ahead: info.ahead },
          });
        } catch (e) {
          jsonResponse(res, 500, { ok: false, error: e && e.message || String(e) });
        }
      },
    });
  }, 'dsh-better-sidebar-push-button: push route');
}

export { apply, inject };
