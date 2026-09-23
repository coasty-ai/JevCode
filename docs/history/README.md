# History

**Historical.** Nothing on this page describes current behaviour. It is the round-by-round record of how the
project was built: what each round designed, what it shipped, what its gates measured, and a set of real run
captures kept as evidence.

For what the system does now, read the [design documents](../design/README.md) and the
[measurements](../measurements/README.md).

## The terminal-interface rounds

Five rounds. Each has its own implementation design, written before the work and kept afterwards. **Rounds 1 to
4 are superseded.** They are kept because the later documents cite them by section and because they record why
a shape was chosen before it was replaced.

| Round | Document | What it designed | Status |
| --- | --- | --- | --- |
| 1 | [`TUI-DESIGN.md`](../TUI-DESIGN.md) | the first interface: the transcript, the composer, the review band, the status line, the exit-code table, packaging | superseded |
| 2 | [`TUI-DESIGN-2.md`](../TUI-DESIGN-2.md) | defaults, decision providers, conversational intake, the visual redesign and the splash | superseded |
| 3 | [`TUI-DESIGN-3.md`](../TUI-DESIGN-3.md) | the default mode change, one-key onboarding, the colour theme, the persistent wordmark, commands and polish | superseded |
| 4 | [`TUI-DESIGN-4.md`](../TUI-DESIGN-4.md) | the pinned header, one grammar for command output, resize robustness, palette navigation, the conversation, file-edit rows, production hardening | superseded |
| 5 | [`TUI-DESIGN-5.md`](../TUI-DESIGN-5.md) | the peer surface, the context meter, the agent tree, import at onboarding, the provider and model picker | **current** — listed under [design](../design/README.md) |

The research each round did first is in the [research archive](../research/README.md).

## The harness eras

The engine has had three defaults. Each change is a dated entry in the [decision log](../DECISIONS.md).

| From | Default mode | In one line |
| --- | --- | --- |
| 2026-09-21 | `jev-only`, then `jev-on` | Jev decides every step; first no generating model at all, then a code model writing one action per step |
| 2026-09-22 | `llm-jev` | the code model writes candidate patches inside a search, tests verify, Jev arbitrates — the mode the published measurements are of |
| 2026-09-23 | `agent` | the code model drives with native tool calls and everything streams; Jev keeps three quick hints at the edges — **current**, see [The agent loop](../architecture/agent-loop.md) |

## The status report, round by round

[`docs/STATUS.md`](../STATUS.md) is one long document with a section per round. It carries what was built, what
was verified with real API calls, what could not be verified on the machine available, and the gate numbers for
each round.

| Section | Covers |
| --- | --- |
| What was built | the first harness: the loop, the sandbox, the checkpoint, the bench |
| Verified live | the first runs against real APIs |
| The 30-instance repository run | the first full repository benchmark run and what it cost |
| Jev-only mode | the mode with no generating model, as of its first rounds |
| What could not be verified | the honest list — no Docker, one machine, one operating system |
| Open questions | what was unknown at the time |
| Interactive interface, rounds 1 to 4 | one section per round, each with its gate rows |

Treat every number in it as dated. The current gate numbers live in the round's own section, and the current
performance numbers are on the [performance page](../measurements/performance.md).

## Live-run captures

Seven complete run directories were captured during an early live session, each with the full transcript, the
step records, every decision with its probability, the run configuration with secrets fingerprinted, and the
raw pseudo-terminal capture of the interface being driven by real keystrokes. **They are not part of the
published repository** — together they are tens of megabytes of run state, most of it of no use to a reader.
What they showed is summarised here, and the one capture that does ship is the
[side-by-side recording](../media/side-by-side.md).

They were kept because they show behaviour that is hard to describe and easy to doubt:

| Directory | What it demonstrates |
| --- | --- |
| `01-fix/` | a whole successful loop, two human reviews approved, the loop detector tripping on a third identical test result and routing to a replan |
| `02-refused-review-replan/` | the generator refusing a destructive task itself, the proposal landing in the review band, and the replan choosing to stop |
| `02b-blocked/` | a **blocked** action: a recursive delete scored as destructive, never run, with the reason returned to the writer |
| `03-review-declined/` | a review answered "no", the same removal proposed again, and the second attempt blocked as a repeat of a step already shown to fail |
| `04-loop-replan/` | the no-network flag in action: an install fails, a probe hits the command timeout, and the intent switches to fixing the environment |
| `05-resume/` | an interrupt mid-run that stalled the interface, the checkpoint surviving it, and a resume continuing from the same step |
| `05c-ctrl-c-resume/` | the same scenario after the fix: the in-flight request is rejected, the partial step is discarded, and the resume is clean |

The first attempt at the first scenario was kept too, under a name that says what it was: a run started with
the review prompt deliberately unanswered, which waited for a keypress — the intended behaviour of the middle
confidence band, and the reason there is no auto-approve.

No artefact in that set contained a key. Each was checked for the key formats after the run. They were all
taken in the Jev-driven `jev-on` mode, the default at the time.

## The decision log

[`docs/DECISIONS.md`](../DECISIONS.md) is the one historical document that is still live. It has 100 dated
entries, oldest first, each giving the decision, why it was taken and what it affects — including the entries
that reversed an earlier one. A generated table of contents sits at the top, newest first.

## Related

- [Normative design documents](../design/README.md)
- [Research archive](../research/README.md)
- [Measurements](../measurements/README.md)
