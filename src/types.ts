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
