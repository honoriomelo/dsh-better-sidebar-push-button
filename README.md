# dsh-better-sidebar-push-button

DSH Web GUI plugin. Adds a **full-width Push button directly below the
commit row** of `dsh-better-sidebar`'s Source Control panel — the row
that holds the commit input + Commit button.

- When the active repository has at least one local commit not yet
  pushed to its upstream (`ahead > 0`), the button is **enabled** and
  shows a small badge with the count (`↑ 3`).
- When the working tree is already up to date with the upstream, the
  button is **disabled** and reads `Push (up to date)`.
- During a push the button is **disabled**, the icon is replaced with a
  spinner, and the label changes to `Pushing…` so a frantic
  double-click cannot fire two `git push` invocations.

The plugin does not modify `dsh-better-sidebar` source code. A
`MutationObserver` waits for the commit row to appear and inserts a
new full-width row of its own immediately after it, styled to match the
sidebar's panel. Updates to `dsh-better-sidebar` are preserved.

## Install

```bash
dsh plugin --profile web add link:/path/to/dsh-better-sidebar-push-button
```

Then restart `dsh web` (or refresh the page so the new bundle is
picked up).

## How it works

- **Client** (`lib/client.js`): a `MutationObserver` watches the
  `dsh-better-sidebar` `<aside>` subtree. When it sees a `<div>` that
  contains a commit input (`placeholder` matches `/commit/i`) and at
  least one `<button>`, it appends a new `<div class="bspb-push-row">`
  immediately after that commit row, containing one
  `<button class="bspb-push-btn">` (↑ icon + "Push" label + optional
  `↑ N` badge). A `ctx.timer.interval` polls the host `/check` route
  every 3 s to refresh `ahead` / `behind` counts and update the
  button's enabled state. While a push is in flight, the polling
  skips (a stale `ahead` count would race the in-progress push) and the
  click handler is inert. The active git root is resolved at click
  time by calling `POST /sidebar/api/git.status` — the same endpoint
  the sidebar itself uses — so the plugin never has to maintain its
  own session-resolver.

- **Host** (`lib/index.js`): two `webServer.register({ kind: 'exact'
  })` routes.
  - `POST /plugins/dsh-better-sidebar-push-button/check` — runs
    `git -C <root> rev-parse --abbrev-ref --symbolic-full-name HEAD`
    and `<branch>@{u}`, plus
    `git -C <root> rev-list --left-right --count <upstream>...HEAD`,
    and returns `{ ok, value: { root, branch, upstream, ahead,
    behind, canPush, detached } }`.
  - `POST /plugins/dsh-better-sidebar-push-button/push` — runs
    `git -C <root> --no-pager push --progress` (no force, no
    `--set-upstream`) and returns the captured stdout/stderr plus the
    exit code. A server-side belt-and-braces re-checks
    `ahead > 0` so a misbehaving caller cannot push when there is
    nothing to push; in that case it short-circuits with
    `{ ok: true, value: { noop: true } }`.

Both routes accept a plain `{ root, sessionId?, cwd? }` JSON body. When
`root` is missing the host falls back to running
`git rev-parse --show-toplevel` against the supplied `cwd` (a defence
in depth so the host never silently pushes the wrong repo).

## State machine

The button's label/title/disabled state is driven entirely by the
latest `/check` response. The five observed states are:

| State | Trigger | Button | Label | Badge |
|-------|---------|--------|-------|-------|
| no-session | no active conversation | disabled | `Push` | hidden |
| not-a-repo | current dir is not a git repo | disabled | `Push` | hidden |
| error | check/push failed | disabled | `Push` | hidden |
| detached | HEAD is detached | disabled | `Push (detached HEAD)` | hidden |
| no-upstream | branch has no `@{u}` | disabled | `Push (no upstream)` | hidden |
| behind-only | `ahead == 0 && behind > 0` | disabled | `Push (up to date)` | hidden |
| ready | `ahead > 0` | **enabled** | `Push` | `↑ N` |
| pushing | push in flight | disabled | `Pushing…` | hidden (spinner) |

A success toast appears when a push completes
(`Pushed 3 commits to origin/main.`), an error toast on failure
(`Push failed: <first 600 chars of stderr>`), and an info toast on
the *transition* from `ahead == 0` to `ahead > 0` so the user knows a
new push is available without re-prompting on every poll.

## License

MIT.
