/**
 * TUI-DESIGN §13.6 / §19.0 `src/cli/report.ts`: the bundle holds run.json, transcript.log, jevcode.log, the last 20
 * steps.jsonl rows, config.json, versions.txt and README.txt; every file passes `redact`; jev.jsonl only with
 * `--include-requests`; missing sources are listed, never fatal; `commandReport` exit codes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
    // TUI-DESIGN-4 §7.7 item 1: state.json, jevcode.log.1, ui.json and the decisions tail join the bundle
    expect(r.files).toEqual(['run.json', 'transcript.log', 'steps.tail.jsonl', 'config.json', 'versions.txt', 'README.txt']);
    expect(r.missing).toEqual(['state.json', 'jevcode.log', 'jevcode.log.1', 'ui.json', 'decisions.jsonl']);
    expect(fs.dirs).toEqual(['/reports/R1']);
    for (const [p, t] of fs.written) expect(t, p).not.toContain(SECRET);
    expect(fs.written.get(join('/reports/R1', 'run.json'))).toContain('[REDACTED:test]');
    const tail = fs.written.get(join('/reports/R1', 'steps.tail.jsonl'))!.trim().split('\n');
    expect(tail).toHaveLength(REPORT_STEPS_TAIL);
    expect(JSON.parse(tail[0]!)).toEqual({ step: 6, decisions: [] });
    expect(fs.written.get(join('/reports/R1', 'versions.txt'))).toBe(versionsText({ term: 'xterm', termProgram: null, columns: 80, rows: 24, version: '0.1.0', inkVersion: '7.1.1', nodeVersion: 'v22.23.2', platform: 'darwin' }));
    // TUI-DESIGN-4 §7.7 item 3: the launch block is `(unknown)` when the run wrote no ui.json
    expect(fs.written.get(join('/reports/R1', 'versions.txt'))).toContain('launch:\n  tier (unknown)');
    expect(fs.written.get(join('/reports/R1', 'versions.txt'))).toContain('size 24×80');
    const readme = fs.written.get(join('/reports/R1', 'README.txt'))!;
    expect(readme).toBe(readmeText('R1', r.files, r.missing));
    expect(readme).toContain('Nothing was sent anywhere');
    expect(readme).toContain('not available in the run directory:\n  state.json');
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
    expect(out.join('')).toMatch(/^report written to \/reports\/R1\/ \(\d+ files, \d+ bytes; redacted bundle written locally; nothing is sent\)\n/);
    expect(out.join('')).toContain('not available: state.json, jevcode.log, jevcode.log.1, ui.json, steps.jsonl, decisions.jsonl');
    // TUI-DESIGN-4 §7.7 item 5: the one command that turns the directory into an attachment
    expect(out.join('')).toContain('tar -czf R1.tgz -C /reports R1');
    const custom = { ...io, fs: memFs({ '/runs/R1/run.json': '{}' }) };
    await commandReport({ command: 'report', runId: 'R1', out: '/elsewhere' }, custom);
    expect(custom.fs.dirs).toEqual(['/elsewhere']);
    // the session log stands in for the run-dir log and the note is printed
    const withLog = { ...io, fs: memFs({ '/runs/R1/run.json': '{}', '/logs/jevcode-7-x.log': 'session log\n' }), sessionLog: async () => '/logs/jevcode-7-x.log' };
    out.length = 0;
    expect(await commandReport({ command: 'report', runId: 'R1' }, withLog)).toBe(0);
    expect(out.join('')).toContain('jevcode.log: copied from the session log /logs/jevcode-7-x.log');
    expect(out.join('')).toContain('not available: state.json, transcript.log, jevcode.log.1, ui.json, steps.jsonl, decisions.jsonl');
    expect(out.join('')).not.toContain(' jevcode.log,');
  });
});

/**
 * TUI-DESIGN-4 §7.7 (P-D7) / §10 (S6 `cli/report.test.ts`): an 8 MiB `transcript.log` → the head/tail marker and
 * ≤ 4 MiB written; a canary secret inside the elided region is never written; a throw mid-bundle leaves
 * `(bundle incomplete)`; the `versionsText` snapshot.
 *
 * Measured before round 4: the bundle was 7 files with a 111-byte `versions.txt`, it omitted `state.json`,
 * `jevcode.log.1`, `decisions.jsonl` and `keybindings.json`, and `put()` did `redact(await readFile(<whole>))`.
 */
describe('the capped, streamed bundle (§7.7)', () => {
  it('item 2: a file past the cap is head + marker + tail, and the middle is never read into the bundle', async () => {
    const { REPORT_FILE_MAX, elisionMarker } = await import('../../../src/cli/report.js');
    const max = 1024;
    const head = `HEAD\n${'a\n'.repeat(2000)}`;
    const middle = `MIDDLE ${SECRET}\n`.repeat(200);
    const tail = `${'z\n'.repeat(2000)}TAIL\n`;
    const whole = head + middle + tail;
    const fs = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/transcript.log': whole });
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fileMax: max, fs });
    const out = fs.written.get(join('/reports/R1', 'transcript.log'))!;
    expect(out).toContain('HEAD');
    expect(out).toContain('TAIL');
    // the canary only ever lived in the elided middle: it is not in the bundle at all
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('MIDDLE');
    expect(out).toMatch(/… \d+ bytes elided \(original \d+ bytes\) …/);
    expect(out).toContain(elisionMarker(Buffer.byteLength(whole, 'utf8') - 2 * max + 2, Buffer.byteLength(whole, 'utf8')).slice(0, 4));
    // ≤ head + tail + the marker
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2 * max + 200);
    expect(r.notes.some((n) => n.startsWith('transcript.log: capped at'))).toBe(true);
    // a file at or under the cap gets no marker
    const small = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/transcript.log': 'x\n' });
    await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fileMax: max, fs: small });
    expect(small.written.get(join('/reports/R1', 'transcript.log'))).toBe('x\n');
    expect(REPORT_FILE_MAX).toBe(2 * 1024 * 1024);
  });

  /**
   * TUI-DESIGN-4 §7.7 item 2 (review finding 1, blocker): the head window at offset 0 and the tail window at
   * `size - max` OVERLAP for every file between `max` and `2 * max`. The shipped cap is 2 MiB, so that is every
   * `transcript.log` between 2 and 4 MiB — the common case. Measured against the real `NODE_FS` path before the
   * fix: a 1 350-byte file at `fileMax: 1000` wrote 2 044 bytes, repeated the mid-file line, and the marker read
   * `0 bytes elided`. The existing case above uses an 8× ratio and cannot see it.
   */
  it('item 2: a file strictly between the cap and twice the cap is copied WHOLE — no overlap, no `0 bytes elided` marker', async () => {
    const max = 1000;
    for (const size of [max + 1, Math.floor(max * 1.5), 2 * max]) {
      const body = Array.from({ length: Math.ceil(size / 10) }, (_, i) => `L${String(i).padStart(7, '0')}`).join('\n').slice(0, size);
      const fs = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/transcript.log': body });
      await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fileMax: max, fs });
      const out = fs.written.get(join('/reports/R1', 'transcript.log'))!;
      expect(out, `size ${size}`).not.toContain('bytes elided');
      expect(Buffer.byteLength(out, 'utf8'), `size ${size}`).toBeLessThanOrEqual(Buffer.byteLength(body, 'utf8'));
      // no line appears twice (the overlap's signature)
      const lines = out.split('\n').filter((l) => l.startsWith('L'));
      expect(new Set(lines).size, `size ${size}`).toBe(lines.length);
    }
  });

  /** The same arithmetic on the REAL `NODE_FS` path (no injected fs), which is where the defect was measured. */
  it('item 2: the real head/tail reader never overlaps and never writes a `0 bytes elided` marker', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jevcode-report-cap-'));
    try {
      const max = 1000;
      const runDir = join(dir, 'runs', 'R1');
      const out = join(dir, 'reports', 'R1');
      mkdirSync(runDir, { recursive: true });
      const body = Array.from({ length: 135 }, (_, i) => `L${String(i).padStart(7, '0')}`).join('\n') + '\n';
      writeFileSync(join(runDir, 'run.json'), '{}');
      writeFileSync(join(runDir, 'transcript.log'), body);
      await writeReportBundle({ runDir, runId: 'R1', out, redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fileMax: max });
      const written = readFileSync(join(out, 'transcript.log'), 'utf8');
      expect(written).not.toContain('bytes elided');
      expect(Buffer.byteLength(written, 'utf8')).toBeLessThanOrEqual(Buffer.byteLength(body, 'utf8'));
      expect(written.split('\n').filter((l) => l === 'L0000075')).toHaveLength(1);
      // and past 2x the cap the window IS taken, with a positive elision count
      writeFileSync(join(runDir, 'transcript.log'), body.repeat(30));
      await writeReportBundle({ runDir, runId: 'R1', out, redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fileMax: max });
      const big = readFileSync(join(out, 'transcript.log'), 'utf8');
      const m = /… (\d+) bytes elided \(original (\d+) bytes\) …/.exec(big);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThan(0);
      expect(Buffer.byteLength(big, 'utf8')).toBeLessThan(Number(m![2]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** TUI-DESIGN-4 §7.7 edge: a read that never settles is abandoned at the deadline and listed `not available`. */
  it('a stalled read is bounded by REPORT_READ_TIMEOUT_MS and the bundle carries on, marked incomplete', async () => {
    const { BUNDLE_INCOMPLETE_MARKER } = await import('../../../src/cli/report.js');
    const base = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/steps.jsonl': steps });
    const fs: ReportFs = { ...base, readFile: async (p) => (p.endsWith('transcript.log') ? new Promise<string>(() => undefined) : base.readFile(p)) };
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, readTimeoutMs: 20, fs });
    expect(r.missing).toContain('transcript.log');
    expect(r.complete).toBe(false);
    expect(r.notes.some((n) => n.startsWith('transcript.log: not available — the read did not finish'))).toBe(true);
    expect(base.written.get(join('/reports/R1', 'README.txt'))).toContain(BUNDLE_INCOMPLETE_MARKER);
    // the rest of the bundle is there
    expect(r.files).toContain('steps.tail.jsonl');
    expect(r.files).toContain('README.txt');
  });

  /** §7.7 item 4: `complete: false` is reachable — a non-ENOENT failure of a file the bundle wanted. */
  it('a copy that fails with EACCES leaves complete=false and `(bundle incomplete)` in the final README', async () => {
    const { BUNDLE_INCOMPLETE_MARKER } = await import('../../../src/cli/report.js');
    const base = memFs({ '/runs/R1/run.json': '{}' });
    const fs: ReportFs = {
      ...base,
      readFile: async (p) => {
        if (p.endsWith('transcript.log')) throw Object.assign(new Error('EACCES'), { code: 'EACCES', path: p });
        return base.readFile(p);
      },
    };
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fs });
    expect(r.complete).toBe(false);
    expect(base.written.get(join('/reports/R1', 'README.txt'))).toContain(BUNDLE_INCOMPLETE_MARKER);
    // an ordinary ENOENT (a run that never rotated its log) is NOT incompleteness
    const clean = memFs({ '/runs/R1/run.json': '{}' });
    const ok = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fs: clean });
    expect(ok.complete).toBe(true);
    expect(clean.written.get(join('/reports/R1', 'README.txt'))).not.toContain(BUNDLE_INCOMPLETE_MARKER);
    // the placeholder README is not double-counted in the reported size
    expect(ok.bytes).toBe([...clean.written.values()].reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0));
  });

  it('item 1: state.json, jevcode.log.1, the decisions tail and keybindings.json join the bundle', async () => {
    const { REPORT_DECISIONS_TAIL } = await import('../../../src/cli/report.js');
    const decisions = Array.from({ length: REPORT_DECISIONS_TAIL + 40 }, (_, i) => JSON.stringify({ d: i })).join('\n') + '\n';
    const fs = memFs({
      '/runs/R1/run.json': '{}',
      '/runs/R1/state.json': '{"version":1}',
      '/runs/R1/jevcode.log': 'new half\n',
      '/runs/R1/jevcode.log.1': 'the rotated half with the crash\n',
      '/runs/R1/decisions.jsonl': decisions,
      '/home/.jevcode/keybindings.json': '{"approve":"ctrl+y"}',
    });
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, keybindingsPath: '/home/.jevcode/keybindings.json', fs });
    expect(r.files).toContain('state.json');
    expect(r.files).toContain('jevcode.log.1');
    expect(r.files).toContain('decisions.tail.jsonl');
    expect(r.files).toContain('keybindings.json');
    expect(fs.written.get(join('/reports/R1', 'jevcode.log.1'))).toContain('the crash');
    expect(fs.written.get(join('/reports/R1', 'decisions.tail.jsonl'))!.trim().split('\n')).toHaveLength(REPORT_DECISIONS_TAIL);
  });

  it('item 3: versions.txt carries the environment that decides which frame the user saw, and SSH/TMUX by presence only', async () => {
    const fs = memFs({ '/runs/R1/run.json': '{}', '/runs/R1/ui.json': JSON.stringify({ tier: 'boxed', fps: 30, renderMode: 'auto', renderer: 'classic', ascii: false, screenReader: false, reducedMotion: false, plain: false, theme: 'dark' }) });
    await writeReportBundle({
      runDir: '/runs/R1',
      runId: 'R1',
      out: '/reports/R1',
      redact,
      configJson: {},
      term: 'xterm-256color',
      termProgram: 'iTerm.app',
      columns: 120,
      rows: 40,
      isTty: true,
      env: { LANG: 'en_GB.UTF-8', TZ: 'Europe/London', COLORTERM: 'truecolor', SSH_TTY: '/dev/ttys004', TMUX: '/private/tmp/tmux-501/default,1,0' },
      fs,
    });
    const v = fs.written.get(join('/reports/R1', 'versions.txt'))!;
    expect(v).toContain('isTTY true');
    expect(v).toContain('LANG en_GB.UTF-8');
    expect(v).toContain('LC_ALL (unset)');
    expect(v).toContain('TZ Europe/London');
    expect(v).toContain('COLORTERM truecolor');
    expect(v).toContain('NO_COLOR (unset)');
    // presence booleans only: a tty path and a session name identify a machine
    expect(v).toContain('SSH_TTY set');
    expect(v).toContain('TMUX set');
    expect(v).toContain('STY (unset)');
    expect(v).not.toContain('/dev/ttys004');
    expect(v).not.toContain('tmux-501');
    // the launch block, read from the run's own ui.json so `report` works offline
    expect(v).toContain('launch:\n  tier boxed\n  fps 30\n  renderMode auto\n  renderer classic\n  ascii false\n  screenReader false\n  reducedMotion false\n  plain false\n  theme dark\n');
  });

  it('item 4: README.txt is written first with `(bundle incomplete)` and rewritten last without it', async () => {
    const { BUNDLE_INCOMPLETE_MARKER } = await import('../../../src/cli/report.js');
    const order: string[] = [];
    const base = memFs({ '/runs/R1/run.json': '{}' });
    const fs: ReportFs = { ...base, writeFile: async (p, t) => { order.push(p); await base.writeFile(p, t); } };
    const r = await writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fs });
    expect(order[0]).toBe(join('/reports/R1', 'README.txt'));
    expect(order.at(-1)).toBe(join('/reports/R1', 'README.txt'));
    expect(base.written.get(join('/reports/R1', 'README.txt'))).not.toContain(BUNDLE_INCOMPLETE_MARKER);
    expect(r.complete).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);

    // a throw mid-bundle leaves the placeholder on disk: the directory says it is partial
    const failing: ReportFs = {
      ...base,
      writeFile: async (p, t) => {
        if (p.endsWith('config.json')) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC', path: '/reports/R1' });
        await base.writeFile(p, t);
      },
    };
    const partial = memFs({ '/runs/R1/run.json': '{}' });
    const both: ReportFs = { ...failing, readFile: partial.readFile, mkdir: partial.mkdir };
    await expect(writeReportBundle({ runDir: '/runs/R1', runId: 'R1', out: '/reports/R1', redact, configJson: {}, term: null, termProgram: null, columns: null, rows: null, fs: both })).rejects.toBeTruthy();
    expect(base.written.get(join('/reports/R1', 'README.txt'))).toContain(BUNDLE_INCOMPLETE_MARKER);
  });

  it('a bundle write that runs out of space exits 3 with §7.4`s explanation and names the incomplete bundle', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const base = memFs({ '/runs/R1/run.json': '{}' });
    const fs: ReportFs = {
      ...base,
      writeFile: async (p, t) => {
        if (p.endsWith('config.json')) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC', path: '/reports/R1' });
        await base.writeFile(p, t);
      },
    };
    const io = { stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) }, env: {}, cwd: '/', resolveConfig: async () => ({ runsDir: '/runs', redact, record: () => ({}), sandbox: 'none' }), reportsDir: '/reports', fs };
    expect(await commandReport({ command: 'report', runId: 'R1' }, io)).toBe(3);
    expect(err.join('')).toContain('the disk holding /reports/R1 is full');
    expect(err.join('')).toContain('free space, or pass --runs-dir <dir> on another volume');
    expect(err.join('')).toContain('(bundle incomplete)');
  });

  /**
   * TUI-DESIGN-4 §7.7 edge / §7.4 (review finding 22): the classified-error path returned 3 for EVERY errno and
   * discarded `x.exitCode`. §7.7 names 3 for ENOSPC; an EACCES on the `--out` directory is a permission problem
   * and §7.4 gives it 2.
   */
  it('an EACCES on the --out directory exits 2, not 3', async () => {
    const err: string[] = [];
    const base = memFs({ '/runs/R1/run.json': '{}' });
    const fs: ReportFs = { ...base, mkdir: async () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: '/reports/R1' }); } };
    const io = { stdout: { write: () => undefined }, stderr: { write: (s: string) => err.push(s) }, env: {}, cwd: '/', resolveConfig: async () => ({ runsDir: '/runs', redact, record: () => ({}), sandbox: 'none' }), reportsDir: '/reports', fs };
    expect(await commandReport({ command: 'report', runId: 'R1' }, io)).toBe(2);
    expect(err.join('')).toContain('permission denied');
  });
});
