#!/usr/bin/env bash
set -e

cd "$(git rev-parse --show-toplevel)" || exit 1

echo "Fetching upstream..."
git fetch upstream --prune --tags || exit 1

# Update master to match upstream/master
echo "Updating origin/master to match upstream/master..."
git checkout master || exit 1
git reset --hard upstream/master || exit 1
git push origin master --force-with-lease -f || exit 1

# Rebase patched on top of master
git checkout patched || exit 1

if ! git rebase master; then
  echo "Merge conflicts detected during rebase!"
  echo ""
  echo "After resolving conflicts:"
  echo "  - Continue: git rebase --continue"
  echo "  - Abort: git rebase --abort"
  exit 1
fi

echo "Successfully rebased patched onto master"
