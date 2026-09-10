const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStore, openStore, pathKey } = require('../dist/store.js');
const gitReader = require('../dist/git.js');
const fixtures = [];
test.afterEach(async () => { await gitReader.disposeGit(); for (const base of fixtures.splice(0)) await rm(base, { recursive: true, force: true }); });

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const record = (pathName, oldOid, newOid, oldMode = '100644', newMode = '100644') => ({
  ordinal: 0, kind: 'snapshot', edits: [], phases: [], weight: 1, reason: null,
  change: { commitOid: newOid || oldOid, pathBase64: Buffer.from(pathName).toString('base64'), oldOid, newOid, oldMode, newMode },
});

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), 'store-test-'));
  fixtures.push(base);
  const repo = path.join(base, 'repo'), storage = path.join(base, 'storage');
  await mkdir(repo); await mkdir(storage);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'test@example.com'); git(repo, 'config', 'user.name', 'Test');
  return { base, repo, storage };
}

test('scratch keys preserve raw path identity without using repository paths', () => {
  const names = ['../outside', 'A.ts', 'a.ts', 'x\ny', '.git/config', 'CON'];
  const keys = names.map(name => pathKey(Buffer.from(name).toString('base64')));
  assert.equal(new Set(keys).size, names.length);
  for (const key of keys) assert.match(key, /^[a-f0-9]{64}$/);
});

test('store preserves exact Git bytes and records inert special files', async () => {
  const { repo, storage } = await fixture();
  const bytes = Buffer.from([0, 13, 10, 255, 65]);
  await writeFile(path.join(repo, 'raw.bin'), bytes); git(repo, 'add', 'raw.bin'); git(repo, 'commit', '-qm', 'raw');
  const oid = git(repo, 'rev-parse', 'HEAD:raw.bin');
  const store = await createStore(storage, 1024 * 1024);
  await store.save(record('raw.bin', null, oid), repo, new AbortController().signal);
  const key = pathKey(Buffer.from('raw.bin').toString('base64'));
  assert.deepEqual(await readFile(path.join(store.root, `${key}.data`)), bytes);
  await store.save(record('raw.bin', oid, oid, '100644', '100755'), repo, new AbortController().signal);
  assert.equal(JSON.parse(await readFile(path.join(store.root, `${key}.json`), 'utf8')).mode, '100755');
  await store.save(record('link', null, oid, '000000', '120000'), repo, new AbortController().signal);
  assert.equal((await lstat(path.join(store.root, `${pathKey(Buffer.from('link').toString('base64'))}.data`))).isSymbolicLink(), false);
  await store.save(record('module', null, oid, '000000', '160000'), repo, new AbortController().signal);
  assert.equal((await readdir(store.root)).some(name => name === `${pathKey(Buffer.from('module').toString('base64'))}.data`), false);
  assert.deepEqual(await store.verify(), { files: 2, bytes: bytes.length * 2 });
});

test('quota failure preserves the prior durable version and source worktree', async () => {
  const { repo, storage } = await fixture();
  await writeFile(path.join(repo, 'same'), 'old'); git(repo, 'add', 'same'); git(repo, 'commit', '-qm', 'old');
  const oldOid = git(repo, 'rev-parse', 'HEAD:same');
  await writeFile(path.join(repo, 'same'), Buffer.alloc(8192, 7)); git(repo, 'add', 'same'); git(repo, 'commit', '-qm', 'new');
  const newOid = git(repo, 'rev-parse', 'HEAD:same');
  const before = { head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, 'status', '--porcelain=v1') };
  const store = await createStore(storage, 4096);
  await store.save(record('same', null, oldOid), repo, new AbortController().signal);
  await assert.rejects(store.save(record('same', oldOid, newOid), repo, new AbortController().signal), /quota/i);
  const key = pathKey(Buffer.from('same').toString('base64'));
  assert.deepEqual(await readFile(path.join(store.root, `${key}.data`)), Buffer.from('old'));
  assert.deepEqual({ head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, 'status', '--porcelain=v1') }, before);
});

test('checkpoint recovery, reset, deletion and cleanup stay inside an owned session', async () => {
  const { repo, storage } = await fixture();
  await writeFile(path.join(repo, 'gone'), 'value\r\n'); git(repo, 'add', 'gone'); git(repo, 'commit', '-qm', 'one');
  const oid = git(repo, 'rev-parse', 'HEAD:gone');
  const store = await createStore(storage, 1024 * 1024);
  await store.save(record('gone', null, oid), repo, new AbortController().signal);
  const checkpoint = { version: 1, planId: path.basename(store.root), completedOffset: 12, pausedPosition: null, timing: { mode: 'speed', charactersPerSecond: 2, pointerMultiplier: 1 }, status: 'paused' };
  await store.checkpoint(checkpoint);
  const reopened = await openStore(storage, store.root, 1024 * 1024);
  assert.deepEqual(await reopened.readCheckpoint(), checkpoint);
  await reopened.save(record('gone', oid, null, '100644', '000000'), repo, new AbortController().signal);
  assert.deepEqual(await reopened.verify(), { files: 0, bytes: 0 });
  await writeFile(path.join(store.root, 'plan.jsonl'), '{}\n');
  await reopened.refreshUsage(); await reopened.reset();
  assert.equal(await readFile(path.join(store.root, 'plan.jsonl'), 'utf8'), '{}\n');
  assert.equal(await reopened.readCheckpoint(), null);
  await assert.rejects(openStore(storage, repo, 1000), /owned|session|storage/i);
  await reopened.clear();
  assert.equal((await readdir(storage)).includes(path.basename(store.root)), false);
});

test('open and clear reject symlinks inside an owned session', async () => {
  const { storage } = await fixture();
  const store = await createStore(storage, 10000);
  await require('node:fs/promises').symlink(storage, path.join(store.root, 'bad'));
  await assert.rejects(openStore(storage, store.root, 10000), /symbolic link/i);
  await assert.rejects(store.clear(), /symbolic link/i);
});

test('an aborted save leaves no temporary file', async () => {
  const { repo, storage } = await fixture();
  await writeFile(path.join(repo, 'cancelled'), 'never written'); git(repo, 'add', 'cancelled'); git(repo, 'commit', '-qm', 'cancelled');
  const oid = git(repo, 'rev-parse', 'HEAD:cancelled'), store = await createStore(storage, 10000), controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(store.save(record('cancelled', null, oid), repo, controller.signal), /stop/);
  assert.equal((await readdir(store.root)).some(name => name.startsWith('.tmp-')), false);
});

test('replay repairs an interruption after data rename without advancing checkpoint', async () => {
  const { repo, storage } = await fixture();
  await writeFile(path.join(repo, 'recover'), 'old'); git(repo, 'add', 'recover'); git(repo, 'commit', '-qm', 'old');
  const oldOid = git(repo, 'rev-parse', 'HEAD:recover');
  await writeFile(path.join(repo, 'recover'), 'new\r\n'); git(repo, 'add', 'recover'); git(repo, 'commit', '-qm', 'new');
  const newOid = git(repo, 'rev-parse', 'HEAD:recover'), encoded = Buffer.from('recover').toString('base64'), key = pathKey(encoded);
  const store = await createStore(storage, 10000);
  await store.save(record('recover', null, oldOid), repo, new AbortController().signal);
  const checkpoint = { version: 1, planId: path.basename(store.root), completedOffset: 3, pausedPosition: null, timing: { mode: 'speed', charactersPerSecond: 2, pointerMultiplier: 1 }, status: 'paused' };
  await store.checkpoint(checkpoint);
  await writeFile(path.join(store.root, `${key}.data`), Buffer.from('new\r\n')); // crash point: data renamed, old metadata/checkpoint remain
  const reopened = await openStore(storage, store.root, 10000);
  assert.deepEqual(await reopened.readCheckpoint(), checkpoint);
  await reopened.save(record('recover', oldOid, newOid), repo, new AbortController().signal);
  assert.deepEqual(await reopened.verify(), { files: 1, bytes: 5 });
  assert.deepEqual(await readFile(path.join(store.root, `${key}.data`)), Buffer.from('new\r\n'));
});

test('deleting an empty blob removes its data file', async () => {
  const { repo, storage } = await fixture();
  await writeFile(path.join(repo, 'empty'), ''); git(repo, 'add', 'empty'); git(repo, 'commit', '-qm', 'empty');
  const oid = git(repo, 'rev-parse', 'HEAD:empty'), encoded = Buffer.from('empty').toString('base64');
  const store = await createStore(storage, 10000);
  await store.save(record('empty', null, oid), repo, new AbortController().signal);
  await store.save(record('empty', oid, null, '100644', '000000'), repo, new AbortController().signal);
  assert.equal((await readdir(store.root)).includes(`${pathKey(encoded)}.data`), false);
});

test('verification rejects orphan bytes and missing expected output', async () => {
  const { storage } = await fixture();
  const store = await createStore(storage, 10000);
  const orphan = path.join(store.root, 'a'.repeat(64) + '.data');
  await writeFile(orphan, 'orphan');
  await assert.rejects(store.verify(), /metadata|orphan/i);
  await rm(orphan);
  const expected = record('missing', null, 'b'.repeat(40));
  expected.phases = [{ kind: 'save', units: 0, minimumMs: 0, preferredMs: 0, target: 'file', editIndex: null }];
  await writeFile(path.join(store.root, 'plan.jsonl'), JSON.stringify(expected) + '\n');
  await assert.rejects(store.verify({ root: store.root }), /missing|ENOENT/i);
});
