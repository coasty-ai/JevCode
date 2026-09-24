/**
 * TUI-DESIGN-4 §5.5 P-C15 (D-Y) — the conversation store. §10's S5 row: round-trip, caps, rewrite, an unreadable
 * file; plus §5.5's edges (a) write failures never throw, (c) a huge file is tail-read, (e) the store is opened
 * **lazily** so the first frame never pays for it, (f) text is redacted on the way to disk, (g) a conversation
 * recorded in another workspace degrades loudly, (i) `/new` mints a new id and therefore a new file.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatTurn } from '../../../src/chat/ledger.js';
import {
  CHAT_FILE_NAME,
  CHAT_REDACT_ERROR,
  CHAT_REPLAY_TURNS,
  CONVERSATION_NOT_RESTORED,
  chatReplay,
  chatStorePath,
  clipEntryBytes,
  conversationText,
  createChatStore,
  parseChatLine,
  resumedConversationHeading,
  type ChatStoreOptions,
} from '../../../src/chat/store.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'jc-chat-'));
  dirs.push(d);
  return d;
}

const WS = '/w/proj';
function store(path: string, over: Partial<ChatStoreOptions> = {}) {
  let n = 0;
  return createChatStore({ path, workspace: WS, redact: (s) => s, writes: true, now: () => `2026-09-22T00:00:${String(n++).padStart(2, '0')}.000Z`, ...over });
}
const you = (text: string, at = ''): ChatTurn => ({ role: 'you', text, at });
const bot = (text: string, at = ''): ChatTurn => ({ role: 'jevcode', text, at });

describe('createChatStore: a conversation that survives a restart (§5.5 P-C15)', () => {
  it('round-trips through a second process: turns, order, the optional fields and the file shape', () => {
    const p = join(tmp(), 's1', CHAT_FILE_NAME);
    const a = store(p);
    a.append(you('hello there'));
    a.append({ role: 'jevcode', text: 'Hi.', at: '', kind: 'greeting_or_smalltalk', probability: 0.12, costUsd: 0.0004 });
    const raw = readFileSync(p, 'utf8').trimEnd().split('\n');
    expect(raw).toHaveLength(2);
    expect(parseChatLine(raw[0]!)).toEqual({ t: '2026-09-22T00:00:00.000Z', role: 'you', text: 'hello there', workspace: WS });
    // a fresh store over the same file is the restart
    const b = store(p);
    expect(b.loaded).toBe(false); // edge (e): nothing is parsed until something asks
    expect(b.turns).toEqual([
      { role: 'you', text: 'hello there', at: '2026-09-22T00:00:00.000Z' },
      { role: 'jevcode', text: 'Hi.', at: '2026-09-22T00:00:01.000Z', kind: 'greeting_or_smalltalk', probability: 0.12, costUsd: 0.0004 },
    ]);
    expect(b.loaded).toBe(true);
    expect(b.workspaceMoved).toBe(false);
    b.append(you('again'));
    expect(store(p).turns.map((t) => t.text)).toEqual(['hello there', 'Hi.', 'again']);
  });

  it('a missing file, a missing directory and a torn line are all tolerated', () => {
    const d = tmp();
    const p = join(d, 'never', CHAT_FILE_NAME);
    const s = store(p);
    expect(s.turns).toEqual([]);
    s.append(you('first'));
    expect(existsSync(p)).toBe(true);
    // a torn / wrong-shaped line is skipped, the good ones survive (the `steps.jsonl` rule)
    writeFileSync(p, `{"t":"a","role":"you","text":"kept","workspace":"${WS}"}\n{"t":"b","rol\n{"t":"c","role":"nobody","text":"x"}\nnot json\n`);
    expect(store(p).turns.map((t) => t.text)).toEqual(['kept']);
    expect(parseChatLine('')).toBeNull();
    expect(parseChatLine('[]')).toBeNull();
    expect(parseChatLine('{"t":1,"role":"you","text":"x"}')).toBeNull();
  });

  it('caps: ≤ maxTurns in memory, ≤ maxEntryBytes per line (on a code-point boundary), and a tail-read of a huge file', () => {
    const p = join(tmp(), 's', CHAT_FILE_NAME);
    const s = store(p, { maxTurns: 3, rewriteSlack: 100 });
    for (let i = 0; i < 6; i++) s.append(you(`m${i}`));
    expect(s.turns.map((t) => t.text)).toEqual(['m3', 'm4', 'm5']);
    // the per-line cap is measured in UTF-8 BYTES and never splits a code point
    expect(clipEntryBytes('abc', 10)).toBe('abc');
    const clipped = clipEntryBytes('é'.repeat(100), 20);
    expect(Buffer.byteLength(clipped, 'utf8')).toBeLessThanOrEqual(20);
    expect(clipped.endsWith('…')).toBe(true);
    expect([...clipped].every((c) => c === 'é' || c === '…')).toBe(true);
    const big = store(join(tmp(), 'b', CHAT_FILE_NAME), { maxEntryBytes: 16 });
    big.append(you('x'.repeat(500)));
    expect(Buffer.byteLength(big.turns[0]!.text, 'utf8')).toBeLessThanOrEqual(16);
    // edge (c): a file far past the read cap is tail-read, so only the tail is parsed and the first (torn) line is dropped
    const huge = join(tmp(), CHAT_FILE_NAME);
    const line = (i: number): string => JSON.stringify({ t: 't', role: 'you', text: `line-${i}`.padEnd(200, 'z'), workspace: WS });
    writeFileSync(huge, `${Array.from({ length: 400 }, (_, i) => line(i)).join('\n')}\n`);
    const tailed = store(huge, { maxReadBytes: 4096, maxTurns: 100 });
    expect(tailed.turns.length).toBeGreaterThan(0);
    expect(tailed.turns.length).toBeLessThan(400);
    expect(tailed.turns.at(-1)!.text.startsWith('line-399')).toBe(true);
  });

  it('the rewrite: once the file is `maxTurns + slack` lines the next append rewrites it atomically', () => {
    const p = join(tmp(), 's', CHAT_FILE_NAME);
    const s = store(p, { maxTurns: 4, rewriteSlack: 2 });
    for (let i = 0; i < 6; i++) s.append(you(`m${i}`));
    expect(readFileSync(p, 'utf8').trimEnd().split('\n')).toHaveLength(6);
    s.append(you('m6')); // 7 > 4 + 2 → one atomic rewrite down to the in-memory window
    const after = readFileSync(p, 'utf8').trimEnd().split('\n');
    expect(after).toHaveLength(4);
    expect(after.map((l) => parseChatLine(l)!.text)).toEqual(['m3', 'm4', 'm5', 'm6']);
    expect(store(p, { maxTurns: 4 }).turns.map((t) => t.text)).toEqual(['m3', 'm4', 'm5', 'm6']);
  });

  it('edge (a): an unwritable file reports through onWriteError and never throws; reads still work', () => {
    const d = tmp();
    const p = join(d, CHAT_FILE_NAME);
    writeFileSync(p, `{"t":"a","role":"you","text":"kept","workspace":"${WS}"}\n`);
    chmodSync(p, 0o400);
    const errors: { file: string; code: string }[] = [];
    const s = store(p, { onWriteError: (e) => errors.push(e) });
    expect(s.turns.map((t) => t.text)).toEqual(['kept']);
    expect(() => s.append(you('new'))).not.toThrow();
    // the turn is still in memory for this process; only the write failed, and it said so
    expect(s.turns.map((t) => t.text)).toEqual(['kept', 'new']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.file).toBe(CHAT_FILE_NAME);
    chmodSync(p, 0o600);
    // `--no-history` / JEVCODE_NO_HISTORY: writes off, reads on, and no error is reported
    const ro = store(p, { writes: false, onWriteError: () => expect.unreachable('no write was attempted') });
    expect(ro.writesEnabled).toBe(false);
    ro.append(you('not persisted'));
    expect(readFileSync(p, 'utf8')).not.toContain('not persisted');
  });

  it('edge (f): every stored text goes through the redactor, and a throwing redactor drops the turn unwritten', () => {
    const p = join(tmp(), 's', CHAT_FILE_NAME);
    const s = store(p, { redact: (x) => x.replace(/sk-[a-z0-9]+/g, '[REDACTED:key]') });
    s.append(you('the key is sk-abc123'));
    expect(readFileSync(p, 'utf8')).toContain('[REDACTED:key]');
    expect(readFileSync(p, 'utf8')).not.toContain('sk-abc123');
    const errors: { file: string; code: string }[] = [];
    const boom = store(join(tmp(), 'x', CHAT_FILE_NAME), {
      redact: () => {
        throw new Error('nope');
      },
      onWriteError: (e) => errors.push(e),
    });
    boom.append(you('secret'));
    expect(boom.turns).toEqual([]);
    expect(errors).toEqual([{ file: CHAT_FILE_NAME, code: CHAT_REDACT_ERROR }]);
  });

  it('edge (g): a conversation recorded in another workspace is flagged, not silently replayed', () => {
    const p = join(tmp(), CHAT_FILE_NAME);
    writeFileSync(p, `{"t":"a","role":"you","text":"elsewhere","workspace":"/other/place"}\n`);
    const s = store(p);
    expect(s.workspaceMoved).toBe(true);
    expect(CONVERSATION_NOT_RESTORED).toContain('not restored');
  });

  it('edge (e): construction reads NOTHING — the tail read happens on the first `turns` / `workspaceMoved` / `append`', () => {
    const dir = tmp();
    mkdirSync(join(dir, 's-lazy'), { recursive: true });
    const p = join(dir, 's-lazy', CHAT_FILE_NAME);

    // constructed against a file that does not exist yet …
    const s1 = store(p);
    expect(s1.loaded).toBe(false);
    // `writesEnabled` is a pure property and must not trigger the read either (§11: the first frame pays nothing)
    expect(s1.writesEnabled).toBe(true);
    expect(s1.loaded).toBe(false);

    // … the file appears AFTER construction; a constructor-time read could not possibly see it
    writeFileSync(p, `${JSON.stringify({ t: '2026-09-22T00:00:00.000Z', role: 'you', text: 'written after construction', workspace: WS })}\n`);
    expect(s1.turns.map((t) => t.text)).toEqual(['written after construction']);
    expect(s1.loaded).toBe(true);

    // the read happens ONCE: a second write is not picked up by an already-loaded store
    writeFileSync(p, `${JSON.stringify({ t: '2026-09-22T00:00:01.000Z', role: 'you', text: 'later still', workspace: WS })}\n`, { flag: 'a' });
    expect(s1.turns).toHaveLength(1);

    // `workspaceMoved` is also a loading accessor
    const s2 = store(p);
    expect(s2.loaded).toBe(false);
    expect(s2.workspaceMoved).toBe(false);
    expect(s2.loaded).toBe(true);

    // `append` on a never-read store loads first, so the earlier turns are not lost
    const s3 = store(p);
    expect(s3.loaded).toBe(false);
    s3.append(you('and now'));
    expect(s3.loaded).toBe(true);
    expect(s3.turns.map((t) => t.text)).toEqual(['written after construction', 'later still', 'and now']);
  });

  it('an append whose `ChatTurn.at` is empty still writes a `t` a reload can parse', () => {
    const p = join(tmp(), 's-at', CHAT_FILE_NAME);
    const a = store(p);
    a.append(you('no timestamp'));
    a.append(bot('nor here'));
    const raw = readFileSync(p, 'utf8').trim().split('\n');
    for (const line of raw) {
      const parsed = parseChatLine(line)!;
      expect(parsed).not.toBeNull();
      expect(parsed.t).not.toBe('');
      expect(Number.isNaN(Date.parse(parsed.t))).toBe(false);
    }
    // the injected clock supplies it, and the reload round-trips both turns with their stamps
    expect(store(p).turns.map((t) => [t.role, t.text, t.at])).toEqual([
      ['you', 'no timestamp', '2026-09-22T00:00:00.000Z'],
      ['jevcode', 'nor here', '2026-09-22T00:00:01.000Z'],
    ]);
    // an explicit `at` is kept verbatim
    const b = store(join(tmp(), 's-at2', CHAT_FILE_NAME));
    b.append(you('stamped', '2020-01-01T00:00:00.000Z'));
    expect(b.turns[0]!.at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('edge (i): `/new` mints a new session id, and `chatStorePath` therefore names a new file', () => {
    expect(chatStorePath('/home/me/.jevcode/sessions', '20260922-1')).toBe('/home/me/.jevcode/sessions/20260922-1/chat.jsonl');
    expect(chatStorePath('/s', 'a')).not.toBe(chatStorePath('/s', 'b'));
  });
});

describe('replay and /copy conversation (§5.5 P-C13, P-C15 c)', () => {
  it('replays the last N = 20 turns under one heading that states BOTH numbers (§14.1 row 10)', () => {
    expect(CHAT_REPLAY_TURNS).toBe(20);
    const turns = Array.from({ length: 31 }, (_, i) => you(`m${i}`));
    const r = chatReplay(turns);
    expect(r.turns).toHaveLength(20);
    expect(r.turns[0]!.text).toBe('m11');
    expect(r.heading).toBe('resumed conversation — 20 of 31 earlier turns');
    // fewer turns than the window: both numbers are the same and the heading still tells the truth
    expect(chatReplay(turns.slice(0, 3)).heading).toBe('resumed conversation — 3 of 3 earlier turns');
    expect(chatReplay([]).turns).toEqual([]);
    expect(resumedConversationHeading(-1, -1)).toBe('resumed conversation — 0 of 0 earlier turns');
  });

  it('`/copy conversation` is `you: …` / `jevcode: …` blocks with one blank row between turns', () => {
    expect(conversationText([you('hi'), bot('hello\nthere')])).toBe('you: hi\n\njevcode: hello\nthere');
    expect(conversationText([])).toBe('');
  });
});
