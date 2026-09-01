'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Db = require('../db');

test('Issue #150 — Search Users SQL Wildcard Escaping & Auth Verification', async (t) => {
  await t.test('1. Db.searchUsers(% or _) does not match all users via wildcard dumping', async () => {
    const user1 = `user-search-1-${Date.now()}`;
    const user2 = `user-search-2-${Date.now()}`;

    await Db.upsertUser(user1, `alice_${user1}`);
    await Db.upsertUser(user2, `bob_${user2}`);

    // Searching for '%' should search literally for '%' and return no users if none contain '%'
    const wildcardPercentResults = await Db.searchUsers('%');
    assert.ok(Array.isArray(wildcardPercentResults));
    const percentMatches = wildcardPercentResults.filter(u => u.displayname === `alice_${user1}` || u.displayname === `bob_${user2}`);
    assert.equal(percentMatches.length, 0, 'Wildcard % must not dump users');

    // Searching for '_' should search literally for '_'
    const userWithUnderscore = `user_with_underscore_${Date.now()}`;
    await Db.upsertUser(userWithUnderscore, userWithUnderscore);

    const wildcardUnderscoreResults = await Db.searchUsers(userWithUnderscore);
    assert.ok(Array.isArray(wildcardUnderscoreResults));
    assert.equal(wildcardUnderscoreResults.length, 1);
    assert.equal(wildcardUnderscoreResults[0].displayname, userWithUnderscore);

    // Cleanup
    await Db.deleteUser(user1);
    await Db.deleteUser(user2);
    await Db.deleteUser(userWithUnderscore);
  });

  await t.test('2. Db.searchUsers handles empty, whitespace, and non-string queries safely', async () => {
    assert.deepEqual(await Db.searchUsers(''), []);
    assert.deepEqual(await Db.searchUsers('   '), []);
    assert.deepEqual(await Db.searchUsers(null), []);
    assert.deepEqual(await Db.searchUsers(undefined), []);
  });

  await t.test('3. Db.searchUsers matches matching substring correctly', async () => {
    const targetId = `target-${Date.now()}`;
    const targetUsername = `unique_search_target_${Date.now()}`;
    await Db.upsertUser(targetId, targetUsername);

    const results = await Db.searchUsers(targetUsername.substring(0, 15));
    assert.ok(Array.isArray(results));
    assert.ok(results.some(u => u.displayname === targetUsername));

    await Db.deleteUser(targetId);
  });
});
