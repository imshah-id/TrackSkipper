import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { Commit, Change, LIMITS } from './types';

const PREFIX = ['--no-pager', '--no-replace-objects', '--no-optional-locks'];
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const STDERR_LIMIT = 64 * 1024;
const HUNK_LIMIT = 4096;
const children = new Set<ChildProcessWithoutNullStreams>();
const closures = new WeakMap<ChildProcessWithoutNullStreams, Promise<number | null>>();
const roots = new Map<string, string>();
let operationTail: Promise<void> = Promise.resolve();

async function waitForSlot(previous: Promise<void>, release: () => void, signal: AbortSignal): Promise<() => void> {
  let cancel: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    await Promise.race([previous, new Promise<never>((_, reject) => {
      cancel = () => reject(aborted(signal));
      signal.addEventListener('abort', cancel, { once: true });
    })]);
    signal.throwIfAborted();
    return release;
  } catch (error) { void previous.then(release); throw error; }
  finally { if (cancel) signal.removeEventListener('abort', cancel); }
}

async function operationSlot(signal: AbortSignal): Promise<() => void> {
  const previous = operationTail;
  let release!: () => void;
  operationTail = new Promise(resolve => { release = resolve; });
  return waitForSlot(previous, release, signal);
}

async function terminate(process: ChildProcessWithoutNullStreams): Promise<void> {
  if (children.has(process)) process.kill();
  await closures.get(process);
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  return { ...env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function child(repo: string, args: string[]): ChildProcessWithoutNullStreams {
  const process = spawn('git', [...PREFIX, '-C', repo, ...args], {
    env: environment(), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(process);
  process.on('error', () => undefined);
  closures.set(process, new Promise(resolve => process.once('close', code => { children.delete(process); resolve(code); })));
  process.stdin.on('error', () => undefined);
  return process;
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Git operation cancelled');
}

async function collect(repo: string, args: string[], signal: AbortSignal, max = LIMITS.recordBytes): Promise<Buffer> {
  const release = await operationSlot(signal);
  try { return await collectInSlot(repo, args, signal, max); }
  finally { release(); }
}

async function collectInSlot(repo: string, args: string[], signal: AbortSignal, max: number): Promise<Buffer> {
  if (signal.aborted) throw aborted(signal);
  const process = child(repo, args);
  let timer: NodeJS.Timeout;
  let stderr = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let length = 0;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => process.kill(), LIMITS.gitIdleMs); };
  const cancel = () => process.kill();
  signal.addEventListener('abort', cancel, { once: true });
  process.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-STDERR_LIMIT); });
  reset();
  try {
    process.stdin.end();
    for await (const value of process.stdout) {
      reset();
      const chunk = Buffer.from(value);
      length += chunk.length;
      if (length > max) { process.kill(); throw new Error(`Git output exceeds ${max} bytes`); }
      chunks.push(chunk);
    }
    const code = await closures.get(process);
    if (signal.aborted) throw aborted(signal);
    if (code !== 0) throw new Error(`Git failed (${code}): ${stderr.toString('utf8').trim()}`);
    return Buffer.concat(chunks, length);
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel);
    await terminate(process);
    process.stderr.destroy();
  }

}

export async function gitText(repo: string, args: string[], signal: AbortSignal): Promise<string> {
  return (await collect(repo, args, signal)).toString('utf8').trim();
}

async function root(repo: string, signal: AbortSignal): Promise<string> {
  const requested = await realpath(repo);
  const cached = roots.get(requested);
  if (cached) return cached;
  const canonical = await realpath(await gitText(requested, ['rev-parse', '--show-toplevel'], signal));
  roots.set(requested, canonical);
  roots.set(canonical, canonical);
  return canonical;
}

async function resolve(repo: string, revision: string, signal: AbortSignal): Promise<string> {
  const oid = await gitText(repo, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], signal);
  if (!OID.test(oid)) throw new Error('Git returned an invalid object ID');
  return oid;
}

class ByteReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private buffer = Buffer.alloc(0);
  constructor(stream: NodeJS.ReadableStream) { this.iterator = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>; }
  private async fill(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw aborted(signal);
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Git operation timed out')), LIMITS.gitIdleMs); });
    let onAbort!: () => void;
    const cancel = new Promise<never>((_, reject) => {
      onAbort = () => reject(aborted(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const next = await Promise.race([this.iterator.next(), timeout, cancel]);
      if (next.done) throw new Error('Git cat-file closed unexpectedly');
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    } finally { clearTimeout(timer!); signal.removeEventListener('abort', onAbort); }
  }
  async line(signal: AbortSignal): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf(10);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      await this.fill(signal);
    }
  }
  async *bytes(size: number, signal: AbortSignal): AsyncGenerator<Buffer> {
    let remaining = size;
    while (remaining) {
      if (!this.buffer.length) await this.fill(signal);
      const length = Math.min(remaining, this.buffer.length, 64 * 1024);
      const value = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      remaining -= length;
      yield value;
    }
    while (!this.buffer.length) await this.fill(signal);
    if (this.buffer[0] !== 10) throw new Error('Invalid cat-file response terminator');
    this.buffer = this.buffer.subarray(1);
  }
}

let batch: { repo: string; process: ChildProcessWithoutNullStreams; reader: ByteReader } | undefined;
let batchTail: Promise<void> = Promise.resolve();

async function acquireBatch(repo: string): Promise<typeof batch & {}> {
  const canonical = await realpath(repo);
  if (batch?.repo !== canonical || batch.process.exitCode !== null) {
    if (batch) await terminate(batch.process);
    const process = child(canonical, ['cat-file', '--batch-command']);
    process.stderr.resume();
    batch = { repo: canonical, process, reader: new ByteReader(process.stdout) };
  }
  return batch;
}

async function batchSlot(signal: AbortSignal): Promise<() => void> {
  const previous = batchTail;
  let release!: () => void;
  batchTail = new Promise(resolve => { release = resolve; });
  return waitForSlot(previous, release, signal);
}

async function locked<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const release = await batchSlot(signal);
  try { return await work(); } finally { release(); }
}

function header(line: string, oid: string): { type: string; size: number } {
  const match = /^([0-9a-f]+) ([^ ]+) ([0-9]+)$/.exec(line);
  if (!match || match[1] !== oid) throw new Error(line.endsWith(' missing') ? `Git object ${oid} is unavailable` : 'Invalid cat-file response');
  return { type: match[2], size: Number(match[3]) };
}

export async function objectInfo(repo: string, oid: string, signal: AbortSignal): Promise<{ type: string; size: number }> {
  if (!OID.test(oid)) throw new Error('A full object ID is required');
  const canonical = await root(repo, signal);
  return locked(signal, async () => {
    const active = await acquireBatch(canonical);
    const cancel = () => { active.process.kill(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      active.process.stdin.write(`info ${oid}\n`);
      return header(await active.reader.line(signal), oid);
    } catch (error) { await terminate(active.process); batch = undefined; throw error; }
    finally { signal.removeEventListener('abort', cancel); }
  });
}

export async function* readBlob(repo: string, oid: string, signal: AbortSignal): AsyncGenerator<Buffer> {
  if (!OID.test(oid)) throw new Error('A full object ID is required');
  const canonical = await root(repo, signal);
  const release = await batchSlot(signal);
  let complete = false;
  try {
    const active = await acquireBatch(canonical);
    const cancel = () => { active.process.kill(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      active.process.stdin.write(`contents ${oid}\n`);
      const info = header(await active.reader.line(signal), oid);
      if (info.type !== 'blob') throw new Error(`Expected blob, got ${info.type}`);
      yield* active.reader.bytes(info.size, signal);
      complete = true;
    } catch (error) { await terminate(active.process); batch = undefined; throw error; }
    finally { signal.removeEventListener('abort', cancel); }
  } finally {
    if (!complete && batch) { await terminate(batch.process); batch = undefined; }
    release();
  }
}

export async function readCommit(repo: string, oid: string, signal: AbortSignal): Promise<Commit> {
  if (!OID.test(oid)) throw new Error('A full object ID is required');
  const canonical = await root(repo, signal);
  return locked(signal, async () => {
    const active = await acquireBatch(canonical);
    const cancel = () => { active.process.kill(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      active.process.stdin.write(`contents ${oid}\n`);
      const info = header(await active.reader.line(signal), oid);
      if (info.type !== 'commit') throw new Error(`Expected commit, got ${info.type}`);
      let parent: string | null = null, subject = '', line = '', inMessage = false, subjectDone = false;
      let discarding = false;
      for await (const chunk of active.reader.bytes(info.size, signal)) {
        // Parse headers incrementally; only the displayed subject and short header prefix stay resident.
        for (const byte of chunk) {
          if (subjectDone) continue;
          if (byte === 10) {
            if (inMessage) { subjectDone = true; continue; }
            if (!line && !discarding) inMessage = true;
            else if (!parent && /^parent [0-9a-f]{40,64}$/.test(line)) parent = line.slice(7);
            line = ''; discarding = false;
          } else if (inMessage) {
            if (subject.length < 4096) subject += String.fromCharCode(byte);
          } else if (line.length < 256) line += String.fromCharCode(byte);
          else discarding = true;
        }
      }
      subject = Buffer.from(subject, 'latin1').toString('utf8');
      return { oid, parentOid: parent, subject };
    } catch (error) { await terminate(active.process); batch = undefined; throw error; }
    finally { signal.removeEventListener('abort', cancel); }
  });
}

export async function* readRange(repo: string, startOid: string, endOid: string, signal: AbortSignal): AsyncGenerator<Commit> {
  const canonical = await root(repo, signal);
  const start = await resolve(canonical, startOid, signal);
  const end = await resolve(canonical, endOid, signal);
  const release = await operationSlot(signal);
  const process = child(canonical, ['rev-list', '--first-parent', '--parents', end]);
  let stderr = Buffer.alloc(0), pending = '';
  let timer: NodeJS.Timeout;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => process.kill(), LIMITS.gitIdleMs); };
  const cancel = () => process.kill();
  signal.addEventListener('abort', cancel, { once: true });
  process.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-STDERR_LIMIT); });
  process.stdin.end(); reset();
  let found = false;
  try {
    for await (const chunk of process.stdout) {
      reset();
      pending += chunk.toString('ascii');
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const [oid] = pending.slice(0, newline).split(' ');
        pending = pending.slice(newline + 1);
        const commit = await readCommit(canonical, oid, signal);
        yield commit;
        if (oid === start) { found = true; process.kill(); return; }
      }
    }
    const code = await closures.get(process);
    if (signal.aborted) throw aborted(signal);
    if (code !== 0) throw new Error(`Git failed (${code}): ${stderr.toString('utf8').trim()}`);
    if (!found) throw new Error('Selected start is outside the ending commit first-parent chain');
  } finally {
    clearTimeout(timer!);
    signal.removeEventListener('abort', cancel);
    await terminate(process);
    release();
  }
}

export async function commitPage(repo: string, tip: string, signal: AbortSignal): Promise<Commit[]> {
  const canonical = await root(repo, signal);
  const oid = await resolve(canonical, tip, signal);
  const ids = (await gitText(canonical, ['rev-list', '--first-parent', '--max-count=100', oid], signal)).split('\n').filter(Boolean);
  const result: Commit[] = [];
  for (const id of ids) result.push(await readCommit(canonical, id, signal));
  return result;
}

export async function* readChanges(repo: string, parentOid: string | null, commitOid: string, signal: AbortSignal): AsyncGenerator<Change> {
  const canonical = await root(repo, signal);
  const commit = await resolve(canonical, commitOid, signal);
  const parent = parentOid === null ? null : await resolve(canonical, parentOid, signal);
  const args = parent
    ? ['diff-tree', '-r', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-commit-id', parent, commit]
    : ['diff-tree', '--root', '-r', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-commit-id', commit];
  const release = await operationSlot(signal);
  const process = child(canonical, args);
  let stderr = Buffer.alloc(0), pending = Buffer.alloc(0);
  let timer: NodeJS.Timeout;
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => process.kill(), LIMITS.gitIdleMs); };
  const cancel = () => process.kill();
  signal.addEventListener('abort', cancel, { once: true });
  process.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-STDERR_LIMIT); });
  process.stdin.end(); reset();
  try {
    for await (const chunk of process.stdout) {
      reset(); pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.length > LIMITS.recordBytes) { process.kill(); throw new Error('Raw diff record exceeds limit'); }
      for (;;) {
        const headerEnd = pending.indexOf(0);
        if (headerEnd < 0) break;
        const pathEnd = pending.indexOf(0, headerEnd + 1);
        if (pathEnd < 0) break;
        const fields = pending.subarray(1, headerEnd).toString('ascii').split(' ');
        if (fields.length !== 5) throw new Error('Invalid raw diff header');
        const [oldMode, newMode, oldId, newId] = fields;
        const zero = (id: string) => /^0+$/.test(id) ? null : id;
        yield { commitOid: commit, pathBase64: pending.subarray(headerEnd + 1, pathEnd).toString('base64'), oldOid: zero(oldId), newOid: zero(newId), oldMode, newMode };
        pending = pending.subarray(pathEnd + 1);
      }
    }
    const code = await closures.get(process);
    if (signal.aborted) throw aborted(signal);
    if (code !== 0) throw new Error(`Git failed (${code}): ${stderr.toString('utf8').trim()}`);
    if (pending.length) throw new Error('Truncated raw diff record');
  } finally {
    clearTimeout(timer!); signal.removeEventListener('abort', cancel);
    await terminate(process);
    release();
  }
}

export async function hunkRanges(repo: string, oldOid: string, newOid: string, signal: AbortSignal): Promise<Array<{ oldLine: number; oldCount: number; newLine: number; newCount: number }>> {
  if (!OID.test(oldOid) || !OID.test(newOid)) throw new Error('Full blob IDs are required');
  const canonical = await root(repo, signal);
  const text = (await collect(canonical, ['diff', '--text', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--diff-algorithm=myers', '--unified=0', oldOid, newOid, '--'], signal)).toString('utf8');
  const ranges = [];
  for (const match of text.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    // The 4,097th range is a sentinel: preparation switches this file to a snapshot.
    if (ranges.length > HUNK_LIMIT) break;
    ranges.push({ oldLine: Number(match[1]), oldCount: Number(match[2] ?? 1), newLine: Number(match[3]), newCount: Number(match[4] ?? 1) });
  }
  return ranges;
}

export async function disposeGit(): Promise<void> {
  await Promise.all([...children].map(terminate));
  batch = undefined;
  roots.clear();
}
