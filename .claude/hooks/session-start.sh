#!/bin/sh
# SessionStart — make a new session start current, and start informed.
#
# Two failures this removes, both of which bite hardest on a phone:
#
#   1. A fresh clone (every Claude Code web/iOS container is one) has
#      core.hooksPath unset, so the pre-push gate and the commit logger are
#      both silently disarmed. This arms them.
#   2. A branch cut from a stale trunk collides on push. This fetches the
#      trunk up front and reports the gap, so the session knows before it
#      writes a line — and fast-forwards when it is safe to.
#
# Everything it prints goes into Claude's context. Everything it does is local
# and reversible: fetch, a config line, and a fast-forward that only happens
# with a clean tree and no commits of our own to lose.
set -u

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# 1. Arm the git hooks (pre-push checks + post-commit ledger).
if [ "$(git config core.hooksPath 2>/dev/null)" != ".githooks" ]; then
  git config core.hooksPath .githooks 2>/dev/null && echo "session: armed .githooks"
fi

# 2. Which branch is the trunk — asked of the remote, never hardcoded.
trunk=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
if [ -z "$trunk" ]; then
  for b in main master; do
    if git rev-parse --verify --quiet "refs/remotes/origin/$b" >/dev/null; then trunk=$b; break; fi
  done
fi
trunk=${trunk:-main}

# 3. Get it. Bounded, and never fatal — an offline start still works.
git fetch --quiet origin "$trunk" 2>/dev/null

# 4. Fast-forward ONLY when there is nothing to lose: a clean tree, and no
#    commit on this branch that the trunk lacks. Anything else is left alone
#    for `ship` (or a human) to rebase deliberately.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
  ahead=$(git rev-list --count "origin/$trunk..HEAD" 2>/dev/null || echo 1)
  behind=$(git rev-list --count "HEAD..origin/$trunk" 2>/dev/null || echo 0)
  dirty=$(git status --porcelain 2>/dev/null | head -1)
  if [ "$ahead" = "0" ] && [ "$behind" != "0" ] && [ -z "$dirty" ]; then
    if git merge --ff-only "origin/$trunk" >/dev/null 2>&1; then
      echo "session: fast-forwarded $branch onto origin/$trunk (+$behind)"
    fi
  fi
fi

# 5. Open this branch's session file and read the ledger into context.
command -v node >/dev/null 2>&1 || exit 0
node scripts/session.mjs start >/dev/null 2>&1
node scripts/session.mjs brief 2>/dev/null

exit 0
