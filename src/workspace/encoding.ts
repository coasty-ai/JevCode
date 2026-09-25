/**
 * What text encoding a file's bytes are in, as far as the file tools care: the harness reads and writes UTF-8, so a
 * file in any other encoding must be refused by an edit rather than silently re-encoded. A one-line edit of a Latin-1
 * file used to decode it as UTF-8 (each accented byte became U+FFFD) and write it back, turning every accented byte
 * elsewhere in the file into `EF BF BD`.
 *
 *  - `utf16`    — a UTF-16 byte-order mark (`FF FE` or `FE FF`); read as UTF-8 it looks binary (every other byte is NUL)
 *  - `binary`   — a NUL byte anywhere in the bytes looked at
 *  - `not-utf8` — bytes that are not valid UTF-8 (Latin-1, Windows-1252, Shift-JIS, …)
 *  - `utf8`     — everything else, including ASCII and a UTF-8 byte-order mark
 */
import { open } from 'node:fs/promises';

export type TextEncoding = 'utf8' | 'utf16' | 'binary' | 'not-utf8';

/**
 * Classify `buf`. `partial` says the bytes are only the head of a longer file, so a multi-byte sequence cut at the end
 * is not evidence of anything (the decoder holds it back in streaming mode instead of rejecting it).
 */
export function textEncodingOf(buf: Uint8Array, partial = false): TextEncoding {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return 'utf16';
  if (buf.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf, { stream: partial });
    return 'utf8';
  } catch {
    return 'not-utf8';
  }
}

/** The encoding of the first `maxBytes` of the file at `absPath`; null when it cannot be read (missing, a directory, no access). */
export async function fileTextEncoding(absPath: string, maxBytes: number): Promise<TextEncoding | null> {
  let fh;
  try {
    fh = await open(absPath, 'r');
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const want = Math.max(0, Math.min(st.size, maxBytes));
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return textEncodingOf(buf.subarray(0, off), st.size > off);
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** The refusal of an edit or an overwrite of a file whose bytes are not UTF-8 (without the `ERROR:` / `EditError:` prefix). */
export function notUtf8Refusal(path: string): string {
  return `${path} is not UTF-8 text (probably Latin-1/Windows-1252); editing it would corrupt it — use a byte-safe command (e.g. iconv to convert it first)`;
}

/** The refusal of an edit or an overwrite of a UTF-16 file (without the prefix). */
export function utf16Refusal(path: string): string {
  return `${path} is UTF-16 text; editing it as UTF-8 would corrupt it — use a byte-safe command (e.g. iconv -f UTF-16 -t UTF-8 to convert it first)`;
}
