#!/bin/sh
# Node unit/integration suite. Test files that read the sibling ../app-repository checkout
# cannot run in a standalone checkout of this repo (CI, driver worktrees); they are listed
# explicitly rather than failing or silently skipping. Tracked in #332.
# Extra node flags: NODE_TEST_FLAGS="--test-reporter=spec --test-timeout=120000"
set -e
EXCLUDED=$(grep -l 'app-repository' server/test/*.test.js || true)
if [ -n "$EXCLUDED" ] && [ ! -d ../app-repository/apps/webcalendar ]; then
  echo "Excluded (need sibling app-repository checkout, #332):"; echo "$EXCLUDED"
  FILES=$(ls server/test/*.test.js | grep -vxF "$EXCLUDED")
else
  FILES=$(ls server/test/*.test.js)
fi
# shellcheck disable=SC2086
NODE_ENV=test exec node --test --test-concurrency=1 $NODE_TEST_FLAGS $FILES
