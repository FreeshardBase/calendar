#!/bin/sh
# Syntax-check every JS and Python file. `node --check` accepts only one file,
# so each file is checked separately (server = CommonJS, public/js = ES modules).
set -e
find server -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
find public/js -name '*.js' -print0 | xargs -0 -n1 sh -c \
  'node --input-type=module --check < "$0" || { echo "FAILED: $0" >&2; exit 1; }'
python3 -m py_compile sync-worker/*.py radicale/*.py
