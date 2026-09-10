import { Frame, LIMITS } from './types';
export type TextView = { oldText: string; newText: string; oldLineStarts: number[]; newLineStarts: number[] };
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

export function createTextView(oldText: string, newText: string): TextView {
  return { oldText, newText, oldLineStarts: lineStarts(oldText), newLineStarts: lineStarts(newText) };
}

export function lineAt(starts: number[], offset: number): number {
  let low = 0, high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

// ponytail: ordered edits need only two immutable slices; arbitrary user editing would need a text model.
export function frameAt(view: TextView, oldBoundary: number, newBoundary: number, firstLine: number, rows: number): Frame {
  const { oldText, newText, oldLineStarts, newLineStarts } = view;
  oldBoundary = Math.max(0, Math.min(oldText.length, oldBoundary));
  newBoundary = Math.max(0, Math.min(newText.length, newBoundary));
  const joinLine = lineAt(newLineStarts, newBoundary);
  const oldJoin = lineAt(oldLineStarts, oldBoundary);
  const totalLines = joinLine + oldLineStarts.length - oldJoin;
  firstLine = Math.max(0, Math.min(totalLines - 1, Math.trunc(firstLine)));
  rows = Math.max(1, Math.min(LIMITS.frameRows, Math.trunc(rows)));
  const lines: string[] = [];
  let remaining = LIMITS.frameBytes;
  for (let line = firstLine; line < Math.min(totalLines, firstLine + rows) && remaining > 0; line++) {
    let value: string;
    if (line < joinLine) value = newText.slice(newLineStarts[line], newLineStarts[line + 1]);
    else if (line === joinLine) value = newText.slice(newLineStarts[joinLine], newBoundary)
      + oldText.slice(oldBoundary, oldLineStarts[oldJoin + 1] ?? oldText.length);
    else {
      const oldLine = oldJoin + line - joinLine;
      value = oldText.slice(oldLineStarts[oldLine], oldLineStarts[oldLine + 1] ?? oldText.length);
    }
    value = value.replace(/\n$/, '').replace(/\r$/, '');
    if (Buffer.byteLength(value) > remaining) {
      let bytes = 0, end = 0;
      for (const character of value) {
        const size = Buffer.byteLength(character);
        if (bytes + size > remaining) break;
        bytes += size; end += character.length;
      }
      value = value.slice(0, end);
    }
    remaining -= Buffer.byteLength(value);
    lines.push(value);
  }
  const caretRow = joinLine - firstLine;
  const column = newBoundary - newLineStarts[joinLine];
  return { firstLine, lines, caret: caretRow >= 0 && caretRow < lines.length && column <= lines[caretRow].length
    ? { row: caretRow, column } : null };
}
