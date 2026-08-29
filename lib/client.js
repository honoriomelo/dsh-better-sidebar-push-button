// dsh-better-sidebar-push-button — browser half.
//
// Renders a full-width "Push" button directly BELOW the dsh-better-sidebar
// commit row (the flex container that holds the commit input + Commit
// button), occupying the entire next row. The button starts disabled; it
// becomes enabled the moment the host reports `ahead > 0` for the active
// repository (i.e. there is at least one local commit not yet pushed to
// the upstream). When the user clicks it, it transitions to a busy state
// ("Pushing…") and is disabled until the host's `git push` call returns
// — so a slow push or a stalled click cannot double-fire.

window.__ModuleLoader__.load({
  id: "dsh-better-sidebar-push-button",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // The button's own block has its own class, namespace-prefixed so it
    // cannot collide with dsh-better-sidebar's hashed CSS-Modules classes
    // (or with any other plugin).
    var ROW_CLASS = "bspb-push-row";
    var BTN_CLASS = "bspb-push-btn";
    var BTN_BUSY_CLASS = "bspb-push-btn-busy";
    var BTN_SPIN_CLASS = "bspb-push-btn-spinner";
    var ICON_CLASS = "bspb-push-icon";
    var LABEL_CLASS = "bspb-push-label";
    var AHEAD_CLASS = "bspb-push-ahead";

    var CHECK_PATH = "/plugins/dsh-better-sidebar-push-button/check";
    var PUSH_PATH = "/plugins/dsh-better-sidebar-push-button/push";

    var POLL_INTERVAL_MS = 3000;
    // The host pushes are bounded by PUSH_TIMEOUT_MS (180 s). Use a
    // larger client-side ceiling so we never race the host's response.
    var PUSH_CLIENT_TIMEOUT_MS = 195000;

    // Services the client half requires. Listed in the CJS export so the
    // module loader can wait for them before invoking apply().
    var inject = ["timer", "sessions"];

    // -- CSS injected as a <style> tag owned by this plugin -------------------
    function injectStyles() {
      if (typeof document === "undefined") return;
      var tagId = "dsh-better-sidebar-push-button/push.css";
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
      var css = [
        // The Push row is a single full-width block that sits directly
        // under the commit row. We match dsh-better-sidebar's visual
        // language (border-top, horizontal padding) so the two rows look
        // like one panel.
        "." + ROW_CLASS + " {",
        "  display: block;",
        "  padding: 8px 12px 10px;",
        "  border-top: 1px solid var(--dsw-alias-border-l1, #3a3a3a);",
        "  box-sizing: border-box;",
        "}",
        // The button itself: 100% width, the same look as the existing
        // .gitCommitButton (primary fill, rounded). DSH themes the alias
        // tokens so the button tracks light/dark mode without us having
        // to listen to theme changes.
        "." + BTN_CLASS + " {",
        "  display: inline-flex;",
        "  align-items: center;",
        "  justify-content: center;",
        "  gap: 8px;",
        "  width: 100%;",
        "  min-height: 28px;",
        "  padding: 4px 12px;",
        "  border: none;",
        "  border-radius: 6px;",
        "  background: var(--dsw-alias-button-primary-fill, #3964fe);",
        "  color: var(--dsw-alias-label-primary-inverted, #fff);",
        "  font: var(--dsw-font-xxs-strong-12, 600 12px/1 inherit);",
        "  cursor: pointer;",
        "  box-sizing: border-box;",
        "  user-select: none;",
        "  -webkit-user-select: none;",
        "}",
        "." + BTN_CLASS + ":hover:not(:disabled) {",
        "  background: var(--dsw-alias-button-primary-hover, #4f76ff);",
        "}",
        "." + BTN_CLASS + ":focus-visible {",
        "  outline: 2px solid var(--dsw-alias-interactive-bg-hover-accent, #5a8bff);",
        "  outline-offset: 2px;",
        "}",
        // Disabled / busy: faded, no pointer. We deliberately keep the
        // text visible (instead of an empty box) so the user always
        // knows *why* the button cannot be clicked.
        "." + BTN_CLASS + ":disabled,",
        "." + BTN_BUSY_CLASS + " {",
        "  opacity: 0.5;",
        "  cursor: default;",
        "}",
        // The up-arrow icon — plain Unicode, no font dependency.
        "." + ICON_CLASS + " {",
        "  display: inline-block;",
        "  font-size: 13px;",
        "  line-height: 1;",
        "}",
        "." + LABEL_CLASS + " {",
        "  display: inline-block;",
        "  font: inherit;",
        "}",
        // Small badge after the label: "↑ 3" — only rendered when we
        // actually have a positive ahead count.
        "." + AHEAD_CLASS + " {",
        "  display: inline-block;",
        "  margin-left: 2px;",
        "  padding: 0 6px;",
        "  border-radius: 999px;",
        "  background: var(--dsw-alias-bg-elevated, rgba(255,255,255,0.12));",
        "  color: var(--dsw-alias-label-primary-inverted, inherit);",
        "  font-size: 11px;",
        "  line-height: 16px;",
        "}",
        // Spinner shown while git push is in flight. The label and the
        // badge are hidden while the spinner is visible.
        "." + BTN_SPIN_CLASS + " {",
        "  display: inline-block;",
        "  width: 12px;",
        "  height: 12px;",
        "  border: 2px solid currentColor;",
        "  border-top-color: transparent;",
        "  border-radius: 50%;",
        "  animation: bspb-spin 0.7s linear infinite;",
        "}",
        "@keyframes bspb-spin { to { transform: rotate(360deg); } }",
        // -- Toast (DSH-style bottom-right notification; non-blocking) -----
        ".bspb-toast {",
        "  position: fixed;",
        "  right: 16px;",
        "  bottom: 16px;",
        "  z-index: 99999;",
        "  max-width: 380px;",
        "  padding: 10px 14px;",
        "  border-radius: 8px;",
        "  background: var(--dsw-alias-bg-elevated, #2a2a2a);",
        "  color: var(--dsw-alias-label-primary, #d4d4d4);",
        "  border: 1px solid var(--dsw-alias-border-l2, #444);",
        "  box-shadow: 0 6px 24px rgba(0,0,0,0.35);",
        "  font-size: 13px;",
        "  line-height: 18px;",
        "  font-family: inherit;",
        "  opacity: 0;",
        "  transform: translateY(8px);",
        "  transition: opacity 160ms ease, transform 160ms ease;",
        "  pointer-events: auto;",
        "  white-space: pre-wrap;",
        "  word-break: break-word;",
        "}",
        ".bspb-toast.bspb-toast-show {",
        "  opacity: 1;",
        "  transform: translateY(0);",
        "}",
        ".bspb-toast.bspb-toast-error {",
        "  border-color: var(--dsw-alias-button-danger-fill, #d04545);",
        "  color: var(--dsw-alias-label-primary, #fff);",
        "}",
        ".bspb-toast.bspb-toast-info {",
        "  border-color: var(--dsw-alias-button-info-fill, #3964fe);",
        "}",
        ".bspb-toast.bspb-toast-success {",
        "  border-color: var(--dsw-alias-button-success-fill, #2ea44f);",
        "}",
      ].join("\n");
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-better-sidebar-push-button";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // -- Toast ----------------------------------------------------------------
    var TOAST_TIMER = null;
    function showToast(message, kind) {
      if (typeof document === "undefined") return;
      var k = (kind === "error" || kind === "info" || kind === "success") ? kind : "info";
      var el = document.createElement("div");
      el.className = "bspb-toast bspb-toast-" + k;
      el.setAttribute("role", k === "error" ? "alert" : "status");
      el.textContent = message;
      document.body.appendChild(el);
      void el.offsetWidth;
      el.classList.add("bspb-toast-show");
      if (TOAST_TIMER) clearTimeout(TOAST_TIMER);
      TOAST_TIMER = setTimeout(function () {
        el.classList.remove("bspb-toast-show");
        setTimeout(function () {
          if (el && el.parentNode) el.parentNode.removeChild(el);
        }, 200);
      }, 5000);
    }

    // -- Commit row detection -------------------------------------------------
    function placeholderOf(el) {
      if (!el) return "";
      return (el.getAttribute && el.getAttribute("placeholder")) || "";
    }

    function isCommitInput(input) {
      if (!input || input.tagName !== "INPUT") return false;
      var ph = placeholderOf(input);
      if (!ph) return false;
      return /commit/i.test(ph);
    }

    // Find the commit row — the <div> that holds the commit input and
    // the Commit button. dsh-better-sidebar renders it as
    // `<div className={css.gitCommit}>` which the CSS-Modules pipeline
    // renames to a hashed class — so we walk up from the input instead
    // of relying on the class. The row is always the FIRST ancestor
    // <div> that contains both the input AND a <button> child.
    function findCommitRow() {
      var inputs = document.querySelectorAll("input");
      for (var i = 0; i < inputs.length; i++) {
        if (isCommitInput(inputs[i])) {
          var node = inputs[i].parentNode;
          while (node && node !== document.body) {
            if (node.nodeType === 1 && node.tagName === "DIV") {
              var btns = node.querySelectorAll ? node.querySelectorAll("button") : null;
              if (btns && btns.length > 0) return node;
            }
            node = node.parentNode;
          }
        }
      }
      return null;
    }

    // -- Active repo discovery (re-used from dsh-better-sidebar-commit-ia) ----
    function currentScope(ctx) {
      try {
        var sessions = ctx && (ctx.get ? ctx.get("sessions") : ctx.sessions);
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== "function") return null;
        var snap = sessions.list.getSnapshot();
        var sessionId = snap && snap.current;
        if (!sessionId) return null;
        var entry = snap && snap.byId && snap.byId[sessionId];
        var cwd = entry && entry.cwd;
        return { sessionId: sessionId, cwd: typeof cwd === "string" ? cwd : undefined };
      } catch (_) {
        return null;
      }
    }

    function fetchActiveRoot(ctx) {
      var scope = currentScope(ctx);
      if (!scope || !scope.sessionId) {
        return Promise.resolve({ root: "", error: "No active session — open a conversation first." });
      }
      var payload = { sessionId: scope.sessionId };
      if (scope.cwd) payload.cwd = scope.cwd;
      return fetch("/sidebar/api/git.status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (res) {
          return res.text().then(function (txt) {
            var body = {};
            if (txt) { try { body = JSON.parse(txt); } catch (_) {} }
            return { status: res.status, body: body };
          });
        })
        .then(function (envelope) {
          var body = envelope && envelope.body;
          if (!body || body.ok !== true) {
            return { root: "", error: (body && body.error && body.error.message) || ("HTTP " + envelope.status) };
          }
          var value = body.value || {};
          if (!value.isRepo) {
            return { root: "", error: "The current directory is not a git repository." };
          }
          if (!value.root) {
            return { root: "", error: "dsh-better-sidebar did not report a git root." };
          }
          return { root: value.root };
        });
    }

    // -- Button UI ------------------------------------------------------------
    function buildRow() {
      var row = document.createElement("div");
      row.className = ROW_CLASS;

      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = BTN_CLASS;
      btn.setAttribute("aria-label", "Push commits to upstream");
      btn.setAttribute("data-bspb-rev", MOUNT_REV);
      btn.disabled = true; // start disabled; the check call will flip this.

      var icon = document.createElement("span");
      icon.className = ICON_CLASS;
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "\u2191"; // ↑

      var label = document.createElement("span");
      label.className = LABEL_CLASS;
      label.textContent = "Push";

      var ahead = document.createElement("span");
      ahead.className = AHEAD_CLASS;
      ahead.style.display = "none";
      ahead.textContent = "0";

      btn.appendChild(icon);
      btn.appendChild(label);
      btn.appendChild(ahead);
      row.appendChild(btn);
      return { row: row, btn: btn, label: label, ahead: ahead, icon: icon };
    }

    // We swap the leading icon for a spinner mid-push, and restore it
    // on completion. Hide the icon+label+badge and inject the spinner
    // as the only visible child so the layout stays centred.
    function setBusy(ui, busy, message) {
      var btn = ui.btn;
      if (busy) {
        var existing = btn.querySelector ? btn.querySelector("." + BTN_SPIN_CLASS) : null;
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        ui.icon.style.display = "none";
        ui.label.style.display = "none";
        ui.ahead.style.display = "none";
        var spin = document.createElement("span");
        spin.className = BTN_SPIN_CLASS;
        spin.setAttribute("aria-hidden", "true");
        btn.insertBefore(spin, ui.icon);
        btn.classList.add(BTN_BUSY_CLASS);
        btn.disabled = true;
        btn.setAttribute("aria-busy", "true");
      } else {
        var existing2 = btn.querySelector ? btn.querySelector("." + BTN_SPIN_CLASS) : null;
        if (existing2 && existing2.parentNode) existing2.parentNode.removeChild(existing2);
        ui.icon.style.display = "";
        ui.label.style.display = "";
        ui.label.textContent = message && typeof message === "string" ? message : "Push";
        btn.classList.remove(BTN_BUSY_CLASS);
        btn.removeAttribute("aria-busy");
        // Disabled state is governed by the latest check() result, NOT
        // by clearing the busy flag — see applyState().
      }
    }

    // Reflect the latest check() result in the UI. Disabled-when-empty
    // is the central product requirement: with nothing to push the
    // button must stay disabled, no exceptions.
    function applyState(ui, info) {
      var labelDefault = "Push";
      if (!info || info.ok !== true) {
        ui.btn.disabled = true;
        setBusy(ui, false, info && info.error ? "Push" : labelDefault);
        ui.btn.title = info && info.error ? String(info.error) : "Push (waiting for repository…)";
        ui.ahead.style.display = "none";
        return;
      }
      if (info.detached) {
        ui.btn.disabled = true;
        ui.btn.title = "HEAD is detached; cannot push from this plugin.";
        ui.label.textContent = "Push (detached HEAD)";
        ui.ahead.style.display = "none";
        return;
      }
      if (!info.upstream) {
        ui.btn.disabled = true;
        ui.btn.title = "No upstream configured for branch \"" + (info.branch || "") + "\". Run `git push --set-upstream <remote> <branch>` first.";
        ui.label.textContent = "Push (no upstream)";
        ui.ahead.style.display = "none";
        return;
      }
      var ahead = typeof info.ahead === "number" ? info.ahead : 0;
      var behind = typeof info.behind === "number" ? info.behind : 0;
      if (ahead > 0) {
        ui.btn.disabled = false;
        ui.btn.title = "Push " + ahead + " commit" + (ahead === 1 ? "" : "s") + " to " + info.upstream
          + (behind > 0 ? " (you are " + behind + " behind — consider pull first)" : "");
        ui.label.textContent = "Push";
        ui.ahead.textContent = "\u2191 " + ahead;
        ui.ahead.style.display = "";
      } else {
        ui.btn.disabled = true;
        ui.btn.title = behind > 0
          ? "Already up to date with " + info.upstream + " (you are " + behind + " behind — pull first)"
          : "Already up to date with " + info.upstream + ".";
        ui.label.textContent = "Push (up to date)";
        ui.ahead.style.display = "none";
      }
    }

    // -- Network helpers ------------------------------------------------------
    function postJson(url, body, signal) {
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
        signal: signal,
      }).then(function (res) {
        return res.text().then(function (txt) {
          var data = {};
          if (txt) { try { data = JSON.parse(txt); } catch (_) {} }
          return { status: res.status, body: data };
        });
      });
    }

    // -- Mounting -------------------------------------------------------------
    var MOUNT_REV = "1";

    function mountInto(commitRow, ctx) {
      // If a current-version row is already attached, do nothing. The
      // MutationObserver must not yank a live button (its busy spinner
      // rewrites children, which would otherwise trigger an infinite
      // mount/unmount loop).
      var existing = commitRow.nextSibling;
      while (existing && existing.nodeType !== 1) existing = existing.nextSibling;
      if (existing && existing.classList && existing.classList.contains(ROW_CLASS)) {
        if (existing.firstChild && existing.firstChild.getAttribute
            && existing.firstChild.getAttribute("data-bspb-rev") === MOUNT_REV) {
          return existing;
        }
        existing.parentNode.removeChild(existing);
      }
      var ui = buildRow();
      attachClickHandler(ui, ctx);
      if (commitRow.parentNode) {
        if (commitRow.nextSibling) {
          commitRow.parentNode.insertBefore(ui.row, commitRow.nextSibling);
        } else {
          commitRow.parentNode.appendChild(ui.row);
        }
      }
      return ui.row;
    }

    // -- State + click wiring -------------------------------------------------
    function attachClickHandler(ui, ctx) {
      ui.btn.addEventListener("mousedown", function (ev) { ev.preventDefault(); });
      ui.btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ui.btn.disabled) return;
        // Atomic: the only place we ever enter the busy state. Re-check
        // the disabled flag so a frantic double-click within the same
        // tick cannot slip through (the browser dispatches a second
        // click before our setBusy call lands, so guard explicitly).
        ui.btn.disabled = true;
        runPush(ui, ctx);
      });
    }

    function runPush(ui, ctx) {
      setBusy(ui, true, "Pushing\u2026");
      // The fetch call uses an AbortController so the client can give
      // up after PUSH_CLIENT_TIMEOUT_MS even if the host never replies
      // (the host is itself bounded by 180 s, so the client ceiling is
      // a safe upper bound that protects the toast layer from getting
      // stuck forever).
      var ctrl = (typeof AbortController === "function") ? new AbortController() : null;
      var clientTimer = setTimeout(function () {
        try { if (ctrl) ctrl.abort(); } catch (_) { /* ignore */ }
      }, PUSH_CLIENT_TIMEOUT_MS);

      var done = function () { if (clientTimer) clearTimeout(clientTimer); };

      // Re-resolve the active root fresh on click — the user may have
      // switched session/branch in the meantime, and we never want to
      // push a stale path.
      fetchActiveRoot(ctx)
        .then(function (resolved) {
          if (!resolved || !resolved.root) {
            done();
            setBusy(ui, false, "Push");
            applyState(ui, { ok: false, error: resolved && resolved.error || "no active git repository" });
            showToast("Push failed: " + (resolved && resolved.error || "no active git repository"), "error");
            return null;
          }
          var scope = currentScope(ctx) || {};
          return postJson(PUSH_PATH, {
            root: resolved.root,
            sessionId: scope.sessionId || "",
            cwd: scope.cwd || "",
          }, ctrl ? ctrl.signal : undefined).then(function (envelope) {
            done();
            var body = envelope && envelope.body;
            if (!body || !body.ok) {
              var detail = (body && body.value && body.value.stderr)
                || (body && body.error)
                || ("HTTP " + envelope.status);
              // Truncate very long stderr in the toast (the full text
              // remains in the host log).
              var truncated = typeof detail === "string" && detail.length > 600
                ? detail.substring(0, 600) + "\u2026"
                : detail;
              setBusy(ui, false, "Push");
              showToast("Push failed:\n" + String(truncated), "error");
              return null;
            }
            var value = body.value || {};
            // The host can short-circuit with `noop: true` when
            // ahead==0 (the host-side belt-and-braces). Treat that as
            // success but do not show a celebratory toast — it
            // usually means another panel pushed in between.
            if (value.noop) {
              setBusy(ui, false, "Push");
              showToast(value.stdout || "Nothing to push.", "info");
            } else {
              setBusy(ui, false, "Push");
              var n = typeof value.ahead === "number" ? value.ahead : 0;
              showToast("Pushed " + n + " commit" + (n === 1 ? "" : "s") + " to " + (value.upstream || "upstream") + ".", "success");
            }
            // Always re-check immediately after a push so the UI flips
            // back to disabled-with-0 as fast as the host can confirm.
            return checkAndApply(ui, ctx, true);
          });
        })
        .catch(function (e) {
          done();
          setBusy(ui, false, "Push");
          var aborted = e && (e.name === "AbortError" || /aborted/i.test(String(e && e.message)));
          var msg = aborted
            ? "Push timed out after " + Math.round(PUSH_CLIENT_TIMEOUT_MS / 1000) + "s."
            : "Push failed: " + (e && e.message || e);
          showToast(msg, "error");
        })
        .then(function () {
          // Final defence: re-apply state once more in case the
          // checkAndApply chain above errored out before the final
          // .then() fired.
          return checkAndApply(ui, ctx, false);
        })
        .catch(function (_) { /* never let the post-push re-check crash the UI */ });
    }

    // Single in-flight check promise so we never fan out a storm of
    // /check requests when several triggers fire close together.
    var IN_FLIGHT_CHECK = null;
    function checkOnce(ctx) {
      if (IN_FLIGHT_CHECK) return IN_FLIGHT_CHECK;
      var scope = currentScope(ctx) || {};
      // Reuse the active-root probe (the same one we use on click) to
      // avoid duplicating the /sidebar/api/git.status call. The
      // host's own /check route already does its own git inspection —
      // we just need a root to give it.
      IN_FLIGHT_CHECK = fetchActiveRoot(ctx)
        .then(function (resolved) {
          if (!resolved || !resolved.root) {
            return { ok: false, error: resolved && resolved.error || "no active git repository" };
          }
          return postJson(CHECK_PATH, {
            root: resolved.root,
            sessionId: scope.sessionId || "",
            cwd: scope.cwd || "",
          }).then(function (envelope) {
            var body = envelope && envelope.body;
            if (!body || !body.ok) {
              return { ok: false, error: (body && body.error) || ("HTTP " + envelope.status) };
            }
            return { ok: true, root: resolved.root, value: body.value };
          });
        })
        .catch(function (e) {
          return { ok: false, error: e && e.message || String(e) };
        })
        .then(function (result) {
          IN_FLIGHT_CHECK = null;
          return result;
        });
      return IN_FLIGHT_CHECK;
    }

    // Flatten a check() result into the "info" shape applyState expects.
    function toInfo(checkResult) {
      if (!checkResult) return { ok: false, error: "unknown" };
      if (checkResult.ok !== true) return { ok: false, error: checkResult.error || "check failed" };
      var v = checkResult.value || {};
      return {
        ok: true,
        root: checkResult.root || "",
        branch: v.branch || "",
        upstream: v.upstream || "",
        ahead: typeof v.ahead === "number" ? v.ahead : 0,
        behind: typeof v.behind === "number" ? v.behind : 0,
        canPush: !!v.canPush,
        detached: !!v.detached,
      };
    }

    function checkAndApply(ui, ctx, force) {
      // Throttle: if the last check ran <1 s ago, skip — but `force`
      // (used after a push) bypasses the throttle.
      var now = Date.now();
      if (!force && ui._lastCheckAt && (now - ui._lastCheckAt) < 1000) {
        return Promise.resolve();
      }
      ui._lastCheckAt = now;
      return checkOnce(ctx).then(function (r) {
        var info = toInfo(r);
        applyState(ui, info);
        // If we just discovered a non-zero ahead, the button is now
        // enabled — flash a subtle toast only on the *transition*
        // from disabled→enabled, never on every poll. This keeps the
        // noise floor low while still signalling "hey, you can push
        // now".
        if (info.ok && info.canPush && !ui._wasPushable) {
          if (ui._hadEverBeenPolled) {
            showToast(info.ahead + " commit" + (info.ahead === 1 ? "" : "s") + " ready to push.", "info");
          }
        }
        ui._wasPushable = !!(info.ok && info.canPush);
        ui._hadEverBeenPolled = true;
      });
    }

    // -- Sidebar root detection (re-used pattern) -----------------------------
    function findSidebarRoot() {
      var aside = document.querySelector('aside[data-testid="dsh-better-sidebar"], aside.dsh-better-sidebar');
      if (aside) return aside;
      var inputs = document.querySelectorAll("input");
      for (var i = 0; i < inputs.length; i++) {
        if (isCommitInput(inputs[i])) {
          var p = inputs[i];
          while (p && p !== document.body) {
            if (p.tagName === "ASIDE") return p;
            p = p.parentNode;
          }
        }
      }
      return null;
    }

    // -- Plugin apply ---------------------------------------------------------
    function apply(ctx) {
      try { injectStyles(); } catch (e) { console.error("[dsh-better-sidebar-push-button] injectStyles failed:", e); }

      // Single canonical UI handle for the lifetime of the plugin. We
      // re-bind it to the new <div> the first time we mount and re-use
      // the same click handlers across React re-renders.
      var uiHandle = null;

      var tryMount = function () {
        try {
          var row = findCommitRow();
          if (!row) {
            // The sidebar might be in a state with no commit input at
            // all (e.g. user is in a non-git directory). Keep the
            // previous UI mounted but stop polling — or, if we have
            // never mounted, wait for the next observer tick.
            return false;
          }
          var mounted = mountInto(row, ctx);
          // Every time tryMount() fires (and it can fire dozens of
          // times per second while React re-renders the sidebar) we
          // clone+swap the inner <button> so the previous click
          // listener is dropped on the floor. Without this, the
          // button would accumulate one listener per observer tick
          // and the captured `ctx` from the original mount would
          // stay live even after a session switch.
          var needRebind = false;
          if (mounted && mounted !== uiHandle) {
            uiHandle = { row: mounted, btn: null, icon: null, label: null, ahead: null };
            needRebind = true;
          } else if (mounted && uiHandle && uiHandle.btn) {
            // Same row as last time. The captured `ctx` may have
            // changed (a session switch swaps ctx.sessions.list);
            // re-clone to be sure.
            if (mounted._bspbArmedCtx !== ctx) needRebind = true;
          }
          if (needRebind && uiHandle && uiHandle.row) {
            var liveBtn = uiHandle.row.firstChild;
            if (liveBtn) {
              var fresh = liveBtn.cloneNode(true);
              liveBtn.parentNode.replaceChild(fresh, liveBtn);
              uiHandle.btn = fresh;
              uiHandle.icon = fresh.querySelector("." + ICON_CLASS);
              uiHandle.label = fresh.querySelector("." + LABEL_CLASS);
              uiHandle.ahead = fresh.querySelector("." + AHEAD_CLASS);
              attachClickHandler(uiHandle, ctx);
              uiHandle.row._bspbArmedCtx = ctx;
            }
            // The first poll happens after a short delay so the page
            // can settle and the user does not see a flash of
            // disabled-then-enabled on every React commit. The
            // mark is cleared by the post-mount poll below.
            if (!uiHandle.row._bspbFirstPollDone) {
              uiHandle.row._bspbFirstPollDone = true;
              setTimeout(function () { checkAndApply(uiHandle, ctx, true); }, 80);
            }
          }
          return true;
        } catch (e) {
          console.error("[dsh-better-sidebar-push-button] mount failed:", e);
          return false;
        }
      };

      tryMount();

      // Scope the MutationObserver to the sidebar subtree. The same
      // lesson as dsh-better-sidebar-commit-ia: observing
      // document.body triggers tryMount() on every render of
      // unrelated React subtrees and can abort React's reconciler
      // mid-commit.
      var root = findSidebarRoot();
      var bodyObs = null;
      if (root) {
        bodyObs = new MutationObserver(function () { tryMount(); });
        bodyObs.observe(root, { childList: true, subtree: true });
      } else {
        bodyObs = new MutationObserver(function () {
          var found = findSidebarRoot();
          if (!found) return;
          bodyObs.disconnect();
          bodyObs = new MutationObserver(function () { tryMount(); });
          bodyObs.observe(found, { childList: true, subtree: true });
          tryMount();
        });
        bodyObs.observe(document.body, { childList: true, subtree: true });
      }

      // 3-second polling — enough to react to a fresh commit (the user
      // is staring at the panel) but light enough to leave the
      // background alone (1 fetch per 3 s of /sidebar/api + 1 of
      // /check, both under 50 ms each in the local case).
      var timer = ctx && (ctx.get ? ctx.get("timer") : ctx.timer);
      var poller = null;
      if (timer && typeof timer.interval === "function") {
        poller = timer.interval(function () {
          if (!uiHandle || !uiHandle.btn) return;
          // Never run the check while a push is mid-flight — the host
          // would race with the in-progress `git push` and report
          // stale ahead counts.
          if (uiHandle.btn.classList && uiHandle.btn.classList.contains(BTN_BUSY_CLASS)) return;
          // Only re-check when the commit row is still on screen
          // (the sidebar may have been collapsed/tabbed away).
          if (!findCommitRow()) return;
          checkAndApply(uiHandle, ctx, false);
        }, POLL_INTERVAL_MS);
        if (ctx.effect && typeof poller === "function") {
          ctx.effect(function () { return poller; });
        }
      } else {
        console.warn("[dsh-better-sidebar-push-button] no timer service available; relying on MutationObserver only");
      }
      if (ctx.effect && typeof bodyObs.disconnect === "function") {
        ctx.effect(function () { bodyObs.disconnect(); });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
