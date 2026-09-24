/**
 * docs/IMPORT-DESIGN.md §4.3 `sqlite.ts` — the guarded stub (§6 row 27).
 *
 * Six SQLite databases sit in `~/.codex` alone, plus `opencode.db` and Cursor's `state.vscdb`.
 * There is **no reader module**, and if one is ever added and is absent at runtime the answer must
 * be the same `skip:unsupported`, never a crash: this module therefore never imports a reader, so
 * there is nothing to fail. It is the whole implementation of "a guarded dynamic import".
 */
import type { ParseResult } from '../types.js';

/** The 16-byte header every SQLite 3 file starts with. */
const MAGIC = Buffer.from('SQLite format 3\u0000', 'binary');

/** §6 row 27: always `skip:unsupported` — the path is named, nothing is opened, nothing throws. */
export function parseSqlite(path: string): ParseResult<never> {
  const name = path.split(/[\\/]/).pop() ?? path;
  return { ok: false, error: `skip:unsupported: sqlite (no reader): ${name}`, warnings: [] };
}

/** §4.4.1 rule 5: the magic sniff, for a database that does not carry a `.sqlite` extension (`state.vscdb`, `opencode.db`). */
export function isSqliteFile(head: Buffer): boolean {
  return head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);
}
