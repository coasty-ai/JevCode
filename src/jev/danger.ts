/**
 * The production command deny-list (docs/LLM-LOOP-DESIGN.md §2.4, contract 1.9 "Fastlane").
 *
 * **This is a DENY-LIST, not a proof.** It recognises a small, fixed set of shapes that are destructive beyond
 * recovery; it does not and cannot decide that a command is safe. A `null` answer means "this list does not
 * recognise it", never "this is harmless" — which is why `codeRiskReason()` (`src/loop/stages/risk.ts`), an
 * ALLOW-list of cases that ARE safe, is the other half of the code-first verdict and neither half yields `allow`
 * for an arbitrary `run`.
 *
 * Why it lives here. Until contract 1.9 the only deny-list in the tree was `DANGEROUS_COMMAND` in
 * `src/jev/mock.ts` — test and `--mock` scaffolding, referenced in a comment in `src/jev/off.ts` and reachable
 * from no production path. Two designs named it as the surviving production risk gate; it was not one. §2.4
 * promotes it verbatim, so the mock decider's behaviour is byte-identical (`src/jev/mock.ts` re-exports the same
 * `DANGEROUS_COMMAND` object) and the risk stage's code-first verdict has something real to stand on.
 *
 * Known misses, stated rather than implied: the match is case-sensitive and literal, so `RM -RF /`, `rm   -rf /`,
 * `$(echo rm) -rf /`, a `Makefile` target that wraps any of these, and every destructive command not listed are
 * all `null`. The verdict a `null` produces is `review` for an arbitrary `run` (the allow-list did not clear it),
 * not `allow`.
 */

/** One deny-list rule: the shape, and the sentence the risk reason prints. */
export interface DangerRule {
  readonly id: string;
  readonly source: string;
  readonly why: string;
}

/**
 * The six alternations of the promoted list, in their original order. `DANGEROUS_COMMAND` is built from these
 * `source`s joined with `|`, so the regex is the same object the mock has always used (asserted in
 * test/unit/jev/danger.test.ts against the literal).
 */
export const DANGER_RULES: readonly DangerRule[] = [
  { id: 'rm_rf', source: 'rm -rf', why: 'recursive force delete (`rm -rf`): removes files with no recoverable copy' },
  { id: 'force_push', source: 'git push --force', why: 'force push (`git push --force`): overwrites a remote history other clones depend on' },
  { id: 'sudo', source: 'sudo', why: 'privilege escalation (`sudo`): the effect reaches outside the workspace and outside the sandbox' },
  { id: 'curl_pipe_sh', source: 'curl[^|]*\\|\\s*sh', why: 'remote script piped to a shell (`curl … | sh`): runs code nobody in this run has read' },
  { id: 'mkfs', source: 'mkfs', why: 'filesystem creation (`mkfs`): destroys every byte on the target device' },
  { id: 'fork_bomb', source: ':\\(\\)\\{', why: 'fork bomb (`:(){`): exhausts the host process table' },
];

/**
 * Commands the deny-list treats as block-level (§5.5 destructive levels 3-4). Historically
 * `src/jev/mock.ts DANGEROUS_COMMAND`; the default mock risk heuristic still reads exactly this object.
 */
export const DANGEROUS_COMMAND = new RegExp(DANGER_RULES.map((r) => r.source).join('|'));

/**
 * The first deny-list rule `command` matches, as the reason the risk verdict prints, or `null` when no rule
 * matches. `null` is NOT a safety claim (see the module docstring).
 */
export function dangerousCommand(command: string): string | null {
  for (const rule of DANGER_RULES) {
    if (new RegExp(rule.source).test(command)) return rule.why;
  }
  return null;
}
