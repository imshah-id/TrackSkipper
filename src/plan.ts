import { createReadStream } from 'node:fs';
import { open, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { Change, Edit, FileRecord, LIMITS, Phase, Plan, RecordEntry, Timing } from './types';
import { readRange, readChanges, readCommit, readBlob, objectInfo, hunkRanges } from './git';
import { lineStarts } from './view';
import { preferredDuration, validateTiming } from './timing';

export async function textBlob(repo: string, oid: string | null, signal: AbortSignal): Promise<string> {
  if (!oid) return '';
  const info = await objectInfo(repo, oid, signal);
  if (info.type !== 'blob' || info.size > LIMITS.textBytes) throw new Error('File exceeds the text animation limit');
  const chunks: Buffer[] = [];
  for await (const chunk of readBlob(repo, oid, signal)) chunks.push(chunk);
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function units(text: string): number {
  let count = 0;
  for (const _segment of segmenter.segment(text)) count++;
  return count;
}

function phases(edits: Edit[]): Phase[] {
  const list: Phase[] = [];
  const add = (kind: Phase['kind'], preferredMs: number, minimumMs: number, target: Phase['target'], editIndex: number | null, count = 0) =>
    list.push({ kind, preferredMs, minimumMs, target, editIndex, units: count });
  add('move', 350, 80, 'file', null); add('hover', 200, 50, 'file', null); add('click', 120, 50, 'file', null);
  edits.forEach((edit, index) => {
    add('scroll', 300, 80, 'code', index); add('move', 350, 80, 'code', index);
    add('hover', 200, 50, 'code', index); add('click', 120, 50, 'code', index);
    if (edit.deleteUnits) add('delete', edit.deleteUnits * 1000 / 24, edit.deleteUnits * 5, 'code', index, edit.deleteUnits);
    if (edit.insertUnits) add('type', edit.insertUnits * 1000 / 24, edit.insertUnits * 5, 'code', index, edit.insertUnits);
  });
  add('save', 0, 0, 'file', null);
  return list;
}

async function planFile(repo: string, change: Change, ordinal: number, signal: AbortSignal): Promise<FileRecord> {
  const record: FileRecord = { ordinal, change, kind: 'text', edits: [], phases: [], weight: 1, reason: null };
  const regular = (mode: string) => mode === '000000' || mode === '100644' || mode === '100755';
  if (!regular(change.oldMode) || !regular(change.newMode) || change.oldOid === change.newOid) {
    record.kind = 'metadata';
    record.reason = change.oldOid === change.newOid ? 'File permissions' : 'Symbolic link or submodule metadata';
  } else {
    const infos = [];
    for (const oid of [change.oldOid, change.newOid]) if (oid) infos.push(await objectInfo(repo, oid, signal));
    if (infos.some(info => info.size > LIMITS.textBytes)) {
      record.kind = 'snapshot'; record.reason = 'File exceeds 1 MiB';
    } else {
      let oldText = '', newText = '';
      try { oldText = await textBlob(repo, change.oldOid, signal); newText = await textBlob(repo, change.newOid, signal); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        record.kind = 'snapshot'; record.reason = 'Non-UTF-8 file';
      }
      if (oldText.includes('\0') || newText.includes('\0')) { record.kind = 'snapshot'; record.reason = 'Binary file'; }
      if (record.kind === 'text') {
        const oldStarts = lineStarts(oldText), newStarts = lineStarts(newText);
        const wide = (text: string, starts: number[]) => starts.some((start, i) => Buffer.byteLength(text.slice(start, starts[i + 1] ?? text.length)) > LIMITS.lineBytes);
        if (wide(oldText, oldStarts) || wide(newText, newStarts)) { record.kind = 'snapshot'; record.reason = 'Line exceeds 8 KiB'; }
        else {
          const ranges = !change.oldOid || !change.newOid ? null : await hunkRanges(repo, change.oldOid, change.newOid, signal);
          if (ranges && ranges.length > 4096) { record.kind = 'snapshot'; record.reason = 'More than 4,096 edit hunks'; }
          else {
            const spans = ranges ? ranges.map(hunk => {
              const a = hunk.oldCount ? hunk.oldLine - 1 : hunk.oldLine;
              const b = hunk.newCount ? hunk.newLine - 1 : hunk.newLine;
              return { oldStart: oldStarts[a] ?? oldText.length, oldEnd: oldStarts[a + hunk.oldCount] ?? oldText.length,
                newStart: newStarts[b] ?? newText.length, newEnd: newStarts[b + hunk.newCount] ?? newText.length };
            }) : [{ oldStart: 0, oldEnd: oldText.length, newStart: 0, newEnd: newText.length }];
            let a = 0, b = 0;
            for (const span of spans) {
              if (span.oldStart < a || span.newStart < b || oldText.slice(a, span.oldStart) !== newText.slice(b, span.newStart)) throw new Error('Git edit ranges do not match their source blobs');
              record.edits.push({ ...span, deleteUnits: units(oldText.slice(span.oldStart, span.oldEnd)), insertUnits: units(newText.slice(span.newStart, span.newEnd)) });
              a = span.oldEnd; b = span.newEnd;
            }
            if (oldText.slice(a) !== newText.slice(b)) throw new Error('Git edit ranges omitted changed content');
          }
        }
      }
    }
  }
  record.phases = phases(record.edits);
  record.weight = Math.max(1, record.edits.reduce((n, edit) => n + edit.deleteUnits + edit.insertUnits, 0));
  if (Buffer.byteLength(JSON.stringify(record)) > LIMITS.recordBytes) {
    record.kind = 'snapshot'; record.edits = []; record.phases = phases([]); record.weight = 1;
    record.reason = 'Text edit plan exceeds the animation limit';
  }
  return record;
}

export type PrepareOptions = { quotaBytes?: number; progress?: (message: string) => void };
export async function preparePlan(repo: string, startOid: string, endOid: string, timing: Timing, root: string, signal: AbortSignal, options: PrepareOptions = {}): Promise<Plan> {
  validateTiming(timing);
  const quota = options.quotaBytes ?? LIMITS.quotaBytes;
  const commitsPath = path.join(root, 'commits.bin'), changesPath = path.join(root, 'changes.tmp'), recordsPath = path.join(root, 'plan.jsonl');
  let used = 0;
  for (const name of await readdir(root)) { const info = await stat(path.join(root, name)); if (info.isFile()) used += info.size; }
  const reserve = (bytes: number) => { if (used + bytes > quota) throw new Error('Session storage quota exceeded during preparation'); used += bytes; };
  const commits = await open(commitsPath, 'wx', 0o600);
  let count = 0, width = 0, baseOid: string | null = null;
  const summary = { commits: 0, animated: 0, snapshots: 0, bytes: 0 };
  try {
    for await (const commit of readRange(repo, startOid, endOid, signal)) {
      const bytes = Buffer.from(commit.oid + '\n'); width = bytes.length;
      reserve(bytes.length); await commits.write(bytes); count++; baseOid = commit.parentOid;
      if (count % 100 === 0) options.progress?.(`Reading ${count.toLocaleString()} commits…`);
    }
  } finally { await commits.close(); }
  if (!count) throw new Error('No commits in the selected range');
  summary.commits = count;
  const plan: Plan = { version: 1, id: path.basename(root), root, repo, startOid, endOid, baseOid, recordsPath, timing,
    totals: { minimumMs: 0, preferredMs: 0, weight: 0, records: 0 }, summary };
  const history = await open(commitsPath, 'r'), output = await open(recordsPath, 'wx', 0o600);
  const append = async (record: RecordEntry) => {
    signal.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(record) + '\n');
    if (bytes.length > LIMITS.recordBytes) throw new Error('Plan record is too large');
    reserve(bytes.length); await output.write(bytes);
    for (const phase of record.phases) { plan.totals.minimumMs += phase.minimumMs; plan.totals.preferredMs += preferredDuration(phase, timing); }
    plan.totals.weight += record.weight; plan.totals.records++;
  };
  try {
    for (let index = count - 1; index >= 0; index--) {
      signal.throwIfAborted();
      const id = Buffer.alloc(width); const result = await history.read(id, 0, width, index * width);
      if (result.bytesRead !== width) throw new Error('Incomplete commit spool');
      const commit = await readCommit(repo, id.toString('ascii').trim(), signal);
      options.progress?.(`Preparing commit ${count - index}/${count}: ${commit.subject}`);
      let changesBytes = 0, changed = 0;
      const spool = await open(changesPath, 'wx', 0o600);
      try {
        for await (const change of readChanges(repo, commit.parentOid, commit.oid, signal)) {
          const bytes = Buffer.from(JSON.stringify(change) + '\n'); reserve(bytes.length); changesBytes += bytes.length; await spool.write(bytes); changed++;
        }
      } finally { await spool.close(); }
      if (!changed) await append({ ordinal: plan.totals.records, kind: 'milestone', commitOid: commit.oid, subject: commit.subject, weight: 1,
        phases: [{ kind: 'wait', units: 0, minimumMs: 100, preferredMs: 100, target: 'file', editIndex: null }] });
      for await (const entry of jsonLines(changesPath, 0, signal)) {
        const record = await planFile(repo, entry.value as Change, plan.totals.records, signal);
        record.subject = commit.subject;
        if (record.kind === 'text') summary.animated++;
        if (record.kind === 'snapshot') summary.snapshots++;
        if (record.change.newOid && record.change.newMode !== '160000') summary.bytes += (await objectInfo(repo, record.change.newOid, signal)).size;
        await append(record); await yieldLoop();
      }
      await unlink(changesPath); used -= changesBytes;
    }
    if (timing.mode === 'duration' && timing.durationMs < plan.totals.minimumMs) throw new Error(`Duration is below minimum: ${Math.ceil(plan.totals.minimumMs / 1000)} seconds`);
    const manifest = Buffer.from(JSON.stringify(plan)); reserve(manifest.length);
    await writeFile(path.join(root, 'manifest.tmp'), manifest, { flag: 'wx', mode: 0o600 });
    await rename(path.join(root, 'manifest.tmp'), path.join(root, 'manifest.json'));
    return plan;
  } finally { await history.close(); await output.close(); }
}

async function* jsonLines(file: string, offset: number, signal: AbortSignal): AsyncGenerator<{ value: unknown; offset: number; nextOffset: number }> {
  const stream = createReadStream(file, { start: offset, highWaterMark: 65536, signal });
  let pending = Buffer.alloc(0), position = offset;
  try {
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let newline: number;
      while ((newline = pending.indexOf(10)) >= 0) {
        if (newline + 1 > LIMITS.recordBytes) throw new Error('Oversized plan record');
        const nextOffset = position + newline + 1;
        yield { value: JSON.parse(pending.subarray(0, newline).toString('utf8')), offset: position, nextOffset };
        pending = pending.subarray(newline + 1); position = nextOffset;
      }
      if (pending.length > LIMITS.recordBytes) throw new Error('Oversized plan record');
    }
    if (pending.length) throw new Error('Truncated plan record');
  } finally { stream.destroy(); }
}

export async function* readRecords(plan: Plan, offset: number, signal: AbortSignal): AsyncGenerator<{ record: RecordEntry; offset: number; nextOffset: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid replay offset');
  const file = path.join(plan.root, 'plan.jsonl'), input = await open(file, 'r');
  try {
    if (offset > (await input.stat()).size) throw new Error('Replay offset exceeds the plan');
    if (offset > 0) {
      const previous = Buffer.alloc(1); await input.read(previous, 0, 1, offset - 1);
      if (previous[0] !== 10) throw new Error('Replay offset is not a record boundary');
    }
  } finally { await input.close(); }
  const oid = (value: unknown) => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  for await (const entry of jsonLines(file, offset, signal)) {
    const record = entry.value as RecordEntry;
    if (!record || !['text', 'snapshot', 'metadata', 'milestone'].includes(record.kind) || !Number.isSafeInteger(record.ordinal)
      || record.ordinal < 0 || !Array.isArray(record.phases) || !record.phases.length || record.phases.length > 30000 || !Number.isFinite(record.weight) || record.weight < 1) throw new Error('Invalid replay record');
    if (record.kind === 'milestone') {
      if (!oid(record.commitOid) || record.phases.some(phase => phase.kind !== 'wait')) throw new Error('Invalid milestone record');
    } else {
      const change = record.change;
      if (!change || !oid(change.commitOid) || (change.oldOid !== null && !oid(change.oldOid)) || (change.newOid !== null && !oid(change.newOid))
        || typeof change.pathBase64 !== 'string' || !change.pathBase64.length || Buffer.from(change.pathBase64, 'base64').toString('base64') !== change.pathBase64
        || ![change.oldMode, change.newMode].every(mode => ['000000', '100644', '100755', '120000', '160000'].includes(mode))
        || !Array.isArray(record.edits) || record.edits.length > 4096 || record.phases.at(-1)?.kind !== 'save'
        || record.phases.filter(phase => phase.kind === 'save').length !== 1) throw new Error('Invalid file record or save phase');
      for (const edit of record.edits) {
        if (!edit || ![edit.oldStart, edit.oldEnd, edit.newStart, edit.newEnd, edit.deleteUnits, edit.insertUnits].every(value => Number.isSafeInteger(value) && value >= 0)
          || edit.oldStart > edit.oldEnd || edit.newStart > edit.newEnd) throw new Error('Invalid text edit');
      }
    }
    for (const phase of record.phases) {
      if (!phase || !['move', 'hover', 'click', 'scroll', 'delete', 'type', 'wait', 'save'].includes(phase.kind)
        || !Number.isFinite(phase.preferredMs) || phase.preferredMs < 0 || !Number.isFinite(phase.minimumMs) || phase.minimumMs < 0
        || !Number.isSafeInteger(phase.units) || phase.units < 0 || !['file', 'code'].includes(phase.target)
        || (phase.editIndex !== null && (record.kind !== 'text' || !Number.isSafeInteger(phase.editIndex) || phase.editIndex < 0 || phase.editIndex >= record.edits.length))
        || (['type', 'delete'].includes(phase.kind) && phase.editIndex === null)) throw new Error('Invalid replay phase');
    }
    yield { record, offset: entry.offset, nextOffset: entry.nextOffset };
  }
}
