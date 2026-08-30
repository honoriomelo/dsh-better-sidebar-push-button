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

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const inject = ['shell', 'webServer', 'agents'];

const CHECK_PATH = '/plugins/dsh-better-sidebar-push-button/check';
const PUSH_PATH = '/plugins/dsh-better-sidebar-push-button/push';
const ACTIVE_SESSION_PATH = '/plugins/dsh-better-sidebar-push-button/active-session';

/**
 * URL of our browser half. The shell busts every bundle URL with `?rev=`
 * (a SHA-1 of the file) so the browser never serves a stale copy from its
 * HTTP cache. We do the same here: compute the SHA-1 of lib/client.js at
 * load time and append it. Without this, a hard refresh could keep serving
 * an older client.js from the browser cache even though the file changed.
 */
function clientRev() {
  try {
    const p = join(__dirname, 'client.js');
    statSync(p); // throws if missing
    return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}
const CLIENT_SRC = '/plugins/dsh-better-sidebar-push-button/client.js?rev=' + clientRev();

/** Per-call shell timeouts. Push can be slow on large repos or slow links. */
const CHECK_TIMEOUT_MS = 8000;
const PUSH_TIMEOUT_MS = 180000;

/** Hard cap on the body we keep in memory (chars). */
const MAX_OUTPUT_CHARS = 8000;

function trimOutput(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text || '';
  return text.substring(0, max) + '\n…[truncated]';
}

/**
 * True when a git result failed because the SYSTEM ssh config
 * (/etc/ssh/ssh_config.d/*) is unreadable (wrong owner / bad permissions).
 * On such systems every SSH-based push fails identically, regardless of
 * workspace, so we retry once with GIT_SSH_COMMAND="ssh -F /dev/null" to
 * bypass the broken config. The workaround is safe: -F /dev/null only
 * skips user+system ssh config files; the default host keys, agent, and
 * identity files are untouched.
 */
function isSshConfigPermissionError(result) {
  const stderrText = (result && result.stderr && result.stderr.text) || '';
  const stdoutText = (result && result.stdout && result.stdout.text) || '';
  const combined = (stderrText + '\n' + stdoutText).trim();
  return /Bad owner or permissions on .*ssh_config/.test(combined)
    || /Permissions .* for .*ssh_config.* are too open/.test(combined);
}

/**
 * True when a git push failed because git could not obtain credentials for
 * an https remote ("could not read Username/Password", "Authentication
 * failed", "terminal prompts disabled"). On machines where the repo uses an
 * https URL and no credential helper is configured, `git push` tries to
 * prompt on the terminal — which the DSH shell cannot do — so it aborts
 * with exactly these messages. In that case we retry by injecting the gh
 * CLI token into the remote URL, mirroring what a manual
 * `TOKEN=$(gh auth token) && git push https://<user>:${TOKEN}@github.com/...`
 * does.
 */
function isCredentialError(result) {
  const stderrText = (result && result.stderr && result.stderr.text) || '';
  const stdoutText = (result && result.stdout && result.stdout.text) || '';
  const combined = (stderrText + '\n' + stdoutText).trim();
  return /could not read Username/.test(combined)
    || /could not read Password/.test(combined)
    || /Authentication failed/.test(combined)
    || /terminal prompts disabled/.test(combined)
    || /instead of providing a password/.test(combined);
}

/** Shell environment that ignores the broken system ssh config. */
const SSH_NO_SYSTEM_CONFIG_ENV = { GIT_SSH_COMMAND: 'ssh -F /dev/null' };

function describeFailure(result, fallback) {
  if (!result) return fallback;
  const stderrText = (result.stderr && result.stderr.text) || '';
  const stdoutText = (result.stdout && result.stdout.text) || '';
  const combined = (stderrText + '\n' + stdoutText).trim();
  if (combined) {
    // Recognise a few common, user-actionable failure modes and rewrite
    // them with a hint. We do this with simple substring matches because
    // the wording is stable across modern git versions and we would
    // rather give a useful nudge than a verbatim wall of stderr. The
    // original stderr is preserved in the toast payload so the user can
    // still see it.
    if (/Bad owner or permissions on .*ssh_config/.test(combined)
      || /Permissions .* for .*ssh_config.* are too open/.test(combined)) {
      return 'System SSH config is blocking git: /etc/ssh/ssh_config.d/* is owned by the wrong user or has bad permissions, so OpenSSH refuses to read it. Two fixes:\n  1. Workaround (works immediately): run git with `GIT_SSH_COMMAND="ssh -F /dev/null"` — e.g. `GIT_SSH_COMMAND="ssh -F /dev/null" git push` — to ignore the broken system config.\n  2. Root cause: `sudo chown root:root /etc/ssh/ssh_config.d/*` and `sudo chmod 644 /etc/ssh/ssh_config.d/*`, then retry.\nRaw error: ' + combined;
    }
    if (/update_ref failed.*cannot lock ref.*read-only|read-only file system|Sistema de arquivos somente para leitura/i.test(combined)
      || /Unable to create.*\.lock.*read-only/i.test(combined)) {
      return 'The git repository is on a READ-ONLY filesystem. Git push succeeded (your commits are on the remote), but git cannot update the local tracking ref (origin/main) because the lock file cannot be created. The badge will keep showing the old ahead count until the workspace is writable. Fix: ensure the repository directory is writable, or run `git fetch origin main` in a writable terminal after each push. Raw error: ' + combined;
    }
    if (/could not read Username for ['"]https:\/\/github\.com['"]/.test(combined)) {
      return 'GitHub HTTPS auth failed: git tried to read a username interactively but the push has no terminal. Either set a credential helper (`git config --global credential.helper store` after one successful push) or switch the remote to SSH: `git remote set-url origin git@github.com:<user>/<repo>.git`. Raw error: ' + combined;
    }
    if (/Permission denied \(publickey\)/.test(combined)
      || /Could not read from remote repository/.test(combined)) {
      return 'GitHub SSH auth failed. Make sure `~/.ssh/id_ed25519` (or `id_rsa`) is loaded in your SSH agent (`ssh-add ~/.ssh/<key>`) and that the public key is registered on https://github.com/settings/keys. Raw error: ' + combined;
    }
    if (/fatal: unable to access/.test(combined) && /Connection refused|Connection timed out|Network is unreachable/.test(combined)) {
      return 'Network is unreachable - check VPN / firewall and retry. Raw error: ' + combined;
    }
    if (/rejected because the remote contains work/.test(combined)
      || /non-fast-forward/.test(combined)
      || /Updates were rejected/.test(combined)) {
      return 'Push was rejected because the remote has commits you do not have locally. Pull first (or rebase) and retry. Raw error: ' + combined;
    }
    return combined;
  }
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
async function runGit(ctx, root, args, timeoutMs, env, sandboxMode) {
  // ctx.shell API (@deepseek-ai/dsh-shell): `command` is a single string,
  // and ShellRunResult carries exitCode + stdout/stderr as { text, truncated }.
  // `sandboxMode` opts into the DSH file sandbox policy for this call. The
  // default (workspace-write) confines writes to the session workspace; a
  // `git push` in another repo (e.g. a different dsh plugin checkout) needs
  // to write .git/refs there, so it must escalate to danger-full-access —
  // otherwise git fails with "Unable to create ... .lock: read-only".
  const spec = ctx.shell.resolve({
    command: 'git -C ' + JSON.stringify(root) + ' ' + args.join(' '),
    workdir: root,
    timeoutMs,
    env,
    ...(sandboxMode ? { sandboxPolicy: { mode: sandboxMode } } : {}),
  });
  return ctx.shell.run(spec);
}

/** Run an arbitrary shell command (not necessarily git) through the shell. */
async function runCommand(ctx, command, timeoutMs, env, sandboxMode) {
  const spec = ctx.shell.resolve({
    command,
    timeoutMs,
    env,
    ...(sandboxMode ? { sandboxPolicy: { mode: sandboxMode } } : {}),
  });
  return ctx.shell.run(spec);
}

/** Best-effort `gh auth token` — returns null when gh is absent/fails. */
async function getGhToken(ctx) {
  try {
    const res = await runCommand(ctx, 'gh auth token', 15000, undefined, 'read-only');
    if (res && typeof res.exitCode === 'number' && res.exitCode === 0) {
      const tok = ((res.stdout && res.stdout.text) || '').trim();
      return tok || null;
    }
  } catch (_) { /* gh missing or not logged in */ }
  return null;
}

/**
 * Build an authenticated push URL for an https remote using the gh CLI
 * token, mirroring a manual `git push https://<user>:$(gh auth token)@…`.
 * Returns null when the remote is not https (SSH/git://) or when no token
 * is available — in both cases the caller keeps the plain `git push`.
 */
async function authedPushUrl(ctx, root, upstream) {
  const remote = (upstream || '').split('/')[0] || 'origin';
  let remoteRes;
  try {
    remoteRes = await runGit(ctx, root, ['remote', 'get-url', remote], 15000, undefined, 'read-only');
  } catch (_) { return null; }
  const url = ((remoteRes && remoteRes.stdout && remoteRes.stdout.text) || '').trim();
  if (!url || !/^https:\/\//i.test(url)) return null; // ssh/git protocol or unknown
  const token = await getGhToken(ctx);
  if (!token) return null;
  // Insert the token as a basic-auth password: https://oauth2:<token>@host/…
  // GitHub accepts `oauth2` as the username with a PAT as the password.
  const authed = url.replace(/^https:\/\//i, 'https://oauth2:' + token + '@');
  return { authed, token };
}

/** Redact a token from any output text we hand back to the client. */
function redactToken(text, token) {
  if (!text || !token) return text || '';
  return String(text).split(token).join('***');
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
            ], PUSH_TIMEOUT_MS, undefined, 'danger-full-access');
          } catch (e) {
            jsonResponse(res, 200, { ok: false, error: 'git push failed: ' + (e && e.message || e) });
            return;
          }
          // A broken SYSTEM ssh config (/etc/ssh/ssh_config.d/* owned by the
          // wrong user / bad perms) makes every SSH push fail with "Bad owner
          // or permissions". That is an environment defect, not a repo defect;
          // retry once with GIT_SSH_COMMAND="ssh -F /dev/null" to bypass the
          // broken config before surfacing the error to the user.
          if (isSshConfigPermissionError(pushResult)) {
            try {
              const retried = await runGit(ctx, resolved.root, [
                '--no-pager', 'push', '--progress',
              ], PUSH_TIMEOUT_MS, SSH_NO_SYSTEM_CONFIG_ENV, 'danger-full-access');
              if (retried && typeof retried.exitCode === 'number' && retried.exitCode === 0) {
                pushResult = retried;
              } else {
                pushResult = retried || pushResult;
              }
            } catch (e) {
              // Keep the original error; the retry itself is best-effort.
            }
          }
          // An https remote without a credential helper makes git try to
          // prompt for a username on the terminal — which the DSH shell
          // cannot do — so push aborts with "could not read Username for
          // 'https://github.com'". Retry once by handing git the gh CLI as a
          // credential helper. We push to the NAMED remote (origin) instead
          // of an explicit URL so git updates the local remote-tracking ref
          // (refs/remotes/origin/<branch>) automatically on success — that
          // is what lets /check report ahead=0 right after the push.
          // GIT_CONFIG_* env vars inject the helper without touching the
          // user's global config or needing shell quoting.
          let ghToken = null;
          if (isCredentialError(pushResult)) {
            try {
              const remoteName = (info.upstream || '').split('/')[0] || 'origin';
              const ghAuthEnv = {
                GIT_TERMINAL_PROMPT: '0',
                GIT_CONFIG_COUNT: '2',
                GIT_CONFIG_KEY_0: 'credential.helper',
                GIT_CONFIG_VALUE_0: '!gh auth git-credential',
                GIT_CONFIG_KEY_1: 'credential.interactive',
                GIT_CONFIG_VALUE_1: 'never',
              };
              const retried = await runGit(ctx, resolved.root, [
                '--no-pager', 'push', '--progress', remoteName, info.branch,
              ], PUSH_TIMEOUT_MS, ghAuthEnv, 'danger-full-access');
              if (retried && typeof retried.exitCode === 'number' && retried.exitCode === 0) {
                pushResult = retried;
              } else {
                pushResult = retried || pushResult;
              }
            } catch (e) {
              // Keep the original error; the credential-helper retry is best-effort.
            }
          }
          const exitCode = pushResult && typeof pushResult.exitCode === 'number' ? pushResult.exitCode : 1;
          const stdout = redactToken(trimOutput((pushResult.stdout && pushResult.stdout.text) || '', MAX_OUTPUT_CHARS), ghToken);
          const stderr = redactToken(trimOutput((pushResult.stderr && pushResult.stderr.text) || '', MAX_OUTPUT_CHARS), ghToken);
          if (exitCode !== 0) {
            jsonResponse(res, 200, {
              ok: false,
              error: describeFailure(pushResult, 'git push failed'),
              value: { exitCode, stdout, stderr, branch: info.branch, upstream: info.upstream },
            });
            return;
          }
          // Re-inspect upstream AFTER the successful push. `git push`
          // returns exit 0 even when the local remote-tracking ref is
          // stale (e.g. another process pushed, or the ref didn't
          // advance), so the `ahead` computed before the push may be
          // wrong. Reporting the post-push truth lets the browser half
          // show the real badge immediately instead of relying on a
          // /check that can still return the old count.
          let after = info;
          try {
            after = await inspectUpstream(ctx, resolved.root);
          } catch (_) { /* keep pre-push info on failure */ }
          // If the re-inspected ahead is still > 0 AND the push
          // stderr mentions a read-only lock failure, the local
          // tracking ref could not be updated because the filesystem
          // is read-only. The push actually succeeded (commits are on
          // the remote) but the local git state is permanently stale.
          // Surface a clear message instead of returning
          // ahead=2 and letting the client show a misleading toast.
          const isFsRo = /update_ref failed.*cannot lock ref.*read-only|read-only file system|Sistema de arquivos somente para leitura|Unable to create.*\.lock/i.test(stderr);
          if (isFsRo && after.ahead > 0) {
            jsonResponse(res, 200, {
              ok: false,
              error: 'Push successful (commits are on GitHub), but the local git tracking ref could not be updated because the filesystem is READ-ONLY — the badge will keep showing a stale count. Either remount the filesystem as read-write, or run `git fetch origin main` in a writable terminal after each push.',
              value: { exitCode, stdout, stderr, branch: after.branch || info.branch, upstream: after.upstream || info.upstream, ahead: after.ahead, behind: after.behind },
            });
            return;
          }
          jsonResponse(res, 200, {
            ok: true,
            value: { exitCode, stdout, stderr, branch: after.branch || info.branch, upstream: after.upstream || info.upstream, ahead: after.ahead, behind: after.behind },
          });
        } catch (e) {
          jsonResponse(res, 500, { ok: false, error: e && e.message || String(e) });
        }
      },
    });
  }, 'dsh-better-sidebar-push-button: push route');

  // ---- Static-bundle client-half bootstrap -----------------------------
  //
  // The DSH cordis-client-runner only mounts client halves in response to a
  // `cordis/request-run` emitted from the dynamic plugin registry. Bundles
  // installed via `cordis.patch.yml` (the static channel) are never
  // registered there, and even though `__DSH_BOOT__` lists our id, the
  // shell's `prefetchImmediateTier()` only prefetches entries with
  // `immediately: true` (which only `@deepseek-ai/*` packages carry), and
  // no `<script src=...>` tag is emitted for non-immediate entries. Our
  // factory therefore never executes, and `apply()` never runs.
  //
  // We close the gap by emitting a structured `IndexInjection` row on the
  // cordis `webserver/index-inject` event. The host webserver consumes
  // those rows on every index render, splicing a `<script src=...>` tag
  // into the HTML head for each one. The client.js top-level then runs
  // the factory itself (see lib/client.js for the dual-consumer pattern).
  //
  // Why `index-inject` and not `tapIndex`? `tapIndex` is also a public API
  // on the webserver, but the `index-inject` event runs earlier in the
  // render pipeline and composes with every other plugin's structured
  // rows; using the structured table keeps our tag ordered predictably
  // relative to the shell's own modules and avoids a string-rewriting
  // race with another tap.
  //
  // When the runtime eventually grows a proper static-bundle auto-mount,
  // this listener becomes a no-op for our id because the runner takes
  // over before our second invocation.
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'script-src',
      placement: 'head',
      src: CLIENT_SRC,
    });
  });

  // Lightweight read-only endpoint the browser half calls instead of going
  // through the DSH cordis-client-runner: returns the active agent's sessionId
  // and cwd so the client can resolve the git root via the existing
  // /sidebar/api/git.status route. The DSH runtime does NOT auto-mount the
  // client half of a static bundle (cordis-client-runner only reacts to
  // cordis/request-run emitted from the dynamic-plugin registry), so we
  // also rely on the host-side auto-run machinery in lib/client.js to keep
  // the UI live. This endpoint exists for the same reason — it lets the
  // client half drive the existing sidebar scope-resolver without ever
  // needing a cordis ctx.
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: ACTIVE_SESSION_PATH,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          // Drain any body even though we ignore it; future-proofs us for
          // POST and matches what other DSH endpoints do.
          if (req.method === 'POST') {
            try { await readJson(req); } catch { /* ignore */ }
          }
          const result = resolveActiveSession(ctx);
          if (!result.ok) {
            jsonResponse(res, 200, { ok: false, error: result.error });
            return;
          }
          jsonResponse(res, 200, { ok: true, value: result.value });
        } catch (e) {
          jsonResponse(res, 500, { ok: false, error: e && e.message || String(e) });
        }
      },
    });
  }, 'dsh-better-sidebar-push-button: active-session route');
}

/**
 * Pick the active conversation session from the DSH agents registry.
 *
 * DSH does not currently expose a "current session" pointer; the closest
 * stable truth is the agents registry: every agent is owned by exactly one
 * session, and the conversation UI always has one agent alive at a time.
 * We pick the most recently created agent (registry order is insertion
 * order). If the user has zero or more than one running, we report a
 * precise reason so the client can surface "open a conversation first".
 *
 * @param ctx - cordis host context with `agents` injected.
 * @returns `{ ok: true, value: { sessionId, cwd? } }` or `{ ok: false, error }`.
 */
function resolveActiveSession(ctx) {
  // Prefer the sessions service, which lists every conversation session in
  // creation order. The sidebar client (dsh-better-sidebar) uses
  // ctx.sessions.list.getSnapshot().current — the session of the current
  // browser tab. On the host side ctx.sessions.list() returns the same array
  // of Session objects, and the last entry is the most recently created one.
  // The old path used agents.list() (last agent globally), but that could
  // pick a session from a different workspace (e.g. a subagent or an older
  // conversation), causing the push button to inspect the wrong repo.
  let sessions;
  try {
    sessions = ctx.get('sessions');
  } catch (_) {
    sessions = null;
  }
  if (sessions && typeof sessions.list === 'function') {
    const list = sessions.list();
    if (Array.isArray(list) && list.length > 0) {
      const last = list[list.length - 1];
      const sessionId = last && (last.id || last.sessionId);
      if (sessionId) {
        const cwd = last.header && last.header.cwd;
        return {
          ok: true,
          value: {
            sessionId: String(sessionId),
            cwd: cwd ? String(cwd) : undefined,
          },
        };
      }
    }
  }

  // Fallback to the agents registry — covers edge cases where the sessions
  // service is not yet mounted.
  let agents;
  try {
    agents = ctx.get('agents');
  } catch (_) {
    agents = null;
  }
  if (!agents || typeof agents.list !== 'function') {
    return { ok: false, error: 'neither sessions nor agents service is mounted in this host' };
  }
  let list;
  try {
    list = agents.list();
  } catch (e) {
    return { ok: false, error: 'agents.list() threw: ' + (e && e.message || e) };
  }
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, error: 'no active conversation — open one first' };
  }
  const agent = list[list.length - 1];
  if (!agent) {
    return { ok: false, error: 'agents registry returned a falsy last entry' };
  }
  const sessionId = agent.id || (agent.session && agent.session.id) || agent.sessionId;
  if (!sessionId) {
    return { ok: false, error: 'active agent has no session id' };
  }
  const cwd = agent.cwd
    || agent.workdir
    || (agent.session && (agent.session.cwd || agent.session.workdir))
    || (agent.options && (agent.options.cwd || agent.options.workdir))
    || undefined;
  return {
    ok: true,
    value: {
      sessionId: String(sessionId),
      cwd: cwd ? String(cwd) : undefined,
    },
  };
}

export { apply, inject };
