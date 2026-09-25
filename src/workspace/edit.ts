/**
 * Exact-match, unique-occurrence replacement (DESIGN.md §8; research 09 §1: every
 * production Claude harness converged on this rule). The write is atomic and preserves the
 * file mode so executable scripts stay executable.
 *
 * Only a UTF-8 file is edited: the file is read as bytes and a Latin-1, UTF-16 or binary file is refused before
 * anything is written (encoding.ts), because decoding it as UTF-8 and writing it back would replace every byte that is
 * not valid UTF-8 — every accented letter of a Latin-1 file, not only the edited one — with U+FFFD. The rule lives
 * here so it protects every mode; the agent loop also refuses such a file before it proposes the edit (calls.ts).
 */
import { readFile, stat } from 'node:fs/promises';

import { writeFileAtomic } from '../core/atomic.js';
import { EditError, JevCodeError } from '../errors.js';
import { notUtf8Refusal, textEncodingOf, utf16Refusal } from './encoding.js';

/** Non-overlapping occurrence count; `needle` must be non-empty. */
export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = haystack.indexOf(needle, i);
    if (j === -1) return n;
    n++;
    i = j + needle.length;
  }
}

/** Pure form: the new content when `old` occurs exactly once, else EditError. */
export function applyEditToContent(content: string, edit: { path: string; old: string; new: string }): string {
  if (typeof edit.old !== 'string' || typeof edit.new !== 'string') throw new JevCodeError('edit', `EditError: old/new must be strings for ${edit.path}`, { exitCode: 6 });
  if (edit.old.length === 0) throw new JevCodeError('edit', `EditError: old text is empty for ${edit.path}`, { exitCode: 6 });
  const matches = countOccurrences(content, edit.old);
  if (matches !== 1) throw new EditError(edit.path, matches);
  const at = content.indexOf(edit.old);
  return content.slice(0, at) + edit.new + content.slice(at + edit.old.length);
}

/** Read, replace, write atomically. `absPath` has already passed resolveInside. A file that is not UTF-8 text is refused untouched. */
export async function applyEditFile(absPath: string, edit: { path: string; old: string; new: string }): Promise<void> {
  let bytes: Buffer;
  let mode: number;
  try {
    const st = await stat(absPath);
    if (!st.isFile()) throw new JevCodeError('edit', `EditError: ${edit.path} is not a regular file`, { exitCode: 6 });
    mode = st.mode & 0o777;
    bytes = await readFile(absPath);
  } catch (e) {
    if (e instanceof JevCodeError) throw e;
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code?: unknown }).code) : 'error';
    throw new JevCodeError('edit', `EditError: cannot read ${edit.path} (${code})`, { exitCode: 6, cause: e });
  }
  const encoding = textEncodingOf(bytes);
  if (encoding === 'not-utf8') throw new JevCodeError('edit', `EditError: ${notUtf8Refusal(edit.path)}`, { exitCode: 6 });
  if (encoding === 'utf16') throw new JevCodeError('edit', `EditError: ${utf16Refusal(edit.path)}`, { exitCode: 6 });
  if (encoding === 'binary') throw new JevCodeError('edit', `EditError: ${edit.path} is binary; an exact-text edit cannot change it safely`, { exitCode: 6 });
  const next = applyEditToContent(bytes.toString('utf8'), edit);
  await writeFileAtomic(absPath, next, { mode });
}
