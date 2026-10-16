#!/usr/bin/env node
'use strict';
// #398 (#358): list every file in server/test/ that reads app sources (.js/.css/.html), using the
// same detector as the ESLint rule, but ignoring the allowlist. Usage: node scripts/list-source-grep-tests.js
const path = require('path');
const { ESLint } = require('eslint');
const noSourceGrep = require('./eslint-rules/no-source-grep');

const ROOT = path.resolve(__dirname, '..');

async function listSourceGrepTests(cwd = ROOT) {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.js'],
      languageOptions: { sourceType: 'commonjs', ecmaVersion: 'latest' },
      plugins: { local: { rules: { 'no-source-grep': noSourceGrep } } },
      rules: { 'local/no-source-grep': 'error' },
    }],
  });
  const results = await eslint.lintFiles(['server/test/**/*.js']);
  for (const r of results) {
    const fatal = r.messages.find((m) => m.fatal);
    if (fatal) throw new Error(`${r.filePath}: ${fatal.message}`);
  }
  return results
    .filter((r) => r.messages.some((m) => m.ruleId === 'local/no-source-grep'))
    .map((r) => path.relative(cwd, r.filePath).split(path.sep).join('/'))
    .sort();
}

module.exports = { listSourceGrepTests };

if (require.main === module) {
  listSourceGrepTests().then((files) => console.log(files.join('\n')));
}
