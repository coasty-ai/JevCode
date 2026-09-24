/**
 * TUI-DESIGN §17 item 4 / §19.0 `src/cli/completion.ts`: the static scripts are generated from `FLAGS` + `COMMANDS`
 * and are byte-identical to the committed `completions/jevcode.*` files (which `scripts/gen-docs.mjs` writes), name
 * every command and every visible flag, and complete run ids shell-side.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS, FLAGS } from '../../../src/cli/args.js';
import { commandCompletion, completionScript, renderBash, renderFish, renderZsh, shQuote } from '../../../src/cli/completion.js';

const root = process.cwd();

describe('completion scripts (§17 item 4)', () => {
  it.each([
    ['bash', 'completions/jevcode.bash', renderBash],
    ['zsh', 'completions/jevcode.zsh', renderZsh],
    ['fish', 'completions/jevcode.fish', renderFish],
  ] as const)('%s equals the committed generated file', (_shell, rel, render) => {
    expect(render()).toBe(readFileSync(join(root, rel), 'utf8').replace(/\r\n/g, '\n'));
  });
  it('every command and every visible flag appears in every script; hidden flags never do', () => {
    for (const shell of ['bash', 'zsh', 'fish'] as const) {
      const text = completionScript(shell);
      for (const c of COMMANDS) expect(text, `${shell} lists ${c}`).toContain(c);
      for (const f of FLAGS) {
        // fish spells long options `-l <name>`; bash and zsh `--<name>`
        const present = (shell === 'fish' ? new RegExp(`-l ${f.name}(?![a-z0-9-])`) : new RegExp(`--${f.name}(?![a-z0-9-])`)).test(text);
        expect(present, `${shell} ${f.hidden ? 'hides' : 'lists'} ${f.name}`).toBe(!f.hidden);
      }
      expect(text).toContain('JEVCODE_HOME');
    }
  });
  it('shQuote and commandCompletion', () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
    let out = '';
    expect(commandCompletion('fish', { write: (s) => (out += s) })).toBe(0);
    expect(out).toBe(renderFish());
  });
});
