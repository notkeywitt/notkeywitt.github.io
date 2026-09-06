# CLAUDE.md — personal projects

These are the working rules for **non-work** projects. They are the general half
of the rules in `ascent-companion` and `ascent-appscript`: the writing style, the
comment convention, the commit and push discipline, and the session ledger.
Nothing here knows about Ascent, JobTread, Google, or a business process.

Copy this file and the `scripts/`, `.githooks/` and `.claude/` folders into any
personal repo and the same workflow works there — see **Take this to another
repo** at the end.

## This repo

`notkeywitt.github.io` is a hand-written static site. GitHub Pages serves it at
`keillorwitt.com` (the `CNAME` file). There is no framework and no build step:
the HTML, CSS and images in the repo root ARE the site.

| Thing | File |
|---|---|
| Home page | `index.html` |
| Portfolio page | `work.html`, images in `work_imgs/` |
| Styles | `style.css` |

**The published branch is `master`, not `main`.** A push to `master` publishes
the site. Every script here reads the branch name from the remote, so nothing
breaks in a repo that says `main`.

## Write like this

Simplified Technical English, relaxed. These rules apply to every response.

- One idea per sentence. Keep sentences under 25 words.
- Active voice. Present tense. Say who does what.
- Use one word for one thing. Do not vary wording for style.
- Answer first. Add a reason only when it changes a decision.
- Prefer lists and tables to paragraphs. Six sentences per paragraph, maximum.
- Cut: "essentially", "basically", "it's worth noting", "I should mention",
  "let me", "great question", and any clause that restates the clause before it.
- State a risk once, in one sentence. Do not soften it. Do not repeat it.
- Do not narrate your process. Report the result.
- Do not summarize a change the user can read in the diff.
- Define a dev-tooling term the first time you use it, in eight words or fewer,
  in parentheses. The owner knows the logic of his own systems well, but not dev
  jargon. That is the only reason to add words.

## Comments: mark a deliberate shortcut with `ponytail:`

A comment explains why, not what. One kind of why needs its own mark: **a limit
that was chosen on purpose.** Without the mark, the next reader cannot tell a
deliberate ceiling from an oversight, and "fixes" it.

A `ponytail:` note has two parts, always in this order:

1. **The ceiling** — the shortcut, and what it costs.
2. **The trigger** — the one condition that would justify replacing it.

```js
// ponytail: ONE global lock for every sync job, so unrelated jobs block each
// other too. Split into per-sheet locks only if a skipped run ever costs more
// than the simplicity is worth.
```

```js
// ponytail: the arithmetic is the ONLY proof the parse was complete. OCR the
// attached PDF only if the emailed HTML body ever stops carrying the table.
```

Rules:

- No trigger, no `ponytail:`. A note with no exit condition is just an excuse.
- Do not remove a ponytail's shortcut because it looks unfinished. Check the
  trigger first. If the trigger has not fired, leave the code alone.
- When the trigger fires, do the work AND delete the note. A stale ponytail is
  worse than none.
- Use it sparingly. Three in a file means the design is the problem.

## Shipping

**Commit and push when a change is done. Do not wait to be asked.** Every one of
these must hold first:

1. `scripts/checks.sh` passes, when the repo has one. The `.githooks/pre-push`
   hook runs it on any push to the published branch. Never bypass it with
   `--no-verify`. Check the hook is armed with `git config core.hooksPath` — it
   must print `.githooks`. On a fresh clone it is empty; the SessionStart hook
   arms it, or run `git config core.hooksPath .githooks` once.
2. Every file is valid UTF-8 text. A stray control or NUL byte makes git treat a
   source file as binary, and it still renders. If `git` shows a text file as
   `Bin`, find the byte and remove it.
3. Stage only the files this change touched, by name. Never `git add -A`, never
   `git commit -a`. If the tree holds edits you did not make, leave them alone
   and name the files you left.
4. Say in one line what is about to be published. Then push.

**Claude writes the commit message.** Style: one lowercase imperative line saying
what changed, e.g. `center the portfolio grid on a phone`. Add a body only when
the summary cannot carry the reason. End it with a `Co-Authored-By:` trailer
naming the model in use.

If the push is rejected, pull and rebase. Never force-push. Never rewrite history
that is already on `origin`.

**Use `./scripts/ship.sh` to finish a session.** It commits the session ledger,
fetches, rebases onto the remote trunk, runs the checks, regenerates
`SESSIONS.md`, then pushes. Rebasing before the push is what stops a stale branch
turning into a conflict.

## Retire, do not delete

Carried over from the work repos, because it is a general rule: **deleting a
record destroys the history that retiring it keeps.** Prefer a status change, an
archive folder, or a tombstone over a delete. When a delete really is the right
move, capture what is about to disappear — the values, the id, the reason —
somewhere durable FIRST, so the result is a record instead of a hole.

## Where you left off — the session ledger

Work on a personal project is interrupted for weeks at a time.
`.claude/sessions/<date>-<slug>.md` is this branch's record, so the next session
can pick the work up cold. `SESSIONS.md` is the index over every session.

- **The log writes itself.** `.githooks/post-commit` appends each commit and
  stages the file. Never hand-write a row under `## Log`.
- **Set `next:` before you stop.** It is the one field a machine cannot fill, and
  the one that answers "what was I in the middle of":
  `node scripts/session.mjs set next "the next concrete step"`.
- `node scripts/session.mjs note "..."` records a decision or a dead end.
  `set status parked` marks work you are stepping away from unfinished.
- `SESSIONS.md` is **generated** — `node scripts/session.mjs board --write`, or
  let `ship` do it. Do not hand-edit it.
- On a fresh clone the SessionStart hook arms `core.hooksPath`, fetches the
  trunk and reads the ledger into context. Nothing to run by hand.

| Command | Does |
|---|---|
| `node scripts/session.mjs start` | Create this branch's session file |
| `node scripts/session.mjs set next "..."` | Record the next concrete step |
| `node scripts/session.mjs note "..."` | Record a decision or a dead end |
| `node scripts/session.mjs board --write` | Regenerate `SESSIONS.md` |
| `./scripts/ship.sh` | End the session: rebase, check, push |

## Stop and ask

Ask before you change anything that reaches a live surface or a secret:

- Domain and hosting config — `CNAME`, DNS, Pages settings.
- Anything holding a key, token or password. Never commit one.
- A destructive or irreversible command, on files or on a remote.

Everything else on a personal project is yours to decide. Make the routine call
and say what you did.

## Take this to another repo

The toolkit is five files and one folder. It needs `node` and `git`, nothing
else — no npm install, no dependencies.

```sh
cd ~/the-other-project
cp -r ~/notkeywitt.github.io/scripts ~/notkeywitt.github.io/.githooks .
mkdir -p .claude && cp -r ~/notkeywitt.github.io/.claude/hooks .claude/
cp ~/notkeywitt.github.io/.claude/settings.json .claude/settings.json
cp ~/notkeywitt.github.io/CLAUDE.md CLAUDE.md      # then edit "This repo"
git config core.hooksPath .githooks
node scripts/session.mjs start
```

| File | Does |
|---|---|
| `scripts/session.mjs` | The ledger CLI. Dependency-free. |
| `scripts/ship.sh` | Ends a session: rebase, check, push. |
| `scripts/checks.sh` | **Optional, per repo.** Tests, linter, build. The gate. |
| `.githooks/post-commit` | Appends each commit to the session file. |
| `.githooks/pre-push` | Runs `checks.sh` before a push to the trunk. |
| `.claude/hooks/session-start.sh` | Arms the hooks, fetches, reads the ledger in. |
| `.claude/hooks/session-stop.sh` | Asks once for `next:` when a session has commits. |
| `.claude/settings.json` | Wires those two hooks to Claude Code. |

To add a gate to a project, write `scripts/checks.sh`, make it executable, and
exit non-zero on failure. That is the whole contract.

```sh
#!/bin/sh
set -e
npm test          # or: pytest, cargo test, tsc --noEmit, whatever the repo has
```
