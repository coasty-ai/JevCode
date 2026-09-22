/**
 * docs/IMPORT-DESIGN.md §1 property 4 / §4.8.1 / §8.3 (`import-leak`) / Appendix A.2 — **W5 gate**.
 *
 * One fixture needle per family for all 15 `REDACTING_FAMILIES` + `WARN_ONLY_FAMILIES` patterns, put
 * into bodies and config values, then discover → classify → plan → report → apply with a **capturing**
 * `Decider`, then grep every artefact and every captured request body. Zero hits.
 *
 * The needle table is generated **against `redact.ts`'s own exported pattern lists**, and the test
 * asserts that every family in those lists has a needle and that `detectSecrets` recognises it. A
 * family added to `redact.ts` therefore fails this gate until its needle exists — the list cannot drift.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { REDACTING_PATTERNS, WARN_ONLY_PATTERNS, createRedactor, detectSecrets, redactSpans } from '../../../src/core/redact.js';
import type { Decider, Json, Question } from '../../../src/core/types.js';
import { SOURCES, applicableRows, applyPlan, discover, fenceExecutables, nodeImportFs, parseMarkdown, planImport, renderPlanJson, renderReport } from '../../../src/import/index.js';
import type { ApplyOptions, ImportClock, ImportEnvironment, ImportWriteFs, SourceItem } from '../../../src/import/index.js';

// ---------------------------------------------------------------------------------------
// the needles — one per family, generated against redact.ts's own lists so they cannot drift
// ---------------------------------------------------------------------------------------

const A36 = 'abcdefghij0123456789ABCDEFGHIJ012345';
const NEEDLES: Readonly<Record<string, string>> = {
  openrouter: 'sk-or-v1-0123456789abcdef0123456789abcdef',
  anthropic: 'sk-ant-api03-0123456789abcdefghij0123456789',
  sk: 'sk-proj-0123456789abcdefghijABCD',
  google: 'AIzaSyA0123456789abcdefghijklmnopqrstuvw',
  github: `ghp_${A36}`,
  github_pat: 'github_pat_11ABCDEFG0abcdefghijkl_0123456789abcdefghij',
  aws: 'AKIAQ2W3E4R5T6Y7U2I3',
  slack: 'xoxb-123456789012-1234567890ab-ABCDEFGHIJKLMNOP',
  slack_webhook: 'hooks.slack.com/services/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrs',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj0FAKEfake\n-----END RSA PRIVATE KEY-----',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  stripe: 'sk_test_0123456789abcdefghij',
  npm: `npm_${A36}`,
  huggingface: 'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh',
  gitlab: 'glpat-0123456789abcdefghijkl',
};

const FAMILIES: readonly string[] = [...REDACTING_PATTERNS.map((p) => p.family), ...WARN_ONLY_PATTERNS.map((p) => p.family)];
const ALL_NEEDLES: readonly string[] = FAMILIES.map((f) => NEEDLES[f] ?? `MISSING-NEEDLE-FOR-${f}`);
/** The fixture's own secrets, beyond the family patterns (§1 property 4 greps for both). */
/**
 * §6 row 45: a 32-hex value at a leaf name that is neither in the non-secret allowlist nor matched
 * by `SECRET_NAME_RE`, and that no family regex recognises. That combination is the only way into
 * §4.4.2 rule 8's band, and the band is the only thing that makes a group I Jev request happen —
 * without it `capture.bodies` is empty and the "every captured Jev request body" half of §1
 * property 4 is vacuous. It is graded as a fixture secret too: a banded value must reach neither an
 * artefact nor a request body, because Jev is given its shape only (§4.4.3 group I).
 */
const BAND_VALUE = 'a7f3c2e1b9d4058613f2ca7e94b1d0c5';

const FIXTURE_SECRETS: readonly string[] = ['hunter2-the-fixture-password', 'corporate-shared-passphrase-2026', BAND_VALUE];

// ---------------------------------------------------------------------------------------
// the seams
// ---------------------------------------------------------------------------------------

function nodeWriteFs(): ImportWriteFs {
  return {
    ...nodeImportFs(),
    async writeFile(p, data, o) {
      if (o.mkdir) await mkdir(dirname(p), { recursive: true });
      await writeFile(p, data, { mode: o.mode });
    },
    async appendFile(p, data, o) {
      if (o.mkdir) await mkdir(dirname(p), { recursive: true });
      await appendFile(p, data, { mode: o.mode });
    },
    async mkdir(p, o) {
      await mkdir(p, o);
    },
    rm: (p) => rm(p, { force: true }),
    chmod: (p, m) => chmod(p, m),
    async createExclusive(p, data, mode) {
      try {
        await mkdir(dirname(p), { recursive: true });
        const fh = await open(p, 'wx', mode);
        await fh.writeFile(data);
        await fh.close();
        return true;
      } catch {
        return false;
      }
    },
  };
}
const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };

/**
 * §2.9: imported text is redacted **at write time** with the session's redactor — "the exact
 * `SecretSet` layer first (`config.addSecret` registrations), then the pattern layer". Both halves
 * matter here and each catches what the other cannot:
 *
 *  - the **pattern** half must be `detectSecrets` + `redactSpans`, not `patternRedact` alone,
 *    because §1 property 4 counts the nine **warn-only** families too and `patternRedact` masks
 *    only the six redacting ones (`patternRedact` would leak aws/slack/jwt/PEM/stripe/npm/hf/glpat);
 *  - the **exact** half is the only thing that can catch a fixture secret no regex knows — a bare
 *    password like `hunter2-…` matches no family, so without a registration it survives into the
 *    destination. That is not a bug in the engine: it is exactly why §2.9 puts the configured
 *    layer first, and the gate has to exercise it to mean anything.
 */
const exactLayer = createRedactor(FIXTURE_SECRETS.map((value, i) => ({ name: `fixture.secret.${i}`, value })));
const writeTimeRedact = (s: string): string => redactSpans(s, detectSecrets(s, exactLayer), '[REDACTED:pattern]');

/** Every state and question set handed to Jev, verbatim, for the grep (§1 property 4, §4.4.3). */
interface Capture {
  bodies: string[];
  decider: Decider;
}
function capturingDecider(): Capture {
  const bodies: string[] = [];
  const decider: Decider = {
    model: 'jev-capture',
    provider: 'openrouter',
    async ask(state: Json, questions: Record<string, Question>): Promise<never> {
      bodies.push(JSON.stringify({ state, questions }));
      // §4.9: a 429 still produces a complete plan from the code fallbacks — and the body is captured
      throw new Error('HTTP 429');
    },
  };
  return { bodies, decider };
}

// ---------------------------------------------------------------------------------------
// the fixture $HOME and repository
// ---------------------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  ws: string;
  userDir: string;
  artifactDir: string;
  env: ImportEnvironment;
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-leak-')));
  dirs.push(root);
  const home = join(root, 'home');
  const ws = join(root, 'repo');
  const write = async (p: string, text: string): Promise<void> => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, { mode: 0o644 });
  };

  // bodies: one needle per family, in the prose a memory import copies verbatim
  const body = ALL_NEEDLES.map((n, i) => `## note ${i}\n\nthe key is ${n} and it must never travel.\n`).join('\n');
  await write(join(home, '.claude', 'CLAUDE.md'), `# user instructions\n\n${body}\nthe password is ${FIXTURE_SECRETS[0]}\n`);
  await write(join(home, '.claude', 'rules', 'leaky.md'), `---\nglobs: "src/**/*.ts"\n---\n\nuse ${NEEDLES['anthropic']} when testing.\n`);
  await write(join(home, '.claude', 'commands', 'deploy.md'), `---\ndescription: deploy\n---\n\nrun with ${NEEDLES['github']}\n`);
  await write(join(ws, 'AGENTS.md'), `# repo\n\nthe shared phrase is ${FIXTURE_SECRETS[1]}\n\n${ALL_NEEDLES.slice(0, 5).join('\n\n')}\n`);

  // config values: one needle per family, per key, which is where §4.4.2 rule 8 classifies
  const envBlock: Record<string, string> = {};
  FAMILIES.forEach((f, i) => {
    envBlock[`${f.toUpperCase()}_API_KEY`] = ALL_NEEDLES[i] ?? '';
  });
  await write(
    join(home, '.claude', 'settings.json'),
    `${JSON.stringify(
      { model: 'sonnet', clientId: BAND_VALUE, env: envBlock, permissions: { allow: ['Bash(git *)'] }, hooks: { PreToolUse: [{ command: 'echo hi' }] } },
      null,
      2,
    )}\n`,
  );
  await write(
    join(ws, '.mcp.json'),
    `${JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: NEEDLES['github'] }, headers: { Authorization: `Bearer ${NEEDLES['jwt']}` } } } }, null, 2)}\n`,
  );

  return {
    home,
    ws,
    userDir: join(home, '.config', 'jevcode'),
    artifactDir: join(home, '.jevcode', 'imports', 'imp_20260921T120000Z_a1b2c3'),
    env: { home, env: {}, platform: process.platform, workspace: ws, gitRoot: ws, extraRoots: [] },
  };
}

/** Every regular file under `dir`, as `[path, text]`. */
function filesUnder(dir: string): readonly (readonly [string, string])[] {
  if (!existsSync(dir)) return [];
  const out: (readonly [string, string])[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(p));
    else if (entry.isFile()) out.push([p, readFileSync(p, 'utf8')]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------

describe('the needle table cannot drift (§1 property 4 [G2.3])', () => {
  it('has one needle for every family redact.ts exports, and at least 15 of them', () => {
    expect(REDACTING_PATTERNS).toHaveLength(6);
    expect(WARN_ONLY_PATTERNS).toHaveLength(9);
    expect(FAMILIES).toHaveLength(15);
    expect(ALL_NEEDLES.length).toBeGreaterThanOrEqual(15);
    for (const family of FAMILIES) expect(NEEDLES[family], `no fixture needle for family "${family}"`).toBeDefined();
    // every needle is recognised as its own family, so the fixture really exercises the pattern
    for (const family of FAMILIES) {
      const needle = NEEDLES[family]!;
      const hits = detectSecrets(needle).map((h) => h.family);
      expect(hits, `needle for "${family}" is not detected as that family`).toContain(family);
    }
    // and the write-time redactor removes every one of them
    for (const needle of ALL_NEEDLES) expect(writeTimeRedact(needle)).not.toContain(needle);
  });
});

describe('import-leak — no secret leaves its file (§1 property 4, §8.3)', () => {
  it('zero hits across report.md, plan.json, sources.jsonl, apply.jsonl, every destination and every Jev body', async () => {
    const f = await fixture();
    const capture = capturingDecider();
    const fs = nodeWriteFs();

    // ----- discover (sources.jsonl is one SourceItem per line, §4.2.5) -----
    const found = await discover({ env: f.env, fs, clock, sources: SOURCES });
    expect(found.items.length).toBeGreaterThan(0);
    const sourcesJsonl = found.items.map((i: SourceItem) => JSON.stringify(i)).join('\n');

    // ----- classify + plan (§4.4, §4.5) with the capturing decider -----
    const plan = await planImport({
      env: f.env,
      fs,
      clock,
      jevcodeVersion: '0.3.0',
      trust: 'trust',
      importId: 'imp_20260921T120000Z_a1b2c3',
      decider: capture.decider,
      redact: writeTimeRedact,
      // A real `jevcode import` always knows its own destinations, and the fixture's
      // `<repo>/AGENTS.md` is deliberately BOTH a needle-bearing source and a destination. Without
      // this the row appends the file to itself and the gate then greps the human's own
      // pre-existing bytes — a false positive, because §1 property 4 is about what the importer
      // WRITES, not about what was already in the human's file. Passing them makes it `skip:self`
      // (§4.4.1 rule 2), which is what a real run does.
      destinations: [join(f.ws, 'AGENTS.md'), join(f.ws, '.jevcode'), f.userDir],
    });

    // ----- report (§4.6) -----
    const report = renderReport(plan);
    const planJson = renderPlanJson(plan);

    // ----- apply (§4.7) over exactly the rows a human could approve -----
    const approved = applicableRows(plan);
    const render: ApplyOptions['render'] = async (_row, sourceText) => {
      const doc = parseMarkdown(sourceText, { redact: writeTimeRedact });
      const fenced = fenceExecutables(sourceText, doc.executables);
      return { text: writeTimeRedact(fenced.text), mode: 0o644, warnings: [] };
    };
    const result = await applyPlan({
      plan,
      fs,
      clock,
      destRoots: { project: f.ws, projectLocal: f.ws, user: f.userDir },
      artifactDir: f.artifactDir,
      lockPath: join(f.home, '.jevcode', 'imports', '.lock'),
      manifest: null,
      consent: 'tty',
      approved,
      render,
      sourcePath: (row) => (row.source.display.startsWith('~/') ? join(f.home, row.source.display.slice(2)) : join(f.ws, row.source.display)),
    });
    expect(result.applied.length).toBeGreaterThan(0);

    // ----- the grep (§1 property 4 / Appendix A.2 line 2) -----
    const artefacts: (readonly [string, string])[] = [
      ['report.md', report],
      ['plan.json', planJson],
      ['sources.jsonl', sourcesJsonl],
      ['apply.jsonl', existsSync(join(f.artifactDir, 'apply.jsonl')) ? readFileSync(join(f.artifactDir, 'apply.jsonl'), 'utf8') : ''],
      ...capture.bodies.map((b, i) => [`jev-request-${i}`, b] as const),
      // every destination the apply wrote, under both trees
      ...result.applied.flatMap((a) => (a.dest !== null && existsSync(a.dest) ? [[a.dest, readFileSync(a.dest, 'utf8')] as const] : [])),
      // and everything under the two destination trees, in case a row wrote somewhere unexpected
      ...filesUnder(f.userDir),
      ...filesUnder(join(f.ws, '.jevcode')),
    ];
    expect(artefacts.length).toBeGreaterThan(6);
    // the band candidate in the fixture guarantees a group I request, so this half of the gate is real
    expect(capture.bodies.length, 'no Jev request was captured: the band clause would be vacuous').toBeGreaterThan(0);

    for (const [label, text] of artefacts) {
      for (const needle of [...ALL_NEEDLES, ...FIXTURE_SECRETS]) {
        expect(text.includes(needle), `${label} leaked a needle`).toBe(false);
      }
      // the PEM body line too — a family whose needle is multi-line must not survive a line at a time
      expect(text.includes('MIIBOgIBAAJBAKj0FAKEfake'), `${label} leaked the PEM body`).toBe(false);
    }

    // §4.8.1 invariant 1: `apply.jsonl` carries sha256 and byte counts, never a body
    const log = readFileSync(join(f.artifactDir, 'apply.jsonl'), 'utf8');
    for (const line of log.split('\n').filter((l) => l.length > 0)) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(['at', 'bytes', 'dest', 'mode', 'ok', 'row', 'sha256After', 'sha256Before'].sort());
    }
    // …and no `PlanRow` field holds a value: the structural half of the property
    for (const row of plan.rows) {
      expect(Object.keys(row).sort()).toEqual(['action', 'bytes', 'class', 'dest', 'id', 'scope', 'source', 'warnings', 'why', ...('group' in row ? ['group'] : [])].sort());
    }
  });

  it('a `--no-jev` run leaks nothing either, and asks nothing at all (§4.9)', async () => {
    const f = await fixture();
    const fs = nodeWriteFs();
    const plan = await planImport({ env: f.env, fs, clock, jevcodeVersion: '0.3.0', trust: 'trust', decider: null, redact: writeTimeRedact });
    expect(plan.jev.requests).toBe(0);
    const text = `${renderReport(plan)}\n${renderPlanJson(plan)}`;
    for (const needle of [...ALL_NEEDLES, ...FIXTURE_SECRETS]) expect(text.includes(needle)).toBe(false);
  });
});
