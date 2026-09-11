const test = require('node:test');
const assert = require('node:assert/strict');
const { phaseDuration, extraWait, validateTiming } = require('../dist/timing.js');
const { createTextView, frameAt } = require('../dist/replay.js');
const replayModule = require('../dist/replay.js');

test('backspace removes whole graphemes from the end, resumes exactly, and typing has pauses', async () => {
  const oldText = 'head\r\nab👩‍💻e\u0301\r\ntail', newText = 'head\r\ncall();\nnext\r\ntail';
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const edit = { oldStart: 6, oldEnd: oldText.indexOf('tail'), newStart: 6, newEnd: newText.indexOf('tail') };
  const removed = [...segmenter.segment(oldText.slice(edit.oldStart, edit.oldEnd))].map(item => item.segment);
  edit.deleteUnits = removed.length; edit.insertUnits = [...segmenter.segment(newText.slice(edit.newStart, edit.newEnd))].length;
  const phases = ['move', 'click', 'delete', 'type', 'save'].map(kind => ({ kind, target: 'code', editIndex: kind === 'save' ? null : 0, units: kind === 'delete' ? edit.deleteUnits : kind === 'type' ? edit.insertUnits : 0, preferredMs: ['move', 'click'].includes(kind) ? 300 : 0, minimumMs: 0 }));
  const record = { kind: 'text', ordinal: 0, edits: [edit], phases, weight: 1, change: { oldOid: 'old', newOid: 'new' } };
  const exports = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../dist/replay.js'), 'utf8'), {
    exports, Buffer, performance, setTimeout, clearTimeout, AbortController,
    require: name => name === './plan' ? { textBlob: async (_, oid) => oid === 'old' ? oldText : newText,
      readRecords: async function* (_, offset) { if (!offset) yield { record, offset: 0, nextOffset: 1 }; } } : require(require('node:path').resolve(__dirname, '../dist', name)),
  });
  let now = 0, timer, latest, checkpoint, saved = 0;
  const clock = { now: () => now, wallNow: () => now, schedule: (callback, delay) => { timer = { callback, delay }; return 1; }, cancel: () => { timer = undefined; } };
  const typingTimes = [], deletionFrames = [];
  const events = { frame: (frame, phase) => {
    latest = structuredClone(frame);
    if (phase.kind === 'delete' && JSON.stringify(latest) !== JSON.stringify(deletionFrames.at(-1))) deletionFrames.push(latest);
    if (phase.kind === 'type' && latest.lines.join('\n') !== typingTimes.at(-1)?.text) typingTimes.push({ at: now, text: latest.lines.join('\n') });
  }, progress() {}, save: async () => saved++, checkpoint: async value => { checkpoint = structuredClone(value); }, error: message => assert.fail(message) };
  const plan = { version: 1, id: 'typing', repo: '/fixture', timing: { mode: 'speed', charactersPerSecond: 2, pointerMultiplier: 1 }, totals: { minimumMs: 0, preferredMs: 20000, weight: 1, records: 1 } };
  let replay = exports.createReplay(plan, clock, events);
  const step = async () => { const pending = timer; timer = undefined; now += pending.delay; await pending.callback(); };
  try {
    await replay.start();
    assert.deepEqual(latest.caret, { row: 2, column: 0 }, 'click starts at the end of the text to remove');
    while (deletionFrames.length < 3) await step();
    await replay.pause(); const pausedFrame = structuredClone(latest);
    await replay.dispose(); replay = exports.createReplay(plan, clock, events); await replay.start(checkpoint);
    assert.deepEqual(latest, pausedFrame, 'recovery restores the same deletion frame');
    await replay.pause(); await replay.setSpeed(3, 1);
    assert.deepEqual(latest, pausedFrame, 'speed changes preserve the edit position'); replay.resume();
    while (timer) await step();
    const expected = new Set(Array.from({ length: removed.length + 1 }, (_, count) => ['head', ...removed.slice(0, count).join('').concat('tail').split('\n').map(line => line.replace(/\r$/, ''))].join('\n')));
    for (const frame of deletionFrames) assert.ok(expected.has(frame.lines.join('\n')), 'backspacing preserves the prefix and untouched tail, including emoji and CRLF');
    const intervals = typingTimes.slice(1).map((item, index) => Math.round(item.at - typingTimes[index].at));
    assert.ok(new Set(intervals).size > 1, 'typing cadence is not uniform');
    assert.deepEqual(latest.lines, ['head', 'call();', 'next', 'tail']); assert.equal(saved, 1);
    assert.equal(replay.getState().status, 'complete');
  } finally { await replay.dispose(); }
});

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

test('following keeps nearby lines still, adapts to the viewport, and respects manual scrolling', async () => {
  const text = Array.from({ length: 240 }, (_, i) => `line ${i}`).join('\n');
  const phases = [10, 11, 12, 160, 160, 5, 5].map((editIndex, index) => ({ kind: [3, 5].includes(index) ? 'scroll' : 'hover', target: 'code', editIndex, units: 0, minimumMs: 0, preferredMs: 1000 }));
  const edits = Array.from({ length: 240 }, (_, line) => {
    const start = text.indexOf(`line ${line}`);
    return { oldStart: start, oldEnd: start, newStart: start, newEnd: start, deleteUnits: 0, insertUnits: 0 };
  });
  const record = { kind: 'text', change: { oldOid: 'old', newOid: 'new' }, edits, phases, weight: 1 };
  const exported = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../dist/replay.js'), 'utf8'), {
    exports: exported, Buffer, performance, setTimeout, clearTimeout, AbortController,
    require: name => name === './plan' ? { textBlob: async () => text, readRecords: async function* () { yield { record, offset: 0, nextOffset: 1 }; } }
      : require(require('node:path').resolve(__dirname, '../dist', name)),
  });
  let now = 0, timer, frame;
  const controller = exported.createReplay({ timing: { mode: 'speed', charactersPerSecond: 24, pointerMultiplier: 1 }, totals: { minimumMs: 0, preferredMs: 4000, weight: 1, records: 1 } },
    { now: () => now, wallNow: () => now, schedule: (callback, delay) => { timer = { callback, delay }; }, cancel() {} },
    { frame: value => frame = value, progress() {}, save: async () => {}, checkpoint: async () => {}, error: message => assert.fail(message) });
  try {
    await controller.start();
    const step = async () => { now += timer.delay; await timer.callback(); };
    const visibleLine = () => frame.viewportLine ?? frame.firstLine;
    const caretRow = () => frame.firstLine + frame.caret.row - visibleLine();
    const firstLine = visibleLine();
    for (let i = 0; i < 2; i++) { await step(); assert.equal(visibleLine(), firstLine); }
    await step();
    assert.equal(visibleLine(), firstLine, 'entering a scroll phase does not teleport to the next edit');
    await step(); const intermediate = visibleLine();
    assert.ok(intermediate > firstLine && intermediate < 150, 'scrolling passes through the intervening code');
    await step(); assert.ok(visibleLine() > intermediate && visibleLine() < 150);
    await step(); assert.equal(visibleLine(), 150, 'the edit is in view before pointer movement and typing');
    assert.ok(frame.lines.length <= 120, 'scroll buffering remains bounded');
    controller.setViewportRows(8);
    assert.ok(caretRow() >= 0 && caretRow() < 8, 'the caret fits in a short editor');
    controller.setViewport(0); controller.setViewportRows(12);
    assert.equal(frame.firstLine, 0, 'resizing respects a manually chosen viewport');
    controller.follow();
    assert.ok(caretRow() >= 0 && caretRow() < 12);
    const distantViewport = visibleLine();
    await step(); await step();
    assert.ok(visibleLine() < distantViewport && visibleLine() > 1, 'upward scrolling also moves progressively');
    controller.setViewport(30); await step();
    assert.equal(visibleLine(), 30, 'manual scrolling holds even during an automatic scroll phase');
    await step(); controller.follow();
    assert.ok(caretRow() >= 0 && caretRow() < 12);
    const finalViewport = visibleLine();
    await step();
    assert.equal(visibleLine(), finalViewport, 'completion does not jump to the end of the file');
  } finally { await controller.dispose(); }
});

test('typing keeps its current line in a short viewport after manual scrolling and resume', async () => {
  const text = 'x\n'.repeat(180);
  const record = { kind: 'text', change: { oldOid: null, newOid: 'new' }, weight: 1,
    edits: [{ oldStart: 0, oldEnd: 0, newStart: 0, newEnd: text.length, deleteUnits: 0, insertUnits: text.length }],
    phases: [{ kind: 'type', target: 'code', editIndex: 0, units: text.length, minimumMs: 0, preferredMs: 1800 },
      { kind: 'save', target: 'file', editIndex: null, units: 0, minimumMs: 0, preferredMs: 0 }] };
  const exported = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(require.resolve('../dist/replay.js'), 'utf8'), {
    exports: exported, Buffer, performance, setTimeout, clearTimeout, AbortController,
    require: name => name === './plan' ? { textBlob: async (_, oid) => oid ? text : '', readRecords: async function* () { yield { record, offset: 0, nextOffset: 1 }; } }
      : require(require('node:path').resolve(__dirname, '../dist', name)),
  });
  let now = 0, timer, frame;
  const replay = exported.createReplay({ timing: { mode: 'speed', charactersPerSecond: 200, pointerMultiplier: 1 }, totals: { minimumMs: 0, preferredMs: 1800, weight: 1, records: 1 } },
    { now: () => now, wallNow: () => now, schedule: (callback, delay) => { timer = { callback, delay }; }, cancel() { timer = undefined; } },
    { frame: value => frame = value, progress() {}, save: async () => {}, checkpoint: async () => {}, error: message => assert.fail(message) });
  const assertVisible = () => {
    assert.ok(frame.caret, 'the current line is in the rendered buffer');
    const row = frame.firstLine + frame.caret.row - frame.viewportLine;
    assert.ok(row >= 0 && row < 5, `caret row ${row} must fit in the five-line editor at ${now}ms (${replay.getState().status}, viewport ${frame.viewportLine})`);
  };
  try {
    replay.setViewportRows(5); await replay.start();
    for (let step = 0; timer; step++) {
      const pending = timer; timer = undefined; now += pending.delay; await pending.callback();
      assertVisible();
      if (step === 5) {
        replay.setViewport(0); assertVisible();
        await replay.pause(); replay.setViewport(0);
        assert.equal(frame.firstLine, 0, 'paused browsing stays where the user scrolled');
        assert.equal(frame.viewportLine, undefined);
        replay.resume(); assertVisible();
      }
    }
    assert.equal(replay.getState().status, 'complete');
  } finally { await replay.dispose(); }
});
