# Importing from the other coding agents — user guide

`jevcode import` reads the memory, rules, slash commands and MCP server definitions the other coding agents on
this machine already have, shows you exactly what it would write, and writes only what you accept. It is the
user-facing half of `docs/IMPORT-DESIGN.md`; the TUI side is `docs/TUI-DESIGN-5.md` §5. This guide describes the
behaviour on disk as of **2026-09-22** — where it and the code disagree the code wins and the disagreement is a
bug, and the round's honest gaps are listed in `docs/STATUS.md`, "Round 5".

## What it reads

Eleven tools, by their own conventions: **claude-code** and **claude-desktop**, **codex**, **opencode**,
**cursor**, **windsurf**, **aider**, **gemini**, **copilot**, any **MCP** server file, and text you paste. Four
classes of artefact:

| class | what it is | where it lands |
| --- | --- | --- |
| `memory` | instruction files — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, … | appended to `AGENTS.md`, user or project scope |
| `rules` | path-scoped rule files (`.cursor/rules/*.mdc`, `.windsurfrules`) | the same, with their globs kept |
| `commands` | slash commands (`.claude/commands/*.md`, …) | `.jevcode/commands/*.md` |
| `mcp` | MCP server definitions | recorded, **disabled on import** — a server is a program, and importing one must never start it |

Anything that looks like a credential is a **review** row: it is never applied by `--yes` and always needs a
terminal.

## The CLI

```
jevcode import [<source>] [--dry-run | --yes] [--scope user|project|both]
               [--resume <importId>] [--undo <importId>] [--json | --plain]
```

- **No flag** — plan, show the report, then apply what you accept.
- **`--dry-run`** — plan and report only. Nothing is written. The report names the counts and the bytes.
- **`--yes`** — apply the non-credential rows with no review step. It calls the engine's own `applicableRows`
  and nothing else, so a credential row can never ride through it.
- **`--scope user|project|both`** — where accepted rows are written. Default `both` (`import.scope`).
- **`<source>`** — plan **one** source id instead of every known one (`claude-code`, `codex`, `cursor`, …). It is
  a positional rather than the `--source <id>` the design sketched: `--source` is already a hidden flag whose
  values are `cli|perf`, and one name cannot mean two things (recorded in `docs/STATUS.md`, "Round 5").
- **`--resume <importId>`** — continue a partly-applied import after an error (the report names the id).
- **`--undo <importId>`** — restore the files an earlier import replaced. Files you have modified since are
  reported and left alone.
- **`--json`** — one `ImportPlan`, no prose. **`--plain`** — the numbered twin (`Enter selection (1-N):`).
  **`--screen-reader`** — the same, spoken, with counts as words. **`--ascii`** — code-generated glyphs
  substituted; user text is never rewritten.

Not a terminal? The command plans and reports and refuses to write (`not a terminal — dry run only; pass --yes to
apply the non-credential rows`).

## Inside a session

`/import` and `/memory` (aliases `/imp`, `/mem`) are registered from day one. **In this build they answer
`/import is not available in this build — jevcode import plans, reviews and applies from the CLI`**: the import
engine and its CLI are finished, and the in-session review overlay is not mounted in the shell yet. The command
answers out loud rather than doing nothing, which is the whole rule.

The onboarding wizard offers the import once per version (`1 import now · 2 later · 3 never`); `3 never` writes
`seen.import: never` and the step never shows again. `/import` still works after that.

## Settings

| setting | default | env | what it does |
| --- | --- | --- | --- |
| `import.enabled` | `true` | `JEVCODE_NO_IMPORT=1` disables (`--no-import`) | offer the import at all |
| `import.scope` | `both` | `JEVCODE_IMPORT_SCOPE` | where accepted rows are written |
| `import.sources` | *(all)* | `JEVCODE_IMPORT_SOURCES` | comma-separated source ids to scan |
| `memory.enabled` | `true` | `JEVCODE_NO_MEMORY=1` disables (`--no-memory`) | read the memory files into the run |
| `memory.path` | *(conventional)* | `JEVCODE_MEMORY_PATH` | the memory file this workspace reads |
| `seen.import` | *(unset)* | — | bookkeeping: the version the one-time wizard step was shown for, or `never` (hidden unless `jevcode config --all`) |

`memory.enabled` is **one switch**, not a read switch and a write switch. Codex CLI splits them because its
memory is written continuously by background session summarisation; JevCode writes memory **once**, at apply, and
again only through `/memory add`/`reload`, so there is no continuous writer to gate separately.

## What it never does

- It never starts an MCP server, and every imported server is recorded **disabled**.
- It never applies a credential row without a terminal, and `--yes` never applies one at all.
- It never writes outside `AGENTS.md`, `.jevcode/` and the scope you chose, and every write is undoable by id.
- It never copies a secret into the report: the report is redacted by the same redactor the run uses.
