# Exit codes

One function decides every exit code: `exitCodeFor(reason, error, degraded, signal)` in
`src/loop/stop.ts`. The command-line entry point and the engine both call it, so a one-shot run
and an interactive session can never disagree about what a stop meant.

**The checkpoint is written before every exit.** Whatever the code, the run directory is
consistent when the process leaves.

| Situation | `jevcode run` | in a session |
| --- | --- | --- |
| completed, or the generator declared itself done | 0 | the item reads `exit 0`; the composer reopens |
| a budget stop — maximum steps, wall time, spend cap, maximum replans, token cap — or a replan stop, an impossible verdict, or a human pause | 4 | the item reads `exit 4`; the composer reopens |
| a configuration or usage error at launch; an unpriced model without the opt-in; a refused secret | 2 | 2, and the process exits |
| a rejected key, or decider model drift on the first call | 2 | a prompt, then the item reads `exit 2` |
| an API failure after retries, or a provider spend limit | 5 | the item reads `exit 5` |
| the checkpoint could not be written and the run stopped — including a completed one; a resume would not work | 3 | the item reads `exit 3`, with a not-resumable notice |
| a sandbox or path abort | 6 | the item reads `exit 6` |
| interrupted twice while a run was live | 130 | the item reads `exit 130`; the composer reopens |
| an external interrupt signal | 130 | 130, and the process exits |
| a termination signal | 143 | 143 |
| a hangup, or the terminal went away | 129 | 129 |
| anything unexpected | 1 | 1 |

<!-- src/errors.ts:300-313 EXIT_CODES; src/loop/stop.ts:21-37 exitCodeFor -->

## The three rules inside the function

**A degraded checkpoint wins over everything except an error.** If the checkpoint could not be
written, every non-error stop becomes 3 — a completed run included. The run is not resumable,
and saying it succeeded would be a lie you would discover later.

**A signal stop is refined by which signal it was.** Termination gives 143, a hangup gives 129,
and anything else gives 130.

**A pause is a budget stop.** Both a human pause and a token cap fall in the exit-4 family, and
a paused run resumes without needing to be forced. A run that was explicitly ended does need to
be forced, and forcing it reopens the run rather than deleting anything.

<!-- src/loop/stop.ts:8-13 BUDGET_STOP_REASONS, :17-20 the degraded and signal rules -->

## The session's own exit code

An interactive session normally exits 0 whatever its runs did, because the session ending is not
the same event as a run ending. Set `ui.exitCode` to `last-run` — or pass `--exit-code last-run`
— to have the session exit with the code of its last run instead. That is the setting to use
when a session is being driven from a script.

Every run inside a session still carries its own code on its end item, whatever the session
policy is.

<!-- src/config/defaults.ts the ui.exitCode row: zero | last-run, default zero -->

## Related pages

- [What a run writes](records.md) — the checkpoint that is always written first.
- [Configuration](configuration.md) — the `ui.exitCode` setting.
