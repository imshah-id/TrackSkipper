import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, opendir, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readBlob } from './git';
import { readRecords } from './plan';
import { Checkpoint, FileRecord, Plan } from './types';

const MARKER = '.git-replay-owned.json';
const VERSION = 1;
const KEYED = /^[a-f0-9]{64}\.(?:data|json)$/;

export type Store = {
  root: string;
  save(record: FileRecord, repo: string, signal: AbortSignal): Promise<void>;
  checkpoint(value: Checkpoint): Promise<void>;
  readCheckpoint(): Promise<Checkpoint | null>;
  verify(plan?: Plan): Promise<{ files: number; bytes: number }>;
  clear(): Promise<void>;
  refreshUsage(): Promise<void>;
  reset(): Promise<void>;
};

export function pathKey(pathBase64: string): string {
  return createHash('sha256').update(Buffer.from(pathBase64, 'base64')).digest('hex');
}

async function* entries(root: string): AsyncGenerator<{ name: string; size: number }> {
  for await (const { name } of await opendir(root)) {
    const info = await lstat(path.join(root, name));
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not allowed in an owned session');
    if (!info.isFile()) throw new Error('Unexpected entry in owned session');
    yield { name, size: info.size };
  }
}

async function usage(root: string): Promise<number> {
  let bytes = 0;
  for await (const item of entries(root)) bytes += item.size;
  return bytes;
}

async function owned(storageRoot: string, sessionRoot: string): Promise<{ root: string; id: string }> {
  const parentInfo = await lstat(storageRoot);
  const sessionInfo = await lstat(sessionRoot);
  if (parentInfo.isSymbolicLink() || sessionInfo.isSymbolicLink() || !parentInfo.isDirectory() || !sessionInfo.isDirectory()) throw new Error('Invalid owned session root');
  const parent = await realpath(storageRoot), root = await realpath(sessionRoot);
  if (path.dirname(root) !== parent) throw new Error('Session is outside its owned storage root');
  await usage(root);
  let marker: { version?: number; id?: string };
  try { marker = JSON.parse(await readFile(path.join(root, MARKER), 'utf8')); }
  catch { throw new Error('Session ownership marker is missing or invalid'); }
  const id = path.basename(root);
  if (marker.version !== VERSION || marker.id !== id) throw new Error('Session ownership marker is invalid');
  return { root, id };
}

async function sizeIfFile(file: string): Promise<number> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Invalid session file');
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function store(root: string, id: string, quotaBytes: number, initialUsage: number): Store {
  if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 0) throw new Error('Invalid session storage quota');
  let used = initialUsage;
  let tail = Promise.resolve();
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const reserve = (bytes: number) => { if (used + bytes > quotaBytes) throw new Error('Session storage quota exceeded'); };
  const atomic = async (name: string, bytes: Buffer): Promise<void> => {
    const destination = path.join(root, name), previous = await sizeIfFile(destination);
    reserve(bytes.length);
    const temporary = path.join(root, `.tmp-${randomUUID()}`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); used += bytes.length;
      await rename(temporary, destination); used -= previous;
    } catch (error) {
      try { const size = await sizeIfFile(temporary); await unlink(temporary); used -= size; } catch { /* original error wins */ }
      throw error;
    }
  };
  const refreshUsage = () => run(async () => { used = await usage(root); });

  return {
    root,
    refreshUsage,
    save: (record, repo, signal) => run(async () => {
      signal.throwIfAborted();
      const key = pathKey(record.change.pathBase64), dataName = `${key}.data`, metadataName = `${key}.json`;
      const dataPath = path.join(root, dataName), oldData = await sizeIfFile(dataPath);
      const metadataBase = { version: VERSION, ordinal: record.ordinal, pathBase64: record.change.pathBase64, oid: record.change.newOid,
        mode: record.change.newMode, deleted: record.change.newOid === null, size: 0, sha256: null as string | null };
      if (!record.change.newOid || record.change.newMode === '160000') {
        const metadata = Buffer.from(JSON.stringify(metadataBase));
        await atomic(metadataName, metadata);
        try { await unlink(dataPath); used -= oldData; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return;
      }

      const temporary = path.join(root, `.tmp-${randomUUID()}`);
      const output = await open(temporary, 'wx', 0o600);
      const digest = createHash('sha256');
      let written = 0, renamed = false;
      try {
        for await (const chunk of readBlob(repo, record.change.newOid, signal)) {
          signal.throwIfAborted(); reserve(chunk.length); await output.write(chunk); digest.update(chunk); written += chunk.length; used += chunk.length;
        }
        await output.close();
        const sha256 = digest.digest('hex'), check = createHash('sha256');
        for await (const chunk of createReadStream(temporary, { highWaterMark: 64 * 1024, signal })) check.update(chunk);
        if (check.digest('hex') !== sha256) throw new Error('Scratch file verification failed');
        const metadata = Buffer.from(JSON.stringify({ ...metadataBase, size: written, sha256 }));
        reserve(metadata.length);
        await rename(temporary, dataPath); renamed = true; used -= oldData;
        await atomic(metadataName, metadata);
      } catch (error) {
        try { await output.close(); } catch { /* original error wins */ }
        if (!renamed) try { await unlink(temporary); used -= written; } catch { /* original error wins */ }
        throw error;
      }
    }),
    checkpoint: value => run(async () => {
      if (value.version !== VERSION || value.planId !== id) throw new Error('Checkpoint does not belong to this session');
      await atomic('checkpoint.json', Buffer.from(JSON.stringify(value)));
    }),
    readCheckpoint: () => run(async () => {
      try {
        const value = JSON.parse(await readFile(path.join(root, 'checkpoint.json'), 'utf8')) as Checkpoint;
        if (value.version !== VERSION || value.planId !== id) throw new Error('Invalid session checkpoint');
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }),
    verify: plan => run(async () => {
      let files = 0, bytes = 0, metadataCount = 0;
      for await (const item of entries(root)) {
        if (/^[a-f0-9]{64}\.data$/.test(item.name)) {
          if (!await sizeIfFile(path.join(root, item.name.replace(/\.data$/, '.json')))) throw new Error('Orphan scratch data has no metadata');
        }
        if (!/^[a-f0-9]{64}\.json$/.test(item.name)) continue;
        if (item.size > 65536) throw new Error('Scratch metadata is too large');
        const metadata = JSON.parse(await readFile(path.join(root, item.name), 'utf8'));
        const key = item.name.slice(0, 64);
        if (metadata.version !== VERSION || !Number.isSafeInteger(metadata.ordinal) || metadata.ordinal < 0
          || typeof metadata.pathBase64 !== 'string' || pathKey(metadata.pathBase64) !== key
          || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || typeof metadata.deleted !== 'boolean'
          || !['000000', '100644', '100755', '120000', '160000'].includes(metadata.mode)
          || (metadata.oid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(metadata.oid))
          || metadata.deleted !== (metadata.oid === null)) throw new Error('Invalid scratch metadata');
        metadataCount++;
        const dataPath = path.join(root, `${key}.data`);
        if (metadata.deleted || metadata.mode === '160000') {
          try { await lstat(dataPath); throw new Error('Unexpected scratch data for metadata-only record'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          continue;
        }
        const digest = createHash('sha256'); let size = 0;
        for await (const chunk of createReadStream(dataPath, { highWaterMark: 64 * 1024 })) { digest.update(chunk); size += chunk.length; }
        if (size !== metadata.size || digest.digest('hex') !== metadata.sha256) throw new Error('Scratch file verification failed');
        files++; bytes += size;
      }
      if (plan) {
        let matched = 0;
        for await (const { record } of readRecords(plan, 0, new AbortController().signal)) {
          if (record.kind === 'milestone') continue;
          const metadata = JSON.parse(await readFile(path.join(root, `${pathKey(record.change.pathBase64)}.json`), 'utf8'));
          if (metadata.ordinal < record.ordinal) throw new Error('Missing final scratch version');
          if (metadata.ordinal === record.ordinal) {
            if (metadata.pathBase64 !== record.change.pathBase64 || metadata.oid !== record.change.newOid || metadata.mode !== record.change.newMode) throw new Error('Scratch output does not match the replay plan');
            matched++;
          }
        }
        if (matched !== metadataCount) throw new Error('Scratch output does not match the replay plan');
      }
      return { files, bytes };
    }),
    reset: () => run(async () => {
      for await (const item of entries(root)) if (KEYED.test(item.name) || item.name === 'checkpoint.json' || item.name.startsWith('.tmp-')) {
        await unlink(path.join(root, item.name)); used -= item.size;
      }
    }),
    clear: () => run(async () => {
      await usage(root);
      const marker = JSON.parse(await readFile(path.join(root, MARKER), 'utf8')) as { version?: number; id?: string };
      if (marker.version !== VERSION || marker.id !== id) throw new Error('Session ownership marker is invalid');
      for await (const item of entries(root)) await unlink(path.join(root, item.name));
      await rmdir(root); used = 0;
    }),
  };
}

export async function createStore(storageRoot: string, quotaBytes: number): Promise<Store> {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(storageRoot);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('Invalid storage root');
  const parent = await realpath(storageRoot);
  const root = await mkdtemp(path.join(parent, 'replay-'));
  await chmod(root, 0o700);
  const id = path.basename(root), marker = Buffer.from(JSON.stringify({ version: VERSION, id }));
  await writeFile(path.join(root, MARKER), marker, { flag: 'wx', mode: 0o600 });
  return store(root, id, quotaBytes, marker.length);
}

export async function openStore(storageRoot: string, sessionRoot: string, quotaBytes: number): Promise<Store> {
  const session = await owned(storageRoot, sessionRoot);
  const bytes = await usage(session.root);
  if (bytes > quotaBytes) throw new Error('Session storage quota exceeded');
  return store(session.root, session.id, quotaBytes, bytes);
}
