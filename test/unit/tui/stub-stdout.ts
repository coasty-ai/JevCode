/**
 * TUI-DESIGN §19.3: `StubStdout(rows, columns)` / `StubStdin` for the ink-testing-library and raw `render()` tests
 * (extracted from height.test.tsx so every O3/O4/O9 test shares one fixture). `dynamicRegion()` finds the rows the
 * §2 budget bounds: everything from the last rule row (`─` × columns or the pane's tab header) onwards.
 */
import { EventEmitter } from 'node:events';

export class StubStdout extends EventEmitter {
  frames: string[] = [];
  rows: number;
  columns: number;
  isTTY: boolean | undefined;
  constructor(rows: number, columns: number, isTTY: boolean | undefined = undefined) {
    super();
    this.rows = rows;
    this.columns = columns;
    this.isTTY = isTTY;
  }
  write = (s: string): boolean => {
    this.frames.push(s);
    return true;
  };
  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
  /** emulate SIGWINCH: Ink's `useWindowSize` listens for `resize` on the stream */
  resize(rows: number, columns: number): void {
    this.rows = rows;
    this.columns = columns;
    this.emit('resize');
  }
}

export class StubStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  private buffered: string | null = null;
  setEncoding(): void {}
  setRawMode(on: boolean): void {
    this.isRaw = on;
  }
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read(): string | null {
    const d = this.buffered;
    this.buffered = null;
    return d;
  }
  /** deliver bytes the way a terminal does (Ink reads on `readable`) */
  write(data: string): void {
    this.buffered = (this.buffered ?? '') + data;
    this.emit('readable');
  }
}

/** The rule row: `─` × columns, or the pane's tab header (starts with `───`; ends with `──`, or `─── plan ─` side by side at ≥ 120×40). */
export function isRuleRow(line: string, columns: number): boolean {
  const t = line.replace(/\x1b\[[0-9;]*m/g, '');
  if (t === '─'.repeat(columns) || t === '-'.repeat(columns)) return true;
  return /^[─-]{3} .* [─-]+$/.test(t) && t.length <= columns;
}

/** Dynamic region = everything from the last rule row onwards (the <Static> scrollback sits above it). */
export function dynamicRegion(frame: string, columns: number): string[] {
  const lines = frame.replace(/\n$/, '').split('\n');
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isRuleRow(lines[i] ?? '', columns)) {
      idx = i;
      break;
    }
  }
  return idx === -1 ? [] : lines.slice(idx);
}

/** Strip SGR so width and text assertions see the cells. */
export function stripSgr(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
