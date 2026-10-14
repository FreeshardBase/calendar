#!/bin/sh
# Syntax-check every JS and Python file. `node --check` accepts only one file,
# so each file is checked separately (server = CommonJS, public/js = ES modules).
set -e
find server -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find public/js -name '*.js' -print0 | xargs -0 -n1 sh -c \
  'node --input-type=module --check < "$0" || { echo "FAILED: $0" >&2; exit 1; }'
python3 -m py_compile sync-worker/*.py radicale/*.py
# ESLint (bug-finding rules). Swallowed errors are errors (#343); the remaining warnings are
# tracked debt and capped: the cap may only go down.
npx eslint . --max-warnings 158
# ruff for the Python workers and their tests (pinned in CI via requirements-dev.txt)
if command -v ruff >/dev/null 2>&1; then ruff check sync-worker radicale server/test/python
else echo "lint: ruff not installed (pip install -r requirements-dev.txt)" >&2; exit 1; fi
