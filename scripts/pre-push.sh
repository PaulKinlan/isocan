#!/bin/sh
# **The gate that answers "is this push allowed to leave?"**
#
# isocan had no test gate on push: the hook git actually ran was Beads' own, and
# nothing on the way out said a push was carrying broken types or a red suite.
# What that cost, on one night: the tree carried a base red on typecheck (four
# WebAssembly errors) and two fast-suite failures, one of them in a script its
# author had just written — and both were found by a person running gates by
# hand while holding an exclusive push slot. (isocan-1j1)
#
# **Two facts make this file and not the hook file the right home.**
#
# 1. Hooks do not travel. `.git/hooks` is untracked and `.beads/hooks` is
#    untracked too, so whatever runs on a given machine is an install, not a
#    commit. This script is the tracked half; `scripts/install-hooks.mjs` chains
#    it into whichever hook directory git is actually configured to use.
# 2. `core.hooksPath` is `.beads/hooks` on this machine, which SHADOWS
#    `.git/hooks` entirely — so the repo's own doc check in
#    `scripts/hooks/pre-push` had never once run. That is why the chain below
#    calls it explicitly instead of assuming the installer put it in the way.
#
# **The fast lane, deliberately**: `npm run typecheck` and `npm test`. The deep
# lane stays CI's — a five-minute suite on every push is a gate people learn to
# `--no-verify`, and `--no-verify` is the honest escape for a push that is not
# going to main.
set -u
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

fail() {
  echo "" >&2
  echo "[pre-push] REFUSED: $1" >&2
  echo "[pre-push] The push has not happened. Fix it, or \`git push --no-verify\` if it is not going to main." >&2
  exit 1
}

# 1. Beads, unless beads itself invoked us (BD_GIT_HOOK is set by its hook, and
#    running it twice would double its own work for no new answer).
if [ -z "${BD_GIT_HOOK:-}" ] && command -v bd >/dev/null 2>&1; then
  echo "[pre-push] beads"
  bd hooks run pre-push "$@" || fail "beads refused the push"
fi

# 2. NOTE: the generated-doc check is NOT called here. It lives in
#    `scripts/hooks/pre-push`, which chains this script — calling it back would be
#    a loop, and the caller has already run it by the time we are reached.

# 3. Types, then the suite. Types first: it is the faster signal and it names a
#    file and a line rather than a test.
#
# **`GIT_DIR` is unset first, and that line is the whole reason this hook could
# not simply run `npm test`.** Git runs hooks with `GIT_DIR` set, so a test that
# spawns git in a scratch directory has its commands applied to the repository
# being pushed instead — measured, on this hook's first green attempt:
#
#     fatal: cannot force update the branch 'main' used by worktree at
#            '/home/paulkinlan/isocan'
#
# which is `test/nightly-prs.test.ts`'s fixture doing `git branch -M main` in a
# temp directory that inherited this hook's `GIT_DIR`. Unsetting it is correct
# here: by the time a pre-push hook runs, git has already decided the push.
# **Every `GIT_*`, not the three that bit me first.** The bug above named
# `GIT_DIR`; the second one was a test whose scan runs `git ls-files` and returned
# NOTHING under the hook, failing as `has a list of exceptions that all still
# exist` and `found files at all: expected 0 to be greater than 50` while passing
# alone (packages/web/test/echoed.test.ts, measured). Which variable git adds this
# time is not the point: a hook's git environment is not the environment a suite
# should be judged in, so all of it goes.
for _v in $(env | sed -n 's/^\(GIT_[A-Z_]*\)=.*/\1/p'); do unset "$_v"; done

echo "[pre-push] typecheck"
npm run typecheck || fail "typecheck is red"

echo "[pre-push] npm test (the fast lane; the deep lane is CI's, and test:deep before a release)"
npm test || fail "the fast suite is red"

echo "[pre-push] ok"
