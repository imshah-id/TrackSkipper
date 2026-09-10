# Isolated Git Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated VS Code Git replay extension with timed code reconstruction, an animated pointer, and resource use that stays bounded as history grows.

**Architecture:** A TypeScript extension reads pinned Git objects, prepares a streaming plan, and runs a monotonic-clock playback controller. A plain webview renders a limited code viewport and internal pointer animation; an extension-owned sparse store saves completed file versions. The user's normal editor, working tree, mouse, and keyboard remain independent.

**Tech Stack:** VS Code extension API, TypeScript, Node.js standard library, Git CLI, HTML/CSS/plain JavaScript, and built-in Node tests.

**Spec:** [2026-09-10-isolated-git-replay-design.md](../specs/2026-09-10-isolated-git-replay-design.md)

## Global Constraints

- Target: desktop VS Code 1.100 or later; local, trusted Git workspaces only; macOS first, with Windows and Linux compatibility checks before claiming support.
- Toolchain: TypeScript, Node.js 22 or later for development checks, Git 2.45 or later, and the Node.js runtime provided by VS Code for execution.
- Runtime dependencies: none beyond VS Code and the installed Git executable; use Node.js and browser standard APIs.
- Input isolation: no operating-system mouse events, keyboard injection, focus stealing, or source-editor edits.
- Source isolation: read committed Git objects only; do not change the source working tree, index, refs, Git configuration, or uncommitted files.
- History: include the selected starting commit and the pinned ending commit; replay the ending commit's first-parent history in oldest-to-newest order.
- Concurrency: one replay session, one active file, and at most two Git child processes per extension host; explicit disposal owns all processes and timers.
- Animated text limits: at most 1 MiB per old/new blob and 8 KiB per logical line; other regular files use a snapshot event preserving their original bytes.
- Rendering limits: at most 120 visible code rows and 64 KiB of code text per frame; at most 10 host updates per second and 30 pointer animation frames per second while moving.
- Storage: default session quota is 1 GiB including scratch data, manifests, plans, and temporary writes; check quota before allocation and permit an explicit increase in settings.
- Timing: duration mode takes priority over typing speed; speed mode takes priority over the displayed duration estimate; explicit pauses and preparation/I/O stalls extend completion time.
- Validation: use built-in node:test and node:assert/strict, temporary Git repositories, and manual VS Code checks; add no test framework.

---

## Current state and execution boundary

The workspace was empty and was not a Git repository when inspected on 2026-09-10. Installed tools observed: Git 2.55.0 and Node.js 26.8.1. Only this plan and its design document have been added. No extension has been scaffolded, dependencies installed, benchmark run, or compatibility claim verified.

The user authorized preparing a concrete plan. Execute implementation when the user asks to build from it; do not treat the unchecked tasks as completed work. Use inline execution by default. Do not dispatch agents merely because the template mentions them. Initialize project version control during implementation if this folder is still not a repository; no remote or publishing step is implicit.

## File map

| File | Responsibility |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `.vscodeignore`, `.vscode/launch.json` | Extension manifest, one TypeScript build, development checks, package inclusion, F5 launch |
| `src/types.ts` | Small shared data contracts and exact resource constants |
| `src/git.ts` | Cancellable Git processes, revision traversal, binary-safe records, blob streaming, hunk coordinates |
| `src/plan.ts` | Sequential preparation, disk records, aggregate weights, file classification |
| `src/replay.ts` | Pure timing and text viewport functions plus the single replay controller |
| `src/store.ts` | Owned scratch directory, quota, atomic saves, metadata, checkpoints, cleanup |
| `src/extension.ts` | Commands, repository/range picker, webview ownership and validated messages |
| `media/panel.js`, `media/panel.css` | Controls, bounded code rows, pointer, accessibility |
| `test/replay.test.cjs` | A small set of behavior tests using built-in Node tools |
| `scripts/benchmark.cjs` | Reproducible history-size and playback-resource measurements |
| `README.md` | Installation, playback semantics, limits, recovery, measured results |

Keep shared contracts here; no service container, plugin architecture, custom event bus, general editor model, or additional storage layer.

## Shared interfaces

Task 1 creates `src/types.ts`; later tasks extend implementation files, not duplicate these declarations. `pathBase64` contains raw Git path bytes; decode it only for display or hashing.

```ts
export type Commit = { oid: string; parentOid: string | null; subject: string };
export type Change = {
  commitOid: string; pathBase64: string;
  oldOid: string | null; newOid: string | null;
  oldMode: string; newMode: string;
};
export type Edit = {
  oldStart: number; oldEnd: number; newStart: number; newEnd: number;
  deleteUnits: number; insertUnits: number;
};
export type Phase = {
  kind: 'move' | 'hover' | 'click' | 'scroll' | 'delete' | 'type' | 'wait' | 'save';
  units: number; minimumMs: number; preferredMs: number;
  target: 'file' | 'code'; editIndex: number | null;
};
export type Timing =
  | { mode: 'duration'; durationMs: number }
  | { mode: 'speed'; charactersPerSecond: number; pointerMultiplier: number };
export type Totals = {
  minimumMs: number; preferredMs: number; weight: number; records: number;
};
export type FileRecord = {
  ordinal: number; change: Change;
  kind: 'text' | 'snapshot' | 'metadata';
  edits: Edit[]; phases: Phase[]; weight: number; reason: string | null;
};
export type MilestoneRecord = {
  ordinal: number; kind: 'milestone'; commitOid: string;
  phases: Phase[]; weight: number;
};
export type RecordEntry = FileRecord | MilestoneRecord;
export type Plan = {
  version: 1; id: string; root: string; repo: string;
  startOid: string; endOid: string; baseOid: string | null;
  recordsPath: string; totals: Totals; timing: Timing;
};
export type Position = {
  recordOffset: number; phaseIndex: number; phaseElapsedMs: number;
  playbackElapsedMs: number;
};
export type Checkpoint = {
  version: 1; planId: string; completedOffset: number;
  pausedPosition: Position | null; timing: Timing;
  status: 'paused' | 'stopped' | 'complete';
};
export type Frame = {
  firstLine: number; lines: string[];
  caret: { row: number; column: number } | null;
};
export const LIMITS = {
  textBytes: 1024 * 1024, lineBytes: 8192, recordBytes: 8 * 1024 * 1024,
  frameBytes: 65536, frameRows: 120, pageEntries: 100,
  gitProcesses: 2, hostHz: 10, pointerHz: 30,
  quotaBytes: 1024 ** 3, gitIdleMs: 30000, lateHeartbeatMs: 2000,
} as const;
```

Offsets in `Edit` are UTF-16 string offsets after strict UTF-8 decoding, not Git byte offsets. Their counts refer to grapheme clusters. Checkpoints use byte offsets in the newline-delimited plan. Reject unsafe integer offsets and nonfinite timing values at deserialization boundaries.

## Task 1: Read a pinned Git range without changing its repository

**Files:** Create the root build/manifest files, `src/types.ts`, `src/git.ts`, `src/extension.ts`, and `test/replay.test.cjs`.

**Consumes:** Installed local Git and trusted local workspace URIs.

**Produces:**

```ts
// src/git.ts
export function readRange(
  repo: string, startOid: string, endOid: string, signal: AbortSignal,
): AsyncGenerator<Commit>;
export function readChanges(
  repo: string, parentOid: string | null, commitOid: string, signal: AbortSignal,
): AsyncGenerator<Change>;
export function readBlob(
  repo: string, oid: string, signal: AbortSignal,
): AsyncGenerator<Buffer>;
export function objectInfo(
  repo: string, oid: string, signal: AbortSignal,
): Promise<{ type: string; size: number }>;
export function hunkRanges(
  repo: string, oldOid: string, newOid: string, signal: AbortSignal,
): Promise<Array<{ oldLine: number; oldCount: number; newLine: number; newCount: number }>>;
export function disposeGit(): Promise<void>;
```

`readRange` yields newest to oldest through the selected start inclusively and rejects a start outside the first-parent chain. `readBlob` shares the one batch process, serializes its requests, and applies stream backpressure. The remaining Git slot serves history/diff operations. `hunkRanges` enforces byte/range-count limits before accumulating an unbounded array.

- [ ] **1. Add the manifest and build commands needed to run the first check.** Use CommonJS extension output at `dist/extension.js`, `engines.vscode: ^1.100.0`, `extensionKind: ["workspace"]`, command `gitReplay.open`, and unsupported untrusted/virtual workspace capabilities. Reject a nonlocal extension host in the command handler. Development packages are TypeScript, `@types/node` for Node 22, `@types/vscode` for 1.100, and a compatible pinned `@vscode/vsce` for local packaging. Commit exact resolutions in the lockfile. Use `tsc` targeting ES2022/CommonJS with strict checks; include DOM types only where `AbortSignal`/browser contracts require them.

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "npm run build && node --test test/replay.test.cjs",
    "benchmark": "npm run build && node scripts/benchmark.cjs",
    "package": "npm run build && vsce package --out trackskipper.vsix"
  }
}
```

Package `dist/**`, `media/**`, the manifest, README and license only. Exclude tests, benchmark repositories, session data, source maps containing local paths, and this planning directory from the VSIX. Use F5's extension development host for manual checks.

- [ ] **2. Add this repository-preservation test before the Git implementation.** Build failure for absent exports is acceptable initially; after stubs compile, verify the assertion fails for an empty/incomplete traversal.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readRange, disposeGit } = require('../dist/git.js');

test('range includes the start and leaves dirty source files untouched', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git-replay-test-'));
  const git = (...args) => execFileSync('git', ['-C', repo,
    '-c', 'user.name=Replay Test', '-c', 'user.email=replay@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
  try {
    git('init');
    await fs.writeFile(path.join(repo, 'code.txt'), 'first\n');
    git('add', '.'); git('commit', '-m', 'first');
    const first = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'code.txt'), 'second\n');
    git('add', '.'); git('commit', '-m', 'second');
    const last = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(repo, 'code.txt'), 'uncommitted\n');
    const status = git('status', '--porcelain=v1');
    const index = await fs.readFile(path.join(repo, '.git', 'index'));
    const commits = [];
    for await (const commit of readRange(repo, first, last, new AbortController().signal)) {
      commits.push(commit.oid);
    }
    assert.deepEqual(commits, [last, first]);
    assert.equal(git('rev-parse', 'HEAD'), last);
    assert.equal(git('status', '--porcelain=v1'), status);
    assert.deepEqual(await fs.readFile(path.join(repo, '.git', 'index')), index);
    assert.equal(await fs.readFile(path.join(repo, 'code.txt'), 'utf8'), 'uncommitted\n');
  } finally {
    await disposeGit();
    await fs.rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **3. Run `npm test` and confirm the failure belongs to the missing Git reader.** Record that failure in the implementation progress; dependency installation problems are not a valid behavioral failure.

- [ ] **4. Implement the reader using these exact command shapes.** All values are separate `spawn` arguments. Resolve revisions first, validate full IDs, and run at the canonical repository root.

```text
git --no-pager --no-replace-objects --no-optional-locks rev-parse --verify --end-of-options HEAD^{commit}
git --no-pager --no-replace-objects --no-optional-locks rev-list --first-parent --parents <end-oid>
git --no-pager --no-replace-objects --no-optional-locks diff-tree -r --raw -z --no-abbrev --no-renames --no-commit-id <parent-oid> <commit-oid>
git --no-pager --no-replace-objects --no-optional-locks diff-tree --root -r --raw -z --no-abbrev --no-renames --no-commit-id <root-oid>
git --no-pager --no-replace-objects --no-optional-locks cat-file --batch-command
git --no-pager --no-replace-objects --no-optional-locks diff --text --no-ext-diff --no-textconv --no-color --no-renames --diff-algorithm=myers --unified=0 <old-blob-oid> <new-blob-oid> --
```

Set `GIT_NO_LAZY_FETCH=1`, `GIT_OPTIONAL_LOCKS=0`, and `GIT_TERMINAL_PROMPT=0` in the sanitized Git environment. In raw records, interpret zero object IDs as absent and modes `120000`/`160000` as special entries. Parse paths as raw buffers. Retrieve commit subjects through the shared batch reader, retaining at most 4 KiB for a displayed subject and draining the remaining content; this stays within the two-process limit while revision traversal is running. Use a 64 KiB maximum retained stderr tail and the specified inactivity timeout. Do not read a nested diff while a raw-diff subprocess still occupies the second slot: finish/spool that commit's change records first, then load blobs and request hunk diffs. Cancellation that deliberately stops a completed range traversal must not be misreported as a Git failure.

- [ ] **5. Expand the same behavior check with a first-parent merge and an empty commit.** Assert the merge appears once, changes reflect its first-parent baseline, a root has `parentOid: null`, and an unreachable start is rejected. Add binary output containing NUL/newline to the blob check. Run `npm test`, then inspect `git diff --check` after version control exists.

- [ ] **6. Commit this tested deliverable** as `feat: read pinned Git history without changing source files`.

## Task 2: Prepare a bounded plan and reconstruct text without full-file rewrites

**Files:** Create `src/plan.ts`; create the pure text portion of `src/replay.ts`; extend `test/replay.test.cjs`.

**Consumes:** `readRange`, `readChanges`, `objectInfo`, `readBlob`, `hunkRanges`, and shared contracts.

**Produces:**

```ts
// src/plan.ts
export function preparePlan(
  repo: string, startOid: string, endOid: string, timing: Timing,
  root: string, signal: AbortSignal,
): Promise<Plan>;
export function readRecords(
  plan: Plan, offset: number, signal: AbortSignal,
): AsyncGenerator<{ record: RecordEntry; offset: number; nextOffset: number }>;
// src/replay.ts
export type TextView = {
  oldText: string; newText: string;
  oldLineStarts: number[]; newLineStarts: number[];
};
export function createTextView(oldText: string, newText: string): TextView;
export function frameAt(
  view: TextView, oldBoundary: number, newBoundary: number,
  firstLine: number, rows: number,
): Frame;
```

`createTextView` builds the two line indexes once when the active file loads. `frameAt` reuses them for every update. Release the view when that file completes; no global buffer cache is required. Each index is bounded by the active text-size limit.

- [ ] **1. Add a text reconstruction check.** The code exercises the join inside a line and exact CRLF/Unicode boundaries, where a naive per-line renderer commonly fails.

```js
const { createTextView, frameAt } = require('../dist/replay.js');

test('prefix/suffix rendering preserves the active edit and bounded rows', () => {
  const oldText = 'head\r\nold\r\ntail';
  const newText = 'head\r\nnew🙂\r\ntail';
  const view = createTextView(oldText, newText);
  assert.deepEqual(frameAt(view, 6, 6, 0, 120).lines,
    ['head', 'old', 'tail']);
  assert.deepEqual(frameAt(view, 9, 8, 0, 120).lines,
    ['head', 'ne', 'tail']);
  assert.deepEqual(frameAt(view, oldText.length, newText.length, 0, 120).lines,
    ['head', 'new🙂', 'tail']);
  const many = createTextView('', 'x\n'.repeat(500));
  assert.ok(frameAt(many, 0, many.newText.length, 0, 500).lines.length <= 120);
});
```

Presentation omits CR in the displayed line terminator; raw bytes saved later retain CRLF exactly. `firstLine` is zero-based. Add an assertion that serialized code text stays within 64 KiB and that truncation never splits a surrogate pair. Test missing-final-newline separately from line presentation by comparing final saved bytes in Task 4.

- [ ] **2. Run `npm test`; confirm the new reconstruction check fails before adding the model.**

- [ ] **3. Implement the line indexes and prefix/suffix viewport.** Build indexes in one linear pass, binary-search the requested line, and walk no more than the visible budget. Treat a join without a newline as one logical line. The full string identity used for test oracles is:

```ts
const expected = newText.slice(0, newBoundary) + oldText.slice(oldBoundary);
```

Use that expression only in small tests/final validation, never in the rendering hot path. Add `// ponytail: ordered hunks permit two immutable slices; use an editor text model only if arbitrary user editing is added.` beside the model.

- [ ] **4. Implement sequential preparation and disk records.** Create an exclusive manifest in the already-owned session root. Spool full commit IDs in fixed-width records, then seek backwards. Spool raw change metadata for one commit before requesting its file diffs. For each file, check sizes and raw modes, classify it, decode eligible UTF-8 strictly, find hunk offsets, count graphemes, verify unchanged gaps, and write one bounded JSON record. Check a record's serialized size before append and use the snapshot fallback when needed. Return aggregate minimum/preferred durations, weights, and record count after all writes finish.

```ts
const weight = Math.max(1, edits.reduce(
  (sum, edit) => sum + edit.deleteUnits + edit.insertUnits, 0));
const entryBytes = Buffer.from(JSON.stringify(record) + '\n');
if (entryBytes.length > LIMITS.recordBytes) {
  // Reclassify this file as a snapshot before serializing it again.
  record.kind = 'snapshot';
  record.edits = [];
  record.phases = record.phases.filter(phase => phase.editIndex === null);
  record.weight = 1;
  record.reason = 'Text edit plan exceeds the animation limit';
}
```

All per-hunk phases carry a non-null edit index; the retained null-index phases are file navigation and save. The final serialized record must be rechecked after reclassification, and aggregate weights must use its final form. Also apply a conservative record-size budget while collecting hunks/phases, stopping before an oversized intermediate array is created. Empty commits generate `MilestoneRecord`; classify oversized lines, invalid UTF-8 and binary content with a preview reason. Dispose active buffers before the next file. Stop cancellation before appending another record; delete only incomplete plan files inside the owned session. Preserve the range manifest for an understandable preparation failure.

- [ ] **5. Extend the temporary-repository check to run preparation.** Assert inclusivity, sequential ordinals, all additions/deletions represented, multiple hunks, rename as add/delete, binary/oversized snapshot classification, and no source changes. Check that reading records in a stream produces correct byte offsets for resume. Run `npm test`.

- [ ] **6. Commit** as `feat: prepare bounded replay plans and reconstruct text`.

## Task 3: Add deterministic timing, pause, and background playback

**Files:** Extend `src/replay.ts` and `test/replay.test.cjs`.

**Consumes:** Prepared records, their phase weights, `TextView`, and bounded frame generation.

**Produces:**

```ts
export function phaseDuration(phase: Phase, totals: Totals, timing: Timing): number;
export function extraWait(weight: number, totals: Totals, timing: Timing): number;
export type Clock = {
  now(): number; wallNow(): number;
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
};
export type ReplayEvents = {
  frame(frame: Frame, phase: Phase, phaseElapsedMs: number): void;
  progress(position: Position): void;
  save(record: FileRecord, signal: AbortSignal): Promise<void>;
  checkpoint(checkpoint: Checkpoint): Promise<void>;
  error(message: string): void;
};
export function createReplay(plan: Plan, clock: Clock, events: ReplayEvents): {
  start(checkpoint?: Checkpoint): Promise<void>;
  pause(): Promise<void>;
  resume(): void;
  stop(): Promise<void>;
  setVisible(visible: boolean): void;
  setSpeed(charactersPerSecond: number, pointerMultiplier: number): Promise<void>;
  dispose(): Promise<void>;
};
```

The clock is a test seam for timing correctness, not a general scheduling framework. Production uses `performance.now`, `Date.now`, `setTimeout`, and `clearTimeout`. The controller exclusively owns one active record, its next byte offset, its text view, and the current grapheme iterator. Source blob loads use the reader from Task 1.

- [ ] **1. Add an allocation check before implementing timing.**

```js
const { phaseDuration, extraWait } = require('../dist/replay.js');

test('duration allocation matches the target and rejects impossible timing', () => {
  const phases = [
    { kind: 'move', units: 0, minimumMs: 100, preferredMs: 300,
      target: 'file', editIndex: null },
    { kind: 'type', units: 24, minimumMs: 100, preferredMs: 1000,
      target: 'code', editIndex: 0 },
  ];
  const totals = { minimumMs: 200, preferredMs: 1300, weight: 24, records: 1 };
  for (const durationMs of [200, 800, 1300, 6 * 60 * 60 * 1000]) {
    const timing = { mode: 'duration', durationMs };
    const actual = phases.reduce((n, p) => n + phaseDuration(p, totals, timing), 0)
      + extraWait(24, totals, timing);
    assert.ok(Math.abs(actual - durationMs) < 0.001);
  }
  assert.throws(() => phaseDuration(phases[0], totals,
    { mode: 'duration', durationMs: 199 }), /minimum/i);
});
```

Add zero-work/`preferredMs == minimumMs`, NaN, infinite, negative, and out-of-range settings to this same timing test.

- [ ] **2. Run `npm test` and confirm timing fails.**

- [ ] **3. Implement allocation with the spec's closed-form equations.** This is per-phase constant work, using totals already on disk; no heap of timers and no list of per-character timestamps.

```ts
if (timing.mode === 'speed') return phase.preferredMs;
const target = timing.durationMs;
if (target < totals.minimumMs) throw new RangeError('Duration is below minimum');
if (target >= totals.preferredMs) return phase.preferredMs;
return phase.minimumMs + (phase.preferredMs - phase.minimumMs)
  * (target - totals.minimumMs) / (totals.preferredMs - totals.minimumMs);
```

`extraWait` returns zero for speed mode and compressed-duration mode; otherwise it returns `(durationMs - preferredMs) * weight / totals.weight`. Handle zero records by showing an empty-range error, so total weight is positive for a playable plan. In speed mode, preparation computes preferred phase times from the requested speed. When speed changes while paused, recompute the remaining current-file phases and subsequent streamed records using their unit counts; completed elapsed time is unchanged. Re-estimate remaining time with one cancellable sequential plan scan outside the animation hot path, holding one record at a time. Preserve completed units within the current phase and recompute only its remaining duration. Persist the updated timing in the checkpoint, and recompute phase preferences on subsequent record loads using that setting.

- [ ] **4. Implement the controller and inject a small in-test clock.** Each callback computes elapsed time from the clock, then advances logical phase progress with an active grapheme iterator. Pausing cancels the timeout and freezes its position. A late heartbeat pauses before consuming the late interval. Hidden playback performs state transitions and saves without generating frames. Prepare the next file outside the animation budget. For progress after a long delay, compute the current position directly; never run a loop that dispatches one callback for each missed character.

Use at most one timeout: the next visible text update, phase boundary, or one-second heartbeat, whichever comes first. Batch parsing or grapheme counting must yield between file records. Cancel the pointer loop through a webview message on pause/stop; do not confuse visibility loss with a user pause.

- [ ] **5. Exercise the controller with an actual prepared one-file plan and fake time.** Advance to mid-typing, pause, advance the fake clock by one hour, and assert the next position is unchanged. Resume and finish; assert one save and one completed checkpoint. Repeat with `setVisible(false)` and assert zero frames but the same final save. Advance beyond the heartbeat tolerance and assert a paused checkpoint without a burst of save callbacks. Assert `dispose()` leaves zero scheduled handles. Run `npm test`.

- [ ] **6. Commit** as `feat: schedule replay with bounded updates and reliable pause`.

## Task 4: Persist real scratch bytes and recover safely

**Files:** Create `src/store.ts`; connect its callbacks in `src/extension.ts`; extend `test/replay.test.cjs`.

**Consumes:** `Plan`, `FileRecord`, `Checkpoint`, `readBlob`, and the extension's global storage URI.

**Produces:**

```ts
export function createStore(storageRoot: string, quotaBytes: number): Promise<{
  root: string;
  save(record: FileRecord, repo: string, signal: AbortSignal): Promise<void>;
  checkpoint(value: Checkpoint): Promise<void>;
  readCheckpoint(): Promise<Checkpoint | null>;
  verify(): Promise<{ files: number; bytes: number }>;
  clear(): Promise<void>;
}>;
export function pathKey(pathBase64: string): string;
```

Allow opening an existing session for recovery via an explicit `openStore(root, quotaBytes)` with the same returned methods. It must validate the manifest version, owned-root containment and session identity. `createStore` generates a random child directory; it does not accept an arbitrary destination selected by the webview.

- [ ] **1. Add the path identity check before writing storage.**

```js
const { pathKey } = require('../dist/store.js');

test('scratch keys preserve raw path identity without using repository paths', () => {
  const names = ['../outside', 'A.ts', 'a.ts', 'x\ny', '.git/config', 'CON'];
  const keys = names.map(name => pathKey(Buffer.from(name).toString('base64')));
  assert.equal(new Set(keys).size, names.length);
  for (const key of keys) assert.match(key, /^[a-f0-9]{64}$/);
});
```

- [ ] **2. Run `npm test`, then implement the standard-library key and store ownership.**

```ts
return createHash('sha256').update(Buffer.from(pathBase64, 'base64')).digest('hex');
```

Base64 is validated before decoding at message/plan boundaries. Create private session directories and files; reject unexpected symbolic links under the owned directory. Store raw path identity in the adjacent JSON record. Never join a repository filename onto `root`.

- [ ] **3. Implement streamed writes, quota and checkpoint order.** Reserve bytes for the replacement while the previous file still exists, stream the target to an exclusive temporary sibling, calculate a digest, read back to verify, then rename. Write metadata atomically, then advance the controller checkpoint. Deletion removes only the keyed data file and writes a tombstone. Special modes save metadata and symlink-target bytes as inert data, never a live symlink. Track usage for plans and metadata as well as blob bytes; rebuild counters with one owned-root scan on recovery.

```text
reserve replacement space
stream target -> exclusive temporary data file
verify temporary bytes
rename data to keyed destination
replace keyed metadata
replace completed-record checkpoint
release obsolete allocation from usage count
```

On error, remove only the incomplete temporary file, preserve the previous checkpoint, and surface a paused/error state. A disk or metadata failure after data replacement is recovered by idempotent replay from the last checkpoint; do not assume the multi-file sequence is atomic.

- [ ] **4. Add an integration check using the temporary Git history.** Save CRLF, missing-final-newline and binary blobs; compare bytes to Git's target blobs. Overwrite the same logical path repeatedly and assert only its latest data version remains. Force a quota failure before replacement and assert the previous durable data survives. Simulate an interruption after data rename but before checkpoint, reopen, replay, and assert final bytes/metadata agree. Check deletion tombstones and inert symlink handling. Finally verify source HEAD/index/worktree remain unchanged. Run `npm test`.

- [ ] **5. Connect controller saves/checkpoints and restart recovery.** Resume checks pinned object availability first. A clean pause restores the saved phase offset; a crash restarts the uncompleted file. Closing the panel pauses; extension deactivation stops and disposes children. A completed session runs `verify()` before reporting success.

- [ ] **6. Commit** as `feat: save isolated replay files with checkpoints and quotas`.

## Task 5: Build the VS Code panel and internal pointer playback

**Files:** Complete `src/extension.ts`; create `media/panel.js`, `media/panel.css`, and `README.md`.

**Consumes:** The Git picker/readers, prepared plan, store, controller and `Frame`/`Phase` messages.

**Produces:** The full **Git Replay: Open** flow from the spec.

- [ ] **1. Create an explicit message union and validate it in the host.** `open` uses native repository/commit picking; the panel may send only the following controls. The current session ID must match every active-session message.

```ts
type PanelCommand =
  | { type: 'ready'; sessionId: string }
  | { type: 'start' | 'pause' | 'resume' | 'stop' | 'restart'; sessionId: string }
  | { type: 'speed'; sessionId: string; charactersPerSecond: number; pointerMultiplier: number }
  | { type: 'viewport'; sessionId: string; firstLine: number }
  | { type: 'clear'; sessionId: string };
```

Start and duration settings are chosen through validated native VS Code inputs during preparation. The speed controls are editable only while paused in speed mode. Reject unknown keys that would request paths or commands; require finite numbers and bounded integer viewport indexes. Use runtime checks, because TypeScript does not validate messages.

- [ ] **2. Create the webview with restrictive resources.** Use `enableScripts: true`, local packaged media roots only, no retained hidden context, and no command URIs. Set `default-src 'none'`, allow only the packaged script/style origin, and apply a script nonce. Keep source-derived strings out of the HTML template. Source code enters the view only through messages and text nodes.

```js
row.textContent = line;
label.textContent = commitSubject;
pointer.style.pointerEvents = 'none';
```

The HTML provides semantic buttons, range/number inputs, a progress element, a paged changed-files region and a code region. Style these with VS Code theme variables. A single small pointer element uses transform positioning. There is no operating-system automation call, hidden native editor, or HTML representation of executable source content.

- [ ] **3. Wire bounded rendering and pointer actions.** Reuse a pool of at most 120 line nodes. Map `Phase.target` to the visible file row or code/caret location. On a move, obtain source/target rectangles once, then interpolate with `t * t * (3 - 2 * t)` inside one requestAnimationFrame loop capped to 30 Hz. Hover holds the position; click changes the pointer's visual state and invokes the panel's own selection handler, not a synthetic system event. Scrolling adjusts only the panel's code viewport. Cancel the animation on pause, hidden view, disposal, or reduced motion.

```js
const progress = Math.min(1, elapsedMs / Math.max(1, durationMs));
const eased = progress * progress * (3 - 2 * progress);
pointer.style.transform = `translate(${startX + (endX - startX) * eased}px, ${startY + (endY - startY) * eased}px)`;
```

Track pointer coordinates in panel-local pixels. On resize, recompute the target once and continue from the current position; do not query layout every frame. Actual user interaction with replay controls remains usable because the pointer cannot intercept input. Don't focus the webview or native editor during automated navigation.

- [ ] **4. Wire lifecycle explicitly.** `onDidChangeViewState` calls `setVisible`; panel disposal pauses and releases UI state; recreation requests a current snapshot. The extension host is authoritative even when the webview DOM is destroyed. Keep only small UI preferences in VS Code webview state. Hide stops UI messages, while logical replay still reaches exact scratch saves.

- [ ] **5. Run `npm test` and a focused manual F5 check.** Use a repository with actual code additions and replacements. Start playback and type in an unrelated VS Code file while moving the real pointer in another app; verify zero interference. Check file navigation, click/hover, Unicode caret position, pause, speed change, hidden/recreated panel, narrow layout, keyboard controls and reduced motion. Include source text `</script><img src=x onerror=alert(1)>` and verify it displays literally with no execution. Add a small pure message-validator assertion to the existing test file for invalid numbers and wrong session IDs; a new UI test framework is unnecessary.

- [ ] **6. Document the controls and their limits.** Explain inclusive first-parent history, snapshot fallbacks, sparse storage/save boundaries, animated versus system pointer, duration versus speed, paused recovery, and how to clear storage. Use a visible title **Git Replay** and a normal progress display. Do not describe it as proven screen-tracker evasion or an original work-session recording.

- [ ] **7. Commit** as `feat: add isolated VS Code playback panel`.

## Task 6: Measure resource scaling and package the extension

**Files:** Create `scripts/benchmark.cjs`; update `README.md` with actual measured results; produce `trackskipper.vsix` locally.

**Consumes:** Complete extension, preparation/controller APIs, and tests from Tasks 1–5.

**Produces:** A reproducible performance report and locally installable build.

- [ ] **1. Build a benchmark with a controlled history shape.** Generate separate temporary repositories with 100 and 1,000 commits. Each contains one 256 KiB text file whose single fixed-width line changes per commit; keep file size and line lengths constant. Use `git commit-tree`/temporary indexes for fixture creation if normal commits dominate setup, but report setup separately. Use the same replay limits and identical timing inputs for both cases. The benchmark owns and removes only its generated temporary directories.

```js
const start = performance.now();
const memoryBefore = process.memoryUsage();
const plan = await preparePlan(repo, startOid, endOid,
  { mode: 'duration', durationMs: 6 * 60 * 60 * 1000 }, store.root, signal);
const preparationMs = performance.now() - start;
const memoryAfter = process.memoryUsage();
process.stdout.write(JSON.stringify({
  commits: count, preparationMs,
  heapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
  rssDelta: memoryAfter.rss - memoryBefore.rss,
  records: plan.totals.records,
}) + '\n');
```

Run multiple samples and report medians; use `node --expose-gc` for retained-heap comparisons, invoking GC before both measurements. Sample during execution for peak memory instead of using only endpoints. Measure Git subprocess peak RSS separately with the OS profiler, and label unavailable cross-platform measurements rather than inventing them. Measure plan/scratch bytes, child-process count, viewport-node count, UI message frequency, controller response latency, and open file descriptors. Account for intentionally elapsed playback time separately from compute time.

- [ ] **2. Run the targeted checks once.**

```text
npm test
npm run benchmark
npm run build
git diff --check
```

Targets: no more than 10 MiB extra retained extension heap for 1,000 versus 100 commits of the same shape; p95 pause/stop response below 100 ms during normal playback; no third Git child; no file-buffer accumulation; no more than 120 code rows, 10 host updates/second or 30 moving-pointer frames/second. Treat failures as findings to fix or accurately report, not values to conceal. Do not equate linear-looking benchmark results with a worst-case complexity proof.

- [ ] **3. Exercise virtual six-hour playback plus a real long run.** The virtual clock checks exact duration allocation without waiting six hours. One real six-hour smoke run checks practical extension lifecycle and memory behavior before advertising six-hour reliability. During that run, use another app, hide/reopen the panel, and pause/resume. Record wall-clock delays separately from active playback duration. If the long run is not completed, explicitly mark it unverified in the README and delivery report.

- [ ] **4. Package and install locally for a final smoke check.** Run `npm run package`, inspect the VSIX file list, and install it in a VS Code development/test profile. Confirm the packaged media files load, the command works in a trusted local repository, and replay completes to correct scratch bytes. Check the version floor in a compatible VS Code test profile before claiming that floor; otherwise raise the floor to the tested version and update both documents. Do not publish to the Marketplace in this task.

- [ ] **5. Record results and commit** as `test: verify replay scaling and package local extension`. Include platform/tool versions, test outcomes, measured resource values, and any remaining unverified long-run/platform checks.

## Completion evidence

The implementation is complete when the automated behavior checks pass, source files remain unchanged, the isolated pointer/code playback works during normal PC use, final scratch bytes match pinned target blobs, quota/recovery checks succeed, resource measurements are recorded, and the local VSIX smoke test passes. State any unperformed long-run or platform checks explicitly.

## Plan review and handoff

This plan preserves the user's requirements with a webview rather than a virtual machine. Its complexity claims separate extension-owned state from Git and VS Code internals. First-parent merge semantics, sparse scratch output, save boundaries, timing precedence, and snapshot fallbacks are explicit so implementation does not guess them.

The plan is ready for review and a subsequent build request. All implementation checkboxes remain open. The workspace is not yet a Git repository, so these planning documents have not been committed.
