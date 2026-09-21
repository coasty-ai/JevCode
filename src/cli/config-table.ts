/**
 * The `jevcode config` table (TUI-DESIGN §16, §24 "CLI"): pure lines over `ResolvedConfig.record()`. Rows with
 * source `derived` print their derivation — `session.spendCapUsd  $10.000 (default: 5 × limits.spendCapUsd)` —
 * and a `<setting>.ignored` row (source `ignored:launch`, a config-file value for a launch setting) prints
 * right after the effective row it shadows. The wave-3 `cli/main.tsx` `commandConfig` prints these lines;
 * `--json` prints the record itself (`sandboxLevel`, `ui`, `session` rows included, `source: 'derived'` kept).
 */
import type { ConfigRecordValue, SandboxLevel } from '../core/types.js';
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, SESSION_CAP_MULTIPLIER } from '../config/defaults.js';

export interface ConfigTableRow {
  setting: string;
  value: string;
  source: string;
}

/** TUI-DESIGN §16: how each derived row explains itself (`(default: …)`). */
export const DERIVATIONS: Readonly<Record<string, string>> = {
  'session.spendCapUsd': `default: ${SESSION_CAP_MULTIPLIER} × limits.spendCapUsd`,
  'limits.maxGeneratorTokens': 'default: limits.spendCapUsd / 15 × 1e6',
  'generator.priceCacheReadPerM': `default: ${CACHE_READ_FACTOR} × generator.priceInPerM`,
  'generator.priceCacheWritePerM': `default: ${CACHE_WRITE_FACTOR} × generator.priceInPerM`,
};

/** Money settings print as `$10.000` in the table (three decimals like every item); `none`/`Infinity` stay words. */
const USD_SETTINGS: ReadonlySet<string> = new Set(['session.spendCapUsd', 'limits.spendCapUsd']);

/** TUI-DESIGN §24 sandbox footer twins of the `[sandbox]` item. */
export const SANDBOX_FOOTER: Readonly<Record<SandboxLevel, string>> = {
  seatbelt: 'sandbox level: seatbelt (writes confined to the workspace and run dirs; harness secret files, ~/.ssh, ~/.aws unreadable; reads elsewhere and network allowed unless --no-network)',
  none: 'sandbox level: none (no sandbox-exec: cwd confinement, env scrubbing, timeout, output cap and tree kill only; .git/config and .git/hooks are writable by commands)',
};

function usdText(v: string): string {
  const t = v.trim();
  if (t.toLowerCase() === 'none' || t === 'Infinity') return 'none';
  const n = Number(t);
  return Number.isFinite(n) ? `$${n.toFixed(3)}` : t;
}

/** The value column of one record entry: masked secrets as `<source> (sha256:…)`, money as `$x.xxx`, derived rows with their derivation. */
export function configValueText(setting: string, v: ConfigRecordValue): string {
  if (typeof v.value !== 'string') return `<${v.value.source}> (sha256:${v.value.fingerprint})`;
  const base = USD_SETTINGS.has(setting) ? usdText(v.value) : v.value;
  if (v.source === 'derived') return `${base} (${DERIVATIONS[setting] ?? 'derived'})`;
  return base;
}

/**
 * TUI-DESIGN §16: the rows in record order with every `<setting>.ignored` row moved directly after its effective
 * row (or kept in place when the effective row is absent). Pure.
 */
export function configTableRows(record: Readonly<Record<string, ConfigRecordValue>>): ConfigTableRow[] {
  const entries = Object.entries(record);
  const ignored = new Map<string, ConfigTableRow>();
  const main: ConfigTableRow[] = [];
  for (const [setting, v] of entries) {
    const row: ConfigTableRow = { setting, value: configValueText(setting, v), source: v.source };
    if (v.source === 'ignored:launch' && setting.endsWith('.ignored')) ignored.set(setting.slice(0, -'.ignored'.length), row);
    else main.push(row);
  }
  const out: ConfigTableRow[] = [];
  for (const row of main) {
    out.push(row);
    const shadow = ignored.get(row.setting);
    if (shadow) {
      out.push({ ...shadow, source: `${shadow.source} (a launch setting: use the flag or the environment variable)` });
      ignored.delete(row.setting);
    }
  }
  for (const row of ignored.values()) out.push({ ...row, source: `${row.source} (a launch setting: use the flag or the environment variable)` });
  return out;
}

/** TUI-DESIGN §16: the aligned `setting  value  source` table plus the sandbox footer, one string per line. */
export function configTableLines(record: Readonly<Record<string, ConfigRecordValue>>, opts: { sandboxLevel: SandboxLevel }): string[] {
  const rows = configTableRows(record);
  const w0 = Math.max(7, ...rows.map((r) => r.setting.length));
  const w1 = Math.max(5, ...rows.map((r) => r.value.length));
  const lines = [`${'setting'.padEnd(w0)}  ${'value'.padEnd(w1)}  source`];
  for (const r of rows) lines.push(`${r.setting.padEnd(w0)}  ${r.value.padEnd(w1)}  ${r.source}`);
  lines.push('', SANDBOX_FOOTER[opts.sandboxLevel]);
  return lines;
}
