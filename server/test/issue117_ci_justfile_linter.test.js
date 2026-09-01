const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

describe('Issue #117 — CI, Justfile, and Linter Verification', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const ciWorkflowPath = path.join(rootDir, '.github/workflows/ci.yml');
  const justfilePath = path.join(rootDir, 'justfile');
  const packageJsonPath = path.join(rootDir, 'package.json');

  it('should have a GitHub Actions CI workflow file at .github/workflows/ci.yml', () => {
    assert.strictEqual(fs.existsSync(ciWorkflowPath), true, '.github/workflows/ci.yml must exist');
    const content = fs.readFileSync(ciWorkflowPath, 'utf8');
    assert.match(content, /name:/, 'Workflow must have a name');
    assert.match(content, /on:/, 'Workflow must have triggers');
    assert.match(content, /jobs:/, 'Workflow must define jobs');
    assert.match(content, /npm (?:run lint|test)/, 'Workflow must execute lint or test');
  });

  it('should have a root justfile with lint, test, and ci recipes', () => {
    assert.strictEqual(fs.existsSync(justfilePath), true, 'justfile must exist in root');
    const content = fs.readFileSync(justfilePath, 'utf8');
    assert.match(content, /^lint:/m, 'justfile must contain lint recipe');
    assert.match(content, /^test:/m, 'justfile must contain test recipe');
    assert.match(content, /^ci:/m, 'justfile must contain ci recipe');
  });

  it('should have a lint script defined in package.json', () => {
    const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    assert.ok(pkgJson.scripts, 'package.json must contain scripts');
    assert.ok(pkgJson.scripts.lint, 'package.json must contain "lint" script');
  });

  it('should execute npm run lint successfully', () => {
    const output = execSync('npm run lint', { cwd: rootDir, encoding: 'utf8' });
    assert.ok(output, 'npm run lint should produce output');
  });
});
