const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

let reader;
try { reader = require('../dist/git.js'); } catch { reader = {}; }

async function fixture() {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-replay-test-'));
  const git = (...args) => execFileSync('git', ['-C', repo,
    '-c', 'user.name=Replay Test', '-c', 'user.email=replay@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'master');
  await fs.writeFile(path.join(repo, 'code.txt'), 'first\n');
  git('add', '.'); git('commit', '-m', 'first');
  const first = git('rev-parse', 'HEAD');
  await fs.writeFile(path.join(repo, 'code.txt'), 'second\n');
  git('add', '.'); git('commit', '-m', 'second');
  const second = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'empty');
  const empty = git('rev-parse', 'HEAD');
  return { repo, git, first, second, empty };
}

test.afterEach(async () => reader.disposeGit?.());

test('large signed headers retain the subject and queued blob reads cancel promptly', async () => {
  const f = await fixture();
  let iterator;
  try {
    const tree = f.git('rev-parse', 'HEAD^{tree}');
    const raw = `tree ${tree}\nparent ${f.first}\nauthor Test <t@example.invalid> 0 +0000\ncommitter Test <t@example.invalid> 0 +0000\ngpgsig ${'x'.repeat(6000)}\n\nVisible subject\n`;
    const oid = execFileSync('git', ['-C', f.repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: raw, encoding: 'utf8' }).trim();
    assert.equal((await reader.readCommit(f.repo, oid, AbortSignal.timeout(5000))).subject, 'Visible subject');
    const blob = f.git('rev-parse', 'HEAD:code.txt');
    iterator = reader.readBlob(f.repo, blob, AbortSignal.timeout(5000));
    await iterator.next();
    const abort = new AbortController();
    const queued = reader.objectInfo(f.repo, blob, abort.signal);
    abort.abort(new Error('Cancelled queued operation'));
    await Promise.race([assert.rejects(queued, /cancel/i), new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('Queued cancellation did not settle')), 1000); timeout.unref();
    })]);
  } finally { await iterator?.return(); await reader.disposeGit(); await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('range includes start, empty commit, and preserves source state', async () => {
  assert.equal(typeof reader.readRange, 'function');
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.repo, 'code.txt'), 'uncommitted\n');
    const status = f.git('status', '--porcelain=v1');
    const index = await fs.readFile(path.join(f.repo, '.git', 'index'));
    const commits = [];
    for await (const commit of reader.readRange(f.repo, f.first, f.empty, AbortSignal.timeout(5000))) commits.push(commit);
    assert.deepEqual(commits.map(c => c.oid), [f.empty, f.second, f.first]);
    assert.equal(commits[2].parentOid, null);
    assert.equal(commits[0].subject, 'empty');
    assert.equal(f.git('rev-parse', 'HEAD'), f.empty);
    assert.equal(f.git('status', '--porcelain=v1'), status);
    assert.deepEqual(await fs.readFile(path.join(f.repo, '.git', 'index')), index);
    assert.equal(await fs.readFile(path.join(f.repo, 'code.txt'), 'utf8'), 'uncommitted\n');
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('rejects a start outside the pinned first-parent chain', async () => {
  const f = await fixture();
  try {
    f.git('checkout', '-b', 'side', f.first);
    await fs.writeFile(path.join(f.repo, 'side.txt'), 'side\n');
    f.git('add', '.'); f.git('commit', '-m', 'side');
    const side = f.git('rev-parse', 'HEAD');
    await assert.rejects(async () => { for await (const _ of reader.readRange(f.repo, side, f.empty, AbortSignal.timeout(5000))) {} }, /first-parent/i);
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('raw changes and blobs preserve bytes', async () => {
  const f = await fixture();
  try {
    const changes = [];
    for await (const change of reader.readChanges(f.repo, f.first, f.second, AbortSignal.timeout(5000))) changes.push(change);
    assert.equal(changes.length, 1);
    assert.equal(Buffer.from(changes[0].pathBase64, 'base64').toString(), 'code.txt');
    const expected = Buffer.from([0, 10, 255, 65]);
    await fs.writeFile(path.join(f.repo, 'binary.dat'), expected);
    f.git('add', '.'); f.git('commit', '-m', 'binary');
    const oid = f.git('rev-parse', 'HEAD:binary.dat');
    const chunks = [];
    for await (const chunk of reader.readBlob(f.repo, oid, AbortSignal.timeout(5000))) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.deepEqual(await reader.objectInfo(f.repo, oid, AbortSignal.timeout(5000)), { type: 'blob', size: expected.length });
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('commit page contains at most 100 first-parent entries', async () => {
  const f = await fixture();
  try {
    const page = await reader.commitPage(f.repo, f.empty, AbortSignal.timeout(5000));
    assert.deepEqual(page.map(c => c.oid), [f.empty, f.second, f.first]);
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('merge appears once and uses its first parent baseline', async () => {
  const f = await fixture();
  try {
    f.git('checkout', '-b', 'topic', f.second);
    await fs.writeFile(path.join(f.repo, 'topic.txt'), 'topic\n');
    f.git('add', '.'); f.git('commit', '-m', 'topic');
    f.git('checkout', 'master');
    await fs.writeFile(path.join(f.repo, 'main.txt'), 'main\n');
    f.git('add', '.'); f.git('commit', '-m', 'main');
    const main = f.git('rev-parse', 'HEAD');
    f.git('merge', '--no-ff', 'topic', '-m', 'merge');
    const merge = f.git('rev-parse', 'HEAD');
    const commits = [];
    for await (const commit of reader.readRange(f.repo, f.second, merge, AbortSignal.timeout(5000))) commits.push(commit);
    assert.deepEqual(commits.map(c => c.oid), [merge, main, f.empty, f.second]);
    const changes = [];
    for await (const change of reader.readChanges(f.repo, main, merge, AbortSignal.timeout(5000))) changes.push(change);
    assert.deepEqual(changes.map(c => Buffer.from(c.pathBase64, 'base64').toString()), ['topic.txt']);
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('parses zero-context hunk coordinates', async () => {
  const f = await fixture();
  try {
    const oldOid = f.git('rev-parse', `${f.first}:code.txt`);
    const newOid = f.git('rev-parse', `${f.second}:code.txt`);
    assert.deepEqual(await reader.hunkRanges(f.repo, oldOid, newOid, AbortSignal.timeout(5000)), [
      { oldLine: 1, oldCount: 1, newLine: 1, newCount: 1 },
    ]);
    assert.equal((await reader.readCommit(f.repo, f.empty, AbortSignal.timeout(5000))).subject, 'empty');
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});

test('replay tree includes unchanged files, change badges and deleted paths at the pinned commit', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.repo, 'nested'));
    await fs.writeFile(path.join(f.repo, 'nested', 'odd\tname\n.txt'), 'unchanged\n');
    await fs.writeFile(path.join(f.repo, 'gone.txt'), 'old\n');
    await fs.symlink('code.txt', path.join(f.repo, 'link'));
    f.git('add', '.'); f.git('commit', '-m', 'baseline');
    await fs.unlink(path.join(f.repo, 'gone.txt'));
    await fs.writeFile(path.join(f.repo, 'code.txt'), 'third\n');
    await fs.writeFile(path.join(f.repo, 'new.bin'), Buffer.from([0, 255]));
    f.git('add', '.'); f.git('commit', '-m', 'changes');
    const commit = f.git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(f.repo, 'future.txt'), 'not in replay\n');
    f.git('add', '.'); f.git('commit', '-m', 'future');
    const files = await reader.readTree(f.repo, commit, AbortSignal.timeout(5000));
    const byPath = new Map(files.map(file => [Buffer.from(file.pathBase64, 'base64').toString(), file]));
    assert.equal(byPath.size, 5);
    assert.equal(byPath.get('code.txt').change, 'M');
    assert.equal(byPath.get('nested/odd\tname\n.txt').change, '');
    assert.equal(byPath.get('new.bin').change, 'A');
    assert.equal(byPath.get('gone.txt').change, 'D');
    assert.equal(byPath.get('link').mode, '120000');
    assert.equal(byPath.get('code.txt').oid, f.git('rev-parse', `${commit}:code.txt`));
    assert.equal(byPath.has('future.txt'), false);
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { await fs.rm(f.repo, { recursive: true, force: true }); }
});
