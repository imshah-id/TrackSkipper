const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

assert.equal(typeof global.gc, 'function', 'run with node --expose-gc');

const originalSpawn = childProcess.spawn;
const measuredChildren = new Set();
let activeChildren = 0;
let peakChildren = 0;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  measuredChildren.add(child);
  activeChildren++;
  peakChildren = Math.max(peakChildren, activeChildren);
  child.once('close', () => { activeChildren--; measuredChildren.delete(child); });
  return child;
};

const planner = require('../dist/plan.js');
const gitReader = require('../dist/git.js');
const storeModule = require('../dist/store.js');
const DURATION_MS = 6 * 60 * 60 * 1000;
const FILE_BYTES = 256 * 1024;
const LINE_BYTES = 64;

function git(repo, args, input) {
  return childProcess.execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', input, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Benchmark', GIT_AUTHOR_EMAIL: 'benchmark@example.invalid',
      GIT_COMMITTER_NAME: 'Benchmark', GIT_COMMITTER_EMAIL: 'benchmark@example.invalid', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

async function fixture(parent, count) {
  const repo = path.join(parent, `repo-${count}`);
  await fsp.mkdir(repo);
  git(repo, ['init', '--quiet']);
  const content = Buffer.alloc(FILE_BYTES, 120);
  for (let offset = LINE_BYTES - 1; offset < content.length; offset += LINE_BYTES) content[offset] = 10;
  let commit = null;
  const started = performance.now();
  for (let index = 0; index < count; index++) {
    const line = index % (FILE_BYTES / LINE_BYTES);
    content.write(index.toString(16).padStart(12, '0'), line * LINE_BYTES, 12, 'ascii');
    const blob = git(repo, ['hash-object', '-w', '--stdin'], content);
    const tree = git(repo, ['mktree'], `100644 blob ${blob}\tbenchmark.txt\n`);
    commit = git(repo, ['commit-tree', tree, ...(commit ? ['-p', commit] : [])], `commit ${index}\n`);
    if (index === 0) var startOid = commit;
  }
  return { repo, startOid, endOid: commit, setupMs: performance.now() - started };
}

function directoryBytes(root) {
  return fsp.readdir(root, { withFileTypes: true }).then(async entries => {
    let bytes = 0;
    for (const entry of entries) {
      const file = path.join(root, entry.name);
      bytes += entry.isDirectory() ? await directoryBytes(file) : (await fsp.stat(file)).size;
    }
    return bytes;
  });
}

function openFds() {
  try { return fs.readdirSync('/dev/fd').length; } catch { return null; }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function sample(parent, fixtureInfo, sampleNumber) {
  await gitReader.disposeGit();
  global.gc();
  const storage = path.join(parent, `storage-${path.basename(fixtureInfo.repo)}-${sampleNumber}`);
  const store = await storeModule.createStore(storage, 1024 * 1024 * 1024);
  const before = process.memoryUsage();
  const fdsBefore = openFds();
  let peakRss = before.rss;
  let peakGitRssKiB = null;
  let peakFds = fdsBefore;
  peakChildren = activeChildren;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    const fds = openFds();
    if (fds !== null) peakFds = Math.max(peakFds ?? fds, fds);
    const pids = [...measuredChildren].map(child => child.pid).filter(Boolean);
    if (pids.length) {
      const values = pids.map(pid => childProcess.spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }))
        .filter(result => result.status === 0).map(result => Number(result.stdout.trim())).filter(Number.isFinite);
      if (values.length) peakGitRssKiB = Math.max(peakGitRssKiB ?? 0, values.reduce((sum, value) => sum + value, 0));
    }
  }, 250);
  const started = performance.now();
  try {
    const plan = await planner.preparePlan(fixtureInfo.repo, fixtureInfo.startOid, fixtureInfo.endOid,
      { mode: 'duration', durationMs: DURATION_MS }, store.root, new AbortController().signal);
    const preparationMs = performance.now() - started;
    clearInterval(sampler);
    await gitReader.disposeGit();
    global.gc();
    const after = process.memoryUsage();
    return {
      preparationMs, retainedHeapBytes: after.heapUsed - before.heapUsed,
      peakRssBytes: peakRss, peakRssDeltaBytes: peakRss - before.rss,
      gitPeakRssBytes: peakGitRssKiB === null ? null : peakGitRssKiB * 1024,
      peakGitChildren: peakChildren, openFdsBefore: fdsBefore, peakOpenFds: peakFds, openFdsAfter: openFds(),
      planBytes: await directoryBytes(store.root), records: plan.totals.records,
      animated: plan.summary.animated, snapshots: plan.summary.snapshots,
    };
  } finally {
    clearInterval(sampler);
    await gitReader.disposeGit();
    await store.clear().catch(() => undefined);
    await fsp.rm(storage, { recursive: true, force: true });
  }
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'trackskipper-benchmark-'));
  try {
    const results = [];
    for (const count of [100, 1000]) {
      const fixtureInfo = await fixture(root, count);
      const samples = [];
      for (let number = 1; number <= 3; number++) samples.push(await sample(root, fixtureInfo, number));
      const numericKeys = Object.keys(samples[0]).filter(key => typeof samples[0][key] === 'number');
      results.push({ commits: count, setupMs: fixtureInfo.setupMs, samples,
        median: Object.fromEntries(numericKeys.map(key => [key, median(samples.map(value => value[key]))])) });
    }
    const byCount = Object.fromEntries(results.map(result => [result.commits, result.median]));
    const report = {
      generatedAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version, git: childProcess.execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(),
      fixture: { samples: 3, fileBytes: FILE_BYTES, lineBytes: LINE_BYTES, durationMs: DURATION_MS }, results,
      comparison: { retainedHeapGrowthBytes: byCount[1000].retainedHeapBytes - byCount[100].retainedHeapBytes,
        preparationRatio: byCount[1000].preparationMs / byCount[100].preparationMs },
      unmeasured: [...(results.every(result => result.samples.every(sample => sample.gitPeakRssBytes === null))
        ? ['Git subprocess peak RSS (OS profiler unavailable)'] : []),
        'scratch bytes (replay not executed)', 'viewport nodes', 'UI message frequency',
        'moving-pointer frame frequency', 'controller pause/stop p95 latency', 'real six-hour playback'],
    };
    await fsp.mkdir(path.join(process.cwd(), 'artifacts'), { recursive: true });
    await fsp.writeFile(path.join(process.cwd(), 'artifacts', 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await gitReader.disposeGit();
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
