const test = require('node:test');
const assert = require('node:assert/strict');
const { phaseDuration, extraWait, validateTiming } = require('../dist/timing.js');
const { createTextView, frameAt } = require('../dist/replay.js');
const replayModule = require('../dist/replay.js');

test('duration allocation completes every phase within the requested active time', () => {
  const phases = [
    { kind: 'move', units: 0, minimumMs: 100, preferredMs: 300, target: 'file', editIndex: null },
    { kind: 'type', units: 24, minimumMs: 100, preferredMs: 1000, target: 'code', editIndex: 0 },
  ];
  const totals = { minimumMs: 200, preferredMs: 1300, weight: 24, records: 1 };
  for (const durationMs of [200, 800, 1300, 21600000]) {
    const timing = { mode: 'duration', durationMs };
    const actual = phases.reduce((n, p) => n + phaseDuration(p, totals, timing), 0) + extraWait(24, totals, timing);
    assert.ok(Math.abs(actual - durationMs) < 0.001);
  }
  assert.throws(() => phaseDuration(phases[0], totals, { mode: 'duration', durationMs: 199 }), /minimum/i);
  assert.equal(extraWait(1, { minimumMs: 100, preferredMs: 100, weight: 1, records: 1 }, { mode: 'duration', durationMs: 200 }), 100);
  for (const durationMs of [NaN, Infinity, -1, 0]) assert.throws(() => validateTiming({ mode: 'duration', durationMs }));
  for (const charactersPerSecond of [0, 201, NaN]) assert.throws(() => validateTiming({ mode: 'speed', charactersPerSecond, pointerMultiplier: 1 }));
});

test('controller freezes pauses, survives hidden view and completes virtual six hours', async () => {
  assert.equal(typeof replayModule.createReplay, 'function');
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-clock-'));
  let now = 0, handle = 0, saved = 0, frameCount = 0, latest, lastCheckpoint;
  const queue = new Map();
  const clock = { now: () => now, wallNow: () => now,
    schedule: (callback, delay) => { const id = ++handle; queue.set(id, { callback, due: now + delay }); return id; },
    cancel: id => queue.delete(id) };
  const step = async (lateMs = 0) => {
    const [id, item] = [...queue].sort((a, b) => a[1].due - b[1].due)[0];
    queue.delete(id); now = item.due + lateMs; await item.callback();
  };
  const record = { ordinal: 0, kind: 'snapshot', edits: [], weight: 1, reason: 'snapshot',
    change: { commitOid: 'a'.repeat(40), pathBase64: 'eA==', oldOid: null, newOid: null, oldMode: '000000', newMode: '000000' },
    phases: [{ kind: 'wait', units: 0, minimumMs: 100, preferredMs: 100, target: 'file', editIndex: null },
      { kind: 'save', units: 0, minimumMs: 0, preferredMs: 0, target: 'file', editIndex: null }] };
  const plan = { version: 1, id: 'test', root, repo: root, startOid: 'a'.repeat(40), endOid: 'a'.repeat(40), baseOid: null,
    recordsPath: path.join(root, 'plan.jsonl'), timing: { mode: 'duration', durationMs: 21600000 },
    totals: { minimumMs: 100, preferredMs: 100, weight: 1, records: 1 } };
  await fs.writeFile(plan.recordsPath, JSON.stringify(record) + '\n');
  const controller = replayModule.createReplay(plan, clock, {
    frame: () => frameCount++, progress: position => latest = { ...position },
    save: async () => saved++, checkpoint: async checkpoint => lastCheckpoint = checkpoint,
    error: message => assert.fail(message) });
  try {
    controller.setVisible(false); await controller.start(); await step();
    await controller.pause(); const frozen = latest.playbackElapsedMs;
    now += 3600000; assert.equal(queue.size, 0); assert.equal(latest.playbackElapsedMs, frozen);
    controller.resume(); await step(2500);
    assert.equal(controller.getState().status, 'paused');
    assert.equal(latest.playbackElapsedMs, frozen);
    controller.resume();
    let steps = 0;
    while (queue.size && steps++ < 25000) await step();
    assert.equal(saved, 1); assert.equal(lastCheckpoint.status, 'complete');
    assert.equal(frameCount, 0); assert.ok(Math.abs(latest.playbackElapsedMs - 21600000) < 0.01);
    assert.equal(queue.size, 0);
  } finally { await controller.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});

test('windowed text preserves joined lines, CRLF and Unicode through edits', () => {
  const oldText = 'head\r\nold\r\ntail';
  const newText = 'head\r\nnew🙂\r\ntail';
  const view = createTextView(oldText, newText);
  assert.deepEqual(frameAt(view, 6, 6, 0, 120).lines, ['head', 'old', 'tail']);
  assert.deepEqual(frameAt(view, 9, 8, 0, 120).lines, ['head', 'ne', 'tail']);
  assert.deepEqual(frameAt(view, oldText.length, newText.length, 0, 120).lines, ['head', 'new🙂', 'tail']);
  const many = createTextView('', 'x\n'.repeat(500));
  assert.equal(frameAt(many, 0, many.newText.length, 0, 500).lines.length, 120);
  const wide = createTextView('', '🙂'.repeat(100000));
  const frame = frameAt(wide, 0, wide.newText.length, 0, 120);
  assert.ok(Buffer.byteLength(frame.lines.join('')) <= 65536);
  assert.equal(frame.lines[0].length % 2, 0);
  // The expected document is an independent, small, complete-string oracle.
  for (const [before, after] of [['a\nb\nc', 'one\ntwo\nthree'], ['', 'a\n'], ['x', ''], ['a\r\nb', 'z\r\nc']]) {
    const model = createTextView(before, after);
    for (let a = 0; a <= before.length; a++) for (let b = 0; b <= after.length; b++) {
      const expected = (after.slice(0, b) + before.slice(a)).split('\n').map(line => line.replace(/\r$/, ''));
      assert.deepEqual(frameAt(model, a, b, 0, 120).lines, expected);
    }
  }
});

test('pause during a durable save recovers, and invalid checkpoints cannot skip saves', async () => {
  const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-recovery-'));
  const record = { ordinal: 0, kind: 'snapshot', edits: [], weight: 1, reason: 'snapshot',
    change: { commitOid: 'a'.repeat(40), pathBase64: 'eA==', oldOid: null, newOid: 'a'.repeat(40), oldMode: '000000', newMode: '100644' },
    phases: [{ kind: 'save', units: 0, minimumMs: 0, preferredMs: 0, target: 'file', editIndex: null }] };
  const plan = { version: 1, id: 'test', root, repo: root, timing: { mode: 'speed', charactersPerSecond: 24, pointerMultiplier: 1 },
    totals: { minimumMs: 0, preferredMs: 0, weight: 1, records: 1 } };
  const source = JSON.stringify(record) + '\n';
  assert.throws(() => replayModule.createReplay({ ...plan, totals: { ...plan.totals, preferredMs: null } }, {}, {}), /totals/);
  await fs.writeFile(path.join(root, 'plan.jsonl'), source);
  let callback, release, entered, checkpoint, saves = 0;
  const saving = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  const clock = { now: () => 0, wallNow: () => 0, schedule: fn => { callback = fn; return 1; }, cancel: () => {} };
  const events = { frame() {}, progress() {}, error() {}, checkpoint: async value => checkpoint = value,
    save: async () => { saves++; entered(); await gate; } };
  let controller = replayModule.createReplay(plan, clock, events);
  try {
    await controller.start(); const tick = callback(); await saving;
    const pause = controller.pause(); release(); await tick; await pause;
    assert.equal(checkpoint.completedOffset, Buffer.byteLength(source));
    assert.equal(checkpoint.pausedPosition, null);
    await controller.dispose();
    controller = replayModule.createReplay(plan, clock, events);
    await controller.start(checkpoint); assert.equal(saves, 1);
    for (const patch of [
      { pausedPosition: { recordOffset: 0, phaseIndex: 0.5, phaseElapsedMs: 0, playbackElapsedMs: 0 } },
      { completedOffset: 1 }, { completedOffset: Buffer.byteLength(source) + 1 },
      { pausedPosition: { recordOffset: 0, phaseIndex: 0, phaseElapsedMs: 1, playbackElapsedMs: 0 } },
    ]) {
      const bad = replayModule.createReplay(plan, clock, events);
      await assert.rejects(bad.start({ version: 1, planId: 'test', timing: plan.timing, status: 'paused', completedOffset: 0, pausedPosition: null, ...patch }));
      await bad.dispose();
    }
    const slower = { ...record, phases: [{ kind: 'move', units: 0, minimumMs: 100, preferredMs: 1000, target: 'file', editIndex: null }, ...record.phases] };
    await fs.writeFile(path.join(root, 'plan.jsonl'), JSON.stringify(slower) + '\n');
    const changed = replayModule.createReplay({ ...plan, totals: { ...plan.totals, preferredMs: 1000 } }, clock, events);
    await changed.start({ version: 1, planId: 'test', completedOffset: 0, pausedPosition: null, status: 'paused', timing: { mode: 'speed', charactersPerSecond: 24, pointerMultiplier: 2 } });
    assert.equal(changed.getState().totalMs, 175); await changed.dispose();
    await fs.writeFile(path.join(root, 'plan.jsonl'), JSON.stringify({ ...record, phases: [] }) + '\n');
    const bad = replayModule.createReplay(plan, clock, events);
    await assert.rejects(bad.start(), /record|phase|save/i); await bad.dispose();
  } finally { await controller.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
