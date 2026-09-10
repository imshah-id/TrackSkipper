export { createTextView, frameAt, lineStarts, lineAt } from './view';
export type { TextView } from './view';
import { Checkpoint, FileRecord, Frame, LIMITS, Phase, Plan, Position, RecordEntry, Timing } from './types';
import { createTextView, frameAt, lineAt, lineStarts, TextView } from './view';
import { readRecords, textBlob } from './plan';
import { extraWait, phaseDuration, validateTiming } from './timing';

export type Clock = {
  now(): number; wallNow(): number;
  schedule(callback: () => void | Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
};
export const systemClock: Clock = {
  now: () => performance.now(), wallNow: () => Date.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  cancel: handle => clearTimeout(handle as NodeJS.Timeout),
};
export type ReplayStatus = 'ready' | 'running' | 'paused' | 'stopped' | 'complete' | 'error';
export type ReplayEvents = {
  frame(frame: Frame, phase: Phase, phaseElapsedMs: number, durationMs: number): void;
  progress(position: Position): void;
  save(record: FileRecord, signal: AbortSignal): Promise<void>;
  checkpoint(checkpoint: Checkpoint): Promise<void>;
  error(message: string): void;
  record?(record: RecordEntry): void;
  status?(status: ReplayStatus): void;
};

export function createReplay(plan: Plan, clock: Clock, events: ReplayEvents) {
  validateTiming(plan.timing);
  const totals = plan.totals;
  if (!totals || ![totals.minimumMs, totals.preferredMs, totals.weight].every(value => Number.isFinite(value) && value >= 0)
    || totals.minimumMs > totals.preferredMs || totals.weight < 1 || !Number.isSafeInteger(totals.records) || totals.records < 1) throw new Error('Invalid replay plan totals');
  let timing: Timing = plan.timing, status: ReplayStatus = 'ready';
  const cancellation = new AbortController();
  let position: Position = { recordOffset: 0, phaseIndex: 0, phaseElapsedMs: 0, playbackElapsedMs: 0 };
  let completedOffset = 0, nextOffset = 0;
  let iterator: ReturnType<typeof readRecords> | undefined;
  let record: RecordEntry | undefined, view: TextView | undefined;
  let schedule: Array<{ phase: Phase; duration: number }> = [];
  let timer: unknown, pending = Promise.resolve();
  let visible = true, lastTime = 0, lastWall = 0, delay = 0, lastFrameTime = -Infinity;
  let oldBoundary = 0, newBoundary = 0, viewport: number | undefined;
  let phaseView: TextView | undefined, deletionView: TextView | undefined, deletionEdit = -1;
  let stepOffsets = new Uint32Array(0), stepBeats = new Float64Array(0), consumed = 0, totalBeats = 0;
  let totalMs = timing.mode === 'duration' ? timing.durationMs : plan.totals.preferredMs;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const setStatus = (value: ReplayStatus) => { status = value; events.status?.(value); };
  const cancelTimer = () => { if (timer !== undefined) clock.cancel(timer); timer = undefined; };
  const current = () => schedule[position.phaseIndex];
  const makeSchedule = (entry: RecordEntry) => {
    const result = entry.phases.map(phase => ({ phase, duration: phaseDuration(phase, plan.totals, timing) }));
    const wait = extraWait(entry.weight, plan.totals, timing);
    if (wait > 0) result.unshift({ phase: { kind: 'wait', units: 0, preferredMs: wait, minimumMs: 0, target: 'file', editIndex: null }, duration: wait });
    return result;
  };
  const persist = async (state: Checkpoint['status'], precise = true) => {
    await events.checkpoint({ version: 1, planId: plan.id, completedOffset, timing, playbackElapsedMs: position.playbackElapsedMs,
      pausedPosition: precise && record ? { ...position } : null, status: state });
  };

  async function updateTotal(): Promise<void> {
    let remaining = 0, first = true;
    for await (const entry of readRecords(plan, position.recordOffset, cancellation.signal)) {
      const items = makeSchedule(entry.record);
      remaining += items.slice(first ? position.phaseIndex : 0).reduce((sum, item) => sum + item.duration, 0);
      if (first) remaining -= position.phaseElapsedMs;
      first = false;
    }
    totalMs = position.playbackElapsedMs + remaining;
  }

  function updateBoundaries(): void {
    const item = current();
    if (!view || !item || record?.kind !== 'text') return;
    if (item.phase.kind === 'save') { oldBoundary = view.oldText.length; newBoundary = view.newText.length; return; }
    const wanted = totalBeats * (item.duration ? position.phaseElapsedMs / item.duration : 1);
    while (consumed < stepOffsets.length && stepBeats[consumed] <= wanted + 1e-7) {
      newBoundary = stepOffsets[item.phase.kind === 'delete' ? stepOffsets.length - 1 - consumed : consumed];
      consumed++;
    }
  }

  function initializePhase(): void {
    stepOffsets = new Uint32Array(0); stepBeats = new Float64Array(0); consumed = 0; totalBeats = 0; phaseView = view;
    const phase = current()?.phase;
    if (!phase || !view || record?.kind !== 'text') return;
    if (phase.editIndex !== null) {
      const edit = record.edits[phase.editIndex];
      if (!edit || edit.oldStart < 0 || edit.newStart < 0 || edit.oldEnd > view.oldText.length || edit.newEnd > view.newText.length) throw new Error('Invalid text edit range');
      oldBoundary = phase.kind === 'type' ? edit.oldEnd : edit.oldStart;
      newBoundary = edit.newStart;
      if (phase.kind !== 'type' && edit.deleteUnits) {
        if (deletionEdit !== phase.editIndex) {
          const prefix = view.newText.slice(0, edit.newStart) + view.oldText.slice(edit.oldStart, edit.oldEnd);
          deletionView = { ...view, newText: prefix, newLineStarts: lineStarts(prefix) }; deletionEdit = phase.editIndex;
        }
        phaseView = deletionView;
        oldBoundary = edit.oldEnd; newBoundary = edit.newStart + edit.oldEnd - edit.oldStart;
      }
      if (phase.kind === 'delete' || phase.kind === 'type') {
        const text = phase.kind === 'delete' ? view.oldText.slice(edit.oldStart, edit.oldEnd) : view.newText.slice(edit.newStart, edit.newEnd);
        if (phase.units > text.length) throw new Error('Text phase exceeds its source range');
        stepOffsets = new Uint32Array(phase.units); stepBeats = new Float64Array(phase.units);
        let index = 0, previous = '';
        for (const part of segmenter.segment(text)) {
          stepOffsets[index] = edit.newStart + part.index + (phase.kind === 'type' ? part.segment.length : 0);
          // Deterministic beats preserve the same frame after resume and keep the phase's total duration.
          totalBeats += phase.kind === 'delete' ? (index < 2 ? 1.8 : 0.65)
            : /\n/.test(previous) ? 4 : /[;,{}()]/.test(previous) ? 2 : 0.7 + (index * 7 % 5) * 0.15;
          stepBeats[index++] = totalBeats; previous = part.segment;
        }
        if (index !== phase.units) throw new Error('Text phase does not match its source range');
      }
    }
    updateBoundaries();
  }

  function emit(force = false): void {
    events.progress({ ...position });
    if (!visible || !current() || (!force && clock.now() - lastFrameTime < 1000 / LIMITS.hostHz)) return;
    const item = current()!;
    let frame: Frame;
    if (phaseView) {
      const firstLine = viewport ?? Math.max(0, lineAt(phaseView.newLineStarts, newBoundary) - 6);
      frame = frameAt(phaseView, oldBoundary, newBoundary, firstLine, LIMITS.frameRows);
    } else frame = { firstLine: 0, lines: [record?.kind === 'milestone' ? 'No file changes in this commit.' : (record as FileRecord | undefined)?.reason ?? 'Saving exact file bytes.'], caret: null };
    lastFrameTime = clock.now(); events.frame(frame, item.phase, position.phaseElapsedMs, item.duration);
  }

  async function loadNext(): Promise<boolean> {
    const next = await iterator!.next();
    if (next.done) {
      if (visible && view && record) {
        const firstLine = viewport ?? Math.max(0, lineAt(view.newLineStarts, view.newText.length) - 6);
        events.frame(frameAt(view, view.oldText.length, view.newText.length, firstLine, LIMITS.frameRows), record.phases.at(-1)!, 0, 0);
      }
      record = undefined; view = phaseView = deletionView = undefined; schedule = [];
      stepOffsets = new Uint32Array(0); stepBeats = new Float64Array(0); return false;
    }
    record = next.value.record; nextOffset = next.value.nextOffset; position.recordOffset = next.value.offset;
    schedule = makeSchedule(record); viewport = undefined; view = undefined; deletionView = undefined; deletionEdit = -1; oldBoundary = 0; newBoundary = 0;
    if (record.kind === 'text') view = createTextView(await textBlob(plan.repo, record.change.oldOid, cancellation.signal), await textBlob(plan.repo, record.change.newOid, cancellation.signal));
    if (!Number.isSafeInteger(position.phaseIndex) || position.phaseIndex >= schedule.length || position.phaseIndex < 0
      || position.phaseElapsedMs < 0 || !Number.isFinite(position.phaseElapsedMs)
      || position.phaseElapsedMs > schedule[position.phaseIndex].duration + 1e-6) throw new Error('Invalid saved playback position');
    events.record?.(record); initializePhase(); return true;
  }

  function arm(): void {
    cancelTimer();
    if (status !== 'running') return;
    const item = current();
    const active = item && ['type', 'delete', 'move', 'scroll'].includes(item.phase.kind);
    delay = Math.max(0, Math.min(item ? item.duration - position.phaseElapsedMs : 0, visible && active ? 100 : 1000));
    lastTime = clock.now(); lastWall = clock.wallNow();
    timer = clock.schedule(async () => {
      timer = undefined;
      pending = tick().catch(fail);
      await pending;
    }, delay);
  }

  async function fail(error: unknown): Promise<void> {
    if (cancellation.signal.aborted) return;
    cancelTimer(); setStatus('error');
    events.error(error instanceof Error ? error.message : String(error));
    await persist('paused').catch(() => undefined);
  }

  async function tick(): Promise<void> {
    if (status !== 'running') return;
    const elapsed = clock.now() - lastTime, wallElapsed = clock.wallNow() - lastWall;
    if (elapsed - delay > LIMITS.lateHeartbeatMs || Math.abs(wallElapsed - elapsed) > LIMITS.lateHeartbeatMs) {
      setStatus('paused'); await persist('paused'); emit(true); return;
    }
    let budget = Math.max(0, elapsed);
    while (record && (status === 'running' || position.phaseIndex === schedule.length)) {
      const item = current();
      if (!item) {
        completedOffset = nextOffset;
        position.recordOffset = nextOffset; position.phaseIndex = 0; position.phaseElapsedMs = 0;
        await persist('paused', false);
        if (cancellation.signal.aborted) { record = undefined; view = undefined; return; }
        if (!await loadNext()) {
          if (cancellation.signal.aborted) return;
          setStatus('complete'); await persist('complete', false); emit(); return;
        }
        continue;
      }
      const advance = Math.min(budget, Math.max(0, item.duration - position.phaseElapsedMs));
      position.phaseElapsedMs += advance; position.playbackElapsedMs += advance; budget -= advance;
      updateBoundaries();
      if (position.phaseElapsedMs + 1e-7 < item.duration) break;
      if (item.phase.kind === 'save' && record.kind !== 'milestone') await events.save(record, cancellation.signal);
      position.phaseIndex++; position.phaseElapsedMs = 0; initializePhase();
      if (budget <= 0 && current()?.duration) break;
    }
    emit(); arm();
  }

  return {
    async start(checkpoint?: Checkpoint): Promise<void> {
      if (status !== 'ready') throw new Error('Replay has already started');
      if (checkpoint) {
        if (checkpoint.version !== 1 || checkpoint.planId !== plan.id || !Number.isSafeInteger(checkpoint.completedOffset) || checkpoint.completedOffset < 0) throw new Error('Checkpoint does not match this session');
        validateTiming(checkpoint.timing); timing = checkpoint.timing; completedOffset = checkpoint.completedOffset;
        position = checkpoint.pausedPosition ? { ...checkpoint.pausedPosition } : { recordOffset: completedOffset, phaseIndex: 0, phaseElapsedMs: 0, playbackElapsedMs: checkpoint.playbackElapsedMs ?? 0 };
        if (position.recordOffset !== completedOffset || !Number.isSafeInteger(position.phaseIndex) || position.phaseIndex < 0
          || !Number.isFinite(position.playbackElapsedMs) || position.playbackElapsedMs < 0
          || !Number.isFinite(position.phaseElapsedMs) || position.phaseElapsedMs < 0) throw new Error('Invalid saved playback position');
      }
      iterator = readRecords(plan, position.recordOffset, cancellation.signal); setStatus('running');
      pending = (async () => {
        if (!await loadNext()) { totalMs = position.playbackElapsedMs; setStatus('complete'); await persist('complete', false); return; }
        if (checkpoint && timing.mode === 'speed') await updateTotal();
        emit(true); arm();
      })();
      try { await pending; } catch (error) { await fail(error); throw error; }
    },
    async pause(): Promise<void> {
      if (status !== 'running') return;
      cancelTimer(); setStatus('paused'); await pending; await persist('paused'); emit(true);
    },
    resume(): void { if (status === 'paused') { setStatus('running'); emit(true); arm(); } },
    async stop(): Promise<void> {
      cancelTimer(); setStatus('stopped'); cancellation.abort();
      await pending.catch(() => undefined); await iterator?.return(undefined); await persist('stopped');
    },
    setVisible(value: boolean): void { visible = value; if (value) emit(true); },
    setViewport(firstLine: number): void { if (Number.isSafeInteger(firstLine) && firstLine >= 0) { viewport = firstLine; emit(true); } },
    follow(): void { viewport = undefined; emit(true); },
    async setSpeed(charactersPerSecond: number, pointerMultiplier: number): Promise<void> {
      if (status !== 'paused' || timing.mode !== 'speed') throw new Error('Pause a fixed-speed replay before changing speed');
      const next: Timing = { mode: 'speed', charactersPerSecond, pointerMultiplier }; validateTiming(next);
      const fraction = current()?.duration ? position.phaseElapsedMs / current()!.duration : 0;
      timing = next;
      if (record) { schedule = makeSchedule(record); position.phaseElapsedMs = fraction * (current()?.duration ?? 0); initializePhase(); }
      await updateTotal(); await persist('paused'); emit(true);
    },
    getState() { return { status, position: { ...position }, record, timing, totalMs, phase: current()?.phase, phaseDurationMs: current()?.duration ?? 0 }; },
    async dispose(): Promise<void> {
      cancelTimer(); cancellation.abort(); await pending.catch(() => undefined); await iterator?.return(undefined);
      view = phaseView = deletionView = undefined; record = undefined; schedule = []; stepOffsets = new Uint32Array(0); stepBeats = new Float64Array(0);
    },
  };
}
