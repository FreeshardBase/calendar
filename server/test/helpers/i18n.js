'use strict';
// #626: the real public/js/i18n.js with its real message catalogues, for the (allowlisted, #398)
// tests that run app.js source outside the browser with its imports stripped. The caller reads
// the files: `read(rel)` returns the source of public/js/<rel>. The catalogues are the ones
// i18n.js imports itself, so a new catalogue needs no change here.
const vm = require('vm');

// An ES module as a classic script: imports dropped, `export default X` assigned to module.exports.
function moduleAsScript(source) {
  return source
    .replace(/^import\s+[\s\S]*?;$/gm, '')
    .replace(/^export\s+default\s+/m, 'module.exports = ')
    .replace(/^export\s+/gm, '');
}

function defaultExport(source, filename) {
  const context = { module: { exports: {} } };
  vm.runInNewContext(moduleAsScript(source), context, { filename });
  return context.module.exports;
}

// Returns { t } in Deutsch (Du), the default language (setLanguage() needs a DOM).
function loadI18n(read) {
  const source = read('i18n.js');
  const imports = [...source.matchAll(/^import\s+(\w+)\s+from\s+'\.\/(messages\/\w+\.js)';$/gm)];
  if (imports.length === 0) throw new Error('i18n.js imports no message catalogue');
  const context = { Intl };
  for (const [, name, rel] of imports) context[name] = defaultExport(read(rel), rel);
  vm.runInNewContext(`${moduleAsScript(source)}\nglobalThis.__i18n = { t };`, context, { filename: 'i18n.js' });
  return context.__i18n;
}

module.exports = { loadI18n };
