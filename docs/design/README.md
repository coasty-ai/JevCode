# Normative design documents

These nine files are the specification. They are **not** tutorials and they are not written for a first
reader. They are long, they carry `file:line` citations into the source, and they are numbered by section
because the code cites them that way — a docblock in the tree says "§4.2 of this document" and means it.

**They never move.** A section number is an address. If you want an explanation of a mechanism rather than its
specification, start at [the measurements](../measurements/README.md) or at the
[contributing guide](../contributing/README.md), then follow the link back here for depth.

| Document | What it specifies | Size |
| --- | --- | --- |
| [`DESIGN.md`](../DESIGN.md) | The whole harness: what JevCode is, the module map, the step loop, the edit formats, the sandbox, the checkpoint, exit codes, the bench and its evaluators. Everything else on this list is a wave layered onto it. | 3,682 lines |
| [`JEV-ONLY-DESIGN.md`](../JEV-ONLY-DESIGN.md) | The "Ledger + Sieve" search engine: goals, the sieve-or-rank rule, candidate sources, localisation, the guard, the issue oracle, budgets, and the evaluation ladder with its thresholds. This is the engine the mode with no generating model runs. | 889 lines |
| [`LLM-JEV-DESIGN.md`](../LLM-JEV-DESIGN.md) | The `llm-jev` mode: the generating model as a candidate source **inside** that search, the seeds-versus-model race with cancellation, the site-local edit contract, harm-only risk scoring, and completion as a code fact. | 569 lines |
| [`HARNESS-NEXT-DESIGN.md`](../HARNESS-NEXT-DESIGN.md) | Nineteen speed mechanisms and the safety principle that bounds them: the decision model routes, it never gates. Also the warm verification plane, the wave plan, and the as-built record of the two waves that shipped. | 962 lines |
| [`LLM-LOOP-DESIGN.md`](../LLM-LOOP-DESIGN.md) | The next step-loop wave: the speculative router table, the bounded sieve fast path, the generator path, and the arms and predictions registered before anything ran. Both switches ship off. | 1,516 lines |
| [`COORDINATION-DESIGN.md`](../COORDINATION-DESIGN.md) | How concurrent sessions on one machine see each other: a file-based ledger, leases, a mailbox, heartbeats, pause and resume from anywhere, and a relaxed context meter. | 3,553 lines |
| [`ORCHESTRATION-DESIGN.md`](../ORCHESTRATION-DESIGN.md) | A run that becomes a parent: children in worktrees, a critic that is code rather than a model, and a landing queue. Ships with the split gate shut. | 1,983 lines |
| [`IMPORT-DESIGN.md`](../IMPORT-DESIGN.md) | Bringing existing memories, rules, commands and server configurations in from other tools: discover, classify, plan, apply — with the first three phases writing nothing at all. | 2,377 lines |
| [`TUI-DESIGN-5.md`](../TUI-DESIGN-5.md) | The current terminal interface design: the peer surface, the context meter, the agent tree, import at onboarding, and the provider and model picker. | 3,084 lines |

## How these documents are written

Three conventions are worth knowing before you open one.

**Every claim about the code carries its address.** A design document that says a function does something cites
the file and the line where it does it, read at a named commit. Where a citation has gone stale against a later
tree, the document says so rather than quietly updating.

**Rejected alternatives stay in.** Each of these documents was chosen from competing designs, and the ones that
lost are named with the reason. A "Rejected critiques" or "not adopted" section near the end is normal.

**A mechanism with no measurement behind it says so.** The predicted-numbers sections name the experiment that
would settle each prediction, and the as-built sections say which waves have not started.

## How they relate to each other

They are not nine parallel specifications. They stack.

`DESIGN.md` is the base: one step loop, six actions, a sandbox, a checkpoint, a bench. Everything else
either replaces a stage of that loop or adds a subsystem beside it.

`JEV-ONLY-DESIGN.md` replaces one stage — the one that asks a model for a patch — with a search.
`LLM-JEV-DESIGN.md` then puts a generating model back **inside** that search as one candidate source among
several. The two are a pair; reading the second without the first will not work.

`HARNESS-NEXT-DESIGN.md` is about speed, not capability, and it states the rule the two documents above have
to keep: the decision model routes and never gates. `LLM-LOOP-DESIGN.md` is the next wave of that work and is
where the pre-registration discipline is at its strictest — arms, predictions and an accept rule, all written
before anything ran.

`COORDINATION-DESIGN.md`, `ORCHESTRATION-DESIGN.md` and `IMPORT-DESIGN.md` are three independent subsystems
beside the loop. Each has exactly one facade the rest of the tree imports, and each is constrained not to
import the surface at all. Those constraints are listed in
[module ownership and import rules](../contributing/architecture-rules.md).

`TUI-DESIGN-5.md` is the surface all of the above eventually has to be visible through.

A reasonable reading order for someone new: `DESIGN.md` §1 and §2, then `JEV-ONLY-DESIGN.md` §1 and §2, then
whichever subsystem you are touching.

## The earlier interface rounds

Four earlier rounds of the terminal-interface design are kept as history, not as specification. They are listed
in [History](../history/README.md). Round 5 above is the current one.

## Related

- [Contributing](../contributing/README.md) — the gates, the module ownership rules and the import rules.
- [Module ownership and import rules](../contributing/architecture-rules.md) — the dependency rules that are
  asserted rather than conventional, with a map of the system.
- [Research archive](../research/README.md) — the source surveys these designs were built from.
- [`docs/DECISIONS.md`](../DECISIONS.md) — the dated log of every decision, including the ones that changed a
  default.
