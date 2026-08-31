'use strict';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const cssPath = path.resolve(__dirname, '../../public/css/app.css');

describe('Issue #113 — prefers-reduced-motion Support', () => {
  const cssContent = fs.readFileSync(cssPath, 'utf8');

  function getReducedMotionBlock(css) {
    const startIndex = css.indexOf('@media (prefers-reduced-motion: reduce)');
    if (startIndex === -1) return null;
    const braceOpen = css.indexOf('{', startIndex);
    if (braceOpen === -1) return null;
    let depth = 1;
    let index = braceOpen + 1;
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth++;
      else if (css[index] === '}') depth--;
      index++;
    }
    return css.slice(braceOpen + 1, index - 1);
  }

  test('app.css contains @media (prefers-reduced-motion: reduce) block', () => {
    assert.ok(
      cssContent.includes('@media (prefers-reduced-motion: reduce)'),
      'app.css must contain a @media (prefers-reduced-motion: reduce) query block'
    );
  });

  test('prefers-reduced-motion media query disables animations and transitions', () => {
    const body = getReducedMotionBlock(cssContent);
    assert.ok(body, '@media (prefers-reduced-motion: reduce) block must exist');

    assert.ok(
      body.includes('animation') || body.includes('--t: 0s') || body.includes('--t: 0ms'),
      'prefers-reduced-motion block must override animation/transition behavior'
    );
    assert.ok(
      body.includes('transition') || body.includes('animation-duration') || body.includes('transition-duration'),
      'prefers-reduced-motion block must explicitly disable or minimize transitions/animations'
    );
    assert.ok(
      body.includes('scroll-behavior: auto'),
      'prefers-reduced-motion block must set scroll-behavior: auto !important'
    );
  });

  test('prefers-reduced-motion media query resets transition tokens --t and --t-slow', () => {
    const body = getReducedMotionBlock(cssContent);
    assert.ok(body, '@media (prefers-reduced-motion: reduce) block must exist');

    assert.ok(
      /--t\s*:\s*0[s|ms]/i.test(body),
      '--t must be set to 0s or 0ms inside prefers-reduced-motion block'
    );
    assert.ok(
      /--t-slow\s*:\s*0[s|ms]/i.test(body),
      '--t-slow must be set to 0s or 0ms inside prefers-reduced-motion block'
    );
  });
});
