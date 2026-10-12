'use strict';
const js = require('@eslint/js');
const globals = require('globals');

// Bug-finding rules only (eslint:recommended). Style is not enforced here.
module.exports = [
  { ignores: ['node_modules/**', 'reports/**', 'test-results/**', 'playwright-report/**', 'data/**', '.stryker-tmp/**'] },
  js.configs.recommended,
  {
    files: ['server/**/*.js', 'e2e/**/*.js', '*.js'],
    languageOptions: { sourceType: 'commonjs', ecmaVersion: 2023, globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['public/js/**/*.js'],
    languageOptions: { sourceType: 'module', ecmaVersion: 2023, globals: { ...globals.browser, module: 'readonly', define: 'readonly', require: 'readonly', Shortcuts: 'readonly' } },
  },
  {
    files: ['public/sw.js', 'public/**/sw*.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 2023, globals: { ...globals.serviceworker } },
  },
];

// Tracked debt, kept visible as warnings and capped in CI by --max-warnings (a ratchet: it may only go down).
// no-empty / no-async-promise-executor are the swallowed-error pattern from #343.
module.exports.push({
  rules: {
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-empty': 'warn',
    'no-async-promise-executor': 'warn',
    'no-useless-escape': 'warn',
    // rejecting control characters in user input is intentional (see #334)
    'no-control-regex': 'off',
  },
});
