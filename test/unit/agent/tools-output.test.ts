/**
 * The read-only `bash` tool (src/agent/tools/shell.ts) hands the model the same cleaned output the execute stage does
 * (core/ansi.ts `cleanCommandStreams`): escape sequences removed whole, CR progress redraws collapsed to their final
 * state, a binary stream replaced by a note — and only then redacted, so a key an SGR touches is still recognised.
 */
import { describe, expect, it } from 'vitest';
import { runReadonlyBash } from '../../../src/agent/tools/shell.js';
import { createAgentContext } from './helpers.js';

const REMNANT_RE = /\u001b|\u009b|\[[0-9;]+[A-Za-z]/;

describe('read-only bash: cleaned command output (core/ansi.ts)', () => {
  it('coloured output reaches the model as its plain text: no ESC, no sequence body', async () => {
    const stdout = '\u001b[1m\u001b[34mdiff --git a/x b/x\u001b[m\n\u001b[32m+added\u001b[m\n\u001b(B\u001b[mplain\n';
    const ctx = createAgentContext({ sandbox: () => ({ exitCode: 0, stdout }) });
    const r = await runReadonlyBash(ctx, { command: 'git -c color.ui=always diff' }, undefined);
    expect(r.text).toBe('exit 0 · 0s\ndiff --git a/x b/x\n+added\nplain\n');
    expect(r.text).not.toMatch(REMNANT_RE);
  });

  it('CR redraws keep their final state, backspaces erase, CRLF becomes LF', async () => {
    const stderr = `${Array.from({ length: 11 }, (_, i) => `\r${i * 10}%`).join('')}\nspin |\b/\b-\bdone\r\n`;
    const ctx = createAgentContext({ sandbox: () => ({ exitCode: 0, stdout: 'ok\n', stderr }) });
    const r = await runReadonlyBash(ctx, { command: 'curl -o /dev/null https://example.test' }, undefined);
    expect(r.text).toBe('exit 0 · 0s\nok\n\n[stderr]\n100%\nspin done\n');
  });

  it('a secret right after an SGR is redacted: the strip runs BEFORE the redactor', async () => {
    const stdout = 'API="\u001b[01;31m\u001b[Ksk-secret-abc123\u001b[m\u001b[K"\n';
    const ctx = createAgentContext({ sandbox: () => ({ exitCode: 0, stdout }) });
    const r = await runReadonlyBash(ctx, { command: 'grep --color=always API .env.example' }, undefined);
    expect(r.text).toBe('exit 0 · 0s\nAPI="[REDACTED]"\n');
  });

  it('binary output becomes a note with its size and how to look at it, never NUL soup', async () => {
    const stdout = `\u007fELF\u0002\u0001${'\u0000'.repeat(3000)}\u0003\u0000${'�'.repeat(100)}`;
    const ctx = createAgentContext({ sandbox: () => ({ exitCode: 0, stdout }) });
    const r = await runReadonlyBash(ctx, { command: 'cat /bin/ls | head -c 3108' }, undefined);
    expect(r.text).toBe(`exit 0 · 0s\n(binary output: ${stdout.length} bytes, not shown — write it to a file, or pipe it through xxd | head or file)`);
    expect(r.text).not.toContain('\u0000');
    // a stray NUL in ordinary text is not binary
    const text = createAgentContext({ sandbox: () => ({ exitCode: 0, stdout: `a\u0000b ${'text '.repeat(40)}\n` }) });
    expect((await runReadonlyBash(text, { command: 'printf x' }, undefined)).text).toBe(`exit 0 · 0s\nab ${'text '.repeat(40)}\n`);
  });
});
