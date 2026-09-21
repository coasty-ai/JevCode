/**
 * TUI-DESIGN §13.6 / §19.0 `src/cli/report.ts`: the bundle holds run.json, transcript.log, jevcode.log, the last 20
 * steps.jsonl rows, config.json, versions.txt and README.txt; every file passes `redact`; jev.jsonl only with
 * `--include-requests`; missing sources are listed, never fatal; `commandReport` exit codes.
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPORT_STEPS_TAIL, commandReport, newestSessionLog, readmeText, tailLines, versionsText, writeReportBundle, type ReportFs } from '../../../src/cli/report.js';

const SECRET = 'sk-ant-api03-SECRETSECRETSECRETSECRETSECRET1234';
const redact = (s: string): string => s.split(SECRET).join('[REDACTED:test]');

function memFs(files: Record<string, string>): ReportFs & { written: Map<string, string>; dirs: string[] } {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    written,
    dirs,
    readFile: async (p) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' });
      return v;
    },
    writeFile: async (p, t) => {
      written.set(p, t);
    },
    mkdir: async (p) => {
      dirs.push(p);
    },
  };
}

const steps = Array.from({ length: 25 }, (_, i) => JSON.stringify({ step: i + 1, decisions: [] })).join('\n') + '\n';

describe('writeReportBundle (§13.6)', () => {
  it('writes the seven files through redact, keeps the last 20 steps, lists missing sources and never includes jev.jsonl by default', async () => {
    const fs = memFs({
      '/runs/R1/run.json': `{"runId":"R1","task":"use ${SECRET}"}`,
      '/runs/R1/transcript.log': `[run] start R1 ${SECRET}\n`,
      '/runs/R1/steps.jsonl': steps,
      '/runs/R1/jev.jsonl': `{"body":"${SECRET}"}\n`,
    });
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: { 'limits.spendCapUsd': { value: '2', source: 'default' } }, term: 'xterm', termProgram: null, columns: 80, rows: 24, version: '0.1.0', inkVersion: '7.1.1', nodeVersion: 'v22.23.2', platform: 'darwin', fs });
    expect(r.dir).toBe('/reports/R1');
    expect(r.files).toEqual(['run.json', 'transcript.log', 'steps.tail.jsonl', 'config.json', 'versions.txt', 'README.txt']);
    expect(r.missing).toEqual(['jevcode.log']);
    expect(fs.dirs).toEqual(['/reports/R1']);
    for (const [p, t] of fs.written) expect(t, p).not.toContain(SECRET);
    expect(fs.written.get(join('/reports/R1', 'run.json'))).toContain('[REDACTED:test]');
    const tail = fs.written.get(join('/reports/R1', 'steps.tail.jsonl'))!.trim().split('\n');
    expect(tail).toHaveLength(REPORT_STEPS_TAIL);
    expect(JSON.parse(tail[0]!)).toEqual({ step: 6, decisions: [] });
    expect(fs.written.get(join('/reports/R1', 'versions.txt'))).toBe(versionsText({ term: 'xterm', termProgram: null, columns: 80, rows: 24, version: '0.1.0', inkVersion: '7.1.1', nodeVersion: 'v22.23.2', platform: 'darwin' }));
    expect(fs.written.get(join('/reports/R1', 'versions.txt'))).toContain('size 24×80');
    const readme = fs.written.get(join('/reports/R1', 'README.txt'))!;
    expect(readme).toBe(readmeText('R1', r.files, r.missing));
    expect(readme).toContain('Nothing was sent anywhere');
    expect(readme).toContain('not available in the run directory:\n  jevcode.log');
    expect(fs.written.has(join('/reports/R1', 'jev.jsonl'))).toBe(false);
  });
  it('a run directory without jevcode.log takes the session log as jevcode.log, with a README note (§13.6)', async () => {
    const fs = memFs({ '/runs/R1/run.json': '{}', '/home/.jevcode/logs/jevcode-42-20260920.log': `2026-09-20 info run R1 ended ${SECRET}\n` });
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fallbackLog: '/home/.jevcode/logs/jevcode-42-20260920.log', fs });
    expect(r.files).toContain('jevcode.log');
    expect(r.missing).not.toContain('jevcode.log');
    expect(r.notes).toEqual(['jevcode.log: copied from the session log /home/.jevcode/logs/jevcode-42-20260920.log (the run directory had none)']);
    expect(fs.written.get(join('/reports/R1', 'jevcode.log'))).toBe('2026-09-20 info run R1 ended [REDACTED:test]\n');
    expect(fs.written.get(join('/reports/R1', 'README.txt'))).toContain('notes:\n  jevcode.log: copied from the session log');
    // the run's own log wins when present; a missing fallback is reported as before
    const own = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/jevcode.log': 'own\n', '/logs/s.log': 'session\n' });
    const r2 = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fallbackLog: '/logs/s.log', fs: own });
    expect(own.written.get(join('/reports/R1', 'jevcode.log'))).toBe('own\n');
    expect(r2.notes).toEqual([]);
    const none = memFs({ '/runs/R1/run.json': '{}' });
    const r3 = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fallbackLog: '/logs/gone.log', fs: none });
    expect(r3.missing).toContain('jevcode.log');
  });

  it('newestSessionLog picks the newest jevcode-<pid>-*.log by mtime and ignores other files; a missing directory is null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-logs-'));
    try {
      writeFileSync(join(dir, 'jevcode-1-a.log'), 'old');
      writeFileSync(join(dir, 'jevcode-2-b.log'), 'new');
      writeFileSync(join(dir, 'other.txt'), 'x');
      utimesSync(join(dir, 'jevcode-1-a.log'), new Date(1_700_000_000_000), new Date(1_700_000_000_000));
      utimesSync(join(dir, 'jevcode-2-b.log'), new Date(1_800_000_000_000), new Date(1_800_000_000_000));
      expect(await newestSessionLog(dir)).toBe(join(dir, 'jevcode-2-b.log'));
      expect(await newestSessionLog(join(dir, 'missing'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--include-requests adds the redacted jev.jsonl; tailLines ignores blank lines', async () => {
    const fs = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/jev.jsonl': `{"k":"${SECRET}"}\n` });
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, includeRequests: true, fs });
    expect(r.files).toContain('jev.jsonl');
    expect(fs.written.get(join('/reports/R1', 'jev.jsonl'))).toBe('{"k":"[REDACTED:test]"}\n');
    expect(tailLines('a\n\nb\nc\n', 2)).toEqual(['b', 'c']);
  });
});

describe('commandReport', () => {
  it('needs a run id (2), reports a missing run (2), and prints the bundle directory on success (0)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const fs = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/transcript.log': 'x\n' });
    const io = { stdout: { write: (s: string) => out.push(s), columns: 80, rows: 24 }, stderr: { write: (s: string) => err.push(s) }, env: { TERM: 'xterm' }, cwd: '/', resolveConfig: async () => ({ runsDir: '/runs', redact, record: () => ({ a: { value: '1', source: 'default' } }), sandbox: 'none' }), reportsDir: '/reports', fs };
    expect(await commandReport({ command: 'report' }, io)).toBe(2);
    expect(await commandReport({ command: 'report', runId: 'R2' }, io)).toBe(2);
    expect(err.join('')).toContain('no run R2');
    expect(await commandReport({ command: 'report', runId: 'R1' }, io)).toBe(0);
    expect(out.join('')).toMatch(/^report written to \/reports\/R1\/ \(\d+ files; redacted bundle written locally; nothing is sent\)\n/);
    expect(out.join('')).toContain('not available: jevcode.log, steps.jsonl');
    const custom = { ...io, fs: memFs({ '/runs/R1/run.json': '{}' }) };
    await commandReport({ command: 'report', runId: 'R1', out: '/elsewhere' }, custom);
    expect(custom.fs.dirs).toEqual(['/elsewhere']);
    // the session log stands in for the run-dir log and the note is printed
    const withLog = { ...io, fs: memFs({ '/runs/R1/run.json': '{}', '/logs/jevcode-7-x.log': 'session log\n' }), sessionLog: async () => '/logs/jevcode-7-x.log' };
    out.length = 0;
    expect(await commandReport({ command: 'report', runId: 'R1' }, withLog)).toBe(0);
    expect(out.join('')).toContain('jevcode.log: copied from the session log /logs/jevcode-7-x.log');
    expect(out.join('')).toContain('not available: transcript.log, steps.jsonl');
    expect(out.join('')).not.toContain('jevcode.log,');
  });
});
