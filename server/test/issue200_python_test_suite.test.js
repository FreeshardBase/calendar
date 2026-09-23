const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('child_process');
const path = require('path');

test('Issue #200 — Python Test Suite Execution', async (t) => {
  await t.test('Executes all Python unit tests (Radicale plugins, Sync Worker, MS Graph Worker)', () => {
    const pythonTestDir = path.join(__dirname, 'python');
    const cmd = `python3 -m unittest discover -s ${pythonTestDir} -p "test_*.py"`;
    
    try {
      const stdout = execSync(cmd, {
        cwd: path.join(__dirname, '../..'),
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ENCRYPTION_KEY: 'test-key-32-bytes-long-1234567890' }
      });
      assert.ok(true, 'Python unit test discovery executed successfully');
    } catch (error) {
      assert.fail(`Python unit test suite failed:\nStdout: ${error.stdout}\nStderr: ${error.stderr}`);
    }
  });
});
