/**
 * `test/pty/run-smoke.sh` helpers with a stable entry point: `--wordmark <capture>` prints the wordmark cells (`██`)
 * before and after the frame that first echoes `› h` (TUI-DESIGN-2 §5.3: the frame that shows the key shows no wordmark
 * row). The cut must be the start of the echo's frame unit (the cursor hide `ESC[?25l`), not the echo's byte offset —
 * the wordmark rows of that frame sit above the composer row and would otherwise count as "before".
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../pty/helpers.js';

const SMOKE = join(ROOT, 'test', 'pty', 'run-smoke.sh');
const HIDE = '\x1b[?25l';
const WM = '████';

function frame(rows: readonly string[]): string {
  return `${HIDE}${rows.join('\r\n')}\r\n\x1b[?25h`;
}

function wordmarkOf(capture: string): [number, number] {
  const dir = mkdtempSync(join(tmpdir(), 'jevcode-smoke-wm-'));
  try {
    const p = join(dir, 'cap.bin');
    writeFileSync(p, capture, 'utf8');
    const r = spawnSync('/bin/sh', [SMOKE, '--wordmark', p], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 });
    expect(r.status).toBe(0);
    const [a, b] = r.stdout.trim().split(' ').map(Number);
    return [a!, b!];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('run-smoke.sh --wordmark (the splash cut)', () => {
  const splash = frame(['────', `  ${WM} ▓▒░`, '╭─ jev-only ─╮', '│ › Say hi │', '╰──╯']);
  it('a clean cancel: wordmark cells only in the frames before the echo frame → "<n> 0"', () => {
    const echoClean = frame(['─── ◆ jevcode 0.2.0 ──', '╭─ jev-only ─╮', '│ › h │', '╰──╯']);
    expect(wordmarkOf(splash + splash + echoClean + echoClean)).toEqual([4, 0]);
  });
  it('a regression: the echo frame still draws the wordmark above the character → after_key > 0 (the cut is the frame start, not the echo offset)', () => {
    const echoWithWordmark = frame(['────', `  ${WM} ▓▒░`, '╭─ jev-only ─╮', '│ › h │', '╰──╯']);
    expect(wordmarkOf(splash + splash + echoWithWordmark)).toEqual([4, 2]);
  });
  it('no echo at all: everything counts as before; an `--ascii` `> h` echo is recognised too', () => {
    expect(wordmarkOf(splash)).toEqual([2, 0]);
    const ascii = frame(['----', '  #### #+.', '+- jev-only -+', '| > h |', '+--+']);
    expect(wordmarkOf(splash + ascii)).toEqual([2, 0]);
  });
});
