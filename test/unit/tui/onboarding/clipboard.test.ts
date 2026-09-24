/** tui/secrets/clipboard.ts (TUI-DESIGN §10.5; §19.0 row O7): native tool order, 2 s timeout, OSC 52 wrapper (tmux DCS), 64 KiB cap, never OSC 52 read. */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRedactor } from '../../../../src/core/redact.js';
import {
  CLIPBOARD_MAX_BYTES,
  CLIPBOARD_TOOLS,
  CLIPBOARD_TOOL_TIMEOUT_MS,
  COPY_FAILED_TOAST,
  clipboardPayload,
  copiedToast,
  copyRedacted,
  osc52Sequence,
  pipeToTool,
  type ChildLike,
  type SpawnLike,
} from '../../../../src/tui/secrets/clipboard.js';

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';

interface FakeSpec {
  /** 'missing' → spawn error ENOENT; 'hang' → never exits; number → exit code */
  behaviour: 'missing' | 'hang' | number;
}

function fakeSpawn(spec: Record<string, FakeSpec>, calls: { cmd: string; args: readonly string[]; stdin: string }[]): SpawnLike {
  return (cmd, args) => {
    const rec = { cmd, args, stdin: '' };
    calls.push(rec);
    const em = new EventEmitter();
    const stdinEm = new EventEmitter();
    const child: ChildLike = {
      stdin: {
        write: (chunk: string) => {
          rec.stdin += chunk;
          return true;
        },
        end: () => undefined,
        on: (event, fn) => stdinEm.on(event, fn),
      },
      on: (event, fn) => em.on(event, fn),
      kill: () => em.emit('exit', null),
    };
    const b = spec[cmd]?.behaviour ?? 'missing';
    queueMicrotask(() => {
      if (b === 'missing') em.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
      else if (typeof b === 'number') em.emit('exit', b);
    });
    return child;
  };
}

afterEach(() => vi.useRealTimers());

describe('clipboardPayload (pure)', () => {
  it('sanitises, redacts and caps at 64 KiB on a UTF-8 boundary; counts the markers redaction added', () => {
    const r = createRedactor([{ name: 'X', value: 'exact-secret-value-1' }]);
    const p = clipboardPayload(`a\u001b[2Jb ${KEY} exact-secret-value-1 [REDACTED:already]`, r.redact);
    expect(p.payload).toBe('a[2Jb [REDACTED:pattern] [REDACTED:X] [REDACTED:already]');
    expect(p.masked).toBe(2);
    expect(p.truncated).toBe(false);
    const big = clipboardPayload('日'.repeat(40_000), (s) => s);
    expect(Buffer.byteLength(big.payload, 'utf8')).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    expect(big.payload.endsWith('日')).toBe(true);
    expect(big.truncated).toBe(true);
    expect(clipboardPayload('', (s) => s)).toEqual({ payload: '', masked: 0, truncated: false });
  });

  it('a [REDACTED:…] marker straddling the 64 KiB cut is dropped whole: the payload never ends in a half marker', () => {
    const r = createRedactor([{ name: 'composer#1', value: 'exact-secret-value-1' }]);
    // place the secret so that its marker (21 chars) straddles the cap
    const head = 'a'.repeat(CLIPBOARD_MAX_BYTES - 10);
    const p = clipboardPayload(`${head}exact-secret-value-1 tail`, r.redact);
    expect(p.truncated).toBe(true);
    expect(p.payload).toBe(head);
    expect(p.payload).not.toContain('[REDACTED:');
    expect(p.masked).toBe(1);
    expect(Buffer.byteLength(p.payload, 'utf8')).toBeLessThanOrEqual(CLIPBOARD_MAX_BYTES);
    // a marker that fits entirely is kept
    const fits = clipboardPayload(`${'a'.repeat(CLIPBOARD_MAX_BYTES - 40)}exact-secret-value-1 ${'b'.repeat(100)}`, r.redact);
    expect(fits.payload.endsWith('[REDACTED:composer#1]') || fits.payload.includes('[REDACTED:composer#1] ')).toBe(true);
    expect(fits.payload).not.toMatch(/\[REDACTED:[^\]]*$/);
  });

  it('a payload containing the OSC 52 read request `ESC ] 52 ; c ; ?` is sanitised and base64-encoded — never a raw read sequence', async () => {
    const writes: string[] = [];
    const raw = 'before \x1b]52;c;? after ;? and ]52;c;?';
    const res = await copyRedacted(raw, (s) => s, { spawn: fakeSpawn({}, []), write: (s) => writes.push(s), osc52: true, env: {} });
    expect(res.method).toBe('osc52');
    expect(writes).toHaveLength(1);
    const seq = writes[0]!;
    expect(seq.startsWith('\x1b]52;c;')).toBe(true);
    expect(seq.endsWith('\x07')).toBe(true);
    const b64 = seq.slice('\x1b]52;c;'.length, -1);
    expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(seq).not.toContain(';?');
    expect(seq.split('\x1b').length - 1).toBe(1);
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).not.toContain('\x1b');
    expect(decoded).toBe(clipboardPayload(raw, (s) => s).payload);
  });

  it('osc52Sequence writes `ESC ] 52 ; c ; base64 BEL`, doubled-ESC inside the tmux DCS wrapper, and never a `?` read', () => {
    const plain = osc52Sequence('hello', false);
    expect(plain).toBe(`\x1b]52;c;${Buffer.from('hello').toString('base64')}\x07`);
    const tmux = osc52Sequence('hello', true);
    expect(tmux.startsWith('\x1bPtmux;\x1b\x1b]52;c;')).toBe(true);
    expect(tmux.endsWith('\x07\x1b\\')).toBe(true);
    expect(tmux.slice(7, -2).split('\x1b\x1b').length - 1).toBe(1);
    for (const s of [plain, tmux, osc52Sequence('?', false)]) expect(s).not.toContain(';?');
  });

  it('copiedToast: `copied` or `copied with N secret(s) masked`', () => {
    expect(copiedToast(0)).toBe('copied');
    expect(copiedToast(1)).toBe('copied with 1 secret masked');
    expect(copiedToast(2)).toBe('copied with 2 secrets masked');
    expect(copiedToast(-1)).toBe('copied');
  });
});

describe('copyRedacted', () => {
  it('tries the native tools in order — pbcopy, wl-copy, xclip -selection clipboard, xsel --clipboard --input — and stops at the first that exits 0', async () => {
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const spawn = fakeSpawn({ pbcopy: { behaviour: 'missing' }, 'wl-copy': { behaviour: 1 }, xclip: { behaviour: 0 } }, calls);
    const res = await copyRedacted(`draft ${KEY}`, (s) => s, { spawn, timeoutMs: 100 });
    expect(res.ok).toBe(true);
    expect(res.method).toBe('xclip');
    expect(calls.map((c) => c.cmd)).toEqual(['pbcopy', 'wl-copy', 'xclip']);
    expect(calls[2]!.args).toEqual(['-selection', 'clipboard']);
    expect(calls[2]!.stdin).toBe(`draft ${KEY}`);
    expect(CLIPBOARD_TOOLS.map((t) => `${t.cmd} ${t.args.join(' ')}`.trim())).toEqual(['pbcopy', 'wl-copy', 'xclip -selection clipboard', 'xsel --clipboard --input']);
  });

  it('the payload handed to the tool is redacted; /copy draft reports how many secrets were masked', async () => {
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const spawn = fakeSpawn({ pbcopy: { behaviour: 0 } }, calls);
    const r = createRedactor([{ name: 'composer#1', value: 'exact-secret-value-1' }]);
    const res = await copyRedacted(`send ${KEY} and exact-secret-value-1`, r.redact, { spawn });
    expect(res.ok).toBe(true);
    expect(res.masked).toBe(2);
    expect(res.toast).toBe('copied with 2 secrets masked');
    expect(calls[0]!.stdin).not.toContain(KEY);
    expect(calls[0]!.stdin).toBe('send [REDACTED:pattern] and [REDACTED:composer#1]');
    const clean = await copyRedacted('plain text', r.redact, { spawn: fakeSpawn({ pbcopy: { behaviour: 0 } }, []) });
    expect(clean.toast).toBe('copied');
  });

  it('a hanging tool is killed after the 2 s timeout and the next tool is tried', async () => {
    vi.useFakeTimers();
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const spawn = fakeSpawn({ pbcopy: { behaviour: 'hang' }, 'wl-copy': { behaviour: 0 } }, calls);
    const pending = copyRedacted('x', (s) => s, { spawn });
    await vi.advanceTimersByTimeAsync(CLIPBOARD_TOOL_TIMEOUT_MS - 1);
    expect(calls.map((c) => c.cmd)).toEqual(['pbcopy']);
    await vi.advanceTimersByTimeAsync(2);
    const res = await pending;
    expect(res.method).toBe('wl-copy');
    expect(CLIPBOARD_TOOL_TIMEOUT_MS).toBe(2000);
  });

  it('a tool that exits 0 after its timeout fired does not resolve twice, change the result or emit OSC 52', async () => {
    vi.useFakeTimers();
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const writes: string[] = [];
    let latePbcopy: ((code: number | null | Error) => void) | null = null;
    const spawn: SpawnLike = (cmd, args) => {
      const rec = { cmd, args, stdin: '' };
      calls.push(rec);
      const em = new EventEmitter();
      const child: ChildLike = {
        stdin: { write: (c: string) => (rec.stdin += c), end: () => undefined, on: () => undefined },
        on: (event, fn) => {
          em.on(event, fn);
          if (cmd === 'pbcopy' && event === 'exit') latePbcopy = fn;
        },
        kill: () => undefined,
      };
      if (cmd === 'wl-copy') queueMicrotask(() => em.emit('exit', 0));
      return child;
    };
    const pending = copyRedacted('x', (s) => s, { spawn, write: (s) => writes.push(s), osc52: true, env: {} });
    await vi.advanceTimersByTimeAsync(CLIPBOARD_TOOL_TIMEOUT_MS + 1);
    const res = await pending;
    expect(res.method).toBe('wl-copy');
    expect(calls.map((c) => c.cmd)).toEqual(['pbcopy', 'wl-copy']);
    // pbcopy wakes up late and exits 0: nothing changes
    expect(latePbcopy).not.toBeNull();
    (latePbcopy as unknown as (code: number) => void)(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(res.method).toBe('wl-copy');
    expect(writes).toEqual([]);
  });

  it('all four tools hanging: 4 × 2 s = 8 s worst case, then the failure toast (or OSC 52 when enabled)', async () => {
    vi.useFakeTimers();
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const spawn = fakeSpawn({ pbcopy: { behaviour: 'hang' }, 'wl-copy': { behaviour: 'hang' }, xclip: { behaviour: 'hang' }, xsel: { behaviour: 'hang' } }, calls);
    let settled = false;
    const pending = copyRedacted('x', (s) => s, { spawn }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(4 * CLIPBOARD_TOOL_TIMEOUT_MS - 5);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    const res = await pending;
    expect(settled).toBe(true);
    expect(res.method).toBe('none');
    expect(res.toast).toBe(COPY_FAILED_TOAST);
    expect(calls.map((c) => c.cmd)).toEqual(['pbcopy', 'wl-copy', 'xclip', 'xsel']);
    const writes: string[] = [];
    const withOsc = copyRedacted('x', (s) => s, { spawn: fakeSpawn({ pbcopy: { behaviour: 'hang' }, 'wl-copy': { behaviour: 'hang' }, xclip: { behaviour: 'hang' }, xsel: { behaviour: 'hang' } }, []), write: (s) => writes.push(s), osc52: true, env: {} });
    await vi.advanceTimersByTimeAsync(4 * CLIPBOARD_TOOL_TIMEOUT_MS + 5);
    expect((await withOsc).method).toBe('osc52');
    expect(writes).toHaveLength(1);
  });

  it('falls back to an OSC 52 write only behind --osc52, with the tmux wrapper under TMUX; never a read', async () => {
    const writes: string[] = [];
    const none = fakeSpawn({}, []);
    const off = await copyRedacted('hello', (s) => s, { spawn: none, write: (s) => writes.push(s) });
    expect(off.ok).toBe(false);
    expect(off.method).toBe('none');
    expect(off.toast).toBe(COPY_FAILED_TOAST);
    expect(writes).toEqual([]);
    const on = await copyRedacted('hello', (s) => s, { spawn: none, write: (s) => writes.push(s), osc52: true, env: {} });
    expect(on.ok).toBe(true);
    expect(on.method).toBe('osc52');
    expect(writes).toEqual([osc52Sequence('hello', false)]);
    const inTmux = await copyRedacted('hello', (s) => s, { spawn: none, write: (s) => writes.push(s), osc52: true, env: { TMUX: '/tmp/tmux-501/default,1,0' } });
    expect(inTmux.method).toBe('osc52');
    expect(writes[1]).toBe(osc52Sequence('hello', true));
    for (const w of writes) expect(w).not.toContain(';?');
    // no writer → no OSC 52 even when asked
    const noWriter = await copyRedacted('hello', (s) => s, { spawn: none, osc52: true });
    expect(noWriter.method).toBe('none');
  });

  it('restricts to the requested tools; a synchronous spawn throw counts as missing', async () => {
    const calls: { cmd: string; args: readonly string[]; stdin: string }[] = [];
    const spawn = fakeSpawn({ xsel: { behaviour: 0 } }, calls);
    const res = await copyRedacted('x', (s) => s, { spawn, tools: ['xsel'] });
    expect(res.method).toBe('xsel');
    expect(calls.map((c) => c.cmd)).toEqual(['xsel']);
    const throwing: SpawnLike = () => {
      throw new Error('EACCES');
    };
    expect(await pipeToTool(throwing, 'pbcopy', [], 'x', 50)).toBe(false);
    const broken = await copyRedacted('x', (s) => s, { spawn: throwing });
    expect(broken.method).toBe('none');
  });

  it('pipeToTool resolves false on a stdin error or a null stdin', async () => {
    const em = new EventEmitter();
    const stdinEm = new EventEmitter();
    const spawn: SpawnLike = () => ({
      stdin: { write: () => true, end: () => stdinEm.emit('error', new Error('EPIPE')), on: (e, fn) => stdinEm.on(e, fn) },
      on: (e, fn) => em.on(e, fn),
      kill: () => undefined,
    });
    expect(await pipeToTool(spawn, 'pbcopy', [], 'x', 50)).toBe(false);
    const noStdin: SpawnLike = () => ({ stdin: null, on: () => undefined, kill: () => undefined });
    expect(await pipeToTool(noStdin, 'pbcopy', [], 'x', 50)).toBe(false);
  });
});
