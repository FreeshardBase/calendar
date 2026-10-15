// Issue #110: the stylesheet and the markup must not drift apart. These are invariants over the
// whole of public/, not lists of names: every custom property in use is defined, every class
// selector in app.css is emitted somewhere, and no top-level rule is declared twice.
const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const publicDir = path.join(__dirname, '..', '..', 'public');
const css = fs.readFileSync(path.join(publicDir, 'css', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function readSources(ext) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (ext.some(e => entry.name.endsWith(e))) out.push(fs.readFileSync(full, 'utf8'));
    }
  })(publicDir);
  return out.join('\n');
}
const markup = readSources(['.html', '.js']);

// Top-level rules of the stylesheet: { selector, depth } where depth > 0 means inside an at-rule.
function rules(text) {
  const result = [];
  const stack = [];
  let buf = '';
  for (const ch of text) {
    if (ch === '{') {
      const sel = buf.trim();
      stack.push(sel);
      if (!sel.startsWith('@')) result.push({ selector: sel, atRules: stack.slice(0, -1).filter(s => s.startsWith('@')) });
      buf = '';
    } else if (ch === '}') {
      stack.pop();
      buf = '';
    } else if (ch === ';' ) {
      buf = '';
    } else {
      buf += ch;
    }
  }
  return result;
}

describe('Issue #110 — stylesheet and markup drift', () => {
  test('every custom property referenced under public/ is defined in app.css', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    const used = new Set([...(css + markup).matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1]));
    const undefinedVars = [...used].filter(v => !defined.has(v)).sort();
    assert.deepStrictEqual(undefinedVars, [], `custom properties used but never defined: ${undefinedVars.join(', ')}`);
  });

  test('every class selector in app.css is emitted by the markup or scripts', () => {
    const classes = new Set();
    for (const { selector } of rules(css)) {
      // Attribute selectors and :not()/:is() arguments may hold dots that are not classes.
      const plain = selector.replace(/\[[^\]]*\]/g, '');
      for (const m of plain.matchAll(/\.(-?[a-zA-Z_][\w-]*)/g)) classes.add(m[1]);
    }
    assert.ok(classes.size > 100, 'the stylesheet parsed into class selectors');
    const dead = [...classes].filter(c => !new RegExp(`(^|[^\\w-])${c}($|[^\\w-])`).test(markup)).sort();
    assert.deepStrictEqual(dead, [], `class selectors with no element that could match them: ${dead.join(', ')}`);
  });

  test('no rule is declared twice at the top level', () => {
    // A later top-level duplicate sits after the media queries and silently overrides them
    // (the second `.sidebar` rule did this to the off-canvas drawer). A shared base rule for a
    // selector group followed by per-selector rules is not a duplicate.
    const seen = new Set();
    const dupes = [];
    for (const { selector, atRules } of rules(css)) {
      if (atRules.length > 0) continue;
      const key = selector.split(',').map(x => x.trim().replace(/\s+/g, ' ')).sort().join(', ');
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    assert.deepStrictEqual(dupes, [], `rules declared more than once at the top level: ${dupes.join(' | ')}`);
  });
});
