# The agent loop

`agent` is JevCode's default mode. The code model drives: it streams its reasoning and prose, calls tools natively
(several per reply), and reads the results. The harness runs the calls, streams everything to the terminal as it
happens, checkpoints every step so `/undo` works, and verifies the change with your own tests. A small decision model,
Jev, makes at most a few quick routing calls at the edges of a run and never decides anything that matters.

This is the shape of the open-source harnesses studied for the redesign (Codex, Gemini CLI, OpenCode, Crush,
mini-swe-agent, the Claude Agent SDK): one model-driven loop with deterministic guards, not a side model on every step.

- The normative specification, with every constant and every rejected alternative:
  [`docs/AGENT-LOOP-DESIGN.md`](../AGENT-LOOP-DESIGN.md). The code cites it by section number.
- The code: `src/agent/` (the driver, tools, prompts, context policy, classifier), and the engine seam in
  `src/loop/stages/agent.ts`.
- The older, Jev-driven modes run on [the step loop](step-loop.md) instead.

## The loop

```mermaid
flowchart TD
  MSG(["a message, or a one-shot task"]) --> HEAD["head of the run: the session so far,<br/>the workspace facts, the task"]
  HEAD --> SAMPLE["sample one model turn<br/>prose, reasoning and tool arguments stream as they arrive"]
  SAMPLE --> CALLS{"tool calls in the reply?"}
  CALLS -- yes --> SEG{"next segment of the calls"}
  SEG -- "reads, searches, read-only commands" --> OBS["observe step<br/>up to 8 in parallel, no pre-images"]
  SEG -- "one edit, write or other command" --> ACT["act step<br/>pre-images, sandbox, post-images"]
  OBS --> RESULTS["tool results appended to the transcript<br/>loop detector"]
  ACT --> RESULTS
  RESULTS --> CHECK["checkpoint: step record, state, transcript"]
  CHECK --> SAMPLE
  CALLS -- no --> STOPQ{"stop rules"}
  STOPQ -- "never called a tool" --> ANSWERED(["answered: a reply, exit 0"])
  STOPQ -- "cut off, or announced an action and stopped" --> SAMPLE
  STOPQ -- "changed files, tests not run since" --> VERIFY["verify step: the harness runs your test command"]
  VERIFY --> SAMPLE
  STOPQ -- otherwise --> FINISH{"last run of the unscoped test command<br/>green and current?"}
  FINISH -- yes --> COMPLETE(["complete, exit 0"])
  FINISH -- no --> DONE(["generator_done: not verified, exit 0"])
```

The model decides what a message is by what it does with it. A greeting or a question is answered in prose with no tool
call; the run stops `answered` and the interface shows it as a chat reply. A task gets tool calls, and from the first one on
the interface shows the run: tool rows, status words, the step count.

## Steps

A step is the engine's unit of pause, steer, budget, checkpoint and undo. Each step is exactly one of four kinds, so
`/undo`, `/rewind` and `/diff N` stay exact.

| Step | What happens | Takes pre-images? |
| --- | --- | --- |
| `observe` | at most one model turn, then one run of consecutive read-only calls, resolved in parallel inside the driver | no |
| `act` | at most one model turn, then **one** mutating call: an edit, a write or a command | yes |
| `verify` | the harness runs the detected test command, because the model stopped after changing files without running it | yes |
| `finish` | the model's final answer | no |

A model turn that asks for three reads and an edit becomes an `observe` step (the three reads, concurrently) followed by
an `act` step (the edit). The default step cap in agent mode is 250 (`limits.maxSteps`), because a step is small.

## Tools

Seven tools, with flat JSON schemas that every provider accepts:

| Tool | Read-only | Runs where |
| --- | --- | --- |
| `read_file` | yes | the driver, through the workspace (boundary and secret checks apply); numbered lines, paged with `offset` / `limit` |
| `grep` | yes | `rg` in the sandbox when it is installed, else a scan of the workspace's file list; secret, ignored and binary files never appear |
| `glob` | yes | the workspace's file list |
| `todo_write` | yes | the driver; the list becomes the run's plan (`/plan`) |
| `bash` | when the classifier proves the command read-only (`ls`, `cat`, `rg`, `git diff`, …) | read-only: the driver, in parallel; anything else: the engine, one at a time, with pre-images |
| `edit_file` | no | the driver finds the span with a tolerant matcher; the engine applies an exact edit |
| `write_file` | no | the engine |

What makes the tools robust on mid-tier models:

- **A tolerant edit matcher** (`src/agent/tools/edit-match.ts`): exact first, then line-trimmed, indentation-flexible,
  whitespace-normalised and escape-normalised matches, with the new text re-indented to fit; a placeholder guard
  (`// ... rest unchanged`); and an error that shows the closest lines when nothing matches.
- **Call repair** (`src/agent/repair.ts`): JSON repair of broken arguments, name and argument aliases (`Read`,
  `str_replace`, `file_path`, `cmd`, …), and recovery of calls a model leaked as XML or fenced JSON into its prose.
  A `bash` workdir that repeats the workspace folder's own name (`workdir: "demo"` in `…/demo`) runs at the root, and a
  missing file whose path starts with that name gets the relative form as a hint: both were seen live with GLM models.
- **Errors are results, never failed steps.** An unknown tool, invalid arguments or an unmatched edit comes back to the
  model as a precise tool result, and the loop continues.
- **Long output is spilled, not lost.** A command's output is clipped to a head and a tail inline (30,000 characters on
  success, 10,000 on failure, where the end matters most), and the whole output is written to
  `outputs/step-N.txt` in the run directory, which the model can `read_file` or `grep`.
- **A post-write syntax check** for Python, JSON and existing JavaScript files reports only errors the edit introduced.

## Streaming

Everything the model produces reaches the terminal as it arrives.

```mermaid
sequenceDiagram
  participant P as provider adapter
  participant E as engine
  participant D as agent driver
  participant T as terminal (TUI, --plain, --json)
  E->>T: generator:start (turn n)
  P->>E: reasoning fragment
  E->>T: generator:reasoning (chars, last line)
  P->>E: prose chunk
  E->>T: generator:delta (the raw chunk)
  E->>D: the same chunk
  D->>T: assistant:text (each completed line)
  P->>E: tool-call argument fragment
  E->>T: generator:tool-delta (tool, target, chars)
  P-->>E: the stream dropped, retrying
  D->>T: assistant:reset
  P-->>E: result: text, tool calls with ids, reasoning state
  E->>T: generator:end
  D->>T: tool:call ×k, then tool:result ×k (the read-only batch)
  E->>T: proposal, exec:start, exec:output…, outcome (a mutating call)
  E->>T: checkpoint, step:end
```

What you see in the interactive terminal:

- **The reply block.** Prose streams in place above the console, under `[jevcode]`, from the first token. A line that
  has no newline yet is drawn as text, never as a character counter. When a line completes it moves into the scrollback
  without the screen jumping.
- **The live region** shows the command running now with the tail of its output, or the reads in flight
  (`Read a.ts · Grep "x" in src…`), or the call being written (`writing edit_file src/a.ts… 1.2k chars`), or, while only
  reasoning has arrived, `thinking… 1.2k chars`.
- **Tool rows**, one per step: `Read calc/core.py, tests/test_core.py`, `Edit calc/core.py (+2 −2)`,
  `Bash python -m pytest -q · 7 passed`, `Verify npm test · 12 passed`, each with its time and cost.
- **Status words**: `thinking`, `reading`, `editing`, `running`, `testing`.
- **The mini indicator.** The status row's glyph slot holds a small braille animation of what is running: a spinning
  donut for a model turn, a globe for reads, a turning cube for an edit or a command, a wave for the test run. It
  animates only while something runs, on the spinner's existing tick, and is still over SSH and under reduced motion.

`--plain` prints each prose line exactly once as it arrives, and `--json` writes every event, including the five the
agent added (`assistant:text`, `assistant:reset`, `generator:reasoning`, `tool:call`, `tool:result`), in the same `v: 1`
stream.

## Context

- **One conversation per session.** Every message in an interactive session starts a run whose transcript continues the
  previous run's, so the model sees the whole session: earlier replies, earlier runs and their tool results. The shared
  prefix keeps the provider's prompt cache warm. The transcript is `agent/transcript.jsonl` in each run directory
  (mode `0600`, append-only).
- **Budget.** `min(0.9 × the model's context window, 200,000 tokens)`.
- **Masking at 50 % of the budget.** Old tool results longer than 800 characters are replaced by a one-line stub, keeping
  the six newest. On the Anthropic adapter this is Anthropic's server-side context editing instead, because Claude's
  thinking is bound to the exact prefix.
- **Compaction at 85 %.** One user message replaces the history: the original task, a structured summary (written by the
  model, with a deterministic fallback), the last three tool results and the recently edited files, re-read.
  `/compact` forces it.
- **The meter.** `/context` and the status row show the estimate against the budget.

## Stop and verification

| The model… | The run |
| --- | --- |
| answered in prose and never called a tool | stops `answered`, exit 0. It is a reply: no run header, no step rows, and it never names the session |
| stopped mid-sentence at the output limit, or ended announcing an action (`Let me check the tests:`) | gets one "continue" note and another turn (at most twice per run) |
| changed files and did not run your test command since | gets a `verify` step: the harness runs the detected test command and hands the result back (at most twice per run) |
| finished after a green run of the full detected test command, with no change since | stops `complete`, exit 0 |
| finished otherwise | stops `generator_done`, exit 0, and the stop line says the change is not verified |
| repeated the same call with the same result (3 in a row, or more than 5 times in the last 10 calls) | gets a nudge to change approach; the sixth trip stops the run `stuck`, exit 4, resumable |

The test command is never chosen by a model: it is `detectTestCommand()` over the workspace. Only a run of the whole,
unscoped command can make a run `complete`. Pending todo items do not block completion; the finish row lists them.
Budgets (spend, tokens, wall time, steps) stop a run exactly as in every other mode.

## Safety and autonomy

Every command runs in the existing sandbox: a scrubbed environment with no API keys in it, a timeout, an output cap, a
process-tree kill, and on macOS a seatbelt profile that allows writes only inside the workspace and the run's temporary
directory ([Sandbox and security](../operations/sandbox-and-security.md)). Every `act` and `verify` step takes pre-images
of what it may change, so `/undo` can put it back.

**Full autonomy (the default) never asks and never refuses.** A pure-code classifier (`src/agent/safety.ts`) sorts each
command into `readonly`, `safe`, `destructive` or `unknown`. Under full autonomy that only decides where a command runs
(a read-only one joins the parallel batch) and whether its step gets a note. A destructive command — one of 13 rules such
as `rm_outside`, `git_discard`, `force_push` or `publish` — runs like any other, and its step carries one truthful line:

| Rule | The note ends with |
| --- | --- |
| the effect left the machine (`force_push`, `publish`, `exfiltrate`, `remote_exec`) | `this left the machine; /undo cannot reverse it` |
| `git_discard` of workspace files, every dirty file captured, both images whole, `HEAD` unmoved | `/undo restores the workspace` |
| anything the pre-images cannot provably cover | `/undo may not restore this` |

The system prompt asks the model not to run destructive commands the task does not need, and never to discard work it did
not make.

**Review autonomy** (`--autonomy review`, `JEVCODE_AUTONOMY=review`, or `autonomy` in the config file) shows a y/n card
for every destructive or unknown command before it runs. The card of a destructive command is titled with the rule's
sentence. A declined command comes back to the model as a tool result; five declined destructive cards pause the run.
Without a terminal the card is declined.

Validation that is not an approval applies under both: a path outside the workspace, a secret path, or an edit into
`.git/` is an error returned to the model, and nothing runs.

## Where Jev sits

Jev is a calibrated decision model: it answers code-built questions with probabilities
([What Jev is](../concepts/what-is-jev.md)). The agent loop asks it only three things, all quick, all optional:

| Id | When | What it decides | Deadline | Without an answer |
| --- | --- | --- | --- | --- |
| RA0 | the first turn of a run, only where it would change the request | whether the message is conversational, so that one turn goes at the provider's low reasoning effort | 300 ms | the default effort |
| RA1 | after a loop trip | which of four nudge wordings to send | 400 ms | "try a different approach" |
| RA2 | after 30 model turns, every 10 turns | whether to add one "step back" hint | 400 ms | no hint |

None of them can allow or block a command, stop or extend a run, or decide completion. A normal run makes at most one
Jev request (RA0), and on the default provider none: every provider but Anthropic already runs each turn at low effort, so
RA0 would change nothing and is not asked. A Jev key is optional in agent mode; with none, the three placements take their
fallbacks with no wait. Each placement carries a four-clause block that `npm run jev-contract` checks
([The Jev contract](jev-contract.md)).

## Providers

All seven generator adapters speak the agent's native tool protocol (`GenerateRequest.agent`), and each keeps its legacy
wire body byte for byte for the older modes.

| Provider | Default model | Reasoning | Notes |
| --- | --- | --- | --- |
| `openrouter` (the default) | `z-ai/glm-5.3-flash` | effort `low`; the reasoning details are replayed on every turn | no provider pinning, so OpenRouter can route tool requests to accurate endpoints |
| `anthropic` | `claude-sonnet-5` | adaptive thinking, summarised, effort `high`; the signed thinking is replayed | server-side context editing instead of client masking |
| `openai` | `gpt-5.6-luna` | effort `low`; encrypted reasoning replayed | Responses API |
| `xai` | `grok-4.7` | effort `low` | |
| `gemini` | `gemini-3.8-flash` | `thinkingLevel: low`; thought signatures replayed | |
| `fireworks` | `glm-5p3-flash` | effort `low`; `reasoning_content` replayed | |
| `meta` | `muse-spark-1.3` | effort `low` | a JSON transport: each turn arrives whole rather than streamed |

Tool results go back as native tool messages paired by id, parallel calls are allowed, and the session id is the cache
key where the provider has one. If a provider rejects the replayed reasoning, the turn is retried once without it and
replay stays off for the run.

## Checkpoints, resume and undo

- The transcript is written before each step's checkpoint, so a checkpoint never points past what is on disk.
  `jevcode run --resume <id>` continues a stopped run from its last committed step.
- A reply (`answered`) is not resumable; `-c` or `--resume` on one sends your message as the next turn instead.
- `/undo`, `/rewind` and `/diff N` work per step exactly as in every other mode. Pause lands between steps; `/steer`
  text reaches the model as a note before its next turn, and any calls it had queued are answered "not executed".

## The code

| Module | What it owns |
| --- | --- |
| `src/agent/driver.ts`, `turn.ts`, `calls.ts`, `stop.ts` | the turn loop, one model turn, the dispositions of its calls, the stop rules |
| `src/agent/transcript.ts`, `head.ts`, `state.ts` | the conversation on disk, the head of a run and the carry from the previous run, the checkpointed counters |
| `src/agent/context.ts`, `providers.ts` | the context policy and the per-provider settings |
| `src/agent/prompt.ts` | the system prompt, which leads with JevCode's identity, and every fixed harness message |
| `src/agent/stream.ts` | the prose stream shaper: completed lines, held code fences, a reset on a retry |
| `src/agent/repair.ts`, `json-repair.ts` | tool-call repair |
| `src/agent/tools/*` | the seven tools, the edit matcher, result formatting and spilling, the syntax check |
| `src/agent/safety*.ts`, `shlex.ts` | the command classifier |
| `src/agent/loop.ts`, `jev.ts` | the loop detector and the three Jev placements |
| `src/loop/stages/agent.ts` | the engine seam: the per-step change set, the destructive note, the completion test |

## Related pages

- [`docs/AGENT-LOOP-DESIGN.md`](../AGENT-LOOP-DESIGN.md) — the specification.
- [System overview](overview.md) — where the agent loop sits among the modules.
- [The step loop](step-loop.md) — the engine of the legacy, Jev-driven modes.
- [Modes](../getting-started/modes.md) — `agent`, `jev-only` and the legacy modes.
- [Sandbox and security](../operations/sandbox-and-security.md) — what a command can and cannot do.
