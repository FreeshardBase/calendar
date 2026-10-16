'use strict';
// #398 (#358): a test must exercise behaviour, not read app sources (.js/.css/.html) and match
// strings in them. This rule flags a file read (readFileSync, readFile, createReadStream) whose
// path is built from a source path: a string like 'app.js', 'index.html' or a 'public' path
// segment, either directly or through variables, loop variables, callback parameters of
// iterations over such values, or local helper functions that pass their argument to a read.
// Paths passed to require()/import() are not reads, and strings starting with '/' are URLs
// (supertest requests), so neither counts. Configuration files (compose, Dockerfile, *.json)
// are out of scope. The allowlist of today's offenders is server/test/source-grep-allowlist.json;
// it may only shrink (server/test/source_grep_lint_rule.test.js).

const READ_CALLS = new Set(['readFileSync', 'readFile', 'createReadStream']);
const SOURCE_FILE = /^[^\s/][^\s]*\.(?:[cm]?js|css|html?)$/i;
const SOURCE_EXTENSION = /^\.(?:[cm]?js|css|html?)$/i;
const PUBLIC_SEGMENT = /^[^\s/](?:[^\s]*[\\/])?public(?:[\\/][^\s]*)?$|^public$/;

function isSourceString(value) {
  return typeof value === 'string' && (SOURCE_FILE.test(value) || SOURCE_EXTENSION.test(value) || PUBLIC_SEGMENT.test(value));
}

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  return null;
}

function isModuleLoad(node) {
  if (node.type === 'ImportExpression') return true;
  if (node.type !== 'CallExpression') return false;
  const { callee } = node;
  if (callee.type === 'Identifier' && callee.name === 'require') return true;
  return callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'require';
}

function patternNames(pattern, out = []) {
  if (!pattern) return out;
  switch (pattern.type) {
    case 'Identifier': out.push(pattern.name); break;
    case 'ObjectPattern': pattern.properties.forEach((p) => patternNames(p.type === 'RestElement' ? p.argument : p.value, out)); break;
    case 'ArrayPattern': pattern.elements.forEach((e) => patternNames(e, out)); break;
    case 'RestElement': patternNames(pattern.argument, out); break;
    case 'AssignmentPattern': patternNames(pattern.left, out); break;
    case 'VariableDeclaration': pattern.declarations.forEach((d) => patternNames(d.id, out)); break;
  }
  return out;
}

function isFunction(node) {
  return node && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow tests that read app sources (.js/.css/.html) instead of testing behaviour (#358)' },
    schema: [],
    messages: {
      sourceRead: 'Test reads app source (#358): test behaviour with supertest, jsdom or Playwright instead of matching source text.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const keys = sourceCode.visitorKeys;
    const nodes = [];

    function children(node) {
      const out = [];
      for (const key of keys[node.type] || []) {
        const value = node[key];
        if (Array.isArray(value)) value.forEach((v) => v && out.push(v));
        else if (value && typeof value.type === 'string') out.push(value);
      }
      return out;
    }

    function walk(node, visit) {
      if (visit(node) === false) return;
      for (const child of children(node)) walk(child, visit);
    }

    function collect(node) {
      nodes.push(node);
      for (const child of children(node)) collect(child);
    }

    const tainted = new Set();

    // Does this subtree carry a source path? Module loads are skipped, nested functions too
    // (a callback inside an argument is not part of the path value).
    function carriesSource(node) {
      let found = false;
      walk(node, (n) => {
        if (found || isModuleLoad(n)) return false;
        if (n !== node && isFunction(n)) return false;
        if (n.type === 'Literal' && isSourceString(n.value)) found = true;
        else if (n.type === 'TemplateElement' && isSourceString(n.value.cooked)) found = true;
        else if (n.type === 'Identifier' && tainted.has(n.name) && !(n.parent && n.parent.type === 'MemberExpression' && n.parent.property === n && !n.parent.computed)) found = true;
        return !found;
      });
      return found;
    }

    function taint(names) {
      let changed = false;
      for (const name of names) if (!tainted.has(name)) { tainted.add(name); changed = true; }
      return changed;
    }

    // Helper functions whose parameters reach a read call become read calls themselves.
    const readers = new Set(READ_CALLS);
    function functionName(fn) {
      if (fn.type === 'FunctionDeclaration' && fn.id) return fn.id.name;
      if (fn.parent && fn.parent.type === 'VariableDeclarator' && fn.parent.id.type === 'Identifier') return fn.parent.id.name;
      return null;
    }
    function isReadCall(node) {
      return node.type === 'CallExpression' && readers.has(calleeName(node.callee));
    }

    return {
      'Program:exit'(program) {
        collect(program);
        let changed = true;
        while (changed) {
          changed = false;
          for (const node of nodes) {
            if (node.type === 'VariableDeclarator' && node.init && carriesSource(node.init)) changed = taint(patternNames(node.id)) || changed;
            else if (node.type === 'AssignmentExpression' && carriesSource(node.right)) changed = taint(patternNames(node.left)) || changed;
            else if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && carriesSource(node.right)) changed = taint(patternNames(node.left)) || changed;
            else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && carriesSource(node.callee.object)) {
              for (const arg of node.arguments) if (isFunction(arg)) changed = taint(arg.params.flatMap((p) => patternNames(p))) || changed;
            } else if (isFunction(node)) {
              const name = functionName(node);
              if (!name || readers.has(name)) continue;
              const params = new Set(node.params.flatMap((p) => patternNames(p)));
              let passesParam = false;
              walk(node.body, (n) => {
                if (passesParam) return false;
                if (isReadCall(n)) {
                  n.arguments.forEach((arg) => walk(arg, (m) => {
                    if (m.type === 'Identifier' && params.has(m.name)) passesParam = true;
                    return !passesParam;
                  }));
                }
                return !passesParam;
              });
              if (passesParam) { readers.add(name); changed = true; }
            }
          }
        }
        for (const node of nodes) {
          if (isReadCall(node) && node.arguments.some(carriesSource)) {
            context.report({ node, messageId: 'sourceRead' });
          }
        }
      },
    };
  },
};
