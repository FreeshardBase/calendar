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

// #343 (CLAUDE.md 3.1): a swallowed error is a lint error. An empty block (`catch {}`) is caught by
// no-empty, a catch block holding only a comment by the CatchClause selector; an empty or constant
// rejection handler (`.catch(() => {})`, `.catch(() => [])`, `.catch(noop)`, `.then(ok, () => {})`)
// by the selectors below.
const SWALLOWED_REJECTION = 'Swallowed rejection (#343): handle a specific error or let it propagate.';
const SWALLOWED_CATCH = 'Swallowed error (#343): a catch block needs code that handles or rethrows the error.';

// Tracked debt, kept visible as warnings and capped in CI by --max-warnings (a ratchet: it may only go down).
module.exports.push({
  rules: {
    'no-empty': 'error',
    'no-restricted-syntax': ['error',
      { selector: "CallExpression[callee.property.name='catch'] > :function[body.type='BlockStatement'][body.body.length=0]", message: SWALLOWED_REJECTION },
      { selector: "CallExpression[callee.property.name='then'][arguments.length=2] > :function:nth-child(2)[body.type='BlockStatement'][body.body.length=0]", message: SWALLOWED_REJECTION },
      { selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Literal'][body.value=null]", message: SWALLOWED_REJECTION },
      { selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Identifier'][body.name='undefined']", message: SWALLOWED_REJECTION },
      { selector: "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type=/^(Literal|ArrayExpression|ObjectExpression)$/]", message: SWALLOWED_REJECTION },
      { selector: "CallExpression[callee.property.name='catch'] > Identifier[name=/^(noop|_)$/]", message: SWALLOWED_REJECTION },
      { selector: 'CatchClause > BlockStatement[body.length=0]', message: SWALLOWED_CATCH },
    ],
    'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
    'no-async-promise-executor': 'warn',
    'no-useless-escape': 'warn',
    // rejecting control characters in user input is intentional (see #334)
    'no-control-regex': 'off',
  },
});
