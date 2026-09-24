/**
 * docs/IMPORT-DESIGN.md §1 property 16 / §4.8.4 / §2.11 **[G2.1]** / §8.3 (`import-authority`) — **W5 gate**.
 *
 * Nothing imported grants a permission, installs a hook, enables an MCP server or changes the sandbox.
 * Four assertions, in the design's own terms:
 *
 *   1. `permissions`-class bytes written = 0
 *   2. `hooks` bytes = 0
 *   3. every `mcp.json` server `enabled === false`
 *   4. the seatbelt profile is byte-identical to today's **except** the three new write denies of §2.11
 *      plus the ordinal-correct `memory-local` read deny
 *
 * The fourth is the one the graft exists for, so it is asserted by *reconstruction*: strip exactly the
 * four new fragments from the emitted profile and the pre-[G2.1] profile must come back, line for line.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { appendFile, chmod, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { detectSecrets, redactSpans } from '../../../src/core/redact.js';
import type { Json } from '../../../src/core/types.js';
import { SOURCES, applicableRows, applyPlan, discover, nodeImportFs, normaliseMcp, parseMcpFile, planImport, renderMcpFile } from '../../../src/import/index.js';
import type { ApplyOptions, ImportClock, ImportEnvironment, ImportWriteFs } from '../../../src/import/index.js';
import { buildProfile, sbplString } from '../../../src/sandbox/seatbelt.js';
import type { ProfileOptions } from '../../../src/sandbox/seatbelt.js';

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
const writeTimeRedact = (s: string): string => redactSpans(s, detectSecrets(s), '[REDACTED:pattern]');

/** §4.8.4: the keys whose bytes must never be written, and the values that would grant something. */
const PERMISSION_TOKENS: readonly string[] = [
  '"permissions"',
  '"allowedTools"',
  'prefix_rule(',
  '"trust_level"',
  '"sandbox_mode"',
  '"approval_policy"',
  '"hasTrustDialogAccepted"',
  'Bash(*)',
  'WebFetch(*)',
];
const HOOK_TOKENS: readonly string[] = ['"hooks"', '"PreToolUse"', '"PostToolUse"', '"statusLine"', '"notify"'];

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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-authority-')));
  dirs.push(root);
  const home = join(root, 'home');
  const ws = join(root, 'repo');
  const write = async (p: string, text: string): Promise<void> => {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, text, { mode: 0o644 });
  };
  await write(join(home, '.claude', 'CLAUDE.md'), '# user instructions\n\nprefer small diffs.\n');
  await write(
    join(home, '.claude', 'settings.json'),
    `${JSON.stringify(
      {
        model: 'sonnet',
        permissions: { allow: ['Bash(*)', 'WebFetch(*)'], deny: [], defaultMode: 'acceptEdits' },
        allowedTools: ['Bash(*)'],
        hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo hook' }] }], PostToolUse: [] },
        statusLine: { type: 'command', command: 'echo status' },
        hasTrustDialogAccepted: true,
      },
      null,
      2,
    )}\n`,
  );
  await write(join(ws, '.claude', 'settings.local.json'), `${JSON.stringify({ permissions: { allow: ['Bash(*)'] }, sandbox_mode: 'danger-full-access', approval_policy: 'never' }, null, 2)}\n`);
  await write(join(ws, '.mcp.json'), `${JSON.stringify({ mcpServers: { a: { command: 'npx', args: ['-y', 'a'] }, b: { url: 'https://b.example/mcp' } } }, null, 2)}\n`);
  return {
    home,
    ws,
    userDir: join(home, '.config', 'jevcode'),
    artifactDir: join(home, '.jevcode', 'imports', 'imp_20260921T120000Z_a1b2c3'),
    env: { home, env: {}, platform: process.platform, workspace: ws, gitRoot: ws, extraRoots: [] },
  };
}

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

describe('import-authority — authority never widens (§1 property 16, §4.8.4)', () => {
  it('writes 0 bytes of permissions and hooks, and every MCP server arrives disabled', async () => {
    const f = await fixture();
    const fs = nodeWriteFs();
    const found = await discover({ env: f.env, fs, clock, sources: SOURCES });
    expect(found.items.some((i) => i.display.endsWith('settings.json'))).toBe(true);

    const plan = await planImport({
      env: f.env,
      fs,
      clock,
      jevcodeVersion: '0.3.0',
      trust: 'trust',
      importId: 'imp_20260921T120000Z_a1b2c3',
      decider: null,
      redact: writeTimeRedact,
    });

    const render: ApplyOptions['render'] = async (row, sourceText) => {
      if (row.dest !== null && row.dest.endsWith('mcp.json')) {
        const r = normaliseMcp({
          dialect: 'claude-code',
          tool: 'claude-code',
          sourcePath: row.source.display,
          sourceSha256: row.source.sha256,
          importId: plan.importId,
          raw: JSON.parse(sourceText) as Json,
        });
        return { text: renderMcpFile({ v: 1, servers: r.servers }), mode: 0o644, warnings: [] };
      }
      return { text: writeTimeRedact(sourceText), mode: 0o644, warnings: [] };
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
      approved: applicableRows(plan),
      render,
      sourcePath: (row) => (row.source.display.startsWith('~/') ? join(f.home, row.source.display.slice(2)) : join(f.ws, row.source.display)),
    });

    const destinations = [...filesUnder(f.userDir), ...filesUnder(join(f.ws, '.jevcode'))];
    expect(destinations.length).toBeGreaterThan(0);

    // 1 + 2: zero bytes of the permission and hook classes, in any destination
    for (const [p, text] of destinations) {
      for (const token of PERMISSION_TOKENS) expect(text.includes(token), `${p} wrote the permission token ${token}`).toBe(false);
      for (const token of HOOK_TOKENS) expect(text.includes(token), `${p} wrote the hook token ${token}`).toBe(false);
    }
    // …and structurally: no applied row was of a class that could carry them
    for (const applied of result.applied) {
      const row = plan.rows.find((r) => r.id === applied.row);
      expect(row?.class, `${applied.row} is not an importable class`).not.toBe('config');
      expect(row?.class).not.toBe('secret');
      expect(row?.class).not.toBe('transcript');
    }
    // the permission and hook rows exist in the plan — they are reported, just never written
    const suggested = plan.rows.filter((r) => r.action === 'suggest' || r.action === 'skip:executable');
    expect(suggested.length).toBeGreaterThan(0);
    for (const r of suggested) expect(r.dest).toBeNull();
    for (const r of suggested) expect(r.bytes).toBe(0);

    // 3: every MCP server disabled
    const mcpPath = join(f.ws, '.jevcode', 'mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const file = parseMcpFile(readFileSync(mcpPath, 'utf8'));
    expect(Object.keys(file?.servers ?? {}).sort()).toEqual(['a', 'b']);
    for (const [name, server] of Object.entries(file?.servers ?? {})) expect(server.enabled, name).toBe(false);
    expect(readFileSync(mcpPath, 'utf8')).not.toContain('"enabled": true');

    // and approving a row a human cannot approve still writes nothing of those classes
    const everything = plan.rows.map((r) => r.id);
    const f2 = await fixture();
    const forced = await applyPlan({
      plan: { ...plan, workspace: f2.ws, workspaceKey: f2.ws },
      fs,
      clock,
      destRoots: { project: f2.ws, projectLocal: f2.ws, user: f2.userDir },
      artifactDir: f2.artifactDir,
      lockPath: join(f2.home, '.jevcode', 'imports', '.lock'),
      manifest: null,
      consent: 'flag',
      approved: everything,
      render,
      sourcePath: (row) => (row.source.display.startsWith('~/') ? join(f.home, row.source.display.slice(2)) : join(f.ws, row.source.display)),
    });
    for (const applied of forced.applied) {
      const row = plan.rows.find((r) => r.id === applied.row);
      expect(['memory', 'rule', 'command', 'mcp']).toContain(row?.class);
    }
    for (const [p, text] of [...filesUnder(f2.userDir), ...filesUnder(join(f2.ws, '.jevcode'))]) {
      for (const token of [...PERMISSION_TOKENS, ...HOOK_TOKENS]) expect(text.includes(token), `${p} wrote ${token}`).toBe(false);
    }
  });
});

describe('the seatbelt diff is exactly the four new fragments (§2.11 [G2.1], §1 property 16)', () => {
  interface Sb {
    ws: string;
    home: string;
    opts: ProfileOptions;
  }
  async function sandboxFixture(): Promise<Sb> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-authority-sb-')));
    dirs.push(root);
    const ws = join(root, 'ws');
    const home = join(root, 'home');
    mkdirSync(join(ws, '.jevcode', 'memory-local'), { recursive: true });
    mkdirSync(join(root, 'run', 'tmp'), { recursive: true });
    mkdirSync(join(root, 'run', 'home'), { recursive: true });
    mkdirSync(home, { recursive: true });
    return { ws, home, opts: { ws, runTmp: join(root, 'run', 'tmp'), runHome: join(root, 'run', 'home'), ttyPath: '/dev/ttys004', readDenies: [], noNetwork: true, home } };
  }

  it('is byte-identical to the pre-graft profile once the three write denies and the one read deny are removed', async () => {
    const sb = await sandboxFixture();
    const jev = (rel: string): string => join(sb.ws, '.jevcode', rel);
    const profile = buildProfile(sb.opts);
    const lines = profile.split('\n');

    // the four fragments, named exactly
    const writeFragments = ['memory', 'rules', 'commands'].map((rel) => ` (literal ${sbplString(jev(rel))}) (subpath ${sbplString(jev(rel))})`);
    const readDeny = `(deny file-read* (literal ${sbplString(jev('memory-local'))}) (subpath ${sbplString(jev('memory-local'))}))`;

    // they are present, and the read deny's ordinal beats BOTH re-allows (the whole point of [G2.1])
    const writeDenyIndex = lines.findIndex((l) => l.startsWith('(deny file-write* (literal'));
    for (const fragment of writeFragments) expect(lines[writeDenyIndex]).toContain(fragment);
    const readDenyIndex = lines.indexOf(readDeny);
    expect(readDenyIndex).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(allow file-read-data ')));
    expect(readDenyIndex).toBeGreaterThan(lines.findIndex((l) => l.startsWith('(allow file-read* ')));

    // removing exactly those four fragments reproduces the pre-graft profile, line for line
    const before = lines
      .filter((l) => l !== readDeny)
      .map((l) => (l.startsWith('(deny file-write* (literal') ? writeFragments.reduce((acc, frag) => acc.replace(frag, ''), l) : l));
    expect(before).toEqual([
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      `(allow file-write* (subpath ${sbplString(sb.ws)}) (subpath ${sbplString(sb.opts.runTmp)}) (subpath ${sbplString(sb.opts.runHome)})`,
      '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/tty")',
      '  (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))',
      `(deny file-write* (literal ${sbplString(join(sb.ws, '.git', 'config'))}) (subpath ${sbplString(join(sb.ws, '.git', 'hooks'))}) (literal "/dev/ttys004"))`,
      `(deny file-read* (subpath ${sbplString(join(sb.home, '.config', 'jevcode'))}) (subpath ${sbplString(join(sb.home, '.ssh'))}) ` +
        `(subpath ${sbplString(join(sb.home, '.aws'))}) (subpath ${sbplString(join(sb.home, '.config', 'gh'))}) (literal ${sbplString(join(sb.home, '.netrc'))}))`,
      `(deny file-read-data (subpath ${sbplString(join(sb.home, '.jevcode'))}))`,
      `(allow file-read-data (subpath ${sbplString(sb.ws)}) (subpath ${sbplString(sb.opts.runTmp)}) (subpath ${sbplString(sb.opts.runHome)}))`,
      `(allow file-read* (subpath ${sbplString(sb.ws)}) (subpath ${sbplString(sb.opts.runTmp)}) (subpath ${sbplString(sb.opts.runHome)}))`,
      '(deny network*)',
      '',
    ]);

    // nothing else about the sandbox moved: no new allow, no new network rule, no new option
    expect(profile.split('(allow ').length - 1).toBe(4);
    expect(profile.split('(deny ').length - 1).toBe(6);
    expect(profile).not.toContain('memory-local"))\n(allow');
  });
});
