/**
 * import/discover.ts (IMPORT-DESIGN §4.2; §6 group A rows 1–7, 10–14, 16, and rows 29, 31, 37).
 *
 * Real temp-directory walks through `nodeImportFs()`, plus a fake `ImportFs` where the case is
 * cleaner that way (a FIFO, a file that grows under the read, the per-volume case probe).
 */
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, type ImportLimits } from '../../../src/core/limits.js';
import { discover, nodeImportFs, probeImport, readSource, systemClock, type DiscoverOptions } from '../../../src/import/discover.js';
import { parseMarkdown } from '../../../src/import/parse/markdown.js';
import { SOURCES, specById } from '../../../src/import/sources.js';
import type { ImportClock, ImportEnvironment, ImportFs, SourceItem, SourceSpec } from '../../../src/import/types.js';

let tmp: string;
let home: string;
let repo: string;

const clock: ImportClock = { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => 0 };

/** A clock that advances by `step` on every call — for the `walkMs` and probe-deadline caps. */
function steppingClock(step: number): ImportClock {
  let calls = 0;
  return { now: () => new Date('2026-09-21T12:00:00.000Z'), monotonicMs: () => step * calls++ };
}

function limitsWith(over: Partial<Record<keyof ImportLimits, number>>): ImportLimits {
  return { ...IMPORT_LIMITS, ...over } as ImportLimits;
}

function envOf(over: Partial<ImportEnvironment> = {}): ImportEnvironment {
  return { home, env: {}, platform: 'darwin', workspace: repo, gitRoot: repo, extraRoots: [], ...over };
}

function recording(fs: ImportFs, reads: string[]): ImportFs {
  return {
    ...fs,
    readFile: (p: string) => {
      reads.push(p);
      return fs.readFile(p);
    },
    readPrefix: (p: string, n: number) => {
      reads.push(p);
      return fs.readPrefix(p, n);
    },
  };
}

function run(over: Partial<DiscoverOptions> = {}): ReturnType<typeof discover> {
  return discover({ env: envOf(), fs: nodeImportFs(), clock, ...over });
}

function byDisplay(items: readonly SourceItem[], suffix: string): SourceItem | undefined {
  return items.find((i) => i.display.endsWith(suffix));
}

function only(ids: readonly string[]): readonly SourceSpec[] {
  return ids.map((id) => {
    const s = specById(id);
    if (s === undefined) throw new Error(`no atlas row ${id}`);
    return s;
  });
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'jevcode-import-')));
  home = join(tmp, 'home');
  repo = join(tmp, 'repo');
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
});

afterEach(async () => {
  await chmod(join(home, '.claude', 'projects'), 0o755).catch(() => undefined);
  await rm(tmp, { recursive: true, force: true });
});

describe('§6 row 5 — nothing installed', () => {
  it('returns no items, no notices and every root not-exists; exit is not an exception', async () => {
    const r = await run();
    expect(r.items).toEqual([]);
    expect(r.notices).toEqual([]);
    expect(r.roots.length).toBeGreaterThan(0);
    expect(r.roots.some((root) => root.tool === 'claude-code' && root.display === '~/.claude')).toBe(true);
    expect(r.roots.find((root) => root.display === '~/.claude')?.exists).toBe(false);
    expect(r.roots.find((root) => root.path === repo)?.exists).toBe(true);
  });
});

describe('§6 rows 1–2 — the overrides reach the walk', () => {
  it('CLAUDE_CONFIG_DIR moves every Claude root; ~/.claude is not scanned', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# default root\n');
    await write(join(tmp, 'cc', 'CLAUDE.md'), '# override root\n');
    const r = await run({ env: envOf({ env: { CLAUDE_CONFIG_DIR: join(tmp, 'cc') } }) });
    const displays = r.items.map((i) => i.display);
    expect(displays).toContain(join(tmp, 'cc', 'CLAUDE.md'));
    expect(displays).not.toContain('~/.claude/CLAUDE.md');
    expect(r.roots.find((root) => root.path === join(tmp, 'cc'))?.env).toBe('CLAUDE_CONFIG_DIR');
  });
});

describe('§6 rows 6–7 — the always-exclusions', () => {
  it('node_modules, .git, dist and .claude/worktrees are excluded before any stat, even under --all', async () => {
    await write(join(repo, 'AGENTS.md'), '# root\n');
    await write(join(repo, 'node_modules', 'pkg', 'AGENTS.md'), '# vendored\n');
    await write(join(repo, 'dist', 'AGENTS.md'), '# built\n');
    await write(join(repo, 'coverage', 'AGENTS.md'), '# coverage\n');
    await write(join(repo, '.git', 'AGENTS.md'), '# git\n');
    for (const w of ['w1', 'w2', 'w3']) await write(join(repo, '.claude', 'worktrees', w, 'AGENTS.md'), `# ${w}\n`);
    const r = await run({ all: true });
    const agents = r.items.filter((i) => i.realpath.endsWith('AGENTS.md'));
    expect(agents.map((i) => i.realpath)).toEqual([join(repo, 'AGENTS.md')]);
  });

  it('a nested AGENTS.md outside an excluded directory is still found', async () => {
    await write(join(repo, 'packages', 'a', 'AGENTS.md'), '# package a\n');
    const r = await run();
    expect(r.items.map((i) => i.realpath)).toContain(join(repo, 'packages', 'a', 'AGENTS.md'));
  });
});

describe('§6 row 10 — the symlink policy', () => {
  it('a symlink resolving outside the root that found it is skip:symlink, with the reason', async () => {
    await write(join(home, 'notes', 'claude.md'), '# outside\n');
    await mkdir(join(home, '.claude'), { recursive: true });
    await symlink(join(home, 'notes', 'claude.md'), join(home, '.claude', 'CLAUDE.md'));
    const r = await run({ sources: only(['claude.user-instructions']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.notices).toEqual(['skip:symlink — resolves outside ~/.claude']);
    expect(r.items[0]?.sha256).toBe('');
  });

  it('a symlink that stays inside the root is followed and read', async () => {
    await write(join(home, '.claude', 'real.md'), '# inside\n');
    await symlink(join(home, '.claude', 'real.md'), join(home, '.claude', 'CLAUDE.md'));
    const r = await run({ sources: only(['claude.user-instructions']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.notices).toEqual([]);
    expect(r.items[0]?.realpath).toBe(join(home, '.claude', 'real.md'));
    expect(r.items[0]?.sha256.length).toBe(64);
  });
});

describe('§6 row 11 — inode cycles', () => {
  it('a directory symlinked back to an ancestor is broken by the dev:ino set, with a notice', async () => {
    await write(join(home, '.claude', 'agent-memory', 'a', 'note.md'), '# note\n');
    await symlink(join(home, '.claude', 'agent-memory'), join(home, '.claude', 'agent-memory', 'a', 'loop'));
    const r = await run({ sources: only(['claude.agent-memory.user']) });
    expect(r.notices).toContain('~/.claude walk stopped (cycle)');
    expect(r.items.map((i) => i.realpath)).toEqual([join(home, '.claude', 'agent-memory', 'a', 'note.md')]);
  });
});

describe('§6 row 12 — EACCES', () => {
  it('names the unreadable directory and keeps scanning every other root; no throw', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# still read\n');
    await write(join(home, '.claude', 'projects', 'slug', 'memory', 'MEMORY.md'), '# memory\n');
    await chmod(join(home, '.claude', 'projects'), 0o000);
    const r = await run();
    expect(r.notices.some((n) => n.startsWith('cannot read ~/.claude/projects:'))).toBe(true);
    expect(r.items.map((i) => i.display)).toContain('~/.claude/CLAUDE.md');
  });
});

describe('§6 row 13 — a directory (or FIFO) where a file is expected', () => {
  it('a directory named CLAUDE.md is skip:not-a-file and is never opened', async () => {
    await mkdir(join(home, '.claude', 'CLAUDE.md'), { recursive: true });
    const r = await run({ sources: only(['claude.user-instructions']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.notices).toEqual(['skip:not-a-file']);
  });

  it('a FIFO is skip:not-a-file, decided by stat().isFile() before any open', async () => {
    const reads: string[] = [];
    const fs = fakeFs(
      {
        '/h/.claude': { type: 'dir' },
        '/h/.claude/CLAUDE.md': { type: 'fifo' },
      },
      { reads },
    );
    const r = await discover({ env: { home: '/h', env: {}, platform: 'darwin', workspace: '/w', gitRoot: null, extraRoots: [] }, fs, clock, sources: only(['claude.user-instructions']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.notices).toEqual(['skip:not-a-file']);
    expect(reads).toEqual([]);
  });
});

describe('§6 row 14 — transcripts', () => {
  const session = [
    JSON.stringify({ type: 'summary', sessionId: 'sess-1', cwd: '/Users/x/repo', gitBranch: 'main', timestamp: '2026-09-20T10:00:00.000Z' }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'do the thing' }, timestamp: '2026-09-20T10:00:01.000Z' }),
  ].join('\n');

  it('are skip:transcript by default: bytes reported, body never read', async () => {
    await write(join(home, '.claude', 'projects', 'slug', 'a.jsonl'), session);
    const reads: string[] = [];
    const r = await discover({ env: envOf(), fs: recording(nodeImportFs(), reads), clock, sources: only(['claude.transcripts']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.notices).toEqual(['skip:transcript']);
    expect(r.items[0]?.bytes).toBe(session.length);
    expect(r.items[0]?.sha256).toBe('');
    expect(reads).toEqual([]);
  });

  it('--source claude-transcripts runs the metadata pass and nothing else', async () => {
    await write(join(home, '.claude', 'projects', 'slug', 'a.jsonl'), session);
    const r = await run({ sources: only(['claude.transcripts']), optIn: ['claude-transcripts'] });
    expect(r.items).toHaveLength(1);
    const notice = r.items[0]?.notices[0] ?? '';
    expect(notice).toContain('transcript: session sess-1');
    expect(notice).toContain('branch main');
    expect(notice).toContain('2 records');
    expect(notice).toContain('"do the thing"');
  });
});

describe('§6 row 16 — the per-volume case probe [G1.6]', () => {
  const tree = {
    '/h/.claude': { type: 'dir' as const },
    '/h/.claude/CLAUDE.md': { type: 'file' as const, content: '# upper\n' },
    '/h/.claude/claude.md': { type: 'file' as const, content: '# lower\n' },
  };
  const env = { home: '/h', env: {}, platform: 'darwin' as const, workspace: '/w', gitRoot: null, extraRoots: [] };

  it('a case-SENSITIVE volume holding both CLAUDE.md and claude.md produces two rows', async () => {
    const r = await discover({ env, fs: fakeFs(tree), clock, sources: only(['claude.user-instructions']) });
    expect(r.items.map((i) => i.realpath).sort()).toEqual(['/h/.claude/CLAUDE.md', '/h/.claude/claude.md']);
  });

  it('a case-INSENSITIVE volume produces one row, with the on-disk name', async () => {
    const r = await discover({ env, fs: fakeFs(tree, { caseInsensitive: true }), clock, sources: only(['claude.user-instructions']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.realpath).toBe('/h/.claude/CLAUDE.md');
  });
});

describe('§4.2.2 — every walk cap yields a notice and the rows found so far', () => {
  it('walkEntries', async () => {
    const fs = fakeFs({
      '/h/.claude': { type: 'dir' },
      '/h/.claude/CLAUDE.md': { type: 'file', content: '# one\n' },
      '/h/.claude/b.md': { type: 'file', content: 'b' },
      '/h/.claude/c.md': { type: 'file', content: 'c' },
    });
    const r = await discover({
      env: { home: '/h', env: {}, platform: 'darwin', workspace: '/w', gitRoot: null, extraRoots: [] },
      fs,
      clock,
      sources: only(['claude.user-instructions']),
      limits: limitsWith({ walkEntries: 2 }),
    });
    expect(r.notices).toContain('~/.claude walk stopped at walkEntries 2');
    expect(r.items.map((i) => i.realpath)).toEqual(['/h/.claude/CLAUDE.md']);
  });

  it('walkDepth', async () => {
    await write(join(home, '.claude', 'agent-memory', 'a', 'shallow.md'), '# shallow\n');
    await write(join(home, '.claude', 'agent-memory', 'a', 'b', 'deep.md'), '# deep\n');
    const r = await run({ sources: only(['claude.agent-memory.user']), limits: limitsWith({ walkDepth: 2 }) });
    expect(r.notices).toContain('~/.claude walk stopped at walkDepth 2');
    expect(r.items.map((i) => basename(i.realpath))).toEqual(['shallow.md']);
  });

  it('walkMs', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# root file\n');
    await write(join(home, '.claude', 'rules', 'a.md'), '# rule\n');
    const r = await run({ sources: only(['claude.user-instructions', 'claude.rules.user']), clock: steppingClock(1_500) });
    expect(r.notices).toContain('~/.claude walk stopped at walkMs 2000');
    expect(r.items.map((i) => basename(i.realpath))).toEqual(['CLAUDE.md']);
  });

  it('filesPerRow', async () => {
    for (const n of ['a', 'b', 'c', 'd']) await write(join(home, '.claude', 'rules', `${n}.md`), `# ${n}\n`);
    const r = await run({ sources: only(['claude.rules.user']), limits: limitsWith({ filesPerRow: 2 }) });
    expect(r.notices).toContain('claude.rules.user stopped at filesPerRow 2');
    expect(r.items).toHaveLength(2);
  });
});

describe('§4.2.2 — .gitignore', () => {
  it('is respected for repo roots by default and ignored for home roots', async () => {
    await write(join(repo, '.gitignore'), '# comment\nprivate/\n!private/keep/\n');
    await write(join(repo, 'AGENTS.md'), '# root\n');
    await write(join(repo, 'private', 'AGENTS.md'), '# private\n');
    await write(join(home, '.claude', '.gitignore'), 'rules/\n');
    await write(join(home, '.claude', 'rules', 'a.md'), '# rule\n');
    const r = await run();
    const paths = r.items.map((i) => i.realpath);
    expect(paths).toContain(join(repo, 'AGENTS.md'));
    expect(paths).not.toContain(join(repo, 'private', 'AGENTS.md'));
    expect(paths).toContain(join(home, '.claude', 'rules', 'a.md'));
  });

  it('--no-respect-gitignore takes the ignored file too', async () => {
    await write(join(repo, '.gitignore'), 'private/\n');
    await write(join(repo, 'private', 'AGENTS.md'), '# private\n');
    const r = await run({ respectGitignore: false });
    expect(r.items.map((i) => i.realpath)).toContain(join(repo, 'private', 'AGENTS.md'));
  });
});

describe('§4.2.3 — identity, skip:self and secrets', () => {
  it('a realpath that is a destination is skip:self', async () => {
    await write(join(repo, 'AGENTS.md'), '# root\n');
    const r = await run({ destinations: [join(repo, 'AGENTS.md')] });
    expect(byDisplay(r.items, 'AGENTS.md')?.notices).toEqual(['skip:self']);
  });

  it('a secret-named path is recorded but never opened', async () => {
    const reads: string[] = [];
    await write(join(home, '.claude', '.credentials.json'), '{"token":"never-read"}');
    const r = await discover({ env: envOf(), fs: recording(nodeImportFs(), reads), clock, sources: only(['claude.credentials']) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.notices).toEqual(['skip:secret — named, never read']);
    expect(r.items[0]?.sha256).toBe('');
    expect(reads).toEqual([]);
  });

  it('the id, display, mtime and parse summary are filled in for a read row', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '---\nname: x\n---\n# Heading\n\ntext\n');
    const r = await run({ sources: only(['claude.user-instructions']) });
    const item = r.items[0];
    expect(item?.id).toHaveLength(12);
    expect(item?.display).toBe('~/.claude/CLAUDE.md');
    expect(item?.tools).toEqual(['claude-code']);
    expect(item?.artefact).toBe('claude.user-instructions');
    expect(item?.scope).toBe('user');
    expect(item?.mtime.endsWith('Z')).toBe(true);
    expect(item?.parse).toMatchObject({ ok: true, headings: ['Heading'], frontmatterKeys: ['name'] });
  });
});

describe('§6 rows 29 and 31 — the capped read', () => {
  it('row 29: a 4.1 MiB CLAUDE.md is skip:oversize with the instructions.ts wording', async () => {
    const fs = fakeFs({
      '/h/.claude': { type: 'dir' },
      '/h/.claude/CLAUDE.md': { type: 'file', size: 4_299_161 },
    });
    const r = await discover({ env: { home: '/h', env: {}, platform: 'darwin', workspace: '/w', gitRoot: null, extraRoots: [] }, fs, clock, sources: only(['claude.user-instructions']) });
    expect(r.items[0]?.notices).toEqual(['skip:oversize — 4,299,161 bytes; larger than 4 MiB']);
  });

  it('row 31: a file that grows between stat and read is skip:oversize (grew during read)', async () => {
    const fs = fakeFs({
      '/h/.claude': { type: 'dir' },
      '/h/.claude/CLAUDE.md': { type: 'file', size: 10, content: 'x'.repeat(64) },
    });
    const r = await discover({
      env: { home: '/h', env: {}, platform: 'darwin', workspace: '/w', gitRoot: null, extraRoots: [] },
      fs,
      clock,
      sources: only(['claude.user-instructions']),
      limits: limitsWith({ readSlackBytes: 4 }),
    });
    expect(r.items[0]?.notices).toEqual(['skip:oversize — grew during read']);
  });
});

describe('readSource', () => {
  it('reads a body under the cap and never throws', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# body\n');
    const r = await run({ sources: only(['claude.user-instructions']) });
    const item = r.items[0];
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(await readSource(item, nodeImportFs())).toEqual({ ok: true, text: '# body\n' });
  });

  it('refuses a secret basename, a missing file and a binary body', async () => {
    await write(join(home, '.env'), 'KEY=abc\n');
    await write(join(home, 'bin.md'), '');
    await writeFile(join(home, 'bin.md'), Buffer.from([0x89, 0x50, 0x00, 0x00]));
    const item = (p: string): SourceItem => ({
      id: 'x',
      realpath: p,
      display: p,
      tools: ['aider'],
      artefact: 'test',
      format: 'text',
      scope: 'user',
      bytes: 8,
      sha256: '',
      mtime: '',
      parse: { ok: true },
      notices: [],
    });
    expect(await readSource(item(join(home, '.env')), nodeImportFs())).toMatchObject({ ok: false, reason: 'skip:secret' });
    expect(await readSource(item(join(home, 'bin.md')), nodeImportFs())).toMatchObject({ ok: false, reason: 'skip:not-text' });
    expect(await readSource(item(join(home, 'gone.md')), nodeImportFs())).toMatchObject({ ok: false, reason: 'skip:unsupported' });
  });
});

describe('§5.1 probeImport', () => {
  it('counts items per tool without opening a single body', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# user\n');
    await write(join(home, '.claude', 'rules', 'a.md'), '# rule\n');
    await write(join(repo, 'AGENTS.md'), '# agents\n');
    const reads: string[] = [];
    const p = await probeImport({ env: envOf(), fs: recording(nodeImportFs(), reads), clock });
    expect(p.total).toBeGreaterThanOrEqual(3);
    expect(p.tools.find((t) => t.tool === 'claude-code')?.items).toBeGreaterThanOrEqual(3);
    expect(p.tools.find((t) => t.tool === 'claude-code')?.display).toBe('~/.claude');
    expect(p.partial).toBe(false);
    expect(reads.filter((r) => !r.endsWith('.gitignore'))).toEqual([]);
  });

  it('drops transcript, secret and skip rows before the walk', async () => {
    await write(join(home, '.claude', 'projects', 'slug', 'a.jsonl'), '{}\n');
    await write(join(home, '.claude', '.credentials.json'), '{}');
    const p = await probeImport({ env: envOf(), fs: nodeImportFs(), clock });
    expect(p.total).toBe(0);
    expect(p.tools).toEqual([]);
  });

  it('a blown deadline yields partial: true and whatever was counted', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# user\n');
    const p = await probeImport({ env: envOf(), fs: nodeImportFs(), clock: steppingClock(40), deadlineMs: 50 });
    expect(p.partial).toBe(true);
  });
});

describe('§6 row 37 — the importer never fetches a URL', () => {
  it('no atlas row names a scheme, and a URL-valued override is not a root', async () => {
    for (const s of SOURCES) {
      expect(s.pattern).not.toContain('://');
      for (const root of s.roots) expect(root.path).not.toContain('://');
    }
    const r = await run({ env: envOf({ env: { CLAUDE_CONFIG_DIR: 'https://example.com/cc' } }) });
    expect(r.roots.some((root) => root.path.includes('://'))).toBe(false);
  });
});

/**
 * Review defect 8: `discover` passed no redactor at all, and `parseMarkdown` defaulted to
 * `patternRedact` — the **six** redacting families. A heading carrying one of the **nine**
 * warn-only ones therefore reached `SourceItem.parse.headings`, which is what `sources.jsonl`
 * and the group-II Jev state are built from. §1 property 4 counts all fifteen.
 */
describe('§1 property 4 — every discovered heading is redacted against all fifteen families', () => {
  const WARN_ONLY_NEEDLES: readonly { family: string; needle: string }[] = [
    { family: 'aws', needle: 'AKIAIOSFODNN7EXAMPLE' },
    { family: 'slack', needle: 'xoxb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrSt' },
    { family: 'slack_webhook', needle: 'hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX' },
    { family: 'pem', needle: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    { family: 'jwt', needle: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' },
    { family: 'stripe', needle: 'sk_live_4eC39HqLyjWDarjtT1zdp7dc' },
    { family: 'npm', needle: 'npm_abcdefghijklmnopqrstuvwxyz0123456789' },
    { family: 'huggingface', needle: 'hf_abcdefghijklmnopqrstuvwxyzABCDEFGH' },
    { family: 'gitlab', needle: 'glpat-abcdefghijklmnopqrstuvwxyz' },
  ];

  it('a needle from each of the nine warn-only families is masked out of a .md heading', async () => {
    const body = WARN_ONLY_NEEDLES.map(({ family, needle }) => `# rotated ${family} key ${needle}`).join('\n\n');
    await write(join(home, '.claude', 'CLAUDE.md'), `${body}\n`);
    const r = await run({ sources: only(['claude.user-instructions']), limits: limitsWith({ jevHeadings: 20 }) });
    const headings = r.items[0]?.parse.headings ?? [];
    expect(headings).toHaveLength(WARN_ONLY_NEEDLES.length);
    const rendered = JSON.stringify(r.items);
    for (const { family, needle } of WARN_ONLY_NEEDLES) expect(rendered, family).not.toContain(needle.slice(0, 12));
    for (const [i, h] of headings.entries()) expect(h, WARN_ONLY_NEEDLES[i]?.family).toContain('[REDACTED:pattern]');
  });

  it('a .mdc heading is redacted too — parseMdc forwards the same options', async () => {
    await write(join(repo, '.cursor', 'rules', 'style.mdc'), '---\nglobs: "**/*.ts"\n---\n# key AKIAIOSFODNN7EXAMPLE\n');
    const r = await run({ sources: only(['cursor.rules']) });
    expect(r.items[0]?.parse.headings).toEqual(['key [REDACTED:pattern]']);
  });

  it('DiscoverOptions.redact is the exact layer, and it is threaded into the heading redaction', async () => {
    // §2.9's reason for putting the configured layer first: a bare password matches no family,
    // so only a registration can catch it. `redactSpans` marks every span `[REDACTED:pattern]`,
    // exactly as the write seam does (`leak.test.ts`), so the two do not diverge.
    await write(join(home, '.claude', 'CLAUDE.md'), '# password hunter2-correct-horse and AKIAIOSFODNN7EXAMPLE\n');
    const exact = (s: string): string => s.split('hunter2-correct-horse').join('[REDACTED:fixture.secret.0]');
    const withExact = (await run({ sources: only(['claude.user-instructions']), redact: exact })).items[0]?.parse.headings?.[0] ?? '';
    expect(withExact).toBe('password [REDACTED:pattern] and [REDACTED:pattern]');
    // without it the family still fires, and only the bare password survives
    const without = (await run({ sources: only(['claude.user-instructions']) })).items[0]?.parse.headings?.[0] ?? '';
    expect(without).toBe('password hunter2-correct-horse and [REDACTED:pattern]');
  });
});

/**
 * Review defect 6(b): `discover` and the facade both parsed every body, so the fixed-but-still
 * real cost of `parseMarkdown` was paid twice per file. The parse `buildItem` already did is
 * threaded out on `DiscoverResult.docs`, keyed by `SourceItem.id` — **bounded**, because
 * `planRows` is 2,000 and one body may be 4 MiB.
 */
describe('§1 property 14 — the parse is threaded out so no body is parsed twice', () => {
  it('a markdown row carries its MarkdownDoc, identical to a fresh parse', async () => {
    const body = '---\nname: x\n---\n# Heading\n\nAlpha beta gamma.\n';
    await write(join(home, '.claude', 'CLAUDE.md'), body);
    const r = await run({ sources: only(['claude.user-instructions']) });
    const item = r.items[0];
    expect(item).toBeDefined();
    const doc = r.docs.get(item?.id ?? '');
    expect(doc).toBeDefined();
    expect(doc?.normalisedSha256).toBe(parseMarkdown(body).normalisedSha256);
    expect(doc?.headings).toEqual(item?.parse.headings);
    expect(doc?.frontmatter?.keys).toEqual(['name']);
    expect(doc?.tokens).toEqual(['alpha', 'beta', 'gamma', 'heading']);
  });

  it('an .mdc row carries its doc too, and a skipped or unparsed row carries none', async () => {
    await write(join(repo, '.cursor', 'rules', 'style.mdc'), '---\nglobs: "**/*.ts"\n---\n# Style\n');
    await write(join(home, '.claude', 'settings.json'), '{"model":"x"}');
    await write(join(home, '.claude', '.credentials.json'), '{"token":"never-read"}');
    const r = await run({ sources: only(['cursor.rules', 'claude.settings.user', 'claude.credentials']) });
    const idOf = (suffix: string): string => byDisplay(r.items, suffix)?.id ?? '';
    expect(r.docs.get(idOf('style.mdc'))?.headings).toEqual(['Style']);
    expect(r.docs.has(idOf('settings.json'))).toBe(false);
    expect(r.docs.has(idOf('.credentials.json'))).toBe(false);
  });

  it('probeImport parses nothing at all, so there is nothing to thread out', async () => {
    await write(join(home, '.claude', 'CLAUDE.md'), '# Heading\n');
    const r = await discover({ env: envOf(), fs: nodeImportFs(), clock, sources: only(['claude.user-instructions']) });
    expect(r.docs.size).toBe(1);
    expect((await probeImport({ env: envOf(), fs: nodeImportFs(), clock, sources: only(['claude.user-instructions']) })).total).toBe(1);
  });

  it('the map is bounded by bytes: the rows past the budget keep their parse summary and lose only the doc', async () => {
    // docBudget: 2 x sourceReadCapBytes of retained body text, so 8 KiB here
    const limits = limitsWith({ sourceReadCapBytes: 4 * 1024 });
    const big = `# Heading\n\n${'alpha beta gamma delta '.repeat(120)}`;
    expect(big.length).toBeGreaterThan(2 * 1024);
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) await write(join(home, '.claude', 'rules', name), big);
    const r = await run({ sources: only(['claude.rules.user']), limits });
    expect(r.items).toHaveLength(5);
    expect(r.docs.size).toBeGreaterThan(0);
    expect(r.docs.size).toBeLessThan(5);
    let bytes = 0;
    for (const doc of r.docs.values()) bytes += doc.text.length;
    expect(bytes).toBeLessThanOrEqual(2 * limits.sourceReadCapBytes);
    for (const item of r.items) expect(item.parse).toMatchObject({ ok: true, headings: ['Heading'] });
  });

  it('the map is bounded by entries too', async () => {
    const limits = limitsWith({ planRows: 8 }); // docBudget: planRows / 4 = 2 entries
    for (const name of ['a.md', 'b.md', 'c.md', 'd.md', 'e.md']) await write(join(home, '.claude', 'rules', name), `# ${name}\n`);
    const r = await run({ sources: only(['claude.rules.user']), limits });
    expect(r.items).toHaveLength(5);
    expect(r.docs.size).toBe(2);
  });
});

/**
 * Not in the review — found by the lead while wiring the atlas destinations. Items are keyed by
 * realpath, so `display` is measured against the canonicalised workspace (`wsReal`); `home`
 * never got the same treatment, so a `$HOME` reached through a symlink (`/var/…` against a
 * `/private/var/…` realpath, which is every macOS `mkdtemp`) stopped folding to `~/…`. That is
 * not cosmetic: `ApplyOptions.sourcePath` inverts `display` to re-read the source (§4.7.2), so
 * every home-scoped row would fail its re-read, and an absolute home path would be baked into
 * `MemoryProvenance.path` and `sources.jsonl`.
 */
describe('§4.2.5 — display folds to ~/… even when home is reached through a symlink', () => {
  it('an item, its root display and the transcript cwd notice all use the canonical home', async () => {
    const linked = join(tmp, 'homelink');
    await symlink(home, linked);
    await write(join(home, '.claude', 'CLAUDE.md'), '# user instructions\n');
    await write(join(home, '.claude', 'projects', 'slug', 'a.jsonl'), JSON.stringify({ type: 'summary', sessionId: 's1', cwd: join(home, 'work'), gitBranch: 'main' }));
    const r = await discover({
      env: envOf({ home: linked, workspace: join(linked, 'ws'), gitRoot: null }),
      fs: nodeImportFs(),
      clock,
      sources: only(['claude.user-instructions', 'claude.transcripts']),
      optIn: ['claude-transcripts'],
    });
    expect(byDisplay(r.items, 'CLAUDE.md')?.display).toBe('~/.claude/CLAUDE.md');
    expect(r.roots.find((root) => root.tool === 'claude-code')?.display).toBe('~/.claude');
    const notice = r.items.find((i) => i.artefact === 'claude.transcripts')?.notices[0] ?? '';
    expect(notice).toContain('cwd ~/work');
  });
});

describe('the production seams', () => {
  it('systemClock is monotonic and dated', () => {
    const c = systemClock();
    const a = c.monotonicMs();
    expect(c.monotonicMs()).toBeGreaterThanOrEqual(a);
    expect(c.now() instanceof Date).toBe(true);
  });

  it('nodeImportFs readPrefix never reads past the requested bytes', async () => {
    await write(join(home, 'big.txt'), 'abcdefghij');
    const buf = await nodeImportFs().readPrefix(join(home, 'big.txt'), 4);
    expect(buf.toString('utf8')).toBe('abcd');
    expect((await nodeImportFs().readPrefix(join(home, 'big.txt'), 100)).length).toBe(10);
  });
});

// ---------------------------------------------------------------------------------------
// a fake ImportFs: absolute path → node. Case folding, symlinks, FIFOs and a size that lies.
// ---------------------------------------------------------------------------------------

type FakeNode =
  | { type: 'dir' }
  | { type: 'file'; content?: string; size?: number }
  | { type: 'fifo' }
  | { type: 'link'; target: string };

function fakeFs(spec: Readonly<Record<string, FakeNode>>, opts: { caseInsensitive?: boolean; reads?: string[] } = {}): ImportFs {
  const ci = opts.caseInsensitive === true;
  const fold = (p: string): string => (ci ? p.toLowerCase() : p);
  const nodes = new Map<string, { name: string; path: string; node: FakeNode; ino: number }>();
  let next = 1;
  for (const [path, node] of Object.entries(spec)) {
    const key = fold(path);
    if (nodes.has(key)) continue;
    nodes.set(key, { name: basename(path), path, node, ino: next++ });
  }
  const get = (p: string): { name: string; path: string; node: FakeNode; ino: number } | undefined => nodes.get(fold(p));
  const resolve = (p: string, depth = 0): string => {
    if (depth > 8) return p;
    const e = get(p);
    if (e !== undefined && e.node.type === 'link') return resolve(e.node.target, depth + 1);
    const parent = dirname(p);
    if (parent !== p) {
      const rp = resolve(parent, depth + 1);
      if (rp !== parent) return resolve(join(rp, basename(p)), depth + 1);
    }
    return e?.path ?? p;
  };
  const statOf = (p: string, follow: boolean): { entry: { name: string; path: string; node: FakeNode; ino: number }; node: FakeNode } => {
    const target = follow ? resolve(p) : p;
    const e = get(target);
    if (e === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return { entry: e, node: e.node };
  };
  const statLike = (p: string, follow: boolean) => {
    const { entry, node } = statOf(p, follow);
    const size = node.type === 'file' ? (node.size ?? Buffer.byteLength(node.content ?? '')) : 0;
    return {
      isFile: () => node.type === 'file',
      isDirectory: () => node.type === 'dir',
      isSymbolicLink: () => node.type === 'link',
      size,
      mtimeMs: 1_600_000_000_000,
      mode: 0o644,
      dev: 1,
      ino: entry.ino,
    };
  };
  const contentOf = (p: string): Buffer => {
    const { node } = statOf(p, true);
    if (node.type !== 'file') throw Object.assign(new Error(`EISDIR: ${p}`), { code: 'EISDIR' });
    return Buffer.from(node.content ?? '', 'utf8');
  };
  return {
    readdir: async (p: string) => {
      const target = resolve(p);
      const out = [...nodes.values()].filter((e) => dirname(e.path) === target && e.path !== target);
      if (out.length === 0 && get(target) === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return out.map((e) => ({
        name: e.name,
        isFile: () => e.node.type === 'file',
        isDirectory: () => e.node.type === 'dir',
        isSymbolicLink: () => e.node.type === 'link',
      }));
    },
    stat: async (p: string) => statLike(p, true),
    lstat: async (p: string) => statLike(p, false),
    realpath: async (p: string) => resolve(p),
    readFile: async (p: string) => {
      opts.reads?.push(p);
      return contentOf(p);
    },
    readPrefix: async (p: string, bytes: number) => {
      opts.reads?.push(p);
      return contentOf(p).subarray(0, bytes);
    },
  };
}
