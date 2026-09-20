/**
 * Render lag (DESIGN.md §12): a mocked run under the real TUI in a sized pseudo-TTY, twice
 * (rows 40 and rows 12). The child runs a 10 ms setInterval lag probe (--perf-lag-probe) and
 * prints LAG_JSON at exit; the pty output is scanned for Ink clear-terminal sequences.
 * Gates: lag p95 < 5 ms, max < 50 ms, zero clears after the first frame, at both geometries.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LagGeometry {
  rows: number;
  lagP50: number | null;
  lagP95: number | null;
  lagMax: number | null;
  samples: number;
  clears: number;
  exitCode: number | null;
  steps: number;
}
export interface RenderLagResult {
  rows40: LagGeometry;
  rows12: LagGeometry;
  pass: boolean;
}

function runGeometry(bin: string, rows: number, steps: number): Promise<LagGeometry> {
  return new Promise((resolve) => {
    const ws = mkdtempSync(join(tmpdir(), 'jevcode-perf-lag-ws-'));
    const runs = mkdtempSync(join(tmpdir(), 'jevcode-perf-lag-runs-'));
    const cmd = `stty rows ${rows} cols 120; exec "${process.execPath}" "${bin}" run "perf lag probe" --workspace "${ws}" --runs-dir "${runs}" --mock --mock-steps ${steps} --max-steps ${steps} --sandbox none --perf-lag-probe`;
    const child = spawn('/usr/bin/script', ['-q', '/dev/null', 'sh', '-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: process.env['HOME'] ?? ws, TERM: 'xterm-256color' },
    });
    let acc = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', (b: Buffer) => { acc += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { acc += b.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      rmSync(ws, { recursive: true, force: true });
      rmSync(runs, { recursive: true, force: true });
      const m = /LAG_JSON=(\{.*?\})/.exec(acc);
      const lag = m ? (JSON.parse(m[1]!) as { p50: number | null; p95: number | null; max: number; samples: number }) : null;
      // count clear-terminal sequences after the first frame ('step 0/' sentinel)
      const first = acc.indexOf('step 0/');
      const after = first >= 0 ? acc.slice(first + 7) : acc;
      const clears = (after.match(/\x1b\[2J/g) ?? []).length;
      const stepsSeen = (acc.match(/\[step \d+\]/g) ?? []).length;
      resolve({ rows, lagP50: lag?.p50 ?? null, lagP95: lag?.p95 ?? null, lagMax: lag?.max ?? null, samples: lag?.samples ?? 0, clears, exitCode: code, steps: stepsSeen });
    });
  });
}

export async function measureRenderLag(opts: { bin: string; steps: number }): Promise<RenderLagResult> {
  const rows40 = await runGeometry(opts.bin, 40, opts.steps);
  const rows12 = await runGeometry(opts.bin, 12, opts.steps);
  const ok = (g: LagGeometry): boolean => g.lagP95 !== null && g.lagP95 < 5 && g.lagMax !== null && g.lagMax < 50 && g.clears === 0 && g.samples > 0;
  return { rows40, rows12, pass: ok(rows40) && ok(rows12) };
}
