const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const planner = require('../dist/plan.js');
const gitReader = require('../dist/git.js');
const { createStore, pathKey } = require('../dist/store.js');
const { createReplay } = require('../dist/replay.js');

test('preparation streams inclusive commits and exact edits with snapshot fallback', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'replay-plan-'));
  const repo = path.join(root, 'repo');
  await fs.mkdir(repo);
  const store = await createStore(path.join(root, 'storage'), 1024 * 1024);
  const session = store.root;
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', repo,
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false',
    ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-b', 'main');
    await fs.writeFile(path.join(repo, 'code.txt'), 'first\r\nkeep\r\nold');
    git('add', '.'); git('commit', '-m', 'create'); const first = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'code.txt'), 'new🙂\r\nkeep\r\nlast');
    await fs.writeFile(path.join(repo, 'binary'), Buffer.from([0, 255, 1]));
    await fs.writeFile(path.join(repo, 'wide.txt'), 'x'.repeat(9000));
    git('add', '.'); git('commit', '-m', 'edit');
    git('mv', 'code.txt', 'new.txt'); git('commit', '-m', 'rename');
    git('commit', '--allow-empty', '-m', 'empty'); const last = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'new.txt'), 'dirty');
    const before = git('status', '--porcelain=v1');
    const plan = await planner.preparePlan(repo, first, last,
      { mode: 'duration', durationMs: 21600000 }, session, new AbortController().signal);
    assert.equal(plan.baseOid, null);
    const entries = [];
    for await (const entry of planner.readRecords(plan, 0, new AbortController().signal)) entries.push(entry);
    assert.equal(entries.length, 7);
    assert.equal(entries[0].record.change.commitOid, first);
    assert.equal(entries.at(-1).record.kind, 'milestone');
    assert.equal(entries.filter(e => e.record.kind === 'snapshot').length, 2);
    const edit = entries.find(e => e.record.kind === 'text' && e.record.edits.length === 2);
    assert.ok(edit, 'separated changed lines are distinct hunks');
    let next = 0;
    for (const entry of entries) { assert.equal(entry.offset, next); next = entry.nextOffset; }
    const resumed = [];
    for await (const entry of planner.readRecords(plan, entries[2].offset, new AbortController().signal)) resumed.push(entry);
    assert.equal(resumed.length, entries.length - 2);
    await store.refreshUsage();
    let now = 0, timer, failure;
    const clock = { now: () => now, wallNow: () => now, schedule: (callback, delay) => { timer = { callback, delay }; return 1; }, cancel: () => { timer = undefined; } };
    const replay = createReplay(plan, clock, { frame() {}, progress() {}, error: message => failure = message,
      save: (record, signal) => store.save(record, repo, signal), checkpoint: value => store.checkpoint(value) });
    replay.setVisible(false); await replay.start();
    let ticks = 0;
    while (timer && ticks++ < 30000) { const pending = timer; timer = undefined; now += pending.delay; await pending.callback(); }
    assert.equal(failure, undefined); assert.equal(replay.getState().status, 'complete');
    assert.deepEqual(await store.verify(plan), { files: 3, bytes: 9000 + 3 + Buffer.byteLength('new🙂\r\nkeep\r\nlast') });
    assert.deepEqual(await fs.readFile(path.join(session, pathKey(Buffer.from('new.txt').toString('base64')) + '.data')), Buffer.from('new🙂\r\nkeep\r\nlast'));
    await replay.dispose();
    const singleRoot = path.join(root, 'single'); await fs.mkdir(singleRoot);
    await fs.writeFile(path.join(singleRoot, 'plan.jsonl'), JSON.stringify(entries[0].record) + '\n');
    let finalFrame;
    const single = createReplay({ ...plan, root: singleRoot, timing: { mode: 'speed', charactersPerSecond: 24, pointerMultiplier: 1 } }, clock,
      { frame: value => finalFrame = value, progress() {}, error: message => assert.fail(message), save: async () => {}, checkpoint: async value => { if (value.status === 'complete') now += 200; } });
    await single.start();
    while (timer) { const pending = timer; timer = undefined; now += pending.delay; await pending.callback(); }
    assert.deepEqual(finalFrame.lines, ['first', 'keep', 'old']);
    await single.dispose();
    assert.equal(git('rev-parse', 'HEAD'), last);
    assert.equal(git('status', '--porcelain=v1'), before);
    assert.equal(await fs.readFile(path.join(repo, 'new.txt'), 'utf8'), 'dirty');
  } finally {
    await gitReader.disposeGit?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});
