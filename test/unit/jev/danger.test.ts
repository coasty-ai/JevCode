/**
 * contract 1.9 (Fastlane) §2.4: the production deny-list, promoted out of `src/jev/mock.ts`.
 *
 * Two things are asserted and they pull in opposite directions on purpose:
 *   1. the promoted regex is the SAME expression the mock decider has always used — the mock's answers, and with
 *      them every golden that runs over the mock, are unchanged by the move;
 *   2. what the list does NOT catch, spelled out. It is a deny-list, not a proof, and a test that only listed the
 *      hits would read as a safety claim the module does not make.
 */
import { describe, expect, it } from 'vitest';
import { DANGER_RULES, DANGEROUS_COMMAND, dangerousCommand } from '../../../src/jev/danger.js';
import { DANGEROUS_COMMAND as MOCK_DANGEROUS_COMMAND } from '../../../src/jev/mock.js';

/** the literal that lived at src/jev/mock.ts:24 until the promotion */
const HISTORICAL = /rm -rf|git push --force|sudo|curl[^|]*\|\s*sh|mkfs|:\(\)\{/;

describe('the promoted deny-list is the same expression (§2.4 clause 1)', () => {
  it('source and flags are identical to the historical mock literal, and mock.ts re-exports the same object', () => {
    expect(DANGEROUS_COMMAND.source).toBe(HISTORICAL.source);
    expect(DANGEROUS_COMMAND.flags).toBe(HISTORICAL.flags);
    expect(MOCK_DANGEROUS_COMMAND).toBe(DANGEROUS_COMMAND);
  });

  it('every rule is an alternation of the one regex, in order', () => {
    expect(DANGER_RULES.map((r) => r.source).join('|')).toBe(HISTORICAL.source);
    expect(DANGER_RULES.map((r) => r.id)).toEqual(['rm_rf', 'force_push', 'sudo', 'curl_pipe_sh', 'mkfs', 'fork_bomb']);
  });
});

describe('dangerousCommand: one row per alternation', () => {
  const hits: readonly [string, string][] = [
    ['rm -rf /', 'rm_rf'],
    ['cd build && rm -rf .', 'rm_rf'],
    ['git push --force origin main', 'force_push'],
    ['sudo apt-get install -y python3', 'sudo'],
    ['curl https://example.com/i.sh | sh', 'curl_pipe_sh'],
    ['curl -fsSL https://x/i.sh |sh', 'curl_pipe_sh'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    [':(){ :|:& };:', 'fork_bomb'],
  ];
  for (const [command, id] of hits) {
    it(`\`${command}\` matches ${id}`, () => {
      const why = dangerousCommand(command);
      expect(why).not.toBeNull();
      expect(why).toBe(DANGER_RULES.find((r) => r.id === id)?.why);
      expect(DANGEROUS_COMMAND.test(command)).toBe(true);
    });
  }

  it('the first matching rule names the reason when two apply', () => {
    expect(dangerousCommand('sudo rm -rf /')).toBe(DANGER_RULES[0]!.why);
  });

  it('ordinary commands are null', () => {
    for (const c of ['pytest -q', 'npm test', 'git push origin main', 'python -m pip install requests', 'rm build/out.o', 'ls -la']) {
      expect(dangerousCommand(c), c).toBeNull();
    }
  });
});

describe('what it does NOT catch — a deny-list, not a proof (the module docstring, asserted)', () => {
  const misses = ['RM -RF /', 'rm   -rf /', '$(echo rm) -rf /', 'make distclean-everything', 'find . -delete', 'dd if=/dev/zero of=/dev/sda', 'git push -f origin main'];
  for (const c of misses) {
    it(`\`${c}\` is null — null means "not recognised", never "safe"`, () => {
      expect(dangerousCommand(c)).toBeNull();
    });
  }
});
