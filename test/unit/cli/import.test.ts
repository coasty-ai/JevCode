/**
 * TUI-DESIGN-5 §10 (R5-5 `cli/import.test.ts`): every flag, every exit code, the five twins, `--yes` refusing
 * credentials, and `--resume` / `--undo` id validation **through `isImportId`** (IMPORT-DESIGN §5.6, §5.7,
 * §4.8.2).
 *
 * The engine arrives through the `ImportIo.engine` seam, so the suite is offline and hermetic; `isImportId`,
 * `summarisePlan` and `applicableRows` are the REAL functions from `src/import/index.ts` — the id rule and the
 * `--yes` policy are the engine's, and a hand-rolled stand-in would prove nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applicableRows, asImportPlan, isImportId, summarisePlan } from '../../../src/import/index.js';
import type { ImportPlan } from '../../../src/core/types.js';
import { EXIT_CODES } from '../../../src/errors.js';
import {
  IMPORT_CREDENTIALS_NEED_TTY,
  IMPORT_DRY_RUN,
  IMPORT_PIPE_DRY_RUN,
  IMPORT_SCOPES,
  commandImport,
  importNotWired,
  type ImportApplyOutcome,
  type ImportEngine,
  type ImportFlags,
  type ImportIo,
} from '../../../src/cli/import.js';
import { IMPORT_NOTHING_FOUND, importSelectionPrompt } from '../../../src/tui/import/lines.js';
import { importManifestPath, importsRoot, readImportManifest } from '../../../src/config/imports.js';
import type { ImportManifestEntry } from '../../../src/core/types.js';

const RAW = readFileSync(new URL('../../fixtures/import/plan.json', import.meta.url), 'utf8');
const plan = (): ImportPlan => JSON.parse(RAW) as ImportPlan;

interface Sink {
  out: string[];
  err: string[];
  io: ImportIo;
  applied: ImportApplyOutcome | null;
  rowsAsked: readonly string[] | null;
}

function sink(over: Partial<ImportIo> = {}, engineOver: Partial<ImportEngine> = {}, p: ImportPlan = plan(), omit: readonly (keyof ImportEngine)[] = []): Sink {
  const out: string[] = [];
  const err: string[] = [];
  const s: Sink = { out, err, applied: null, rowsAsked: null, io: {} as ImportIo };
  const built: ImportEngine = {
    isImportId,
    planImport: async () => p,
    summarisePlan,
    applicableRows: (pl, opts) => applicableRows(pl, opts ?? {}),
    asImportPlan,
    applyPlan: async (input) => {
      s.rowsAsked = input.rows ?? null;
      const o: ImportApplyOutcome = { applied: input.rows?.length ?? 0, failed: 0, total: input.rows?.length ?? 0, importId: input.importId ?? p.importId, error: null };
      s.applied = o;
      return o;
    },
    resumeImport: async (input) => {
      s.rowsAsked = input.rows ?? null;
      const o: ImportApplyOutcome = { applied: 2, failed: 0, total: 2, importId: input.importId ?? p.importId, error: null };
      s.applied = o;
      return o;
    },
    undoImport: async ({ importId }) => ({ restored: 41, modified: 0, importId }),
    ...engineOver,
  };
  // `exactOptionalPropertyTypes` forbids `{ applyPlan: undefined }`, so an ABSENT seam is modelled by omission
  const engine = Object.fromEntries(Object.entries(built).filter(([k]) => !omit.includes(k as keyof ImportEngine))) as unknown as ImportEngine;
  s.io = {
    stdout: { write: (t: string) => out.push(t) },
    stderr: { write: (t: string) => err.push(t) },
    columns: 120,
    isTTY: true,
    engine,
    ...over,
  };
  return s;
}

const text = (rows: readonly string[]): string => rows.join('');

let homes: string[] = [];
beforeEach(() => {
  homes = [];
});
afterEach(async () => {
  for (const h of homes) await rm(h, { recursive: true, force: true });
});
async function tempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jevcode-cli-import-'));
  homes.push(dir);
  return dir;
}
/** a `<jevcodeDir>` the CLI may write its manifest into, without a stored plan on disk */
function stored(): Partial<ImportIo> {
  return { jevcodeDir: join(tmpdir(), 'jevcode-cli-import-none'), workspaceKey: '/ws' };
}
const ENTRY: ImportManifestEntry = {
  importId: 'imp_20260921T120000Z_a1b2c3',
  dest: '.jevcode/memory/MEMORY.md',
  sourceSha256: 'aa',
  destSha256: 'bb',
  scope: 'project',
  at: '2026-09-21T12:00:00.000Z',
  by: 'flag',
};


describe('flags and usage (exit 2)', () => {
  it('refuses an unknown --scope and names the three values', async () => {
    const s = sink();
    expect(await commandImport({ scope: 'nope' }, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toContain(IMPORT_SCOPES.join('|'));
    expect(s.out).toEqual([]);
  });

  it('accepts every declared --scope', async () => {
    for (const scope of IMPORT_SCOPES) {
      const s = sink();
      expect(await commandImport({ scope }, s.io), scope).toBe(EXIT_CODES.ok);
    }
  });

  it('refuses --resume with --undo, and --yes with --dry-run', async () => {
    const a = sink();
    expect(await commandImport({ resume: 'imp_20260921T120000Z_a1b2c3', undo: 'imp_20260921T120000Z_a1b2c3' }, a.io)).toBe(EXIT_CODES.config);
    expect(text(a.err)).toContain('--resume and --undo are exclusive');
    const b = sink();
    expect(await commandImport({ yes: true, dryRun: true }, b.io)).toBe(EXIT_CODES.config);
    expect(text(b.err)).toContain('--yes and --dry-run are exclusive');
  });
});

describe('--resume / --undo id validation goes through `isImportId`', () => {
  const bad = ['imp_2026', 'imp_20260921T120000Z_A1B2C3', 'imp_20260921T120000_a1b2c3', '', 'nonsense', 'imp_20260921T120000Z_a1b2c3x'];
  const good = 'imp_20260921T120000Z_a1b2c3';

  it('the good id is the one `isImportId` accepts and the bad ones are the ones it rejects', () => {
    expect(isImportId(good)).toBe(true);
    for (const v of bad) expect(isImportId(v), v).toBe(false);
  });

  it('every bad --undo id is exit 2 with the id shape named', async () => {
    for (const v of bad) {
      const s = sink();
      expect(await commandImport({ undo: v }, s.io), v).toBe(EXIT_CODES.config);
      expect(text(s.err)).toContain('imp_YYYYMMDDTHHMMSSZ_xxxxxx');
    }
  });

  it('every bad --resume id is exit 2', async () => {
    for (const v of bad) {
      const s = sink();
      expect(await commandImport({ resume: v, yes: true }, s.io), v).toBe(EXIT_CODES.config);
    }
  });

  it('the CLI calls the engine’s own `isImportId`, not a private regex', async () => {
    let asked: string[] = [];
    const s = sink({}, { isImportId: (v) => (asked.push(v), isImportId(v)) });
    asked = [];
    await commandImport({ undo: good }, s.io);
    expect(asked).toEqual([good]);
  });

  it('a good --undo id prints the §12.4 S94 item and exits 0', async () => {
    const s = sink();
    expect(await commandImport({ undo: good }, s.io)).toBe(EXIT_CODES.ok);
    expect(text(s.out)).toBe('[import] undo imp_…a1b2c3 · 41 files restored · 0 modified since\n');
  });

  it('--undo --json is the documented `{ importId, applied, restored, skipped, errors }` shape', async () => {
    const s = sink();
    expect(await commandImport({ undo: good, json: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(JSON.parse(text(s.out))).toEqual({ importId: good, applied: 0, restored: 41, skipped: 0, errors: [] });
  });
});

describe('the dry run (the default) and the five twins', () => {
  it('prints the plan item and the numbered group list; exit 0; nothing applied', async () => {
    const s = sink();
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.ok);
    const all = text(s.out);
    expect(all).toContain('[import] plan imp_20260921T120000Z_a1b2c3 · 10 to import · 2 to review · 7 skipped');
    expect(all).toMatch(/^ {2}1 memory/m);
    expect(s.applied).toBeNull();
  });

  it('§5.7: a TTY dry run never prints a prompt nothing can answer — it says it was a dry run instead', async () => {
    const s = sink({ isTTY: true });
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.ok);
    // the numbered twin's `Enter selection (1-N):` belongs to the readline twin, which this build does not have
    expect(text(s.out)).not.toContain(importSelectionPrompt(6));
    expect(text(s.out)).not.toContain('Enter selection');
    expect(text(s.err)).toContain(IMPORT_DRY_RUN);
  });

  it('`--dry-run` is the same output as the default (it exists for scripts)', async () => {
    const a = sink();
    const b = sink();
    await commandImport({}, a.io);
    await commandImport({ dryRun: true }, b.io);
    expect(text(b.out)).toBe(text(a.out));
  });

  it('`--json` is ONE `ImportPlan`, no prose (§13.3)', async () => {
    const s = sink();
    expect(await commandImport({ json: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(s.out).toHaveLength(1);
    const parsed = JSON.parse(text(s.out)) as ImportPlan;
    expect(parsed.importId).toBe('imp_20260921T120000Z_a1b2c3');
    expect(parsed.rows).toHaveLength(19);
    expect(text(s.out)).not.toContain('[import]');
  });

  it('`--ascii` renders the same rows with no unicode glyph', async () => {
    const s = sink({ ascii: true });
    await commandImport({}, s.io);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f\n]*$/.test(text(s.out))).toBe(true);
    expect(text(s.out)).toContain('Import - 10 to import - 2 to review - 7 skipped');
  });

  it('`--screen-reader` is the numbered, spoken twin', async () => {
    const s = sink({ screenReader: true });
    await commandImport({}, s.io);
    expect(text(s.out)).toContain('Import: 10 to import, 2 to review, 7 skipped,');
    expect(text(s.out)).toContain('1. memory, 5 rows');
  });

  it('a pipe (or `--no-input`) says the run is a dry run rather than silently not applying — on STDERR', async () => {
    const piped = sink({ isTTY: false });
    await commandImport({}, piped.io);
    expect(text(piped.err)).toContain(IMPORT_PIPE_DRY_RUN);
    // the notice is operator prose: it never lands in the rows a script parses
    expect(text(piped.out)).not.toContain(IMPORT_PIPE_DRY_RUN);
    const tty = sink();
    await commandImport({}, tty.io);
    expect(text(tty.err)).not.toContain(IMPORT_PIPE_DRY_RUN);
    const noInput = sink();
    await commandImport({ noInput: true }, noInput.io);
    expect(text(noInput.err)).toContain(IMPORT_PIPE_DRY_RUN);
  });

  it('§12.4 S92 in `--ascii`: the empty-plan sentence carries no unicode cell either', async () => {
    const empty: ImportPlan = { ...plan(), rows: [] };
    const s = sink({ ascii: true }, {}, empty);
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.ok);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f\n]*$/.test(text(s.out))).toBe(true);
    expect(text(s.out)).toBe('nothing to import - no claude-code, codex or cursor configuration found\n');
  });

  it('`--source` reaches the engine as `optIn` — the one way a transcript pass is enabled', async () => {
    let seen: unknown = null;
    const s = sink({}, { planImport: async (opts) => ((seen = opts.optIn), plan()) });
    await commandImport({ source: 'claude-transcripts' }, s.io);
    expect(seen).toEqual(['claude-transcripts']);
  });

  it('§12.4 S92 / §7 row 52: an empty plan is one sentence and exit 0', async () => {
    const empty: ImportPlan = { ...plan(), rows: [] };
    const s = sink({}, {}, empty);
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.ok);
    expect(text(s.out)).toBe(`${IMPORT_NOTHING_FOUND}\n`);
  });

  it('prints the `[import] report …` item when the caller supplies the artefact path', async () => {
    const s = sink({ reportPath: (id) => `~/.jevcode/imports/${id}/report.md` });
    await commandImport({}, s.io);
    expect(text(s.out)).toContain('[import] report ~/.jevcode/imports/imp_20260921T120000Z_a1b2c3/report.md (0600)');
  });
});

describe('`--yes` (§4.8.2, §5.5)', () => {
  it('applies exactly `applicableRows` — never a credential, never a review, never a skip, never a `suggest`', async () => {
    const s = sink();
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.ok);
    const expected = applicableRows(plan(), { scope: 'both' });
    expect(s.rowsAsked).toEqual(expected);
    for (const id of s.rowsAsked ?? []) {
      const row = plan().rows.find((r) => r.id === id);
      expect(row?.class, id).not.toBe('secret');
      expect(row?.action, id).not.toBe('review');
      expect(row?.action, id).not.toBe('suggest');
      expect(row?.action.startsWith('skip:'), id).toBe(false);
    }
  });

  it('records `by: "flag"` — only the human’s own `--yes` is authority', async () => {
    let by: string | undefined;
    const s = sink({}, { applyPlan: async (i) => ((by = i.by), { applied: 0, failed: 0, total: 0, importId: 'x', error: null }) });
    await commandImport({ yes: true }, s.io);
    expect(by).toBe('flag');
  });

  it('refuses credentials in a NON-TTY with §4.8.2’s sentence on STDERR, and applies the rest', async () => {
    const s = sink({ isTTY: false });
    expect(summarisePlan(plan()).credentialsFound).toBeGreaterThan(0);
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(text(s.err)).toContain(IMPORT_CREDENTIALS_NEED_TTY);
    expect(text(s.out)).not.toContain(IMPORT_CREDENTIALS_NEED_TTY);
    expect(s.rowsAsked).toEqual(applicableRows(plan(), { scope: 'both' }));
  });

  it('does not print the credential refusal on a TTY', async () => {
    const s = sink({ isTTY: true });
    await commandImport({ yes: true }, s.io);
    expect(text(s.err)).not.toContain(IMPORT_CREDENTIALS_NEED_TTY);
  });

  it('`--scope user` narrows what `--yes` writes', async () => {
    const s = sink();
    await commandImport({ yes: true, scope: 'user' }, s.io);
    expect(s.rowsAsked).toEqual(applicableRows(plan(), { scope: 'user' }));
  });

  it('`--resume <id>` routes to `resumeImport`, not `applyPlan`', async () => {
    let which = '';
    const s = sink(
      { ...stored(), readArtifact: async () => RAW },
      {
        applyPlan: async () => ((which = 'apply'), { applied: 0, failed: 0, total: 0, importId: 'x', error: null }),
        resumeImport: async () => ((which = 'resume'), { applied: 2, failed: 0, total: 2, importId: 'imp_20260921T120000Z_a1b2c3', error: null }),
      },
    );
    expect(await commandImport({ yes: true, resume: 'imp_20260921T120000Z_a1b2c3' }, s.io)).toBe(EXIT_CODES.ok);
    expect(which).toBe('resume');
  });
});

/**
 * §12.4 S95 / §7 row 59 behaviour 2: `importWriteErrorItem` and `importInterruptedItem` both tell the human to
 * run `jevcode import --resume imp_…` — **without** `--yes`. That command must continue the half-applied import,
 * from the plan that import stored, or the sentence is a lie.
 */
describe('`--resume <id>` is an apply intent on its own (§12.4 S95)', () => {
  const ID = 'imp_20260921T120000Z_a1b2c3';

  it('with NO `--yes`: it calls `resumeImport` and exits 0', async () => {
    let which = '';
    const s = sink({ ...stored(), readArtifact: async () => RAW }, {
      applyPlan: async () => ((which = 'apply'), { applied: 0, failed: 0, total: 0, importId: 'x', error: null }),
      resumeImport: async () => ((which = 'resume'), { applied: 9, failed: 0, total: 9, importId: ID, error: null }),
    });
    expect(await commandImport({ resume: ID }, s.io)).toBe(EXIT_CODES.ok);
    expect(which).toBe('resume');
    expect(text(s.out)).toContain('[import] applied 9 of 9');
    // and it is NOT a dry run: no plan item, no dry-run notice
    expect(text(s.err)).not.toContain(IMPORT_DRY_RUN);
  });

  it('it resumes the STORED plan for that id — never a freshly re-planned one with a new importId', async () => {
    const fresh: ImportPlan = { ...plan(), importId: 'imp_20260922T090000Z_ffffff', rows: plan().rows.slice(0, 1) };
    let planned = 0;
    let resumedId: string | undefined;
    let resumedRows = 0;
    const asked: string[] = [];
    const s = sink(
      {
        ...stored(),
        readArtifact: async (path) => {
          asked.push(path);
          return RAW;
        },
      },
      {
        planImport: async () => (planned++, fresh),
        resumeImport: async (input) => {
          resumedId = input.plan?.importId;
          resumedRows = input.plan?.rows.length ?? 0;
          return { applied: 9, failed: 0, total: 9, importId: input.importId ?? '', error: null };
        },
      },
    );
    expect(await commandImport({ resume: ID }, s.io)).toBe(EXIT_CODES.ok);
    expect(planned).toBe(0);
    expect(resumedId).toBe(ID);
    expect(resumedRows).toBe(plan().rows.length);
    expect(asked[0]).toContain(join('imports', ID, 'plan.json'));
  });

  it('reads the stored plan through the ENGINE’s `asImportPlan`, and refuses when it cannot', async () => {
    const s = sink({ ...stored(), readArtifact: async () => '{ not json' });
    expect(await commandImport({ resume: ID }, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toContain('cannot read its stored plan');
    const missing = sink({ ...stored(), readArtifact: async () => null });
    expect(await commandImport({ resume: ID }, missing.io)).toBe(EXIT_CODES.config);
  });

  it('`--resume` with `--dry-run` is a usage error, not a silent no-op', async () => {
    const s = sink({ ...stored() });
    expect(await commandImport({ resume: ID, dryRun: true }, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toContain('--resume and --dry-run are exclusive');
  });

  it('the default `readArtifact` reads the real file under `<jevcodeDir>/imports/<id>/plan.json`', async () => {
    const dir = await tempHome();
    await mkdir(join(importsRoot(dir), ID), { recursive: true });
    await writeFile(join(importsRoot(dir), ID, 'plan.json'), RAW, 'utf8');
    let resumedRows = 0;
    const s = sink({ jevcodeDir: dir, workspaceKey: '/ws' }, {
      resumeImport: async (input) => {
        resumedRows = input.plan?.rows.length ?? 0;
        return { applied: 9, failed: 0, total: 9, importId: input.importId ?? '', error: null };
      },
    });
    expect(await commandImport({ resume: ID }, s.io)).toBe(EXIT_CODES.ok);
    expect(resumedRows).toBe(plan().rows.length);
  });
});

describe('exit codes (§5.6)', () => {
  it('0 for a clean apply, and the item is §12.4 S93 whole — counts and bytes, never a truncated second string', async () => {
    const s = sink();
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(text(s.out)).toBe('[import] applied 9 of 9 · memory 5 · commands 1 · rules 2 · mcp 1 (disabled) · 14 KiB\n');
    // the apply path prints ONE item: the plan item belongs to the dry run
    expect(text(s.out)).not.toContain('[import] plan ');
  });

  it('2 for a write failure, with §12.4 S95’s item', async () => {
    const s = sink({}, { applyPlan: async () => ({ applied: 40, failed: 1, total: 41, importId: 'imp_20260921T120000Z_a1b2c3', error: { path: '.jevcode/memory/MEMORY.md', code: 'EACCES' } }) });
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.out)).toBe('[import] error: could not write .jevcode/memory/MEMORY.md: EACCES (40 of 41 applied) — jevcode import --resume imp_…a1b2c3 continues\n');
  });

  it('2 when a row was demoted by the source re-check [G1.1], even with no write error', async () => {
    const s = sink({}, { applyPlan: async () => ({ applied: 8, failed: 1, total: 9, importId: 'imp_20260921T120000Z_a1b2c3', error: null }) });
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.config);
  });

  it('2 when the plan itself fails', async () => {
    const s = sink({}, { planImport: async () => { throw new Error('no roots readable'); } });
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toContain('no roots readable');
  });

  it('130 when Ctrl-C aborts discover — nothing written (§7 row 59, behaviour 1)', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const s = sink({}, { planImport: async () => { throw abort; } });
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.sigint);
    expect(text(s.out)).toBe('[import] cancelled · nothing was written\n');
  });

  it('130 when Ctrl-C stops the apply at a row boundary, with the resume hint (§7 row 59, behaviour 2)', async () => {
    const s = sink({}, { applyPlan: async () => ({ applied: 9, failed: 0, total: 41, importId: 'imp_20260921T120000Z_a1b2c3', error: null, interrupted: true }) });
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.sigint);
    expect(text(s.out)).toBe('[import] applied 9 of 41 — jevcode import --resume imp_20260921T120000Z_a1b2c3\n');
  });

  it('2 when the build has no apply seam at all — the named refusal, BEFORE anything is planned', async () => {
    let planned = 0;
    const s = sink({}, { planImport: async () => (planned++, plan()) }, plan(), ['applyPlan']);
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toBe(`${importNotWired('--yes')}\n`);
    expect(planned).toBe(0);
  });

  it('2 when the build has no UNDO seam (the other half of the same gap)', async () => {
    const s = sink({}, {}, plan(), ['undoImport']);
    expect(await commandImport({ undo: 'imp_20260921T120000Z_a1b2c3' }, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toBe(`${importNotWired('--undo')}\n`);
  });

  it('a plan failure whose MESSAGE says "aborted" is exit 2 with its reason, not a silent 130', async () => {
    const s = sink({}, {
      planImport: async () => {
        throw new Error('discovery aborted: EPERM');
      },
    });
    expect(await commandImport({}, s.io)).toBe(EXIT_CODES.config);
    expect(text(s.err)).toContain('discovery aborted: EPERM');
    expect(text(s.out)).not.toContain('cancelled');
  });
});

describe('gate G-R5-1', () => {
  it('`src/cli/import.ts` reaches `src/import/**` only through a dynamic import inside a function body', () => {
    const src = readFileSync(new URL('../../../src/cli/import.ts', import.meta.url), 'utf8');
    const statics = src.match(/^import\s+(?!type\b)[^;]*from\s+'[^']*import\/index\.js'/gm) ?? [];
    expect(statics).toEqual([]);
    expect(src).toContain("await import('../import/index.js')");
    // the only top-level reach into the facade is type-only, which `verbatimModuleSyntax` erases
    expect(src).toMatch(/^import type \{ PlanSummary \} from '\.\.\/import\/index\.js';$/m);
  });
});

/** the flag surface, as one table, so a new flag cannot be added without a row here */
describe('the flag surface', () => {
  it('names every flag §5.5 lists', () => {
    const f: Required<Pick<ImportFlags, 'dryRun' | 'yes' | 'scope' | 'source' | 'resume' | 'undo' | 'json' | 'plain'>> = {
      dryRun: true,
      yes: false,
      scope: 'both',
      source: 'claude',
      resume: 'imp_20260921T120000Z_a1b2c3',
      undo: 'imp_20260921T120000Z_a1b2c3',
      json: false,
      plain: false,
    };
    expect(Object.keys(f).sort()).toEqual(['dryRun', 'json', 'plain', 'resume', 'scope', 'source', 'undo', 'yes']);
  });
});

describe('the manifest is the CLI’s (§4.7.5 [G1.3], [G1.4])', () => {
  it('a successful apply merges what the engine wrote, at 0600 under a 0700 `imports/`', async () => {
    const dir = await tempHome();
    const s = sink({ jevcodeDir: dir, workspaceKey: '/ws' }, {
      applyPlan: async (input) => ({ applied: input.rows?.length ?? 0, failed: 0, total: input.rows?.length ?? 0, importId: plan().importId, error: null, entries: [ENTRY] }),
    });
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.ok);
    const path = importManifestPath(dir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(importsRoot(dir))).mode & 0o777).toBe(0o700);
    const back = await readImportManifest(path, '/ws');
    expect(back.manifest.workspaces['/ws']?.map((e) => e.dest)).toEqual(['.jevcode/memory/MEMORY.md']);
    expect(back.manifest.lastRun).toBe(ENTRY.importId);
  });

  it('the apply hands the engine the manifest it read, so the engine merges rather than re-creates', async () => {
    const dir = await tempHome();
    await mkdir(importsRoot(dir), { recursive: true });
    await writeFile(importManifestPath(dir), JSON.stringify({ v: 1, user: [], workspaces: { '/ws': [ENTRY] } }), 'utf8');
    let handed: unknown = 'absent';
    const s = sink({ jevcodeDir: dir, workspaceKey: '/ws' }, {
      applyPlan: async (input) => {
        handed = input.manifest;
        return { applied: 1, failed: 0, total: 1, importId: plan().importId, error: null };
      },
    });
    await commandImport({ yes: true }, s.io);
    expect(handed).not.toBe('absent');
    expect((handed as { workspaces: Record<string, unknown[]> }).workspaces['/ws']).toHaveLength(1);
  });

  it('[G1.4]: the retention GC runs after the apply and says what it removed', async () => {
    const dir = await tempHome();
    const ids = Array.from({ length: 12 }, (_, i) => `imp_202601${String(i + 1).padStart(2, '0')}T000000Z_aaaaaa`);
    for (const id of ids) await mkdir(join(importsRoot(dir), id), { recursive: true });
    const s = sink({ jevcodeDir: dir, workspaceKey: '/ws' }, {
      applyPlan: async () => ({ applied: 1, failed: 0, total: 1, importId: plan().importId, error: null, entries: [ENTRY] }),
    });
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(text(s.out)).toContain('[import] removed 2 old import records (kept the newest 10)');
  });

  it('a manifest written by a NEWER JevCode is read as empty and never overwritten (finding 12)', async () => {
    const dir = await tempHome();
    await mkdir(importsRoot(dir), { recursive: true });
    const future = JSON.stringify({ v: 99, somethingNew: true });
    await writeFile(importManifestPath(dir), future, 'utf8');
    const s = sink({ jevcodeDir: dir, workspaceKey: '/ws' }, {
      applyPlan: async () => ({ applied: 1, failed: 0, total: 1, importId: plan().importId, error: null, entries: [ENTRY] }),
    });
    expect(await commandImport({ yes: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(await readFile(importManifestPath(dir), 'utf8')).toBe(future);
  });

  it('`--undo` reads the manifest, hands it over, and writes back what the engine left', async () => {
    const dir = await tempHome();
    await mkdir(importsRoot(dir), { recursive: true });
    await writeFile(importManifestPath(dir), JSON.stringify({ v: 1, user: [], workspaces: { '/ws': [ENTRY] } }), 'utf8');
    let handed = 0;
    const s = sink({ jevcodeDir: dir, workspaceKey: '/ws' }, {
      undoImport: async (input) => {
        handed = input.manifest?.workspaces['/ws']?.length ?? 0;
        return { restored: 1, modified: 0, importId: input.importId, manifest: { v: 1, user: [], workspaces: {} } };
      },
    });
    expect(await commandImport({ undo: ENTRY.importId }, s.io)).toBe(EXIT_CODES.ok);
    expect(handed).toBe(1);
    const back = await readImportManifest(importManifestPath(dir), '/ws');
    expect(back.manifest.workspaces['/ws'] ?? []).toEqual([]);
  });
});

describe('the production loader (no injected engine)', () => {
  it('`--yes` with NO `io.engine` is the named refusal and exit 2 — never a silent "nothing happened"', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: ImportIo = { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, isTTY: false, jevcodeDir: await tempHome() };
    expect(await commandImport({ yes: true }, io)).toBe(EXIT_CODES.config);
    expect(text(err)).toBe(`${importNotWired('--yes')}\n`);
    expect(out).toEqual([]);
  });

  it('`--undo` with NO `io.engine` is the same refusal, and the id is still validated first', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: ImportIo = { stdout: { write: (t: string) => out.push(t) }, stderr: { write: (t: string) => err.push(t) }, isTTY: false, jevcodeDir: await tempHome() };
    expect(await commandImport({ undo: 'nonsense' }, io)).toBe(EXIT_CODES.config);
    expect(text(err)).toContain('imp_YYYYMMDDTHHMMSSZ_xxxxxx');
    err.length = 0;
    expect(await commandImport({ undo: 'imp_20260921T120000Z_a1b2c3' }, io)).toBe(EXIT_CODES.config);
    expect(text(err)).toBe(`${importNotWired('--undo')}\n`);
  });

  it('the loader wires the five READ verbs from the facade itself (no adapter, no copy)', async () => {
    const out: string[] = [];
    const err: string[] = [];
    let seen: unknown = null;
    const io: ImportIo = {
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => err.push(t) },
      isTTY: false,
      jevcodeDir: await tempHome(),
      readArtifact: async () => RAW,
    };
    // `--resume` reaches `asImportPlan` and then the (absent) write verb: the READ half of the loader is live
    expect(await commandImport({ resume: 'imp_20260921T120000Z_a1b2c3' }, io)).toBe(EXIT_CODES.config);
    expect(text(err)).toBe(`${importNotWired('--resume')}\n`);
    expect(seen).toBeNull();
  });
});

describe('§5.7: every flag the surface names changes an observable output', () => {
  it('`--ascii` works without a host that pre-resolved it', async () => {
    const s = sink({ ascii: false });
    await commandImport({ ascii: true }, s.io);
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7f\n]*$/.test(text(s.out))).toBe(true);
    expect(text(s.out)).toContain('Import - 10 to import');
  });

  it('`--screen-reader` works without a host that pre-resolved it, and `--plain` overrides it', async () => {
    const sr = sink();
    await commandImport({ screenReader: true }, sr.io);
    expect(text(sr.out)).toContain('Import: 10 to import, 2 to review');
    const plain = sink({ screenReader: true });
    await commandImport({ plain: true }, plain.io);
    expect(text(plain.out)).not.toContain('Import: 10 to import,');
    expect(text(plain.out)).toMatch(/^ {2}1 memory/m);
  });

  it('`--json` with `--yes` is the apply shape, not the plan (§13.3 row 10)', async () => {
    const s = sink();
    expect(await commandImport({ yes: true, json: true }, s.io)).toBe(EXIT_CODES.ok);
    expect(JSON.parse(text(s.out))).toEqual({ importId: 'imp_20260921T120000Z_a1b2c3', applied: 9, restored: 0, skipped: 0, errors: [] });
  });
});
