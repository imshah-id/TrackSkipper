const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const vm = require('node:vm');

test('native safety guard rejects stale, unarmed, moved, busy, and unknown requests', () => {
  const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), [path.join(__dirname, 'native_input_test.py')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
});

test('input transport has no queued events and closes the helper on stop or errors', () => {
  let child;
  const writes = [], statuses = [], calls = [];
  const exports = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, '../dist/input.js'), 'utf8'), {
    exports, Date, setTimeout, clearTimeout,
    require: () => ({ spawn: (...args) => {
      calls.push(args);
      child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin.write = line => writes.push(JSON.parse(line));
      child.stdin.end = () => { child.closed = true; queueMicrotask(() => child.emit('exit', 0)); };
      child.kill = () => {};
      return child;
    } }),
  });
  const input = exports.createNativeInput('/extension/native/input.py', '/python', status => statuses.push(status));
  input.start();
  assert.equal(calls[0][2].shell, false);
  input.pulse('click', Date.now()); assert.equal(writes.length, 0, 'startup never queues input');
  child.stdout.emit('data', '{"status":"ready"}\n');
  input.pulse('click', Date.now());
  assert.equal(writes[0].op, 'arm');
  input.pulse('click', Date.now()); assert.equal(writes.length, 1);
  child.stdout.emit('data', '{"status":"armed"}\n');
  input.pulse('wait', Date.now()); assert.equal(writes.length, 1, 'idle phases emit no events');
  input.pulse('type', Date.now()); assert.equal(writes[1].kind, 'type');
  input.stop(); assert.equal(child.closed, true);
  child.stdout.emit('data', '{"status":"armed"}\n');
  input.pulse('click', Date.now()); assert.equal(writes.length, 2, 'late replies cannot restart input');
  input.start(); child.stdout.emit('data', '{"error":"Permission denied"}\n');
  assert.equal(statuses.at(-1), 'Permission denied');
  assert.equal(child.closed, true);
});
