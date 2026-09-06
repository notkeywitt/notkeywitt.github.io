#!/bin/sh
# ship — end a session: rebase onto the trunk, run the checks, push, close the ledger.
#
# The problem it removes: a branch cut an hour ago is already behind the trunk,
# and a straight `git push` is what turns that into a conflict. This does the
# steps in the order that avoids it, every time, so the order never has to be
# remembered:
#
#   1. commit whatever the ledger has staged
#   2. fetch + rebase onto the remote trunk   ← the conflict, resolved before the push
#   3. run this repo's checks (scripts/checks.sh, when it exists)
#   4. regenerate SESSIONS.md, mark the session shipped, push
#
#   ./scripts/ship.sh          (or `npm run ship`, where package.json defines one)
#
# The trunk is read from the remote, not hardcoded — this repo may say `master`.
# Set SHIP_TARGET to push somewhere else:  SHIP_TARGET=my-branch ./scripts/ship.sh
#
# It never force-pushes, and never rewrites history that is already on origin.
set -u

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ship: not inside a git repository" >&2
  exit 1
}

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "HEAD" ]; then
  echo "ship: detached HEAD — check out a branch first" >&2
  exit 1
fi

# The trunk: the remote's own answer first, then whichever of the two names exists.
trunk=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
if [ -z "$trunk" ]; then
  for b in main master; do
    if git rev-parse --verify --quiet "refs/remotes/origin/$b" >/dev/null; then trunk=$b; break; fi
  done
fi
trunk=${trunk:-main}
target=${SHIP_TARGET:-$trunk}

echo "ship: $branch → origin/$target"

# Arms the post-commit ledger logger and the pre-push checks on a fresh clone.
if [ "$(git config core.hooksPath 2>/dev/null)" != ".githooks" ]; then
  git config core.hooksPath .githooks
  echo "ship: armed .githooks"
fi

ledger=$(node scripts/session.mjs path 2>/dev/null || true)

# ── 1. commit the ledger ────────────────────────────────────────────────────
# post-commit stages each entry but cannot commit it. Anything left is this
# session's own record, and it must travel with the work.
if [ -n "$ledger" ] && ! git diff --quiet -- "$ledger" 2>/dev/null; then
  git add -- "$ledger"
fi
if [ -n "$ledger" ] && ! git diff --cached --quiet -- "$ledger" 2>/dev/null; then
  SESSION_LEDGER_SKIP=1 git commit -q --only -m "log session $(basename "$ledger" .md)" -- "$ledger" \
    || { echo "ship: could not commit the session ledger" >&2; exit 1; }
  echo "ship: committed the session ledger"
fi

# ── 2. a clean tree, then rebase ────────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  echo "ship: the working tree has uncommitted changes — commit or stash them first:" >&2
  git status --short >&2
  exit 1
fi

n=0
until git fetch origin "$trunk"; do
  n=$((n + 1))
  [ "$n" -ge 4 ] && { echo "ship: could not fetch origin/$trunk" >&2; exit 1; }
  sleep $((1 << n))
done

behind=$(git rev-list --count "HEAD..origin/$trunk")
if [ "$behind" != "0" ]; then
  echo "ship: rebasing onto origin/$trunk (+$behind)"
  if ! git rebase "origin/$trunk"; then
    # SESSIONS.md is generated from the session files, so a conflict in it is
    # never a real disagreement — regenerate and carry on. Any other conflict
    # is genuine and stays for a human (or Claude) to resolve.
    conflicts=$(git diff --name-only --diff-filter=U)
    generated_only=1
    for f in $conflicts; do
      case "$f" in
        SESSIONS.md | src/lib/sessionLog.generated.json) ;;
        *) generated_only=0 ;;
      esac
    done
    if [ -n "$conflicts" ] && [ "$generated_only" = "1" ]; then
      node scripts/session.mjs board --write >/dev/null
      git add -- $conflicts
      GIT_EDITOR=true git rebase --continue >/dev/null 2>&1 \
        || { echo "ship: rebase still blocked — resolve it, then run ship again" >&2; exit 1; }
      echo "ship: regenerated the session board through the rebase"
    else
      echo "ship: rebase conflict — resolve these, \`git rebase --continue\`, then run ship again:" >&2
      echo "$conflicts" >&2
      exit 1
    fi
  fi
fi

# ── 3. this repo's checks ───────────────────────────────────────────────────
# One optional file, so a project can grow a gate without this script changing.
# The pre-push hook runs the same file; running it here surfaces a failure
# before the ledger is closed.
if [ -x scripts/checks.sh ]; then
  echo "ship: running scripts/checks.sh"
  SHIP_CHECKS=1 ./scripts/checks.sh || { echo "ship: checks FAILED — push blocked" >&2; exit 1; }
fi

# ── 4. close the ledger, then push ──────────────────────────────────────────
if [ -n "$ledger" ]; then
  node scripts/session.mjs set status shipped >/dev/null
  ledger=$(node scripts/session.mjs path)
fi
node scripts/session.mjs board --write >/dev/null
git add -- SESSIONS.md ${ledger:+"$ledger"}
if ! git diff --cached --quiet; then
  SESSION_LEDGER_SKIP=1 git commit -q -m "close session $(basename "${ledger:-session}" .md)"
fi

# Branch → the remote target directly. Merging into a local trunk first is what
# breaks in an ephemeral container, where the local ref is stale or unrelated.
#
# Three ways a push fails, and only one of them is worth retrying:
#   · a pre-push check said no  → a real failure; retrying just re-runs it
#   · the remote moved          → rebase once, push again
#   · the network               → back off and retry
log=$(mktemp)
trap 'rm -f "$log"' EXIT
n=0
while :; do
  # Captured, not piped: a pipeline's exit status is `tee`'s, so the push's own
  # failure would be swallowed and every push would look like it worked.
  if git push origin "HEAD:$target" >"$log" 2>&1; then
    cat "$log"
    echo "ship: pushed $(git rev-parse --short HEAD) to origin/$target"
    exit 0
  fi
  cat "$log" >&2

  if grep -qE "pre-push|hook declined" "$log"; then
    echo "ship: the pre-push gate blocked this push — fix what it reported, then run ship again" >&2
    exit 1
  fi

  if [ "$n" -eq 0 ] && grep -qiE "rejected|non-fast-forward|fetch first" "$log"; then
    echo "ship: origin/$target moved — rebasing and retrying"
    git fetch origin "$trunk" && git rebase "origin/$trunk" || {
      echo "ship: rebase conflict on retry — resolve it, then run ship again" >&2
      exit 1
    }
    n=1
    continue
  fi

  n=$((n + 1))
  [ "$n" -ge 5 ] && { echo "ship: push failed — see the output above" >&2; exit 1; }
  echo "ship: push failed — retrying in $((1 << n))s"
  sleep $((1 << n))
done
