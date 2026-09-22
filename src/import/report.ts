/**
 * The dry-run report (docs/IMPORT-DESIGN.md §4.6.2) and the `--json` twin (§4.6.1).
 *
 * *The report **is** the plan* (§0 principle 9): every section is rendered from `ImportPlan` and
 * nothing else, every section head is rendered **even when its list is empty** (§6 row 5 — "no
 * tool installed" must not read as "you have nothing"), and §8.2 **R5** holds: `parseReport`
 * recovers the same row ids, actions and destinations from the rendered markdown as the plan
 * holds, so the report is not allowed to say something the plan does not.
 *
 * Pure and deterministic: no clock, no locale, no `process` beyond the debug gate, no ANSI, no
 * network, no writes. Byte-capped at `reportBytes`. §1 property 4 is enforced in two steps: the
 * rendered text is redacted against all fifteen families, **and then** a debug assertion refuses
 * to return a report any `REDACTING_PATTERNS` or `WARN_ONLY_PATTERNS` family still matches a
 * line of. That order matters — the assertion used to run on raw output, so an attacker-chosen
 * *filename* (`docs/AKIA….md`) aborted the whole dry run instead of being masked.
 */
import { IMPORT_LIMITS } from '../core/limits.js';
import { REDACTING_PATTERNS, WARN_ONLY_PATTERNS } from '../core/redact.js';
import { clipBytes } from '../core/text.js';
import { redactSecrets } from './parse/markdown.js';
import type { ImportPlan, PlanRow } from './types.js';

/** `--ascii` (§6 row 89): every glyph has an ASCII twin. */
export type ReportView = 'unicode' | 'ascii';

/** §4.6.2: the thirteen section heads, in order, all always rendered. */
export const REPORT_SECTIONS: readonly string[] = [
  'Summary',
  'Sources',
  'Memory',
  'Rules',
  'Commands',
  'MCP',
  'Review',
  'Suggested permissions (not applied)',
  'Credentials',
  'Cannot be read from disk',
  'Skipped',
  'Notices',
  'Apply',
];

interface Glyphs {
  arrow: string;
  from: string;
  dot: string;
  dash: string;
  approx: string;
}
const UNICODE: Glyphs = { arrow: '→', from: '←', dot: '·', dash: '—', approx: '≈' };
const ASCII: Glyphs = { arrow: '->', from: '<-', dot: '*', dash: '-', approx: '~' };

/** The plan's own `dest` for a report-only row. Parsed back to `null` by `parseReport`. */
const NO_DEST = '(none)';

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Deterministic, locale-free: `4.1 KiB`, `938 B`, `2.7 GB` is never needed — bytes are ours. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : String(Math.round(kib))} KiB`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : String(Math.round(mib))} MiB`;
}

/** TD3 §5.1 / §4.4.4: money is four decimals — `$0.0003`. */
function usdOf(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * Terminal cells of a string: East-Asian wide and fullwidth code points count two, combining
 * marks and zero-width joiners count none. Enough for the column padding of a report that is
 * mostly paths; the TUI's own measurer is off-limits to `src/import/**` (§7 ownership).
 */
export function cells(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    n += wide ? 2 : 1;
  }
  return n;
}

function pad(s: string, width: number): string {
  const n = cells(s);
  return n >= width ? s : s + ' '.repeat(width - n);
}

const SKIP_PREFIX = 'skip:';

function isSkip(row: PlanRow): boolean {
  return row.action.startsWith(SKIP_PREFIX);
}

/**
 * §1 property 2: the row sections **partition** the plan — every row has exactly one primary
 * section, so no row can be rendered nowhere. (`## Credentials` additionally lists every
 * `secret`-class row, whatever its action; `parseReport` keys by row id, so the repeat costs
 * nothing.)
 */
function primarySection(row: PlanRow): string {
  if (isSkip(row)) return 'Skipped';
  if (row.action === 'review') return 'Review';
  if (row.action === 'suggest') return 'Suggested permissions (not applied)';
  switch (row.class) {
    case 'rule':
      return 'Rules';
    case 'command':
      return 'Commands';
    case 'mcp':
      return 'MCP';
    case 'secret':
      return 'Credentials';
    default:
      return 'Memory';
  }
}

/** ASCII twins for the six glyphs the report and the plan's own strings use (§6 row 89). */
function asciiFold(s: string): string {
  return s.replace(/→/g, '->').replace(/←/g, '<-').replace(/·/g, '*').replace(/—/g, '-').replace(/≈/g, '~').replace(/…/g, '...');
}

/** §4.6.2: the row line. The id is column 1 — §8.2 R5 requires the ids to be recoverable, and the design's sample line has no column for them. */
function rowLine(row: PlanRow, g: Glyphs): string {
  const dest = row.dest ?? NO_DEST;
  const size = row.bytes === 0 ? '' : sizeOf(row.bytes);
  const sha = row.source.sha256.slice(0, 8);
  const warn = row.warnings.length === 0 ? '' : `  ${g.dot} ${row.warnings.join(`; `)}`;
  const group = row.group === undefined ? '' : `  [${row.group}]`;
  return `${row.id}  ${pad(row.action, 16)}  ${pad(dest, 40)}  ${g.from} ${row.source.display}  ${pad(size, 9)}  ${sha}  ${row.why}${group}${warn}`.trimEnd();
}

function section(head: string, count: string, lines: readonly string[]): string[] {
  return [`## ${head}${count.length > 0 ? `  ${count}` : ''}`, ...lines, ''];
}

function destGroup(rows: readonly PlanRow[], head: string): { rows: PlanRow[]; bytes: number } {
  const picked = rows.filter((r) => primarySection(r) === head);
  return { rows: picked, bytes: picked.reduce((n, r) => n + r.bytes, 0) };
}

/**
 * §4.6.2: `report.md`, deterministic, cell-measured, `≤ reportBytes` (1 MiB) and free of ANSI.
 * `view === 'ascii'` swaps every glyph for its twin (§6 row 89).
 */
export function renderReport(plan: ImportPlan, view: ReportView = 'unicode'): string {
  const g = view === 'ascii' ? ASCII : UNICODE;
  const rows = plan.rows;
  const out: string[] = [];

  const toImport = rows.filter((r) => !isSkip(r) && r.action !== 'review' && r.action !== 'suggest').length;
  const toReview = rows.filter((r) => r.action === 'review').length;
  const skipped = rows.filter(isSkip).length;

  const trustWord = plan.trust === 'trust' ? 'trusted' : plan.trust === 'session' ? 'trusted for this session' : 'not trusted';
  const where = plan.gitRoot === null ? `(no git root, ${trustWord})` : `(git root, ${trustWord})`;
  out.push(`# jevcode import ${g.dash} dry run ${plan.importId}`);
  out.push(`${plan.at} ${g.dot} jevcode ${plan.jevcodeVersion} ${g.dot} workspace ${plan.workspace} ${where}`);
  out.push(`Nothing outside ~/.jevcode/imports/${plan.importId}/ has been written.`);
  out.push('');

  // ## Summary
  out.push(
    ...section('Summary', '', [
      `${toImport} to import ${g.dot} ${toReview} to review ${g.dot} ${skipped} skipped ${g.dot} 0 bytes of secrets copied`,
      `memory ${sizeOf(plan.budget.memoryBytes)} of ${sizeOf(plan.budget.memoryMax)} ${g.dot} index ${plan.budget.indexLines} of ${plan.budget.indexMax} lines ${g.dot} jev ${plan.jev.requests} request${plan.jev.requests === 1 ? '' : 's'}, ${plan.jev.questions} questions, ${usdOf(plan.jev.usd)}, ${plan.jev.fallbacks} fallback${plan.jev.fallbacks === 1 ? '' : 's'}${plan.jev.reason === undefined ? '' : ` ${g.dot} ${plan.jev.reason}`}`,
    ]),
  );

  // ## Sources
  const byTool = new Map<string, number>();
  for (const r of rows) for (const t of r.source.tools) byTool.set(t, (byTool.get(t) ?? 0) + 1);
  out.push(
    ...section(
      'Sources',
      '',
      plan.roots.map((root) => {
        const via = root.via === 'env' ? (root.env ?? 'env') : '(default)';
        const n = byTool.get(root.tool) ?? 0;
        return `${pad(root.tool, 14)} ${pad(root.display, 26)} ${pad(via, 16)} ${root.exists ? `${n} artefact${n === 1 ? '' : 's'}` : 'not installed'}`;
      }),
    ),
  );

  // ## Memory / ## Rules / ## Commands / ## MCP
  const memory = destGroup(rows, 'Memory');
  out.push(...section('Memory', `${g.arrow} .jevcode/memory  (${memory.rows.length} rows, ${sizeOf(memory.bytes)})`, memory.rows.map((r) => rowLine(r, g))));
  const rules = destGroup(rows, 'Rules');
  out.push(...section('Rules', `${g.arrow} .jevcode/rules  (${rules.rows.length} rows, ${sizeOf(rules.bytes)})`, rules.rows.map((r) => rowLine(r, g))));
  const commands = destGroup(rows, 'Commands');
  out.push(...section('Commands', `${g.arrow} .jevcode/commands  (${commands.rows.length} rows, ${sizeOf(commands.bytes)})`, commands.rows.map((r) => rowLine(r, g))));
  const mcp = destGroup(rows, 'MCP');
  out.push(...section('MCP', `${g.arrow} .jevcode/mcp.json  (${mcp.rows.length} rows, all disabled)`, mcp.rows.map((r) => rowLine(r, g))));

  // ## Review
  const review = destGroup(rows, 'Review').rows;
  out.push(...section('Review', `(${review.length} rows)`, review.map((r) => rowLine(r, g))));

  // ## Suggested permissions (not applied)
  const suggest = destGroup(rows, 'Suggested permissions (not applied)').rows;
  out.push(
    ...section('Suggested permissions (not applied)', `(${suggest.length})`, [
      ...suggest.map((r) => rowLine(r, g)),
      `  JevCode's sandbox is set by --sandbox and /trust; nothing here was copied.`,
    ]),
  );

  // ## Credentials
  const credentials = rows.filter((r) => r.class === 'secret');
  out.push(
    ...section('Credentials', `(${credentials.length} found ${g.dot} 0 copied)`, [
      ...credentials.map((r) => rowLine(r, g)),
      '  Run `jevcode import --yes` on a terminal to be asked per key. Values never appear here.',
    ]),
  );

  // ## Cannot be read from disk — rendered even when empty (§6 row 5)
  out.push(
    ...section('Cannot be read from disk', `(${plan.cannotRead.length})`, plan.cannotRead.map((c) => `${pad(c.what, 28)} ${pad(c.why, 34)} ${g.arrow} ${c.paste}`)),
  );

  // ## Skipped — grouped by reason, with the rows underneath
  const skippedRows = rows.filter(isSkip);
  const byReason = new Map<string, PlanRow[]>();
  for (const r of skippedRows) {
    const list = byReason.get(r.action);
    if (list) list.push(r);
    else byReason.set(r.action, [r]);
  }
  const skipLines: string[] = [];
  for (const reason of [...byReason.keys()].sort()) {
    const list = byReason.get(reason) ?? [];
    skipLines.push(`${pad(reason, 20)} ${thousands(list.length)}`);
    for (const r of list) skipLines.push(`  ${rowLine(r, g)}`);
  }
  out.push(...section('Skipped', `(${thousands(skippedRows.length)})`, skipLines));

  // ## Notices
  out.push(...section('Notices', '', plan.notices.map((n) => n)));

  // ## Apply
  out.push(
    ...section('Apply', '', [
      'jevcode import --yes                              everything above except review and skip rows',
      'jevcode import --yes --scope=user                 user-scope rows only',
      `jevcode import --undo ${plan.importId}`,
    ]),
  );

  let text = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  if (view === 'ascii') text = asciiFold(text);
  // §1 property 4: redact the rendered text, **then** assert (review defect 9). Every string the
  // report interpolates — `display`, `why`, `warnings`, `notices`, `dest` — is derived from a
  // source the user did not write, and `display` is the worst of them because a filename is
  // chosen by whoever made the file. The assertion below is the net for a family the redactor
  // and the probes disagree about; it must not be the thing that a filename trips.
  text = redactSecrets(text);
  if (Buffer.byteLength(text, 'utf8') > IMPORT_LIMITS.reportBytes) {
    const clipped = clipBytes(text, IMPORT_LIMITS.reportBytes - 80);
    text = `${clipped.text}\n\n_report clipped at ${thousands(IMPORT_LIMITS.reportBytes)} bytes_\n`;
  }
  assertNoSecretLines(text);
  return text;
}

/** §4.6.1: the `--json` form — one object, no prose, no ANSI, no secrets. */
export function renderPlanJson(plan: ImportPlan): string {
  // §1 property 4 names `plan.json` in the same breath as `report.md`, and §4.6.2 puts this exact
  // string on stdout under `--json`. Review defect 9 redacted the report because its own leak
  // assertion was crashing; `plan.json` had no assertion, so nothing forced the issue — but the
  // exposure is identical. `source.display`, `why`, `warnings` and `notices` are all
  // source-controlled, so a repository shipping `docs/AKIA….md` would otherwise echo that string
  // into an artefact and onto the terminal from a path the human never typed.
  //
  // Redacting the serialised form rather than the fields keeps one rule for the whole document
  // and cannot miss a member added later. It is safe for the JSON contract: `[REDACTED:pattern]`
  // contains no quote, backslash or control character, so the result still parses, and a plan
  // with nothing to redact is returned byte for byte unchanged.
  return `${redactSecrets(JSON.stringify(plan, null, 2))}\n`;
}

// ---------------------------------------------------------------------------------------
// §8.2 R5 — reading the report back
// ---------------------------------------------------------------------------------------

const ROW_RE = /^ {0,2}([0-9a-f]{12}) {2}(\S+) +(\S.*?) {2}(?:←|<-) /;

/**
 * §8.2 R5: a strict parser over the rendered markdown. It recovers the row id, the action and
 * the destination of every row line, plus the section heads in order — so a report that says
 * something the plan does not becomes a test failure rather than a surprise.
 */
export function parseReport(markdown: string): { rows: readonly { id: string; action: string; dest: string | null }[]; sections: readonly string[] } {
  const rows: { id: string; action: string; dest: string | null }[] = [];
  const sections: string[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      sections.push(line.slice(3).trim());
      continue;
    }
    const m = ROW_RE.exec(line);
    if (m === null) continue;
    const id = m[1];
    const action = m[2];
    const destRaw = (m[3] ?? '').trim();
    if (id === undefined || action === undefined) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, action, dest: destRaw === NO_DEST || destRaw.length === 0 ? null : destRaw });
  }
  return { rows, sections };
}

// ---------------------------------------------------------------------------------------
// §1 property 4 — the structural half, asserted at render time
// ---------------------------------------------------------------------------------------

const DEBUG = process.env['NODE_ENV'] !== 'production';

/** The fifteen families as non-global probes, built once: a `/g` regex carries `lastIndex` state. */
const SECRET_PROBES: readonly { family: string; re: RegExp }[] = [...REDACTING_PATTERNS.map((p) => ({ family: p.family, re: p.re })), ...WARN_ONLY_PATTERNS].map(({ family, re }) => ({
  family,
  re: new RegExp(re.source, re.flags.replace('g', '')),
}));

/**
 * §4.6.2 / §1 property 4: in debug, refuse to hand back a report any secret family matches a
 * line of. The message names the family and the line number and **never the match** — a leak
 * assertion that printed the leak would be its own bug.
 *
 * It runs on the **redacted** text (`renderReport` masks before it asserts), so what it now
 * catches is a divergence between `detectSecrets`' spans and these probes, not source content:
 * a hostile filename is masked, and a real disagreement is still loud (review defect 9).
 */
function assertNoSecretLines(text: string): void {
  if (!DEBUG) return;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const { family, re } of SECRET_PROBES) {
      if (re.test(line)) throw new Error(`import report: line ${i + 1} matches the ${family} secret family; the report may not carry a value`);
    }
  }
}
