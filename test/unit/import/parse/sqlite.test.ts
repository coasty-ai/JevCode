/** import/parse/sqlite.ts (IMPORT-DESIGN §4.3; §6 row 27): the guarded stub — always skip:unsupported. */
import { describe, expect, it } from 'vitest';
import { isSqliteFile, parseSqlite } from '../../../../src/import/parse/sqlite.js';

describe('parseSqlite — §6 row 27', () => {
  it.each(['/Users/x/.codex/state_5.sqlite', '/Users/x/.codex/thread_history_1.sqlite', '/Users/x/.local/share/opencode/opencode.db', '/Users/x/Library/Application Support/Cursor/User/globalStorage/state.vscdb'])(
    'never reads %s: one skip:unsupported, never a crash',
    (path) => {
      const r = parseSqlite(path);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.startsWith('skip:unsupported: ')).toBe(true);
      expect(r.error).toContain('sqlite (no reader)');
      expect(r.warnings).toEqual([]);
    },
  );

  it('names the basename, never the directory (no absolute home path in an artefact)', () => {
    const r = parseSqlite('/Users/someone/.codex/memories_1.sqlite');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('memories_1.sqlite');
    expect(r.error).not.toContain('/Users/someone');
  });
});

describe('isSqliteFile', () => {
  it('recognises the magic, whatever the extension', () => {
    const head = Buffer.concat([Buffer.from('SQLite format 3\u0000', 'binary'), Buffer.alloc(16)]);
    expect(isSqliteFile(head)).toBe(true);
    expect(isSqliteFile(Buffer.from('# just markdown\n'))).toBe(false);
    expect(isSqliteFile(Buffer.alloc(0))).toBe(false);
    expect(isSqliteFile(Buffer.from('SQLite'))).toBe(false);
  });
});
