default:
    @just --list

lint:
    npm run lint

test:
    npm test

test-e2e:
    npx playwright test

ci: lint test test-e2e
