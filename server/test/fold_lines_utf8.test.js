'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { foldLines } = require('../utils/ical');
const parser = require('../caldav/parser');

test('Issue #66 — UTF-8 Octet-Aware Line Folding (foldLines)', async (t) => {
  await t.test('Short line (<= 75 octets) is not folded', () => {
    const text = 'SUMMARY:This is a short summary text';
    assert.strictEqual(foldLines(text), text);
    if (parser.foldLines) {
      assert.strictEqual(parser.foldLines(text), text);
    }
  });

  await t.test('Long ASCII line folds at 75 octets max per line', () => {
    // 80 characters ASCII = 80 octets
    const text = 'DESCRIPTION:' + 'A'.repeat(80);
    const folded = foldLines(text);
    const lines = folded.split('\r\n');
    
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(Buffer.byteLength(lines[0], 'utf8'), 75);
    assert.strictEqual(Buffer.byteLength(lines[1], 'utf8'), 18); // 1 space + 17 'A's
    assert.ok(lines[1].startsWith(' '));
  });

  await t.test('Multi-byte UTF-8 characters fold by octet count, not UTF-16 code units', () => {
    // 40 German umlauts (ä = 2 bytes). 'DESCRIPTION:' (12 bytes) + 40 * 2 = 92 bytes.
    // Length in UTF-16 is 12 + 40 = 52 (< 75 code units!), but UTF-8 byte count is 92 bytes (> 75 octets!).
    const text = 'DESCRIPTION:' + 'ä'.repeat(40);
    const folded = foldLines(text);
    const lines = folded.split('\r\n');

    assert.ok(lines.length > 1, 'Should fold even though char count is 52 because byte count is 92');
    for (const l of lines) {
      assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `Line length ${Buffer.byteLength(l, 'utf8')} exceeds 75 octets`);
    }
  });

  await t.test('4-byte Emoji surrogate pairs are preserved and not split across fold boundaries', () => {
    // Create a string where an emoji sits right at byte 74-75
    // 70 ASCII chars + 🚀 (4 bytes) = 74 bytes. Next char 🚀 (4 bytes) would exceed 75 bytes (78), so it must move to next line without splitting surrogate pair.
    const text = 'SUMMARY:' + 'X'.repeat(62) + '🚀'.repeat(10);
    const folded = foldLines(text);
    const lines = folded.split('\r\n');

    for (const l of lines) {
      assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `Line byte length ${Buffer.byteLength(l, 'utf8')} exceeds 75 octets`);
      assert.ok(!l.includes('\uFFFD'), 'Should not contain replacement character U+FFFD (corrupted surrogate pair)');
    }

    // Verify unfolding restores exact original text
    const unfolded = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('');
    assert.strictEqual(unfolded, text);
  });
});
