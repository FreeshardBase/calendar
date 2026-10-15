default:
    @just --list

lint:
    npm run lint

test:
    npm test

test-e2e: e2e-radicale
    npx playwright test

# The internal CalDAV server the e2e suite needs on :5232 (#217), started as in CI
# (.github/workflows/ci.yml); the image entrypoint creates its self-signed certificate.
# Its collections live in the container, each e2e run removes its own (e2e/global-teardown.js).
e2e-radicale:
    #!/bin/sh
    set -e
    if curl -sk -o /dev/null https://localhost:5232/; then exit 0; fi
    docker build -t webcalendar-radicale ./radicale
    docker rm -f webcalendar-e2e-radicale >/dev/null 2>&1 || true
    docker run -d --name webcalendar-e2e-radicale -p 5232:5232 \
      -e SYSTEM_SYNC_SECRET=super-secret-bypass -e DATABASE_PATH=/data/webcalendar.db \
      webcalendar-radicale
    for i in $(seq 1 30); do
      curl -sk -o /dev/null https://localhost:5232/ && exit 0
      sleep 1
    done
    docker logs webcalendar-e2e-radicale
    echo "Radicale did not become ready on :5232" >&2
    exit 1

ci: lint test test-e2e
