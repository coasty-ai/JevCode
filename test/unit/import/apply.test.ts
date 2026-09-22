/**
 * docs/IMPORT-DESIGN.md §4.7 — phase 4 over the injected write seam, and §6 group F rows 66, 67, 79.
 *
 * The seam is the point: `src/import/**` performs no writes of its own, so every assertion here runs
 * against an `ImportWriteFs` the test supplies. It is backed by a real temp tree rather than a map,
 * because modes, symlinks and `O_EXCL` are exactly what the design's properties are about.
 *
 * The plan comes from the committed W2→W3 fixture (`test/fixtures/import/plan.json`, §7.7): the row
 * set, the destinations, the actions, the scopes and the classes are the fixture's; only the source
 * `sha256`/`bytes`/`mtimeMs` are re-pinned to the files this test actually creates, because a pinned
 * digest of a file that does not exist would test nothing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/core/hash.js';
import { APPLY_ORDER, applyPlan, joinDestination, markerClose, markerOpen, preKeyFor } from '../../../src/import/apply.js';
import type { AppliedRow, ApplyOptions } from '../../../src/import/apply.js';
import { renderMcpFile } from '../../../src/import/mcp.js';
import type { ImportClock, ImportPlan, ImportWriteFs, McpFile, PlanRow } from '../../../src/import/types.js';

// ---------------------------------------------------------------------------------------
// the injected seams (§4.2, §4.7)
// ---------------------------------------------------------------------------------------

export function nodeWriteFs(): ImportWriteFs {
  return {
    async readdir(p) {
      return (await readdir(p, { withFileTypes: true })).map((d) => ({ name: d.name, isFile: () => d.isFile(), isDirectory: () => d.isDirectory(), isSymbolicLink: () => d.isSymbolicLink() }));
    },
    async stat(p) {
      const s = await stat(p);
      return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, dev: s.dev, ino: s.ino };
    },
    async lstat(p) {
      const s = await lstat(p);
      return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), isSymbolicLink: () => s.isSymbolicLink(), size: s.size, mtimeMs: s.mtimeMs, mode: s.mode, dev: s.dev, ino: s.ino };
    },
    realpath: (p) => realpath(p),
    readFile: (p) => readFile(p),
    async readPrefix(p, bytes) {
      const fh = await open(p, 'r');
      try {
        const buf = Buffer.alloc(bytes);
        const { bytesRead } = await fh.read(buf, 0, bytes, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
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

export interface TestClock extends ImportClock {
  advance(ms: number): void;
}
export function clockAt(iso: string): TestClock {
  let t = Date.parse(iso);
  return { now: () => new Date(t), monotonicMs: () => t, advance: (ms) => void (t += ms) };
}

// ---------------------------------------------------------------------------------------
// the W2→W3 fixture (§7.7)
// ---------------------------------------------------------------------------------------

const FIXTURE = join(import.meta.dirname, '../../fixtures/import/plan.json');

export interface Tree {
  dir: string;
  ws: string;
  userDir: string;
  artifactDir: string;
  lockPath: string;
  srcDir: string;
  plan: ImportPlan;
  sourcePath(row: PlanRow): string;
}

/** A plan whose rows are the fixture's, over sources that exist on disk with the digests the plan pins. */
export async function makeTree(prefix = 'jev-apply-'): Promise<Tree> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const ws = join(dir, 'ws');
  const userDir = join(dir, 'home', '.config', 'jevcode');
  const srcDir = join(dir, 'sources');
  const artifactDir = join(dir, 'home', '.jevcode', 'imports', 'imp_20260921T120000Z_a1b2c3');
  await mkdir(ws, { recursive: true });
  await mkdir(userDir, { recursive: true });
  await mkdir(srcDir, { recursive: true });
  const raw: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const base = raw as ImportPlan;
  const rows: PlanRow[] = [];
  for (const row of base.rows) {
    const path = join(srcDir, `${row.source.id}.src`);
    const body = row.dest !== null && row.dest.endsWith('mcp.json') ? mcpSourceText(row) : `# ${row.source.display}\n\nbody of ${row.id}\n`;
    await writeFile(path, body, { mode: 0o644 });
    const st = statSync(path);
    rows.push({ ...row, source: { ...row.source, sha256: sha256Hex(body), bytes: st.size, mtimeMs: st.mtimeMs } });
  }
  return {
    dir,
    ws,
    userDir,
    srcDir,
    artifactDir,
    lockPath: join(dir, 'home', '.jevcode', 'imports', '.lock'),
    plan: { ...base, rows, workspace: ws, workspaceKey: ws, gitRoot: ws },
    sourcePath: (row) => join(srcDir, `${row.source.id}.src`),
  };
}

function mcpSourceText(row: PlanRow): string {
  return JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } } }, from: row.id }, null, 2);
}

/** The caller's renderer (§4.7: the engine never writes the source's bytes unverified). */
export const renderRow: ApplyOptions['render'] = async (row, sourceText) => {
  if (row.dest !== null && row.dest.endsWith('mcp.json')) {
    const file: McpFile = {
      v: 1,
      servers: {
        github: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'server-github'],
          env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
          enabled: false,
          source: { tool: 'codex', path: row.source.display, sha256: row.source.sha256, importId: 'imp_20260921T120000Z_a1b2c3' },
        },
      },
    };
    return { text: renderMcpFile(file), mode: 0o644, warnings: [] };
  }
  return { text: `<!-- rendered ${row.id} -->\n${sourceText.trim()}\n`, mode: 0o644, warnings: [] };
};

export function optionsFor(tree: Tree, over: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    plan: tree.plan,
    fs: nodeWriteFs(),
    clock: clockAt('2026-09-21T12:00:00.000Z'),
    destRoots: { project: tree.ws, projectLocal: tree.ws, user: tree.userDir },
    artifactDir: tree.artifactDir,
    lockPath: tree.lockPath,
    manifest: null,
    consent: 'tty',
    // the rows a human can approve at all, exactly as `applicableRows` (index.ts) filters them
    approved: tree.plan.rows.filter((r) => r.dest !== null && r.action !== 'review' && r.action !== 'suggest' && !r.action.startsWith('skip:')).map((r) => r.id),
    render: renderRow,
    sourcePath: tree.sourcePath,
    ...over,
  };
}

export function applyLogOf(tree: Tree): readonly AppliedRow[] {
  const path = join(tree.artifactDir, 'apply.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AppliedRow);
}

const trees: Tree[] = [];
afterEach(async () => {
  for (const t of trees.splice(0)) await rm(t.dir, { recursive: true, force: true });
});
async function tree(prefix?: string): Promise<Tree> {
  const t = await makeTree(prefix);
  trees.push(t);
  return t;
}

// ---------------------------------------------------------------------------------------

describe('APPLY_ORDER (§4.7.4)', () => {
  it('is the nine steps in the order the design fixes, asserted rather than inferred', () => {
    expect(APPLY_ORDER).toEqual([
      'pre-snapshots',
      'credentials',
      'memory-rules-commands',
      'memory-index',
      'mcp',
      'agents-append',
      'apply-log',
      'manifest',
      'trust-repin',
    ]);
    // the three orderings the design gives reasons for
    expect(APPLY_ORDER.indexOf('credentials')).toBeLessThan(APPLY_ORDER.indexOf('memory-rules-commands'));
    expect(APPLY_ORDER.indexOf('memory-rules-commands')).toBeLessThan(APPLY_ORDER.indexOf('memory-index'));
    expect(APPLY_ORDER.indexOf('agents-append')).toBeGreaterThan(APPLY_ORDER.indexOf('mcp'));
    expect(APPLY_ORDER[APPLY_ORDER.length - 1]).toBe('trust-repin');
  });
});

describe('applyPlan (§4.7)', () => {
  it('writes every approved row to its scope root, records apply.jsonl and merges the manifest', async () => {
    const t = await tree();
    const r = await applyPlan(optionsFor(t));
    expect(r.exitCode).toBe(0);
    expect(r.failed).toEqual([]);

    const memory = join(t.ws, '.jevcode', 'memory', 'project-notes.md');
    expect(readFileSync(memory, 'utf8')).toContain('body of 0a1b2c3d4e5f');
    expect(readFileSync(join(t.userDir, 'commands', 'ft.md'), 'utf8')).toContain('body of 7a1b2c3d4e5f');
    expect(readFileSync(join(t.ws, '.jevcode', 'rules', 'style.md'), 'utf8')).toContain('body of 5a1b2c3d4e5f');
    // `~/.config/jevcode/AGENTS.md` collapses onto the user root rather than nesting under it
    expect(existsSync(join(t.userDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(t.userDir, '.config'))).toBe(false);

    // §2.2 modes: workspace files 0644, memory-local and the config dir 0600
    expect(statSync(memory).mode & 0o777).toBe(0o644);
    expect(statSync(join(t.ws, '.jevcode', 'memory-local', 'claude-local.md')).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.userDir, 'commands', 'ft.md')).mode & 0o777).toBe(0o600);

    // §4.7.4 step 7: one line per item, appended after each write, sha256 and byte counts only
    const log = applyLogOf(t);
    expect(log.length).toBe(r.applied.length);
    for (const line of log) {
      expect(Object.keys(line).sort()).toEqual(['at', 'bytes', 'dest', 'destRel', 'mode', 'ok', 'row', 'sha256After', 'sha256Before'].sort());
      expect(line.sha256After).toMatch(/^[0-9a-f]{64}$/);
    }
    // §4.7.5 [G1.3]: the manifest is keyed by workspace
    expect(r.manifest.workspaces[t.ws]?.length).toBeGreaterThan(0);
    expect(r.manifest.user.map((e) => e.dest)).toContain('~/.config/jevcode/AGENTS.md');
    expect(r.manifest.user.every((e) => e.by === 'tty')).toBe(true);
    expect(r.manifest.lastRun).toBe('2026-09-21T12:00:00.000Z');
  });

  it('takes pre/ snapshots FIRST, before any row is written, keyed by destination (§4.7.4 step 1)', async () => {
    const t = await tree();
    const dest = join(t.ws, '.jevcode', 'rules', 'style.md');
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, 'the bytes that were there before\n', { mode: 0o644 });
    await applyPlan(optionsFor(t));
    const real = await realpath(dest);
    expect(readFileSync(join(t.artifactDir, 'pre', preKeyFor(real)), 'utf8')).toBe('the bytes that were there before\n');
    const index = readFileSync(join(t.artifactDir, 'pre', 'index.jsonl'), 'utf8');
    expect(index).toContain(sha256Hex('the bytes that were there before\n'));
    expect(index).toContain('"mode":420');
    // a destination that did not exist is recorded as an absence, so undo knows to delete it and a
    // resumed run cannot mistake its own earlier write for the human's file
    const created = await realpath(join(t.ws, '.jevcode', 'memory', 'project-notes.md'));
    expect(index).toContain(`"key":"${preKeyFor(created)}","dest":"${created}","sha256":null`);
    expect(existsSync(join(t.artifactDir, 'pre', preKeyFor(created)))).toBe(false);
    // and the destination really was rewritten afterwards
    expect(readFileSync(dest, 'utf8')).not.toContain('before\n');
  });

  it('two rows that share a destination snapshot it once, and the snapshot is the ORIGINAL (review defect 2)', async () => {
    const t = await tree();
    // both the `append` row and the `review` row of the fixture name `~/.config/jevcode/AGENTS.md`
    const dest = join(t.userDir, 'AGENTS.md');
    await writeFile(dest, '# yours\n', { mode: 0o600 });
    const rows = t.plan.rows.filter((r) => r.dest === '~/.config/jevcode/AGENTS.md');
    expect(rows.length).toBeGreaterThan(1);
    const second = { ...rows[1]!, action: 'append' as const };
    const plan = { ...t.plan, rows: [...t.plan.rows.filter((r) => r.id !== second.id), second] };
    await applyPlan(optionsFor(t, { plan, approved: [rows[0]!.id, second.id] }));

    const real = await realpath(dest);
    expect(readFileSync(join(t.artifactDir, 'pre', preKeyFor(real)), 'utf8')).toBe('# yours\n');
    const index = readFileSync(join(t.artifactDir, 'pre', 'index.jsonl'), 'utf8').trimEnd().split('\n');
    expect(index.filter((l) => l.includes(preKeyFor(real)))).toHaveLength(1);
    // both blocks landed on the one destination
    expect(readFileSync(dest, 'utf8').split('<!-- jevcode:import ').length - 1).toBe(2);
  });

  it('row 66: an `update` replaces the marker block interior and leaves every byte outside it', async () => {
    const t = await tree();
    const row = t.plan.rows.find((r) => r.dest === 'AGENTS.md')!;
    const head = '# Project\n\nhand-written prose above\n';
    const tail = '\n\nhand-written prose below\n';
    const before = `${head}\n${markerOpen(t.plan.importId, 'codex', row.source.display, 'deadbeefdeadbeef')}\nOLD INTERIOR\n${markerClose(t.plan.importId)}${tail}`;
    await writeFile(join(t.ws, 'AGENTS.md'), before, { mode: 0o644 });
    const r = await applyPlan(optionsFor(t));
    const after = readFileSync(join(t.ws, 'AGENTS.md'), 'utf8');
    expect(after.startsWith(head)).toBe(true);
    expect(after.endsWith(tail)).toBe(true);
    expect(after).not.toContain('OLD INTERIOR');
    expect(after).toContain(`sha256=${row.source.sha256.slice(0, 8)}`);
    expect(r.demoted.find((d) => d.row === row.id)).toBeUndefined();
  });

  it('row 67: the human deleted the marker block — `review`, nothing written, never re-appended', async () => {
    const t = await tree();
    const row = t.plan.rows.find((r) => r.dest === 'AGENTS.md')!;
    const before = '# Project\n\nthe block was removed by hand\n';
    await writeFile(join(t.ws, 'AGENTS.md'), before, { mode: 0o644 });
    const r = await applyPlan(optionsFor(t));
    expect(readFileSync(join(t.ws, 'AGENTS.md'), 'utf8')).toBe(before);
    expect(r.demoted).toContainEqual({ row: row.id, why: 'review — the block was edited or removed; nothing was written' });
    expect(r.exitCode).toBe(2);
    expect(applyLogOf(t).some((l) => l.row === row.id)).toBe(false);
  });

  it('an `append` wraps the imported text in the marker pair, below what is already there', async () => {
    const t = await tree();
    const row = t.plan.rows.find((r) => r.dest === '~/.config/jevcode/AGENTS.md')!;
    await writeFile(join(t.userDir, 'AGENTS.md'), '# yours\n', { mode: 0o600 });
    await applyPlan(optionsFor(t));
    const after = readFileSync(join(t.userDir, 'AGENTS.md'), 'utf8');
    expect(after.startsWith('# yours\n\n<!-- jevcode:import ')).toBe(true);
    expect(after.trimEnd().endsWith(markerClose(t.plan.importId))).toBe(true);
    expect(after).toContain(`source=claude-code:${row.source.display}`);
  });

  it('row 79: a per-row failure is recorded, the loop continues, and the exit code becomes 2', async () => {
    const t = await tree();
    const base = nodeWriteFs();
    const failing: ImportWriteFs = {
      ...base,
      async writeFile(p, data, o) {
        if (p.endsWith(join('.jevcode', 'memory', 'MEMORY.md'))) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        await base.writeFile(p, data, o);
      },
    };
    const r = await applyPlan(optionsFor(t, { fs: failing }));
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.error).toContain('EACCES');
    expect(r.exitCode).toBe(2);
    // the other rows applied
    expect(existsSync(join(t.ws, '.jevcode', 'memory', 'project-notes.md'))).toBe(true);
    expect(existsSync(join(t.ws, '.jevcode', 'rules', 'long.md'))).toBe(true);
    // and the failure is in apply.jsonl as ok:false, so --resume retries exactly it
    const log = applyLogOf(t);
    expect(log.filter((l) => !l.ok)).toHaveLength(1);
    expect(log.filter((l) => !l.ok)[0]?.error).toContain('EACCES');
  });

  it('only approved rows are applied, and a row of an unwritable class can never be written at all', async () => {
    const t = await tree();
    const one = t.plan.rows.find((r) => r.dest === '.jevcode/rules/style.md')!;
    const r = await applyPlan(optionsFor(t, { approved: [one.id] }));
    expect(r.applied.map((a) => a.row)).toEqual([one.id]);
    expect(existsSync(join(t.ws, '.jevcode', 'memory', 'project-notes.md'))).toBe(false);

    // §4.8.4: the permission, hook, secret and transcript rows are demoted structurally, not by policy
    const reportOnly = t.plan.rows.filter((row) => row.dest === null).map((row) => row.id);
    const all = await applyPlan(optionsFor(await tree(), { approved: [...reportOnly] }));
    expect(all.applied).toEqual([]);
    expect(all.demoted.map((d) => d.row).sort()).toEqual([...reportOnly].sort());
    for (const d of all.demoted) expect(d.why).toContain('nothing was written');
  });

  it('an mcp.json merge keeps the servers already on disk and adds the new one disabled (§4.7.4 step 5)', async () => {
    const t = await tree();
    const existing: McpFile = {
      v: 1,
      servers: { local: { transport: 'stdio', command: 'x', enabled: false, source: { tool: 'cursor', path: '~/.cursor/mcp.json', sha256: 'aa', importId: 'imp_old' } } },
    };
    await mkdir(join(t.ws, '.jevcode'), { recursive: true });
    await writeFile(join(t.ws, '.jevcode', 'mcp.json'), renderMcpFile(existing), { mode: 0o644 });
    await applyPlan(optionsFor(t));
    const after = JSON.parse(readFileSync(join(t.ws, '.jevcode', 'mcp.json'), 'utf8')) as { servers: Record<string, { enabled: boolean }> };
    expect(Object.keys(after.servers).sort()).toEqual(['github', 'local']);
    expect(Object.values(after.servers).every((s) => s.enabled === false)).toBe(true);
  });

  it('the lock is released whatever happens, so a second apply in the same process succeeds', async () => {
    const t = await tree();
    await applyPlan(optionsFor(t));
    expect(existsSync(t.lockPath)).toBe(false);
    const again = await applyPlan(optionsFor(t));
    expect(again.exitCode).toBe(2); // the AGENTS.md `update` now finds no marker block
    expect(existsSync(t.lockPath)).toBe(false);
  });

  it('an aborted apply stops and names the resume command (§4.9 SIGINT during apply)', async () => {
    const t = await tree();
    const controller = new AbortController();
    controller.abort();
    const r = await applyPlan(optionsFor(t, { signal: controller.signal }));
    expect(r.applied).toEqual([]);
    expect(r.notices.some((n) => n.includes(`jevcode import --resume ${t.plan.importId}`))).toBe(true);
  });
});

describe('joinDestination (§2.2 layout)', () => {
  it('collapses a ~-relative destination onto its root and never collapses a ..', () => {
    expect(joinDestination('/h/.config/jevcode', '~/.config/jevcode/AGENTS.md')).toBe('/h/.config/jevcode/AGENTS.md');
    expect(joinDestination('/h/.config/jevcode', '~/.config/jevcode/memory/a.md')).toBe('/h/.config/jevcode/memory/a.md');
    expect(joinDestination('/ws', '.jevcode/memory/a.md')).toBe('/ws/.jevcode/memory/a.md');
    expect(joinDestination('/ws/.jevcode/memory-local', '.jevcode/memory-local/a.md')).toBe('/ws/.jevcode/memory-local/a.md');
    expect(joinDestination('/ws', 'AGENTS.md')).toBe('/ws/AGENTS.md');
    expect(joinDestination('/ws', '../../.git/hooks/pre-commit')).toBe('/.git/hooks/pre-commit');
  });
});

// ---------------------------------------------------------------------------------------
// the adversarial review's apply-side defects (review-engine-2026-09-22.md, defects 7 and 10,
// and the `modeFor` item under "Lower")
// ---------------------------------------------------------------------------------------

describe('a destination that is not valid UTF-8 (review defect 7)', () => {
  it('is refused with a `review` that names it, and not one byte of it changes', async () => {
    const t = await tree();
    // a latin-1 `AGENTS.md`: `é` is the single byte 0xe9, which `toString(utf8)` turns into ef bf bd
    const latin1 = Buffer.from('# projet\n\nle café était déjà là\n', 'latin1');
    expect(latin1.includes(0xe9)).toBe(true);
    const dest = join(t.userDir, 'AGENTS.md');
    await writeFile(dest, latin1, { mode: 0o600 });
    const row = t.plan.rows.find((r) => r.dest === '~/.config/jevcode/AGENTS.md' && r.action === 'append')!;

    const r = await applyPlan(optionsFor(t));

    const why = r.demoted.find((d) => d.row === row.id)?.why ?? '';
    expect(why).toContain('AGENTS.md');
    expect(why).toContain('not valid UTF-8');
    expect(why).toContain('nothing was written');
    expect(r.exitCode).toBe(2);
    // byte for byte: no replacement characters, no appended block, no truncation
    expect(Buffer.compare(readFileSync(dest), latin1)).toBe(0);
    expect(readFileSync(dest).includes(0xef)).toBe(false);
    expect(applyLogOf(t).some((l) => l.row === row.id)).toBe(false);
  });

  it('the pre-image of a non-UTF-8 destination is byte-exact, so nothing is mangled on the way in either', async () => {
    const t = await tree();
    const latin1 = Buffer.from('caf\xe9\n', 'latin1');
    await writeFile(join(t.userDir, 'AGENTS.md'), latin1, { mode: 0o600 });
    await applyPlan(optionsFor(t));
    const preDir = join(t.artifactDir, 'pre');
    const snapshots = existsSync(preDir) ? readdirSync(preDir).filter((n) => n !== 'index.jsonl') : [];
    const mangled = snapshots.map((n) => readFileSync(join(preDir, n))).filter((b) => b.includes(0xef) && b.includes(0xbf));
    expect(mangled).toEqual([]);
  });
});

describe('an existing mcp.json that does not parse (review defect 10)', () => {
  it('is `review`, never a merge that drops the human’s servers', async () => {
    const t = await tree();
    const dest = join(t.ws, '.jevcode', 'mcp.json');
    // a hand-written file in another tool's dialect: no `v: 1`, so `parseMcpFile` returns null
    const handWritten = `{\n  "mcpServers": {\n    "local": { "command": "my-server", "args": ["--port", "1234"] }\n  }\n}\n`;
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, handWritten, { mode: 0o644 });
    const row = t.plan.rows.find((r) => r.dest === '.jevcode/mcp.json')!;

    const r = await applyPlan(optionsFor(t));

    const why = r.demoted.find((d) => d.row === row.id)?.why ?? '';
    expect(why).toContain('mcp.json');
    expect(why).toContain('nothing was written');
    expect(r.exitCode).toBe(2);
    // the human's servers are still there, byte for byte
    expect(readFileSync(dest, 'utf8')).toBe(handWritten);
    expect(applyLogOf(t).some((l) => l.row === row.id)).toBe(false);
  });

  it('a rendered document that does not parse never replaces servers that do', async () => {
    const t = await tree();
    const dest = join(t.ws, '.jevcode', 'mcp.json');
    const existing: McpFile = {
      v: 1,
      servers: { local: { transport: 'stdio', command: 'x', enabled: false, source: { tool: 'cursor', path: '~/.cursor/mcp.json', sha256: 'aa', importId: 'imp_old' } } },
    };
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, renderMcpFile(existing), { mode: 0o644 });
    const before = readFileSync(dest, 'utf8');
    const row = t.plan.rows.find((r) => r.dest === '.jevcode/mcp.json')!;
    const broken: ApplyOptions['render'] = async (r, text) => (r.id === row.id ? { text: 'not an mcp document at all\n', mode: 0o644, warnings: [] } : await renderRow(r, text));

    const result = await applyPlan(optionsFor(t, { render: broken }));

    expect(result.demoted.find((d) => d.row === row.id)?.why).toContain('nothing was written');
    expect(readFileSync(dest, 'utf8')).toBe(before);
  });
});

describe('modeFor is clamped, whatever the render seam returns (§2.2)', () => {
  it('a hostile render mode of 0o777 never reaches a destination', async () => {
    const t = await tree();
    const hostile: ApplyOptions['render'] = async (row, sourceText) => ({ ...(await renderRow(row, sourceText)), mode: 0o777 });
    const r = await applyPlan(optionsFor(t, { render: hostile }));
    expect(r.failed).toEqual([]);
    // §2.2: workspace files 0644, `memory-local/**` and everything under the config dir 0600
    expect(statSync(join(t.ws, '.jevcode', 'memory', 'project-notes.md')).mode & 0o777).toBe(0o644);
    expect(statSync(join(t.ws, '.jevcode', 'rules', 'style.md')).mode & 0o777).toBe(0o644);
    expect(statSync(join(t.ws, '.jevcode', 'memory-local', 'claude-local.md')).mode & 0o777).toBe(0o600);
    expect(statSync(join(t.userDir, 'commands', 'ft.md')).mode & 0o777).toBe(0o600);
    // and nothing anywhere came out executable
    for (const line of applyLogOf(t)) {
      if (line.dest === null) continue;
      expect(statSync(line.dest).mode & 0o111).toBe(0);
      expect(line.mode === 0o644 || line.mode === 0o600).toBe(true);
    }
  });
});
