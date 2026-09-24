/**
 * The `jevcode config` table (TUI-DESIGN §16, §24 "CLI"): pure lines over `ResolvedConfig.record()`. Rows with
 * source `derived` print their derivation — `session.spendCapUsd  $10.000 (default: 5 × limits.spendCapUsd)` —
 * and a `<setting>.ignored` row (source `ignored:launch`, a config-file value for a launch setting) prints
 * right after the effective row it shadows. The wave-3 `cli/main.tsx` `commandConfig` prints these lines;
 * `--json` prints the record itself (`sandboxLevel`, `ui`, `session` rows included, `source: 'derived'` kept).
 */
import type { ConfigRecordValue, SandboxLevel } from '../core/types.js';
import type { SettingProblem } from '../config/types.js';
import { CACHE_READ_FACTOR, CACHE_WRITE_FACTOR, SESSION_CAP_MULTIPLIER, SETTINGS, isClampProblem } from '../config/defaults.js';
import { blockTier, blockWidth, elideLeft, renderBlock, type BlockRow, type RenderBlockOptions } from '../tui/block/lines.js';
import { GLYPHS, cellWidth, type GlyphSet } from '../tui/glyphs.js';
import { shortPath } from '../core/text.js';
import { rank } from '../tui/commands/fuzzy.js';

export interface ConfigTableRow {
  setting: string;
  value: string;
  source: string;
  /** TUI-DESIGN-4 §3.3: a row at its default folds behind the footer unless it carries a problem or is `.ignored` */
  atDefault: boolean;
  /** TUI-DESIGN-4 §7.5: why the next run will reject this value (`✗ expected an integer ≥ 1`) */
  problem?: SettingProblem;
}

/** TUI-DESIGN §16: how each derived row explains itself (`(default: …)`). */
export const DERIVATIONS: Readonly<Record<string, string>> = {
  'session.spendCapUsd': `default: ${SESSION_CAP_MULTIPLIER} × limits.spendCapUsd`,
  'limits.maxGeneratorTokens': 'default: limits.spendCapUsd / 15 × 1e6',
  'generator.priceCacheReadPerM': `default: ${CACHE_READ_FACTOR} × generator.priceInPerM`,
  'generator.priceCacheWritePerM': `default: ${CACHE_WRITE_FACTOR} × generator.priceInPerM`,
};

/**
 * TUI-DESIGN-2 §2.6: the `decider.provider` row's source column when resolveConfig derived it (`derived (auto: TYPESAFE_API_KEY is
 * set)`), keyed by the `decider.providerSource` record row that `--json` keeps and the table folds away.
 */
export const PROVIDER_DERIVATIONS: Readonly<Record<string, string>> = {
  'auto:typesafe-key': 'auto: TYPESAFE_API_KEY is set',
  'auto:openrouter-key': 'auto: JEV_API_KEY or OPENROUTER_API_KEY is set',
  'auto:base-url': 'auto: decider.baseUrl names it',
};

/** TUI-DESIGN-2 §2.6: the rows whose defaults are provider-keyed print `default (<provider>)`. */
const PROVIDER_KEYED_DEFAULTS: ReadonlySet<string> = new Set(['decider.baseUrl', 'decider.model']);
const PROVIDER_SOURCE_ROW = 'decider.providerSource';

/** TUI-DESIGN-3 §0.1 (D-Q): the rows `jevcode config` hides unless `--all` (`SettingSpec.hidden`: the `seen.*` bookkeeping) */
export const HIDDEN_SETTINGS: ReadonlySet<string> = new Set(SETTINGS.filter((s) => s.hidden === true).map((s) => s.name));

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
export function configTableRows(record: Readonly<Record<string, ConfigRecordValue>>, opts: { all?: boolean } = {}): ConfigTableRow[] {
  const entries = Object.entries(record).filter(([setting]) => opts.all === true || !HIDDEN_SETTINGS.has(setting));
  const ignored = new Map<string, ConfigTableRow>();
  const main: ConfigTableRow[] = [];
  // TUI-DESIGN-2 §2.6: `decider.providerSource` is folded into the provider row's source column; provider-keyed defaults name the provider
  const providerSourceV = record[PROVIDER_SOURCE_ROW]?.value;
  const providerSource = typeof providerSourceV === 'string' ? providerSourceV : null;
  // an older or hand-edited record may carry any text in the row: only a known provider labels the provider-keyed defaults
  const providerV = record['decider.provider']?.value;
  const provider = providerV === 'typesafe' || providerV === 'openrouter' ? providerV : null;
  for (const [setting, v] of entries) {
    if (setting === PROVIDER_SOURCE_ROW) continue;
    // the provider row's derivation lives in the source column (§2.6), so its value stays the bare provider name
    const value = setting === 'decider.provider' && typeof v.value === 'string' ? v.value : configValueText(setting, v);
    const row: ConfigTableRow = { setting, value, source: v.source, atDefault: v.source === 'default' };
    // TUI-DESIGN-4 §7.5: the problem resolveConfig recorded rides the row so §3.3's fold can never hide it
    if (v.problem !== undefined && v.problem !== null) row.problem = v.problem;
    if (setting === 'decider.provider' && v.source === 'derived' && providerSource !== null) row.source = `derived (${PROVIDER_DERIVATIONS[providerSource] ?? providerSource})`;
    if (PROVIDER_KEYED_DEFAULTS.has(setting) && v.source === 'default' && provider !== null) row.source = `default (${provider})`;
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

// --- TUI-DESIGN-4 §3.1 / §3.3: `/config` as a block ------------------------------------------------------------

/** §3.3: `setting` = min(28, longest), `source` = min(20, longest), `value` = the rest, min 12. */
export const CONFIG_SETTING_COL_MAX = 28;
export const CONFIG_SOURCE_COL_MAX = 20;
export const CONFIG_VALUE_COL_MIN = 12;
/**
 * §3.1.5 "block caps": the `/config` BLOCK (the TUI / `--plain` transcript item) keeps 24 body rows and names
 * where the rest is. `jevcode config` on the CLI is uncapped — see `ConfigBlockOptions.max`.
 */
export const CONFIG_BLOCK_MAX_ROWS = 24;
/** §3.3 edge 4: the `gap` + `rule` + `facts` sandbox footer `configBlock` always appends, exempt from the cap. */
export const SANDBOX_TAIL_ROWS = 3;

/**
 * §3.3 / F-B3: the SHORT source parenthetical — `(flag)`, `(env)`, `(file)`, `(derived: 5 × limits.spendCapUsd)`.
 * `null` for a plain default, which is what makes three columns fit in 70 cells: only rows that are NOT at their
 * default spend the width. A `file:`/`dotenv:` path is dropped here; `/config --all` and `--json` still carry it,
 * which is what `all` is for — with several config files in play (`~/.config/jevcode/jevcode.json`, the workspace
 * file, `--config`) the bare word `file` cannot say WHICH one set the value.
 */
export function configSourceText(source: string, all = false): string | null {
  if (source === 'default') return null;
  if (all && (source.startsWith('file:') || source.startsWith('dotenv:'))) return source;
  if (source.startsWith('file:')) return 'file';
  if (source.startsWith('dotenv:')) return 'dotenv';
  if (source.startsWith('derived (')) return source.slice('derived ('.length, -1);
  if (source === 'derived') return 'derived';
  // TUI-DESIGN-2 §2.6: `default (typesafe)` — a provider-keyed default is at its default but says WHICH default
  if (source.startsWith('default (')) return `default: ${source.slice('default ('.length, -1)}`;
  if (source.startsWith('ignored:launch')) return 'ignored: a launch setting — use the flag or the variable';
  return source;
}

/** §7.5 / §12: the row suffix — `✗ expected an integer ≥ 1` (`x expected …`), `⚠ clamped to 30`. */
export function problemSuffix(problem: SettingProblem, g: GlyphSet): string {
  if (isClampProblem(problem)) return `${g.warn} ${problem.expected}`;
  return `${g.cross} expected ${problem.expected}`;
}

/**
 * TUI-DESIGN-4 §3.4: `/config` is a `shortPath` consumer — an absolute path value is `~`-abbreviated and, when it
 * still does not fit, left-elided so the leaf survives (`…/a3-home-L5tIsG/runs`). Anything that is not an absolute
 * path is returned unchanged, and `--json` / `configTableRows` always keep the value the record holds.
 */
function shortValue(value: string, room: number, g: GlyphSet, home?: string): string {
  if (!value.startsWith('/')) return value;
  return shortPath(value, { root: '', ...(home !== undefined ? { home } : {}), width: Math.max(1, room), measure: cellWidth, ellipsis: g.ellipsis });
}

const MASKED_RE = /^<(.*)> (\(sha256:[0-9a-f]+\))$/;

/** §3.3 edge 2: a masked secret is NEVER elided in the middle of its fingerprint — the source path goes first. */
function fitMaskedValue(text: string, width: number, g: GlyphSet): string | null {
  const m = MASKED_RE.exec(text);
  if (m === null) return null;
  const tail = ` ${m[2] as string}`;
  const room = Math.max(1, width - cellWidth(tail));
  return `<${elideLeft(m[1] as string, Math.max(1, room - 2), g)}>${tail}`;
}

/** F-B3: the sandbox footer is a `rule` caption plus one `facts` row, not a 180-cell sentence. */
export function sandboxFacts(level: SandboxLevel, network: boolean): string[] {
  const net = network ? 'network on (--no-network)' : 'network off';
  if (level === 'seatbelt') return ['seatbelt', 'writes only in the workspace and run dirs', 'secrets, ~/.ssh, ~/.aws unreadable', net];
  return ['none', 'cwd confinement, env scrubbing, timeout, output cap and tree kill only', '.git/config and .git/hooks are writable by commands', net];
}

export interface ConfigBlockOptions {
  sandboxLevel: SandboxLevel;
  /** the block body width — `blockWidth(columns())`, §3.1.2. Defaults to the 80-column body (70). */
  width?: number;
  all?: boolean;
  /** TUI-DESIGN-4 §7.5 item 4: file keys that name no setting; one warning row names the nearest valid setting */
  unknownFileKeys?: readonly string[];
  /** TUI-DESIGN-4 §3.4: $HOME, so an absolute path value prints `~/T/a3-ws-eO2WYu` (F-B3). `--json` keeps the absolute path. */
  home?: string;
  glyphs?: GlyphSet;
  /**
   * §3.1.5's row cap — **opt-in**. A cap belongs to a TRANSCRIPT (the `/config` block competes with the run for
   * the scrollback); `jevcode config` on the CLI is the command whose whole job is to print the settings, so it
   * passes nothing and prints them all. Ignored when `all` is true: a footer may never point at a flag that is
   * already set, and `--all` with a cap made `jevcode config --all` unable to print the rows it exists for.
   */
  max?: number;
}

export interface ConfigBlock {
  /** §3.1.1: the head, with its one right-hand meta field — `config · 6 set, 34 at their defaults` */
  head: string;
  rows: BlockRow[];
  /** §3.3: the pinned INNER table widths (`setting`, `value`); `renderBlock` adds the two-cell gap */
  tableCols: readonly number[];
  /**
   * §3.3 edge 4: the trailing rows `renderBlock`'s cap may never drop — the `gap` + `rule` + `facts` sandbox
   * footer is the block's security statement, and a cap that ate it left `╶──── sandbox` with nothing under it.
   */
  protectTail: number;
}

/**
 * §3.3: `/config` as `BlockRow[]`. Rows at their default fold behind `… +N settings at their defaults
 * (/config --all)`; a row with a **problem** and an `.ignored` row are NEVER folded (§3.3 edges 3 and 8).
 */
export function configBlock(record: Readonly<Record<string, ConfigRecordValue>>, opts: ConfigBlockOptions): ConfigBlock {
  const g = opts.glyphs ?? GLYPHS.unicode;
  const width = opts.width ?? blockWidth(80);
  const tier = blockTier(width);
  const short = tier === 'tight' || tier === 'narrow';
  const all = opts.all === true;
  const rows = configTableRows(record, { ...(opts.all !== undefined ? { all: opts.all } : {}) });
  const keepAlways = (r: ConfigTableRow): boolean => r.problem !== undefined || r.setting.endsWith('.ignored');
  const shown = all ? rows : rows.filter((r) => !r.atDefault || keepAlways(r));
  const folded = rows.length - shown.length;
  const set = rows.filter((r) => !r.atDefault).length;
  const defaults = rows.length - set;
  const head = rows.length === 0 ? 'config' : `config ${g.dot} ${set} set, ${defaults}${short ? ' default' : ' at their defaults'}`;

  const body: BlockRow[] = [];
  // §3.3: `setting` = min(28, longest) INCLUDING the folded rows, so `--all` and the folded view line up; the
  // two-cell gap lives inside that budget, which is what puts F-B3's value column at exactly 28.
  const settingCol = Math.min(CONFIG_SETTING_COL_MAX, Math.max(7, ...rows.map((r) => cellWidth(r.setting))) + 2);
  const valueCol = Math.max(CONFIG_VALUE_COL_MIN, width - settingCol);
  if (rows.length === 0) {
    body.push({ kind: 'note', text: 'no settings resolved yet' });
  } else {
    body.push({ kind: 'table', cells: ['setting', 'value'], header: true });
    // §3.1.2 / F-B4: in the `tight` tier the value row is the whole body less the two-cell indent, NOT the
    // three-column `valueCol` — `renderBlock` puts the setting on its own row there, so the budget is different
    const room = tier === 'tight' ? Math.max(1, width - 2) : valueCol;
    for (const r of shown) {
      const src = configSourceText(r.source, all);
      // §3.4: an absolute path value is `~`-abbreviated and left-elided (F-B3 `~/T/a3-ws-eO2WYu`, `…/a3-home/runs`)
      const parts = [shortValue(r.value, room, g, opts.home)];
      if (src !== null) parts.push(`(${src})`);
      if (r.problem !== undefined) parts.push(problemSuffix(r.problem, g));
      const masked = fitMaskedValue(r.value, room, g);
      if (masked !== null) parts[0] = masked;
      const whole = parts.join('  ');
      // §3.3: a `derived (…)` suffix that does not fit moves to its own indented note row
      const fits = cellWidth(whole) <= room;
      body.push({ kind: 'table', cells: [r.setting, fits ? whole : parts[0]!] });
      if (!fits) for (const extra of parts.slice(1)) body.push({ kind: 'note', text: extra });
    }
    // F-B3 / F-B4 draw the fold footer FLUSH with the table, not indented like a note (§3.1.5's footer shape)
    if (folded > 0) body.push({ kind: 'note', flush: true, text: `${g.ellipsis} +${folded}${short ? ' default' : ' settings at their defaults'} (/config --all)` });
  }
  // §7.5 item 4: one warning row, naming each unknown key with the nearest valid setting
  const unknown = opts.unknownFileKeys ?? [];
  if (unknown.length > 0) body.push({ kind: 'note', text: unknown.map((k) => `${k} is not a setting${nearestSetting(k)}`).join(` ${g.dot} `) });
  const networkRow = record['noNetwork']?.value;
  const network = !(typeof networkRow === 'string' && /^(1|true|yes|on)$/i.test(networkRow.trim()));
  body.push({ kind: 'gap' }, { kind: 'rule', caption: 'sandbox' }, { kind: 'facts', segments: sandboxFacts(opts.sandboxLevel, network) });
  return { head, rows: body, tableCols: [Math.max(1, settingCol - 2), valueCol], protectTail: SANDBOX_TAIL_ROWS };
}

/** §7.5 item 4: the nearest valid setting through the palette's `rank`, or nothing when nothing scores well enough. */
function nearestSetting(key: string): string {
  const names = SETTINGS.filter((sp) => sp.fileKey !== undefined).map((sp) => sp.fileKey!);
  const best = rank(key, names, 1)[0];
  return best === undefined || best.score < 700 ? '' : ` (did you mean ${best.candidate}?)`;
}

/**
 * TUI-DESIGN-4 §3.3: the rendered body rows of the `/config` block at `opts.width` — one string per row, every one
 * at most `width` cells. `jevcode config` prints the head and these; the session hands the same rows to the TUI
 * detail body, to `--plain` and to `transcript.log` (§3.5).
 */
export function configTableLines(record: Readonly<Record<string, ConfigRecordValue>>, opts: ConfigBlockOptions): string[] {
  const g = opts.glyphs ?? GLYPHS.unicode;
  const width = opts.width ?? blockWidth(80);
  const block = configBlock(record, opts);
  return renderBlock(block.rows, width, g, { ...configRenderOptions(block, opts) }).map((r) => r.text);
}

/**
 * §3.1.5 / §3.3 edge 4: the `renderBlock` options of a `/config` block — the pinned columns, the protected
 * sandbox tail and the cap, which fires only when the caller asked for one and `--all` is off. The footer is
 * §12's bare `… +<n> more rows` (laddered by `renderBlock`), never a pointer at a flag that is already set.
 */
export function configRenderOptions(block: ConfigBlock, opts: ConfigBlockOptions): RenderBlockOptions {
  const cap = opts.all === true ? undefined : opts.max;
  return {
    tableCols: block.tableCols,
    protectTail: block.protectTail,
    ...(cap !== undefined ? { max: cap, moreFooter: `${opts.glyphs?.ellipsis ?? GLYPHS.unicode.ellipsis} +{n} more rows (/config --all)` } : {}),
  };
}

/**
 * TUI-DESIGN-4 §7.5: the exit code of `jevcode config` — 2 for a `wrong-type` or an `out-of-range` problem (they
 * will fail the next run, so the command that reports them fails too), 0 for an unknown key, which is a warning
 * row. A clamped bound (`ui.fps: 240`) is a `⚠` row, not a failure.
 */
export function configExitCode(record: Readonly<Record<string, ConfigRecordValue>>): 0 | 2 {
  for (const v of Object.values(record)) {
    const p = v.problem;
    if (p === undefined || p === null) continue;
    if (p.kind === 'unknown-key' || isClampProblem(p)) continue;
    return 2;
  }
  return 0;
}

/**
 * TUI-DESIGN-4 §7.5 item 5 (P-D5): the config problems as `[setup]` item texts, emitted once at session start so a
 * TUI user sees a value the next run will reject without running `/config`. One row per problem plus one row for
 * the unknown file keys; a clamped bound is a `⚠` row, a refused value a `✗` row. Empty when nothing is wrong.
 */
export function configProblemLines(
  c: { record(): Readonly<Record<string, ConfigRecordValue>>; readonly unknownFileKeys?: readonly string[] },
  g: GlyphSet = GLYPHS.unicode,
): string[] {
  const out: string[] = [];
  for (const [setting, v] of Object.entries(c.record())) {
    const p = v.problem;
    if (p === undefined || p === null || p.kind === 'unknown-key') continue;
    out.push(`${setting}: ${problemSuffix(p, g)}`);
  }
  const unknown = c.unknownFileKeys ?? [];
  if (unknown.length > 0) out.push(unknown.map((k) => `${k} is not a setting${nearestSetting(k)}`).join(` ${g.dot} `));
  return out;
}
