const test = require('node:test');
const assert = require('node:assert/strict');
const { validCommand } = require('../dist/panel.js');
test('panel accepts only bounded controls for its own session', () => {
  assert.equal(validCommand({ type: 'browse', sessionId: 'one', pathBase64: 'YS50cw==' }, 'one'), true);
  assert.equal(validCommand({ type: 'browse', sessionId: 'one', pathBase64: 'YS50cw==', offset: 0 }, 'one'), false);
  assert.equal(validCommand({ type: 'browse', sessionId: 'one', pathBase64: '../bad' }, 'one'), false);
  assert.equal(validCommand({ type: 'viewportSize', sessionId: 'one', rows: 30 }, 'one'), true);
  assert.equal(validCommand({ type: 'viewportSize', sessionId: 'one', rows: 121 }, 'one'), false);
  assert.equal(validCommand({ type: 'closeTab', sessionId: 'one', offset: 0 }, 'one'), true);
  assert.equal(validCommand({ type: 'pause', sessionId: 'one' }, 'one'), true);
  assert.equal(validCommand({ type: 'pause', sessionId: 'old' }, 'one'), false);
  assert.equal(validCommand({ type: 'speed', sessionId: 'one', charactersPerSecond: 24, pointerMultiplier: 1 }, 'one'), true);
  assert.equal(validCommand({ type: 'repository', sessionId: 'one', repositoryId: 'repo-1' }, 'one'), true);
  assert.equal(validCommand({ type: 'commits', sessionId: 'one', cursor: null }, 'one'), true);
  assert.equal(validCommand({ type: 'prepare', sessionId: 'one', repositoryId: 'repo-1', startOid: 'a'.repeat(40), endOid: 'b'.repeat(40), timing: { mode: 'duration', durationMs: 60000 } }, 'one'), true);
  assert.equal(validCommand({ type: 'nativeInput', sessionId: 'one', action: 'arm', at: 1000 }, 'one'), true);
  assert.equal(validCommand({ type: 'nativeInput', sessionId: 'one', action: 'pulse', at: 1000, key: 'Enter' }, 'one'), false);
  assert.equal(validCommand({ type: 'nativeInput', sessionId: 'one', action: 'exec', at: 1000 }, 'one'), false);
  for (const value of [null, {}, { type: 'exec', sessionId: 'one' },
    { type: 'pause', sessionId: 'one', path: '/outside' },
    { type: 'speed', sessionId: 'one', charactersPerSecond: Infinity, pointerMultiplier: 1 },
    { type: 'viewport', sessionId: 'one', firstLine: -1 },
    { type: 'repository', sessionId: 'one', repositoryId: '' },
    { type: 'commits', sessionId: 'one', cursor: '--all' },
    { type: 'prepare', sessionId: 'one', repositoryId: 'repo-1', startOid: 'a'.repeat(40), endOid: 'b'.repeat(40), timing: { mode: 'speed', charactersPerSecond: NaN, pointerMultiplier: 1 } }]) assert.equal(validCommand(value, 'one'), false);
});
