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

// i18n.js run as a script with the catalogues it imports. #627: also exposes LANGUAGES, the
// per-area catalogues (AREAS) and the merged ones, for the completeness test.
function loadModule(read) {
  const source = read('i18n.js');
  const imports = [...source.matchAll(/^import\s+(\w+)\s+from\s+'\.\/(messages\/\w+\.js)';$/gm)];
  if (imports.length === 0) throw new Error('i18n.js imports no message catalogue');
  const context = { Intl };
  for (const [, name, rel] of imports) context[name] = defaultExport(read(rel), rel);
  vm.runInNewContext(`${moduleAsScript(source)}\nglobalThis.__i18n = { t, LANGUAGES, AREAS, catalogues };`, context, { filename: 'i18n.js' });
  return context.__i18n;
}

// Returns { t } in Deutsch (Du), the default language (setLanguage() needs a DOM).
function loadI18n(read) {
  return { t: loadModule(read).t };
}

// #627: i18n.js and its catalogues as the running app serves them to the browser (no source read).
async function fetchModule(baseUrl) {
  const get = async rel => {
    const res = await fetch(`${baseUrl}/js/${rel}`);
    if (!res.ok) throw new Error(`GET /js/${rel}: ${res.status}`);
    return res.text();
  };
  const source = await get('i18n.js');
  const files = new Map([['i18n.js', source]]);
  for (const [, rel] of source.matchAll(/^import\s+\w+\s+from\s+'\.\/(messages\/\w+\.js)';$/gm)) files.set(rel, await get(rel));
  return loadModule(rel => files.get(rel));
}

module.exports = { loadI18n, loadModule, fetchModule };
