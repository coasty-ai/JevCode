/**
 * TUI-DESIGN-4 §7.11 / §10 (S6 `faults.test.ts`): `parseFault` over all thirteen values plus an unknown one
 * (which must **reject loudly**), the round trip through `faultToString`, and `readFaultEnv`'s two variables.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSERT_HEIGHT_ENV_VAR,
  CONFIG_FAULT_KINDS,
  FAULT_ENV_VAR,
  FAULT_GRAMMAR,
  FAULT_PANES,
  NET_FAULT_CODES,
  PERSIST_FAULT_CODES,
  faultEnvError,
  faultToString,
  parseFault,
  readFaultEnv,
  renderFaultMode,
  renderFaultString,
  type Fault,
} from '../../../src/tui/faults.js';

describe('parseFault (§7.11: thirteen scenarios, one grammar)', () => {
  it('1, 2 — render:<pane>[:lines][:sticky] over every boundary the catalogue names', () => {
    for (const pane of FAULT_PANES) {
      expect(parseFault(`render:${pane}`)).toEqual({ kind: 'render', pane, lines: false, sticky: false });
      expect(parseFault(`render:${pane}:lines`)).toEqual({ kind: 'render', pane, lines: true, sticky: false });
      expect(parseFault(`render:${pane}:sticky`)).toEqual({ kind: 'render', pane, lines: false, sticky: true });
      expect(parseFault(`render:${pane}:lines:sticky`)).toEqual({ kind: 'render', pane, lines: true, sticky: true });
    }
    // §7.3 item 2: the wordmark is a boundary this round, so the fault that drives it must parse
    expect(parseFault('render:wordmark')).toMatchObject({ pane: 'wordmark' });
    // a typo'd pane is not a fault (it would otherwise measure the unfaulted frame)
    expect(parseFault('render:wordmarkk')).toBeNull();
    expect(parseFault('render:')).toBeNull();
    expect(parseFault('render:pane:sticky:sticky')).toBeNull();
    expect(parseFault('render:pane:lnies')).toBeNull();
  });

  it('3 — persist:<CODE>[:after=<n>]', () => {
    for (const code of PERSIST_FAULT_CODES) expect(parseFault(`persist:${code}`)).toEqual({ kind: 'persist', code, after: 1 });
    expect(parseFault('persist:ENOSPC:after=7')).toEqual({ kind: 'persist', code: 'ENOSPC', after: 7 });
    expect(parseFault('persist:EBADF')).toBeNull();
    expect(parseFault('persist:ENOSPC:7')).toBeNull();
    expect(parseFault('persist:ENOSPC:after=x')).toBeNull();
  });

  it('4 — rundir:rm[:after=<n>]', () => {
    expect(parseFault('rundir:rm')).toEqual({ kind: 'rundir', op: 'rm', after: 1 });
    expect(parseFault('rundir:rm:after=0')).toEqual({ kind: 'rundir', op: 'rm', after: 0 });
    expect(parseFault('rundir:mv')).toBeNull();
  });

  it('5 — submit:hang', () => {
    expect(parseFault('submit:hang')).toEqual({ kind: 'submit', mode: 'hang' });
    expect(parseFault('submit')).toBeNull();
    expect(parseFault('submit:hang:2')).toBeNull();
  });

  it('6 — jev:429[:<retry-after>] · jev:401 · jev:5xx:<n>', () => {
    expect(parseFault('jev:401')).toEqual({ kind: 'jev', status: 401, retryAfterMs: null, count: 1 });
    expect(parseFault('jev:429')).toEqual({ kind: 'jev', status: 429, retryAfterMs: null, count: 1 });
    // the `<retryAfter>` of the grammar is the HTTP header's unit: seconds
    expect(parseFault('jev:429:30')).toEqual({ kind: 'jev', status: 429, retryAfterMs: 30_000, count: 1 });
    expect(parseFault('jev:5xx:4')).toEqual({ kind: 'jev', status: 500, retryAfterMs: null, count: 4 });
    expect(parseFault('jev:5xx:0')).toBeNull();
    expect(parseFault('jev:500')).toBeNull();
    expect(parseFault('jev:401:1')).toBeNull();
  });

  it('7 — net:<code>[:mid-stream]', () => {
    for (const code of NET_FAULT_CODES) expect(parseFault(`net:${code}`)).toEqual({ kind: 'net', code, midStream: false });
    expect(parseFault('net:ECONNRESET:mid-stream')).toEqual({ kind: 'net', code: 'ECONNRESET', midStream: true });
    expect(parseFault('net:ECONNRESET:midstream')).toBeNull();
    expect(parseFault('net:EHOSTDOWN')).toBeNull();
  });

  it('8 — stdout:EPIPE[:after=<n>]', () => {
    expect(parseFault('stdout:EPIPE')).toEqual({ kind: 'stdout', code: 'EPIPE', after: 1 });
    expect(parseFault('stdout:EPIPE:after=12')).toEqual({ kind: 'stdout', code: 'EPIPE', after: 12 });
    expect(parseFault('stdout:EIO')).toBeNull();
  });

  it('9 — clock:jump:<±s>[:at=<n>]', () => {
    expect(parseFault('clock:jump:30')).toEqual({ kind: 'clock', jumpMs: 30_000, at: 0 });
    expect(parseFault('clock:jump:+30')).toEqual({ kind: 'clock', jumpMs: 30_000, at: 0 });
    expect(parseFault('clock:jump:-90:at=4')).toEqual({ kind: 'clock', jumpMs: -90_000, at: 4 });
    expect(parseFault('clock:jump')).toBeNull();
    expect(parseFault('clock:jump:soon')).toBeNull();
  });

  it('10 — index:corrupt · index:huge:<n>', () => {
    expect(parseFault('index:corrupt')).toEqual({ kind: 'index', mode: 'corrupt', lines: 0 });
    expect(parseFault('index:huge:200000')).toEqual({ kind: 'index', mode: 'huge', lines: 200_000 });
    expect(parseFault('index:huge')).toBeNull();
    expect(parseFault('index:corrupt:1')).toBeNull();
  });

  it('11 — config:<kind>', () => {
    for (const mode of CONFIG_FAULT_KINDS) expect(parseFault(`config:${mode}`)).toEqual({ kind: 'config', mode });
    expect(parseFault('config:weird')).toBeNull();
  });

  it('12 — loop:hog:<ms>', () => {
    expect(parseFault('loop:hog:250')).toEqual({ kind: 'loop', hogMs: 250 });
    expect(parseFault('loop:hog')).toBeNull();
    expect(parseFault('loop:250')).toBeNull();
  });

  it('13 — peer:<n>', () => {
    expect(parseFault('peer:2')).toEqual({ kind: 'peer', count: 2 });
    expect(parseFault('peer:0')).toEqual({ kind: 'peer', count: 0 });
    expect(parseFault('peer:many')).toBeNull();
  });

  it('an absent, empty, over-long or unknown value is not a fault', () => {
    expect(parseFault(undefined)).toBeNull();
    expect(parseFault(null)).toBeNull();
    expect(parseFault('')).toBeNull();
    expect(parseFault('   ')).toBeNull();
    expect(parseFault('x'.repeat(200))).toBeNull();
    expect(parseFault('wibble')).toBeNull();
    expect(parseFault('render')).toBeNull();
  });

  it('every parsed fault round-trips through faultToString', () => {
    const values = [
      'render:pane',
      'render:transcript:lines',
      'render:wordmark:sticky',
      'persist:EACCES:after=3',
      'rundir:rm:after=2',
      'submit:hang',
      'jev:401',
      'jev:429:15',
      'jev:5xx:3',
      'net:ETIMEDOUT',
      'net:ECONNRESET:mid-stream',
      'stdout:EPIPE:after=9',
      'clock:jump:+30:at=2',
      'index:corrupt',
      'index:huge:1000',
      'config:truncated',
      'loop:hog:80',
      'peer:3',
    ];
    for (const v of values) {
      const f = parseFault(v);
      expect(f, v).not.toBeNull();
      expect(faultToString(f as Fault), v).toBe(v);
      expect(parseFault(faultToString(f as Fault)), v).toEqual(f);
    }
  });
});

describe('renderFaultMode / renderFaultString (§7.11 scenario 1)', () => {
  it('names the pane, distinguishes the line variant and reports sticky', () => {
    expect(renderFaultMode(parseFault('render:pane'), 'pane')).toBe('once');
    expect(renderFaultMode(parseFault('render:pane:sticky'), 'pane')).toBe('sticky');
    expect(renderFaultMode(parseFault('render:pane'), 'live')).toBeNull();
    // the `:lines` variant belongs to the line builder, not to the boundary
    expect(renderFaultMode(parseFault('render:pane:lines'), 'pane')).toBeNull();
    expect(renderFaultMode(parseFault('render:pane:lines'), 'pane', { lines: true })).toBe('once');
    expect(renderFaultMode(null, 'pane')).toBeNull();
    expect(renderFaultMode(parseFault('peer:2'), 'pane')).toBeNull();
    expect(renderFaultString('status')).toBe('render:status');
    expect(renderFaultString('status', { sticky: true })).toBe('render:status:sticky');
  });
});

describe('readFaultEnv (§7.11: an unknown value is rejected loudly, before Ink mounts)', () => {
  it('parses a known value and reports no error', () => {
    expect(readFaultEnv({ [FAULT_ENV_VAR]: 'render:live' })).toEqual({ fault: { kind: 'render', pane: 'live', lines: false, sticky: false }, assertHeight: false, error: null });
  });
  it('an unset variable is not an error', () => {
    expect(readFaultEnv({})).toEqual({ fault: null, assertHeight: false, error: null });
    expect(readFaultEnv({ [FAULT_ENV_VAR]: '  ' })).toEqual({ fault: null, assertHeight: false, error: null });
  });
  it('an unknown value produces the grammar on stderr, so a typo in CI fails the test instead of passing', () => {
    const r = readFaultEnv({ [FAULT_ENV_VAR]: 'render:wordmarkk' });
    expect(r.fault).toBeNull();
    expect(r.error).not.toBeNull();
    expect(r.error).toContain('render:wordmarkk is not a fault this build understands');
    for (const row of FAULT_GRAMMAR) expect(r.error).toContain(row);
  });
  it('a hostile value is clipped in the rejection', () => {
    const long = `render:${'z'.repeat(400)}`;
    expect(faultEnvError(long).split("\n")[0]!.length).toBeLessThan(180);
  });
  it('JEVCODE_ASSERT_HEIGHT is a field, not a fourteenth string (§1.5)', () => {
    expect(readFaultEnv({ [ASSERT_HEIGHT_ENV_VAR]: '1' }).assertHeight).toBe(true);
    expect(readFaultEnv({ [ASSERT_HEIGHT_ENV_VAR]: 'yes' }).assertHeight).toBe(false);
    expect(parseFault('assert:height')).toBeNull();
    // both together
    expect(readFaultEnv({ [FAULT_ENV_VAR]: 'peer:2', [ASSERT_HEIGHT_ENV_VAR]: '1' })).toEqual({ fault: { kind: 'peer', count: 2 }, assertHeight: true, error: null });
  });
});

/**
 * TUI-DESIGN-4 §7.11 / §7.3's catalogue (review finding 16): the boundary names `FAULT_PANES` lists and the
 * `<PaneBoundary pane=…>` names actually mounted in `src/tui/**` must be the SAME SET. A boundary missing from
 * the catalogue makes its own fault string a loud rejection instead of the fault it names — which is how
 * `viewport` (`src/tui/fullscreen/ViewportBox.tsx`) got in without one. Same shape as `round4-identity.test.ts`'s
 * "fails on an unlisted command".
 */
describe('the catalogue covers every boundary this tree mounts (§7.3, §7.11)', () => {
  const root = new URL('../../../src/tui/', import.meta.url).pathname;

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  it('every `<PaneBoundary pane=…>` name mounted in src/tui/** is in FAULT_PANES', () => {
    const files = walk(root);
    const texts = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
    // `export const X_PANE = 'name'` — the constants the JSX refers to
    const consts = new Map<string, string>();
    for (const t of texts.values()) for (const m of t.matchAll(/export const ([A-Z0-9_]+)\s*=\s*'([a-z][a-z-]*)'/g)) consts.set(m[1]!, m[2]!);
    const mounted = new Set<string>();
    for (const t of texts.values()) {
      for (const m of t.matchAll(/<PaneBoundary\b[^>]*?\bpane=(?:"([^"]+)"|\{([A-Z0-9_]+)\})/g)) {
        const literal = m[1];
        const ident = m[2];
        if (literal !== undefined) mounted.add(literal);
        else if (ident !== undefined) {
          const v = consts.get(ident);
          expect(v, `the pane constant ${ident} must be an exported string literal so this gate can read it`).toBeDefined();
          mounted.add(v!);
        }
      }
    }
    // the tree really does mount boundaries (a regex that matched nothing would pass vacuously)
    expect(mounted.size).toBeGreaterThanOrEqual(5);
    const missing = [...mounted].filter((p) => !FAULT_PANES.includes(p)).sort();
    expect(missing, `add these to FAULT_PANES in src/tui/faults.ts: ${missing.join(', ')}`).toEqual([]);
    // `viewport` in particular — the one the first pass missed
    expect(FAULT_PANES).toContain('viewport');
    expect(parseFault('render:viewport')).toEqual({ kind: 'render', pane: 'viewport', lines: false, sticky: false });
  });
});
