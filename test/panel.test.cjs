const test = require('node:test');
const assert = require('node:assert/strict');
const { validCommand } = require('../dist/panel.js');
test('panel accepts only bounded controls for its own session', () => {
  assert.equal(validCommand({ type: 'pause', sessionId: 'one' }, 'one'), true);
  assert.equal(validCommand({ type: 'pause', sessionId: 'old' }, 'one'), false);
  assert.equal(validCommand({ type: 'speed', sessionId: 'one', charactersPerSecond: 24, pointerMultiplier: 1 }, 'one'), true);
  for (const value of [null, {}, { type: 'exec', sessionId: 'one' },
    { type: 'pause', sessionId: 'one', path: '/outside' },
    { type: 'speed', sessionId: 'one', charactersPerSecond: Infinity, pointerMultiplier: 1 },
    { type: 'viewport', sessionId: 'one', firstLine: -1 }]) assert.equal(validCommand(value, 'one'), false);
});
