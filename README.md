# dsh-worktree-toggle

**A one-click git worktree launcher for DeepSeek Harness.** A compact switch sits beside the
composer's branch pill: flip it and the session continues in a fresh git worktree on its own
branch — no command line, no copy of the main checkout, no dirty working tree.

![switch](icon.svg)

## Why

Parallel work in one repository normally means juggling branches or cloning the repo again. This
plugin turns "isolate this session" into a single click: the new checkout is created by the
harness's own worktree service, the session directory moves into it, and the main checkout is
left exactly as it was.

## Features

- **One click, no commands** — the switch appears in the composer tool row for an empty session
  in a git checkout. Click it and the worktree exists and the session runs inside it.
- **Fast by design** — the click path runs no pre-flight git process: the only wait is git's own
  checkout. The UI shows progress immediately and never blocks the composer.
- **Zero layout noise** — a fixed 22 px chip next to the branch pill. It does not change width
  between states, and it never prints a branch or worktree name, so the input stays on one line.
- **Automatic cleanup** — worktrees with no session activity for **3 days** are removed to give
  the disk space back. The branch is kept, and deletion is two-phase so a freshly started host
  never deletes anything before you can see the report.
- **The same safety as the built-in tool** — creation goes through the harness `worktrees`
  service, so the existing sandbox and file policy apply, and the checkout is retained exactly
  like the `create_worktree` tool's.
- **Visible state** — a session already running in a worktree shows the switch checked and
  read-only, with the checkout path in the tooltip.

## Install

From the plugin market (after it is listed):

> Plugins → Discover → search for **dsh-worktree-toggle**.

npm:

```sh
dsh plugin --profile <profile> add dsh-worktree-toggle
```

GitHub:

```sh
dsh plugin --profile <profile> add github:wzciczw/dsh-worktree-toggle
```

Then restart the host (or let the profile reload) and refresh the page.

Requires DeepSeek Harness `0.2.1-rc.2` or newer. Tested on Windows with the desktop build.

## Use

1. Open a **new session** in a git repository.
2. The `Worktree` switch shows up in the composer's tool row, right after the branch pill.
3. Click it.

The host creates a branch and a linked checkout under `<repo>/.agents/worktrees/`, moves the
session's working directory into it, and the switch turns into a checked, read-only `Worktree`
chip. Everything you do in that session — tools, edits, commands — now happens in the new
checkout.

The switch stays hidden for a session that already started outside a worktree, and for
directories that are not git repositories.

## Idle cleanup

A host-side sweep runs 20 seconds after mount and then hourly:

1. the first sweep only **records** an idle worktree (reported as `deferred`);
2. the next sweep removes it if it is still idle;
3. only worktrees inside `<repo>/.agents/worktrees/` are considered — never a linked checkout
   created elsewhere;
4. a worktree is skipped while any session or agent still uses it;
5. removal uses `git worktree remove --force`, which deletes the checkout's files (including
   uncommitted and untracked ones) but keeps the branch.

The last sweep is written to `~/.dsh/dsh-worktree-toggle/gc-state.json`, and the worktrees this
plugin created are tracked in `~/.dsh/dsh-worktree-toggle/worktrees.json`. Worktrees created
another way are adopted when a live session is seen in them.

## Limits

- The switch is offered only before the session's first message; a started session cannot switch
  worktrees.
- Cleanup is scoped to `.agents/worktrees/` under the repository root.
- The branch is retained after cleanup; the uncommitted content of the checkout is not.
- Requires a git executable on the host `PATH`.

## License

MIT
