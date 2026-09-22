/** import/parse/markdown.ts resolveImports (IMPORT-DESIGN §4.3; §6 rows 32–36): @path resolution. */
import { describe, expect, it } from 'vitest';
import { isMentionDeniedBasename } from '../../../../src/sandbox/paths.js';
import { parseMarkdown, resolveImports } from '../../../../src/import/parse/markdown.js';

const ROOT = '/repo';

function depsOf(files: Readonly<Record<string, string>>) {
  const reads: string[] = [];
  return {
    reads,
    deps: {
      readFile: async (p: string): Promise<string | null> => {
        reads.push(p);
        return Object.prototype.hasOwnProperty.call(files, p) ? files[p]! : null;
      },
      isDenied: (name: string): boolean => isMentionDeniedBasename(name),
    },
  };
}

describe('resolveImports — §6 row 32', () => {
  it('inlines a one-line CLAUDE.md whose whole body is `@AGENTS.md`', async () => {
    const { deps } = depsOf({ '/repo/AGENTS.md': '# Conventions\n\nUse pnpm.\n' });
    const r = await resolveImports('@AGENTS.md\n', { file: '/repo/CLAUDE.md', root: ROOT, deps });
    expect(r.resolved).toBe(1);
    expect(r.unresolved).toEqual([]);
    expect(r.text).toBe('# Conventions\n\nUse pnpm.\n\n');
    // and the inlined body hashes exactly like the AGENTS.md row, so the deduper folds them
    expect(parseMarkdown(r.text.trimEnd()).normalisedSha256).toBe(parseMarkdown('# Conventions\n\nUse pnpm.').normalisedSha256);
  });

  it('resolves relative to the CONTAINING file, not the root', async () => {
    const { deps, reads } = depsOf({ '/repo/pkg/a/notes.md': 'inner' });
    const r = await resolveImports('see @notes.md', { file: '/repo/pkg/a/CLAUDE.md', root: ROOT, deps });
    expect(reads).toEqual(['/repo/pkg/a/notes.md']);
    expect(r.text).toBe('see inner');
  });
});

describe('resolveImports — §6 row 33, refusals', () => {
  it.each([
    ['@~/.ssh/id_rsa', 'outside <root>'],
    ['@../../.env', 'outside <root>'],
    ['@/etc/shadow', 'outside <root>'],
  ])('%s is refused with %s and left as a comment', async (ref, reason) => {
    const { deps, reads } = depsOf({});
    const r = await resolveImports(`x ${ref} y`, { file: '/repo/CLAUDE.md', root: ROOT, deps });
    expect(reads).toEqual([]);
    expect(r.resolved).toBe(0);
    expect(r.unresolved).toEqual([`${ref} (${reason})`]);
    expect(r.text).toBe(`x <!-- jevcode: unresolved ${ref} (${reason}) --> y`);
  });

  it('isSecretBasename refuses independently of the root check', async () => {
    const { deps, reads } = depsOf({ '/repo/.env': 'KEY=abc' });
    const r = await resolveImports('@.env', { file: '/repo/CLAUDE.md', root: ROOT, deps });
    expect(reads).toEqual([]);
    expect(r.unresolved).toEqual(['@.env (refused: secret path)']);
    expect(r.text).not.toContain('KEY=abc');
  });

  it('a missing file is preserved verbatim as a comment, never silently dropped', async () => {
    const { deps } = depsOf({});
    const r = await resolveImports('@gone.md', { file: '/repo/CLAUDE.md', root: ROOT, deps });
    expect(r.text).toBe('<!-- jevcode: unresolved @gone.md (not found) -->');
  });
});

describe('resolveImports — §6 rows 34–36, cycles, depth and fences', () => {
  it('row 34: a cycle a → b → a stops, and both bodies are present once', async () => {
    const { deps } = depsOf({ '/repo/b.md': 'B says @a.md' });
    const r = await resolveImports('A says @b.md', { file: '/repo/a.md', root: ROOT, deps });
    expect(r.text).toBe('A says B says <!-- jevcode: unresolved @a.md (cycle at b.md) -->');
    expect(r.unresolved).toEqual(['@a.md (cycle at b.md)']);
  });

  it('row 36: a depth-5 chain stops at 4 hops and names the file it stopped at', async () => {
    const { deps } = depsOf({
      '/repo/b.md': '@c.md',
      '/repo/c.md': '@d.md',
      '/repo/d.md': '@e.md',
      '/repo/e.md': '@f.md',
      '/repo/f.md': 'never reached',
    });
    const r = await resolveImports('@b.md', { file: '/repo/a.md', root: ROOT, deps });
    expect(r.resolved).toBe(4);
    expect(r.unresolved).toEqual(['@f.md (depth 4 reached at e.md)']);
    expect(r.text).not.toContain('never reached');
  });

  it('row 35: a reference inside a fence or an inline code span is not an import', async () => {
    const { deps, reads } = depsOf({ '/repo/x.md': 'inlined' });
    const src = 'real @x.md\n\n```\n@x.md\n```\n\nspan `@x.md` end\n';
    const r = await resolveImports(src, { file: '/repo/CLAUDE.md', root: ROOT, deps });
    expect(reads).toEqual(['/repo/x.md']);
    expect(r.resolved).toBe(1);
    expect(r.text).toContain('```\n@x.md\n```');
    expect(r.text).toContain('`@x.md`');
  });

  it('a custom depth is honoured and an email address is not a reference', async () => {
    const { deps } = depsOf({ '/repo/b.md': '@c.md', '/repo/c.md': 'deep' });
    const r = await resolveImports('write to me@example.com or @b.md', { file: '/repo/a.md', root: ROOT, depth: 1, deps });
    expect(r.text).toBe('write to me@example.com or <!-- jevcode: unresolved @c.md (depth 1 reached at b.md) -->');
  });

  it('a readFile that throws is an unresolved comment, never an exception', async () => {
    const deps = {
      readFile: async (): Promise<string | null> => {
        throw new Error('EACCES');
      },
      isDenied: (): boolean => false,
    };
    const r = await resolveImports('@x.md', { file: '/repo/a.md', root: ROOT, deps });
    expect(r.text).toContain('unresolved @x.md (not found)');
  });
});
