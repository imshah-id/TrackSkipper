import { Phase, Timing, Totals } from './types';
export function validateTiming(value: unknown): asserts value is Timing {
  if (!value || typeof value !== 'object') throw new Error('Choose a playback timing mode');
  const input = value as Record<string, unknown>;
  if (input.mode === 'duration' && typeof input.durationMs === 'number' && Number.isFinite(input.durationMs)
    && input.durationMs > 0 && input.durationMs <= 30 * 86400000) return;
  if (input.mode === 'speed' && typeof input.charactersPerSecond === 'number'
    && Number.isFinite(input.charactersPerSecond) && input.charactersPerSecond >= 1 && input.charactersPerSecond <= 200
    && typeof input.pointerMultiplier === 'number' && Number.isFinite(input.pointerMultiplier)
    && input.pointerMultiplier >= 0.25 && input.pointerMultiplier <= 4) return;
  throw new RangeError('Use a positive duration up to 30 days, or 1–200 characters/sec and 0.25–4× pointer speed');
}

export function preferredDuration(phase: Phase, timing: Timing): number {
  if (timing.mode === 'duration') return phase.preferredMs;
  if (phase.kind === 'type' || phase.kind === 'delete') return phase.units * 1000 / timing.charactersPerSecond;
  if (phase.kind === 'move') return Math.max(phase.minimumMs, 350 / timing.pointerMultiplier);
  if (phase.kind === 'scroll') return Math.max(phase.minimumMs, 300 / timing.pointerMultiplier);
  return phase.preferredMs;
}

export function phaseDuration(phase: Phase, totals: Totals, timing: Timing): number {
  validateTiming(timing);
  if (timing.mode === 'speed') return preferredDuration(phase, timing);
  if (timing.durationMs < totals.minimumMs) throw new RangeError(`Duration is below minimum (${Math.ceil(totals.minimumMs / 1000)} seconds)`);
  if (timing.durationMs >= totals.preferredMs) return phase.preferredMs;
  return phase.minimumMs + (phase.preferredMs - phase.minimumMs)
    * (timing.durationMs - totals.minimumMs) / (totals.preferredMs - totals.minimumMs);
}

export function extraWait(weight: number, totals: Totals, timing: Timing): number {
  validateTiming(timing);
  return timing.mode === 'duration' && totals.weight > 0
    ? Math.max(0, timing.durationMs - totals.preferredMs) * weight / totals.weight : 0;
}
