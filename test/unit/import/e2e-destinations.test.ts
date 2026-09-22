/**
 * Review defect 1 (`docs/research/import/review-engine-2026-09-22.md`): the atlas destinations
 * were never wired. `planImport` built each `PlanCandidate` without `destination`, so
 * `plan.ts` always fell back to the class map and `agents-append`, `memory-index`,
 * `memory-local` and `report-only` were dead end to end — the marker/append path, `MEMORY.md`
 * and the [G1.5] trust re-pin were unreachable in a real run.
 *
 * This is the end-to-end gate for the whole destination path: discover → classify → plan →
 * apply, over a real temp workspace, asserting that a row the ATLAS routes to `agents-append`
 * actually lands in `<repo>/AGENTS.md` inside a marker pair, that the index lands in
 * `MEMORY.md`, that a personal file lands 0600 in `memory-local/`, and that the resulting bytes
 * `reconstructs()` from the pre-image — which is exactly the precondition §4.7.5 [G1.5] puts on
 * the trust re-pin.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applicableRows,
  applyPlan,
  findMarkerBlocks,
  nodeImportFs,
  planImport,
  reconstructs,
  specById,
} from '../../../src/import/index.js';
import type { ApplyOptions, ImportClock, ImportEnvironment, ImportWriteFs, PlanRow } from '../../../src/import/index.js';

const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };
const IMPORT_ID = 'imp_20260921T120000Z_a1b2c3';

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

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Fixture {
  ws: string;
  home: string;
  userDir: string;
  artifactDir: string;
  env: ImportEnvironment;
  agentsBefore: string;
}

async function fixture(): Promise<Fixture> {
  // realpath'd deliberately: on macOS `os.tmpdir()` is `/var/…` while the realpath is
  // `/private/var/…`, and items are keyed by realpath. Canonicalising here keeps THIS test about
  // destinations; the non-canonical-home case is covered on its own in `discover.test.ts`.
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'jev-e2e-dest-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ws = join(root, 'repo');
  const home = join(root, 'home');
  await mkdir(join(ws, '.claude'), { recursive: true });
  await mkdir(home, { recursive: true });

  // the destination already exists, so the atlas row must APPEND into it behind a marker pair
  const agentsBefore = '# repo conventions\n\nRun the tests before you claim anything.\n';
  await writeFile(join(ws, 'AGENTS.md'), agentsBefore);

  // an `agents-append` source: Claude project instructions at the repo root (atlas
  // `claude.project-instructions`, dest `agents-append`)
  await writeFile(join(ws, 'CLAUDE.md'), '# claude\n\nPrefer terse diffs.\nNever write prose before a patch.\n');
  // a personal, git-ignored file → memory-local, 0600
  await writeFile(join(ws, 'CLAUDE.local.md'), '# personal\n\nMy own scratch notes.\n');
  // a user-scope auto-memory index + topic → memory-index and memory-topic
  await mkdir(join(home, '.claude', 'projects', '-repo', 'memory'), { recursive: true });
  await writeFile(join(home, '.claude', 'projects', '-repo', 'memory', 'MEMORY.md'), '<!-- jevcode:memory-index v1 -->\n# Memory\n\n- [A note](a-note.md) — a summary\n');
  await writeFile(
    join(home, '.claude', 'projects', '-repo', 'memory', 'a-note.md'),
    '---\nname: a-note\ndescription: a fixture note\nmetadata:\n  type: project\n---\n# A note\n\nThe body of the note.\n',
  );

  return {
    ws,
    home,
    userDir: join(home, '.config', 'jevcode'),
    artifactDir: join(home, '.jevcode', 'imports', IMPORT_ID),
    env: { home, env: {}, platform: process.platform, workspace: ws, gitRoot: ws, extraRoots: [] },
    agentsBefore,
  };
}

/** The destinations a real run would pass, so a source that IS a destination is `skip:self`. */
function destinationsOf(f: Fixture): readonly string[] {
  return [join(f.ws, 'AGENTS.md'), join(f.ws, '.jevcode'), join(f.userDir)];
}

describe('destinations, end to end (review defect 1)', () => {
  it('the atlas routes a project-instructions row to AGENTS.md, not to memory/<slug>.md', async () => {
    const f = await fixture();
    const plan = await planImport({
      env: f.env,
      fs: nodeWriteFs(),
      clock,
      jevcodeVersion: '0.3.0',
      trust: 'trust',
      importId: IMPORT_ID,
      decider: null,
      destinations: destinationsOf(f),
    });

    // the atlas row itself says agents-append — if this drifts the rest of the test is meaningless
    expect(specById('claude.project-instructions')?.destination.kind).toBe('agents-append');

    const row = plan.rows.find((r) => r.source.display === 'CLAUDE.md');
    expect(row, 'the repo CLAUDE.md was discovered').toBeDefined();
    expect(row?.dest, 'the atlas destination must win over the class map').toBe('AGENTS.md');
    expect(row?.action, 'the destination exists, so this is an append').toBe('append');
    expect(row?.scope).toBe('project');

    // and the other three atlas destination kinds are reachable too
    const local = plan.rows.find((r) => r.source.display === 'CLAUDE.local.md');
    expect(local?.dest).toBe('.jevcode/memory-local/claude-local.md');
    expect(local?.scope).toBe('project-local');
    const index = plan.rows.find((r) => r.source.display.endsWith('memory/MEMORY.md'));
    expect(index?.dest, 'memory-index is not the class-map fallback').toMatch(/MEMORY\.md$/);
  });

  it('the repo’s own AGENTS.md is skip:self — a destination never imports itself (§4.4.1 rule 2, §6 row 9)', async () => {
    const f = await fixture();
    const plan = await planImport({
      env: f.env,
      fs: nodeWriteFs(),
      clock,
      jevcodeVersion: '0.3.0',
      trust: 'trust',
      importId: IMPORT_ID,
      decider: null,
      destinations: destinationsOf(f),
    });
    const own = plan.rows.find((r) => r.source.display === 'AGENTS.md');
    expect(own, 'the repo AGENTS.md was discovered').toBeDefined();
    expect(own?.action).toBe('skip:self');
    expect(applicableRows(plan)).not.toContain(own?.id);
  });

  it('apply appends into AGENTS.md behind a marker pair, and the result reconstructs for the [G1.5] trust re-pin', async () => {
    const f = await fixture();
    const fs = nodeWriteFs();
    const plan = await planImport({
      env: f.env,
      fs,
      clock,
      jevcodeVersion: '0.3.0',
      trust: 'trust',
      importId: IMPORT_ID,
      decider: null,
      destinations: destinationsOf(f),
    });

    const render: ApplyOptions['render'] = async (row: PlanRow, sourceText: string) => ({
      text: sourceText,
      mode: row.scope === 'project-local' ? 0o600 : 0o644,
      warnings: [],
    });
    const result = await applyPlan({
      plan,
      fs,
      clock,
      destRoots: { project: f.ws, projectLocal: f.ws, user: f.userDir },
      artifactDir: f.artifactDir,
      lockPath: join(f.home, '.jevcode', 'imports', '.lock'),
      manifest: null,
      consent: 'tty',
      approved: applicableRows(plan),
      render,
      sourcePath: (row) => (row.source.display.startsWith('~/') ? join(f.home, row.source.display.slice(2)) : join(f.ws, row.source.display)),
    });
    // assert on the messages, not the objects: a failure here should say WHY in the diff
    expect(result.failed.map((x) => x.error)).toEqual([]);
    expect(result.demoted.map((x) => x.why)).toEqual([]);

    // ----- AGENTS.md: the original bytes survive, the import sits behind a marker pair -----
    const agentsPath = join(f.ws, 'AGENTS.md');
    const after = readFileSync(agentsPath, 'utf8');
    expect(after.startsWith(f.agentsBefore), 'the human’s own bytes are untouched and still first').toBe(true);
    const blocks = findMarkerBlocks(after);
    expect(blocks, 'exactly one marker block').toHaveLength(1);
    expect(blocks[0]?.importId).toBe(IMPORT_ID);
    expect(after).toContain('Prefer terse diffs.');

    // §4.7.5 [G1.5]: the re-pin is allowed only when the new bytes reconstruct from the old plus
    // exactly the marker-delimited edits this apply performed. That is the property, not a diff.
    const interior = after.slice(blocks[0]!.interiorStart, blocks[0]!.interiorEnd);
    // `header` is the open-marker LINE without its newline — `renderBlock` supplies the newline,
    // so slicing up to `interiorStart` (which is past it) would reconstruct a doubled blank line.
    const openLineEnd = after.indexOf('\n', blocks[0]!.start);
    const header = after.slice(blocks[0]!.start, openLineEnd === -1 ? blocks[0]!.interiorStart : openLineEnd);
    expect(reconstructs(f.agentsBefore, after, [{ importId: IMPORT_ID, interior, header, kind: 'append' }])).toBe(true);
    // and a byte changed outside the block breaks reconstruction, so the pin is not re-pinned blindly
    expect(reconstructs(`${f.agentsBefore}stray line\n`, after, [{ importId: IMPORT_ID, interior, header, kind: 'append' }])).toBe(false);

    // ----- memory-local is 0600, the workspace files 0644 (§2.2) -----
    const localPath = join(f.ws, '.jevcode', 'memory-local', 'claude-local.md');
    expect(existsSync(localPath), 'memory-local destination written').toBe(true);
    expect(statSync(localPath).mode & 0o777).toBe(0o600);
    expect(statSync(agentsPath).mode & 0o777).toBe(0o644);

    // ----- the index landed as an index, not as a topic -----
    const written = result.applied.filter((a) => a.ok).map((a) => a.dest ?? '');
    expect(written.some((d) => d.endsWith('MEMORY.md')), 'a MEMORY.md index was written').toBe(true);

    // ----- nothing was written outside the two destination roots -----
    for (const d of written) {
      expect(d.startsWith(f.ws) || d.startsWith(f.userDir), `${d} is outside both destination roots`).toBe(true);
    }
  });
});
