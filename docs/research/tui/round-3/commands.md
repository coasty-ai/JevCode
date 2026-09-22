# R4 — Slash-command audit and shortcut design (TUI round 3)

Date 2026-09-21 · HEAD `626fc40` (0.3.0, round 2) · bundle `dist/jevcode.mjs` built 15:47 from that tree (no uncommitted `src/` edits) · macOS 26, Node 22.23.2, `/usr/bin/expect`.

Everything below was either **read** (file:line given) or **measured** by driving `node bin/jevcode.js --mock` in a real pseudo-terminal through `scripts/pty/drive.exp` with the smoke's hermetic environment (`HOME`/`XDG_CONFIG_HOME`/`JEVCODE_HOME` inside a temp dir, every key variable unset, `OPEN_ASSIST_PATH` at a directory that does not exist). Probe runner, steps files, raw captures (`.cap`), SGR-stripped text (`.txt`) and timing files (`.jsonl`) are under `.scratch/r4-commands/` (`run.sh`, `steps/*.steps`, `out/*`). 14 scenarios were driven; §4 lists them.

The task text says "all 39 commands"; the registry has **37 command names and 4 aliases** (`h`, `sessions`, `continue`, `quit`) = 41 tokens (`src/tui/commands/registry.ts:79–517`, `COMMAND_TOKENS` `dispatch.ts:471`).

---

## 1. How a `/line` travels today (the five handlers)

| Stage | File:line | Notes |
| --- | --- | --- |
| Grammar | `src/tui/commands/parse.ts:58–128` (`parseCommand`), `:134` (`restOf`) | `rest` commands (`/rename /steer /why`) skip the tokeniser (`dispatch.ts:191–201` `parseCommandLine`) |
| Registry | `registry.ts:79–517` `COMMANDS`, `:519–527` `BY_NAME` (names + aliases, case-folded), `:545` `isExactCommand` | one array feeds dispatcher, palette, help, `docs/COMMANDS.md`, man page |
| Dispatch | `dispatch.ts:211–437` `dispatchCommand` → `CommandAction`; `:440–458` `argumentCandidates` | `argumentCandidates` has **no consumer anywhere in `src/`** (grep) |
| Router | `src/tui/composer/submit.ts:150–173` `routeSubmit` | `submitting → ignore` first (line 150); palette overlay → exact token only (`:154–158`) |
| **App pre-router** | `src/tui/App.tsx:1064–1070` `parsePanelCommand` (`src/tui/pane/commands.ts:11–28`, case-sensitive regexes) | `/panel …` and `/transcript …` are applied **before** `routeSubmit`; history appended unredacted (`App.tsx:1068`) |
| App-local actions | `App.tsx:930–1057` `runCommand`: `help`(938, `reload` falls through), `why`(945), `decisions`(974), `plan`(980), `theme`(986), `editor`(993), `exit`(996), `pause`(1010), `abort`(1016), `unsteer`(1020), `steer`(1027), `copy`(1038); everything else → `host.command(line)` (`:1049`) | the App dispatches with its own `dispatchCtx()` (`App.tsx:802–807`: no `isDeniedPath`, `sessions` ids = `sessionId`), the host re-dispatches with `dispatchContext()` (`session.ts:3423–3431`: `newestRunId`, denylist) |
| Controller | `src/cli/session.ts:2860–2887` `runCommand` (plain support gate `:2867`, `EXCLUSIVE_COMMANDS` `:202`), `:2674–2858` `execute()` switch | **no `case 'panel'` and no `case 'transcript'`** in `execute()` — the switch has no `default`, so the two actions fall out silently |
| `--plain` composer | `src/tui/plain-composer.ts:53–58` `plainSupports`, `:233–247` `command()` | no palette, no completion (`terminal: false`, `:139`) |
| Palette | `src/tui/commands/palette.ts:133–163` `paletteMatches`, `:175–180` `paletteGhost`, `:181–227` `paletteRows`; drawn by `src/tui/Overlay.tsx:104–114` (want) and `:297–316` (card in the boxed tier, bare rows in the flat tier) | 8 rows max (`layout.ts:34` `CAP.palette`); boxed card = 2 edges + ≤ 6 rows |
| Keys | `src/tui/keys/resolve.ts:406–407` (`/` opens on an empty draft), `:643–689` `resolvePalette` (Tab = accept, Enter = run, Shift+Tab = up) | Tab accept → `App.tsx` `case 'complete'` (`:1372–1384`): `composer.set(\`/${pick} \`)` — **always the command name, never an argument** |

---

## 2. Every command

Legend — **Handled**: `A` = App-local (`App.tsx`), `H` = controller (`session.ts`), `A→H` = App pre-parses then forwards, `pre` = `parsePanelCommand`. **States**: I idle · L live · T thinking (chat intake in flight) · P `--plain` · SR `--screen-reader` (a TTY under SR draws the same text rows; the palette has no SR twin — `Overlay.tsx` passes `screenReader` only to the Wizard, `:276`). `✓` works, `✗` refused by design, `!` see finding. **T is `!silent` for every command** (F14): Enter on any `/` line while the intake is thinking is dropped by `routeSubmit`'s `submitting` guard with no item and no toast (measured twice: `thinking-cmd`, `thinking-toast`).

| # | Command (aliases) | Purpose · args · flags | Avail | Handled (file:line) | Tests (file:line) | I / L / T / P / SR | Findings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `/help` (`/h`) | help block · `[keys\|commands\|reload]` | any | A `App.tsx:938` (palette.ts `helpLines:302`); `reload` → H `session.ts:2676–2687`; plain H `:2688` (session.ts `helpLines:954`) | `dispatch.test.ts:152–156`, `palette.test.ts:235–300`, `session.test.ts:541–549`, `app.test.tsx:532` (`?`) | ✓ ✓ !silent ✓ ✓ | **F9** two formatters → different transcript text; **F10** `reload` re-reads a file nobody consumes |
| 2 | `/new` | end the session | idle | H `:2690–2702` | `session.test.ts:500–518`, `dispatch.test.ts:207–217` | ✓ ✗ !silent ✓ ✓ | **F12** silent when no session exists (measured) |
| 3 | `/resume` (`/sessions`, `/continue`) | picker / continue `[id\|title]` `--force` `--sort=updated\|created` | idle | H `:2703–2711` → `pickerCommand :2648`, `resumeOrFollowUp :2627`; picker `tui-prompter.ts:226` | `dispatch.test.ts:125–140`, `session.test.ts:464–498`, `plain-composer.test.ts:304–321` | ✓ ✗ !silent id/title only ✓ | measured: empty picker row `no session in <ws> yet`, `/continue: no session in <ws> yet`, `--sort` errors verbatim; **F20** App/host `sessions` id mapping differs |
| 4 | `/rename <title>` | title ≤ 60 (rest) | any | H `:2712–2718` (`text60` `src/session/index.ts:58`) | `dispatch.test.ts:141–150`, `session.test.ts:528` | ✓ ✓ !silent ✓ ✓ | **F13** silent cut at 60 (`dispatch.ts:300`) |
| 5 | `/steer <text>` | queue a directive (rest) | live | A `:1027–1037` (gate); plain H `:2719–2723` | `app.test.tsx:1124–1160`, `dispatch.test.ts:42–60`, `plain-composer.test.ts:294–303, 475` | ✗ ✓ !silent ✓ ✓ | — |
| 6 | `/unsteer` | take the newest steer back | live | A `:1020–1026`; plain H `:2724` | `dispatch.test.ts:205`, `app.test.tsx:1180` | ✗ ✓ !silent ✓ ✓ | — |
| 7 | `/pause` | pause at the boundary | live | A `:1010–1015`; plain H `:2727` | `dispatch.test.ts:61–72`, `plain-composer.test.ts:294`, `session.test.ts:520` | ✗ ✓ !silent ✓ ✓ | — |
| 8 | `/abort` | abort now | live | A `:1016–1019`; plain H `:2730` | `dispatch.test.ts:206` | ✗ ✓ !silent ✓ ✓ | — |
| 9 | `/undo [n]` | restore a step's files | idle | H `:2733` → `undoCommand :2194–2214`; y/N `tui-prompter.ts:215` | `dispatch.test.ts:113–124`, `session.test.ts:631–643, 659–672` | ✓ ✗ !silent ✓ (readline y/N) ✓ | measured errors `/undo: no finished run in this session yet`, `expected a step 1..4 with changed files, got "99"` |
| 10 | `/rewind [step]` | picker → undo → files/plan/both | idle | H `:2736` → `:2232–2277`; picker `tui-prompter.ts:258`; plain prints rows + `pick a step with /rewind <step>` (`:2249–2251`) | `dispatch.test.ts:113–124`, `session.test.ts:659–672` | ✓ ✗ !silent ✓ ✓ | — |
| 11 | `/diff [step] --full --all` | numstat / pager | any (`--full` idle) | H `:2739` → `:2279–2336`; pager fallback `src/undo/pager.ts:246–276` | `dispatch.test.ts:61–81`, `plain-composer.test.ts:304–321` | ✓ ✓ !silent inline only ✓ | no pager → inline with a notice (`pager.ts:273–275`); measured `/diff: no run in this session yet` |
| 12 | `/plan` | plan ledger | any | A `:980–985` (pane state); plain H `:2742` → `:2556` (`lastPlan ?? finalPlan`) | `session.test.ts:561` | ✓ ✓ !silent ✓ ✓ | **F11** two sources, identity not asserted |
| 13 | `/decisions [n] [stage]` | last n rows | any | A `:974–979` (**drops `stage`**, `n` = row budget); plain H `:2745` → `:2547–2554` (filters, `slice(-n)`) | `dispatch.test.ts:156–160`, `session.test.ts:563` | ✓ ✓ !silent ✓ ✓ | **F6** measured: `/decisions 3 risk` printed a `complete` row |
| 14 | `/why <ref\|digit>` | why block | any | A `:945–973` (`intake*` refs → H); H `:2748` → `:2562–2578` | `dispatch.test.ts:141–150`, `session-chat.test.ts:718–736`, `round2.pty.test.ts:643` (`it.fails`), `app.test.tsx:303` | ✓ ✓ !silent ✓ ✓ | **F8** error texts differ (`App.tsx:962` vs `session.ts:2565, 2569`) |
| 15 | `/calibration` | reliability block | idle | H `:2751` → `:2580–2585` | `dispatch.test.ts:207` (loop only) | ✓ ✗ !silent ✓ ✓ | **G1** no controller test |
| 16 | `/jev` | decider facts | any | H `:2754` → `:2496–2532` | `session.test.ts:555`, `session-chat.test.ts:212–221`, `round2.pty.test.ts:312` | ✓ ✓ !silent ✓ ✓ | — |
| 17 | `/cost` | spend block | any | H `:2757` → `:2462–2494` | `session.test.ts:552`, `round2.pty.test.ts:312` | ✓ ✓ !silent ✓ ✓ | — |
| 18 | `/budget [setting <v>]` | show / set caps | any | H `:2760` → `:2372–2432`, `pendingLines :2434` | `dispatch.test.ts:82–112`, `session.test.ts:415–460, 1103`, smoke `budgetfirst.steps` | ✓ ✓ !silent ✓ ✓ | measured: the show form lists `pending: model/provider/mode` too (so `/budget` is the only "what is pending" view) |
| 19 | `/model <id>` | pending generator model | any | H `:2763–2766` | `dispatch.test.ts:189–190`, `session.test.ts:565` | ✓ ✓ !silent ✓ ✓ | **F15** no show form; no cross-check with `/provider`; no warning under `jev-only` |
| 20 | `/provider <p>` | pending generator provider | any | H `:2767–2770` | `dispatch.test.ts:175–177` | ✓ ✓ !silent ✓ ✓ | **F15** |
| 21 | `/mode [m]` | show / pend the engine mode | any | H `:2771–2794` (`runLogin :1513` for missing keys) | `dispatch.test.ts:178–186`, `session.test.ts:126–200`, `round2.pty.test.ts:328–380, 783`, smoke `mode-switch(-keyed)` | ✓ ✓ !silent ✓ ✓ | **F1** echo names the pending mode twice (measured); **F2** default-mode strings hard-coded |
| 22 | `/llm <on\|off>` | = `/mode jev-on` / `jev-only` | any | dispatch maps to the `mode` action (`dispatch.ts:383–389`) | `dispatch.test.ts:187–191`, `session.test.ts:126–150` | as `/mode` | as `/mode`; the pair must follow the default flip (P5) |
| 23 | `/config` | masked table | any | H `:2795–2800` | `session.test.ts:557` | ✓ ✓ !silent ✓ ✓ | shows `ui.theme dark` after a TUI `/theme light` (**F5**, measured) |
| 24 | `/login` | wizard re-entry | any | H `:2801` → `runLogin :1513–1533`; wizard `tui-prompter.ts:162–180` | `session.test.ts:167–200, 645–657`, `round2.pty.test.ts:328, 783` | ✓ ✓ !silent raw-mode ✓ | measured: opens `setup · jev provider` / `No Jev key found…` (startup wording for a re-entry, F19); Ctrl-C closes, session continues |
| 25 | `/logout [generator\|jev]` | remove a saved key | any | H `:2804` → `logoutCommand :2602–2617` | `session.test.ts:1091–1098` | ✓ ✓ !silent ✓ ✓ | **F16** doubled label `[setup] [setup] …` (measured) |
| 26 | `/trust` | reopen the trust gate | idle | H `:2807–2810` → `trustGate(true) :1554–1594`; wizard trust step `tui-prompter.ts:194–207`, keys `Wizard.tsx:193–197` | none with a prompter | ✓ ✗ !silent ✓ ✓ | **F17** Esc/Enter inert; Ctrl-C **exits the session with 2** and prints the stale decision (measured) |
| 27 | `/theme <t>` | recolour | any | A `:986–992` (**never reaches H**); H `:2811–2818` (plain refuses: n/a) | `session.test.ts:569, 645`, `plain-composer.test.ts:304` | ✓ ✓ !silent ✗ ✓ | **F5** no item, host unaware, reverts at the next `applyConfig` (`session.ts:1498–1504` → `App.tsx:2321`) |
| 28 | `/panel [d\|p\|t\|s\|off\|full]` | Jev panel | any | pre `App.tsx:1064–1070` + `applyPanelCommand :858–875`; **H: no case** | `round2-app.test.tsx:269–299`, `round2.pty.test.ts:507–640`, smoke `panel.steps` | ✓ ✓ !silent **!silent** ✓ | **F3** `--plain` prints nothing although `plain: 'yes'` (measured); `/Panel` (any capital) and `/panel` under an open wizard reach the host → silent |
| 29 | `/transcript [compact\|full]` | transcript view | any | pre (same path); no-arg → `transcript compact` note (`App.tsx:861–866`); H: no case; plain n/a | `round2.pty.test.ts:654`, `app.test.tsx:132–176` | ✓ ✓ !silent ✗ ✓ | new items only (reducer `useEngine.tsx:490`) — as designed |
| 30 | `/copy [last\|proposal\|diff\|draft]` | clipboard | any | A `:1038–1043` (`copyRedacted` `src/tui/secrets/clipboard.ts:165`); H `:2819–2832` (plain n/a) | `plain-composer.test.ts:304` only | ✓ ✓ !silent ✗ ✓ | **F7** `diff` copies the **last item** (measured via OSC 52); **G2** no TUI test |
| 31 | `/export [file]` | write transcripts | idle | H `:2833` → `exportCommand :2338–2370` (`resolvePath(workspaceRoot, file)`) | `dispatch.test.ts:197–200`, `session.test.ts:573–612, 629` | ✓ ✗ !silent ✓ ✓ | measured `/export: no session yet`; the App's first dispatch lacks the denylist (**F20**, the host's re-dispatch catches it) |
| 32 | `/status` | facts block | any | H `:2836` → `:2534–2545` | `session.test.ts:550, 636`, `app.test.tsx:472–476` | ✓ ✓ !silent ✓ ✓ | — |
| 33 | `/errors` | recent warnings | any | H `:2839–2841` | `session.test.ts:559` | ✓ ✓ !silent ✓ ✓ | **F18** never clears the status `!n` (only Ctrl+O dispatches `ack-errors`, `App.tsx:1321`, reducer `useEngine.tsx:452`) although the row says it does (`registry.ts:461–470`) |
| 34 | `/report` | support bundle | idle | H `:2842` → `:2587–2599` | `dispatch.test.ts:207` (loop only) | ✓ ✗ !silent ✓ ✓ | measured `/report: no finished run in this session yet`; **G1** |
| 35 | `/history clear` | truncate history | any | H `:2845–2851` (`prompter.historyClear`) | `dispatch.test.ts:201–203` | ✓ ✓ !silent ✓ ✓ | **G3** no end-to-end test of the y/N |
| 36 | `/editor` | Ctrl+G | any | A `:993–995`; H `:2852` (error); plain n/a | `app.test.tsx:1222`, `plain-composer.test.ts:304` | ✓ ✓ !silent ✗ ✓ | — |
| 37 | `/exit` (`/quit`) | leave | any | A `:996–1009` (exit confirm while live); plain H `:2855` → `exitCommand :2663` | `app.test.tsx:640, 1099`, `session.test.ts:674–760`, `interrupts.pty.test.ts:162`, `twins.pty.test.ts:46` | ✓ ✓ !silent ✓ ✓ | — |

---

## 3. Findings (bugs and inconsistencies)

Severity: **H** breaks a documented behaviour or loses user intent · **M** wrong/ misleading output · **L** polish. "measured" = seen in a pty capture under `.scratch/r4-commands/out/`; "read" = established from the source.

| # | Sev | Finding | Evidence |
| --- | --- | --- | --- |
| F1 | M | `/mode` with no argument names the **pending** mode twice: `mode jev+llm (next run: jev+llm)` after `/llm on` while the base is `jev-only`. `cur` is `next` unless a run is live (`session.ts:2773–2774`). STATUS "Round 2" deviation 15. | measured `mode-echo.txt:103` |
| F2 | M | The default mode is hard-coded in prose in several places, so the owner's one-constant flip will leave stale strings: `registry.ts:67` ("jev-only is the default"), `scripts/gen-docs.mjs:229` man ENVIRONMENT `engine mode (jev-only, the default \| jev-on \| jev-off)` (also lacks `llm-jev`), `test/pty/run-smoke.sh:16`, `docs/TUI.md` §Modes. The `MODE_*_SET` items are a ternary chain (`session.ts:2792`) and `modeBadgeWord` a ternary (`src/tui/status/lines.ts:107–109`), not one table. | read |
| F3 | H | `/panel` and `/transcript` have **no `case` in `execute()`** (`session.ts:2674–2858`). In `--plain`, `/panel` and `/panel full` print nothing although the registry promises `plain: 'yes'` / "`--plain` prints the rows" (`registry.ts:406–416`). In the TUI the pre-router catches the lower-case exact forms only (`pane/commands.ts:11–12`), so `/Panel`, `/PANEL d` and `/panel` while the wizard overlay is open (`App.tsx:1065`) reach the host and vanish. The switch has no `default`, so TypeScript cannot flag a dropped kind. | measured `plain-panel.txt` (lines `/panel`, `> /panel full`, nothing between) |
| F4 | H | **Tab never completes an argument and wipes one that was typed.** `case 'complete'` sets `/${pick} ` from the command match (`App.tsx:1383`); `argumentCandidates` (`dispatch.ts:440`) has no consumer. Design §5.1 promises Tab inside enum/run/step/path/setting arguments. | measured `palette-tab.cap` frames 16→17: `› /budget spend-cap` → Tab → `› /budget` |
| F5 | H | `/theme` is App-local (`App.tsx:986–992`): (a) no `[ui] theme …` item in the TUI while `--plain` would print one (`session.ts:2817`) — identity break; (b) the host's `themeOverride` stays null, so `/config` reports the old theme; (c) the next `applyConfig()` (`/login`, `/logout`, or a pending `/model`/`/provider`/`/mode` at run start, `session.ts:1702`) pushes `config.ui()` back through `renderer.setUi` (`:1503`) → `bridge.ui = ui` (`App.tsx:2321`) and the TUI theme **reverts**. | (a),(b) measured `after-run.txt:271` `ui.theme dark` after `/theme light`; (c) read |
| F6 | M | `/decisions [n] [stage]` in the TUI ignores `stage` and uses `n` as a row budget of the pane projection (`App.tsx:974–979`) while the host filters by stage and slices the last `n` decisions (`session.ts:2547–2554`). | measured `after-run.txt:162–165`: `/decisions 3 risk` printed `s4 complete task_complete` |
| F7 | H | `/copy diff` copies the **last transcript item**, not a diff: the App's payload picks `draft` / `proposal` / else last item (`App.tsx:1039`). The host's `copy` case answers `nothing to copy for diff` (`session.ts:2820–2828`) but the TUI never asks it. | measured: OSC 52 payload decoded from `copy-osc52.cap` = `[ui] stopped — complete (exit 0)` |
| F8 | M | `/why` failure text differs by renderer: TUI `error: /why: no decision <ref> in the last 3 steps` (`App.tsx:962`), plain `/why: no decision matches <ref>` and a different parse error (`session.ts:2565, 2569`). | read |
| F9 | M | Two help formatters: `palette.ts:302` (`keys` header, packed contexts, `commands` header, `  /name usage  title`, ≤ 60 lines with a compaction ladder) vs `session.ts:954` (one `keys · <ctx>: …` line per context, `/name usage  title`, no compaction, cut at 60). The transcript item text therefore differs between the TUI and `--plain`, and the plain form can exceed 80 cells per line. | measured `plain-help.txt` vs `kb-rebind.txt:40–60` |
| F10 | H | **`keybindings.json` never reaches the App.** `session.ts:3465` loads it, `:2680` reloads it on `/help reload`, but the only readers are the warnings (`:3495`). `createTuiRenderer` accepts `opts.bindings` (`App.tsx:2248`) and `main.tsx` never passes it, so `resolveKey` runs on `DEFAULT_BINDINGS` (`App.tsx:553`). `/help reload` therefore reports success for a file that changes nothing. | measured `kb-rebind`: `--keybindings kb.json` with `"global:help": "none"`; `?` appended the help block before **and** after `[ui] keybindings reloaded from …` (2 blocks) |
| F11 | L | `/plan` and `/decisions` are rendered from the reducer's pane state in the TUI (`App.tsx:974–985`) and from `lastPlan`/`decisions` in `--plain`; nothing asserts the two texts agree (identity predicate). | read |
| F12 | M | `/new` before any session prints nothing (`old === null` skips the note, `session.ts:2691–2692`). | measured `plain-panel.txt` (`> /new` then `> /undo`), `idle-nothing.txt` |
| F13 | L | `/rename` silently truncates at 60 (`dispatch.ts:300`) then `text60` again (`session.ts:2713`); the item shows the cut title without saying so. | read |
| F14 | H | While the intake is **thinking**, Enter on a `/` line is dropped silently: `App.tsx:1074` exempts `/` lines from the `still thinking` toast, then `routeSubmit` returns `ignore('submitting')` (`submit.ts:150`) because `submittingRef` is true until the reply, and `case 'ignore'` does nothing (`App.tsx:1090`). Plain text gets the toast; `/status`, `/help`, `/cost` get nothing. | measured `thinking-cmd.txt` (`› /new` under `⠹ thinking`, no item), `thinking-toast.txt:47` (toast for `hello`) |
| F15 | M | `/model` and `/provider` have no show form (`/mode` has one); they pend independently with no cross-check (an Anthropic id on `openrouter` surfaces only as `ConfigError` at run start, `session.ts:1493–1495, 1702`) and under `jev-only` a pending generator model is silently irrelevant. | measured `mode-echo.txt:132–151` (`provider anthropic pending`, `model gpt-9 pending`, both listed by `/budget`) |
| F16 | L | `/logout` items read `[setup] [setup] generator key: not in …`: `commandLogout` writes `[setup] ${item}` (`src/cli/login.ts:648, 662, 673`) and the session's writer adds the label again (`session.ts:2609`). | measured `login-reopen.txt` |
| F17 | H | `/trust` reopens the trust card through the wizard (`tui-prompter.ts:194–207` `openWizard({ trustNeeded: true })`); the card accepts only `1/2/3` (`Wizard.tsx:193`), Esc and Enter are inert, and Ctrl-C follows the startup rule "no run live → exit 2" — **the whole session exits 2** — after which `trustGate` returns early on `exiting` (`session.ts:1582`) and `case 'trust'` prints the **previous** decision as if new (`:2809`). | measured `trust-esc`: exit 2, last line `[config] workspace trusted (trust)` |
| F18 | L | `/errors` never dispatches `ack-errors`; the status `!n` clears only on Ctrl+O (`App.tsx:1321`). The registry row promises "acknowledges `!n`" (`registry.ts:461–470`). | read |
| F19 | L | `/login` re-entry shows the startup copy `No Jev key found. Where do you reach Jev?` (`setup · jev provider`) even when invoked as a deliberate re-entry. | measured `login-reopen.txt` |
| F20 | L | The App's `dispatchCtx()` (`App.tsx:802–807`) has no `isDeniedPath` and maps `sessions[].id = sessionId`; the host's (`session.ts:3423–3431`) uses `newestRunId(s) ?? sessionId` and the denylist. The host re-dispatches every forwarded line, so results agree today, but a future App-local action (P8, P9) would see the weaker context. | read |
| F21 | M | An errored command **keeps the draft** (§4.9), so the next line typed appends to it (`/steer x` → error → `/pause` typed → `› /steer x/pause`); only `/why` clears on failure (STATUS finding 16 fix, `App.tsx:963`). Fixable errors (typo, bad argument) deserve the kept draft; availability errors (`needs a live run`, `runs when the run is idle`) have nothing to fix. | measured in 5 probes (`idle-nothing`, `after-run`, `resume-empty`, `palette-narrow`, `thinking-toast`) |
| F22 | M | Aliases are second-class in the palette: an alias match is appended **last with score 0 and no spans** (`palette.ts:163–168`), the ghost only completes a **name** prefix (`:175–180`), and rows never show aliases. `/q` shows `/exit` with no ghost; `/x` shows `/exit` then `/export` by subsequence. | measured `rank-probe` (§5.1 table) and `palette-tab` (`/m` ghost `+ode (+5)`) |
| F23 | L | The one-letter prefixes users will reach for rank a *different* command first today: `s` → `/steer` (status 2nd), `p` → `/plan` (panel 3rd), `t` → `/trust` (theme 2nd), `l` → `/llm` (login 2nd), `tr` → `/trust`, `e` → `/exit` (export 2nd). Ties resolve by table order (`c` → cost over copy, `r` → resume over rename/rewind). | measured (§5.1) |

Coverage gaps: **G1** `/calibration`, `/report` have no controller test (only the dispatch loop); **G2** `/copy` has no TUI test; **G3** `/history clear` has no end-to-end y/N test; **G4** no pty matrix that runs the popular set in each state; **G5** nothing asserts that every `CommandAction['kind']` is handled by the App or the host (`execute()` has no `default`).

---

## 4. Probe log (14 pty scenarios; all under `.scratch/r4-commands/`)

| Scenario (steps file) | Geometry · args · env | What it showed |
| --- | --- | --- |
| `palette-tab` | 24×80 `chat --mock` | `/` palette frame (§5.7 mock A); `/m` → ghost `/mode +5`; Enter on `/m` → `error: unknown command /m`; `/budget` Tab → `/budget `; typing `spend-cap` then Tab → **`/budget `** (F4) |
| `mode-echo` | 24×80 `chat`, fake `OPENROUTER_API_KEY`, `JEVCODE_ASSERT_NO_NETWORK=1` | `/mode` → `mode jev-only (next run: jev-only)`; `/llm on` → `MODE_JEV_ON_SET`; `/mode` → `mode jev+llm (next run: jev+llm)` (F1); `/mode jev-on` → `already`; `/llm off`; `/provider anthropic`, `/model gpt-9` pend; `/budget` lists all three pendings (F15) |
| `plain-panel` | 24×80 `chat --plain --mock` | `/panel`, `/panel full` print nothing (F3); `/transcript` refused (n/a); `/help` plain format (F9); `/theme light` refused; `/new` silent (F12); `/undo` error text |
| `plain-help` | 24×80 `chat --plain --mock` | `/help commands` one item per command; `/mode` plain echo; `/copy`, `/editor` refused |
| `idle-nothing` | 24×80 `chat --mock` | error texts of `/undo /diff /report /export /rewind /continue /steer` before any run; kept draft chain `› /steer x/pause` (F21) |
| `copy-osc52` | 24×80 `chat --mode jev-on --mock --mock-steps 4 --osc52`, `PATH` = node+git+sh only | toast `✓ copied` via the OSC 52 fallback; payload of `/copy diff` = `[ui] stopped — complete (exit 0)` (F7); `/copy proposal` = `proposal done scratch work complete: All done \| plan …` |
| `after-run` | 24×80 `chat --mode jev-on --mock --mock-steps 4` | `/decisions 3 risk` includes a `complete` row (F6); `/theme light` → no item; `/config` → `ui.theme dark` (F5); `/status /jev /cost /errors /plan /help reload` blocks; `/undo 99` error; kept-draft chain |
| `thinking-cmd` | 24×80 `chat --mock`, `JEVCODE_MOCK_JEV_MS=4000` | `/new` Enter under `⠹ thinking`: nothing (F14) |
| `thinking-toast` | same | plain `hello` → toast `one moment — still thinking`; Ctrl-C = stop thinking (draft kept); `/status` appended to `hello` |
| `palette-narrow` | 12×60 `chat --mock` | flat-tier palette: 6 rows + footer (§5.7 mock C); `/b` → 3 commands + 3 sub-rows + footer; Esc keeps `/b` |
| `login-reopen` | 24×80 `chat --mock` | `/login` opens `setup · jev provider` (F19); Ctrl-C closes, session continues; `/logout` doubled label (F16); `/trust` card → Ctrl-C exits 2 (F17) |
| `resume-empty` | 24×80 `chat --mock` | `/resume` picker with `no session in … yet`; `/sessions` same; `/resume nothing-here`, `/resume --sort` errors verbatim |
| `trust-esc` | 24×80 `chat --mock` | `/trust` → Esc inert, Enter inert, Ctrl-C → exit 2 and `[config] workspace trusted (trust)` (F17) |
| `kb-rebind` | 24×80 `chat --mock --keybindings kb.json` (`global:help: none`) | `?` appends help before and after `/help reload` (F10) |

---

## 5. Shortcut design

### 5.1 The popular set and its aliases — measured against the real scorer

`rank()` (`src/tui/commands/fuzzy.ts:236`) over the 37 names, `paletteMatches` and `paletteGhost` with a fresh state (`.scratch/r4-commands/rank-probe.ts`). "Top today" is what the first palette row shows for that token now; "prefix set" is every name starting with the token.

| Alias | Owner | Top today (score) → 2nd, 3rd | Ghost today | Prefix set | Verdict |
| --- | --- | --- | --- | --- | --- |
| `h` (exists) | help | help 896 → history 893 | `+elp (+3)` | help, history | keep |
| `m` | mode | mode 896 → model 895 | `+ode (+5)` | mode, model | ✓ owner already first |
| `ml` | model | model 42 (subsequence, sole) | none | — | ✓ unambiguous; non-prefix → ghost must read `→ /model` |
| `c` | cost | cost 896 = copy 896 (table order) → config 894 | `+ost (+6)` | calibration, cost, config, copy | ✓ owner first by tie rule |
| `s` | status | **steer 895** → status 894 | `+teer (+10)` | steer, status | needs the pin rule (P2) |
| `r` | resume | resume 894 = rename = rewind (table order) → report | `+esume (+14)` | resume, rename, rewind, report | ✓ owner first |
| `n` | new | new 897 | `+ew (+11)` | new | ✓ |
| `q` | exit | (alias only; no name contains q) | none | — | ✓; ghost `→ /exit` |
| `x` | exit | exit 9 → export 8 (subsequence) | none | — | ✓ with pin; ghost `→ /exit` |
| `p` | panel | **plan 896** → pause 895 → panel 895 | `+lan (+8)` | pause, plan, provider, panel | needs the pin rule |
| `pl` | plan | plan 896 → panel 42 | `+an (+1)` | plan | ✓ |
| `d` | diff | diff 896 → decisions 891 | `+iff (+8)` | diff, decisions | ✓ |
| `u` | undo | undo 896 → unsteer 893 | `+ndo (+7)` | unsteer, undo | ✓ |
| `t` | theme | **trust 895** → theme 895 (table order) | `+rust (+15)` | trust, theme, transcript | needs the pin rule |
| `l` | login | **llm 897** → login 895 → logout 894 | `+lm (+7)` | llm, login, logout | needs the pin rule |
| `b` | budget | budget 894 | `+udget (+2)` | budget | ✓ |
| `j` | jev | jev 897 | `+ev (+0)` | jev | ✓ |
| `tr` | transcript | **trust 895** → transcript 890 | `+ust (+5)` | trust, transcript | needs the pin rule |
| `cp` | copy | copy 44 → transcript 12 | none | — | ✓; ghost `→ /copy` |
| `cf` | config | config 42 | none | — | ✓ |
| `rw` | rewind | rewind 43 | none | — | ✓ |
| `w` | why | why 897 | `+hy (+2)` | why | ✓ |
| `a` | abort | abort 895 | `+bort (+7)` | abort | ✓ (live-only; palette dims it idle) |
| `dc` | decisions | decisions 43 | none | — | ✓ |
| `e` | export? | exit 896 → export 894 = errors 894 | `+xit (+20)` | export, errors, editor, exit | **do not alias `e`** (four popular prefixes; `x`/`q` cover exit) |
| `st` | steer? | steer 895 → status 894 | `+eer (+6)` | steer, status | **do not alias** (`s` is status; live-only steer is Enter-while-live anyway) |

Proposed shortcut table (16 popular + 8 secondary):

| Command | Aliases after R3 | Command | Aliases after R3 |
| --- | --- | --- | --- |
| `/help` | `h` | `/panel` | `p` |
| `/mode` | `m` | `/plan` | `pl` |
| `/model` | `ml` | `/diff` | `d` |
| `/cost` | `c` | `/undo` | `u` |
| `/status` | `s` | `/theme` | `t` |
| `/resume` | `r`, `sessions`, `continue` | `/login` | `l` |
| `/new` | `n` | `/budget` | `b` |
| `/exit` | `q`, `x`, `quit` | `/jev` | `j` |
| `/transcript` | `tr` | `/copy` | `cp` |
| `/config` | `cf` | `/rewind` | `rw` |
| `/why` | `w` | `/abort` | `a` |
| `/decisions` | `dc` | `/llm` | — (keep the word; `/m jev-on` is two keys shorter anyway) |

Every alias is a valid `name` token (`parse.ts:35` `NAME_RE`), unique across names + aliases (`registry.test.ts:95` already asserts this), never equal to another command's name, and never one of `PANEL_ARGS`/`TRANSCRIPT_VIEWS`/`LLM_STATES` in the **same** position (arguments live after the name, so `d` as an alias and `d` as `/panel d` cannot collide).

### 5.2 Resolution rules (the decision the task asks for)

1. **Enter: exact alias wins.** Already true — `findCommand` folds aliases into `BY_NAME` (`registry.ts:519–527`), `isExactCommand` accepts them (`:545`), `routeSubmit`'s palette path runs an exact alias (`submit.ts:154–158`, tested `submit.test.ts:40–49` with `/quit`). No change.
2. **Palette ranking: an exact alias pins its owner to the top** (score 1000, the same as an exact name) instead of appending it last with score 0 (`palette.ts:163–168`). Then `/s` shows `/status` first (steer second), `/p` shows `/panel` first, `/t` `/theme`, `/l` `/login`. Prefix candidates follow in today's score order — the user still sees `/steer`, `/plan`, `/trust`, `/llm` one row down.
3. **Ghost text follows the top row:** when the top match is an alias hit whose name does not extend the token, the ghost reads ` → /status` (dim) instead of nothing; `→` (composer:right at end of text, `App.tsx:1609–1613`) accepts it as `/status `. Prefix ghosts stay `+tatus (+N)`.
4. **Alias column:** command rows gain a 3-cell dim alias column between the name and the title (`▌ /status     s  run id, …`); `NAME_COL` 15 → 12 + 3 so the title budget is unchanged. Hidden below 50 columns (the flat tier at 40 wide keeps today's layout).
5. **Fuzzy rules unchanged** (prefix 900−len > word-prefix 700 > subsequence; ties shorter then table order, `fuzzy.ts:182–221`). Subsequence stays enabled so `ml`, `cp`, `rw`, `dc` still match their owners even before the alias lands, and typos like `/bdgt` still find `/budget`.
6. `/help` and `docs/COMMANDS.md` show aliases (today the help block hides them, `palette.ts:341–345`): `  /status, /s   run id, …`.

### 5.3 Tab completion of arguments (fixes F4)

`case 'complete'` (`App.tsx:1372–1384`) becomes: parse the draft with `parseCommandLine`; if the cursor is inside/after the name token → today's command completion; else `argIndex` = number of completed positional args, `partial` = the token under the cursor; `candidates = rank(partial, argumentCandidates(spec, argIndex, dispatchCtx()))`; Tab/Shift+Tab cycle `pal.selected` over them and **replace only the partial token**; the palette sub-rows filter to the same candidates (highlighting the selected one) so the overlay and the draft agree; a `run` candidate with spaces is inserted quoted (`/resume "fix the docs" `); `rest`/`text`/`path` arguments (`/rename`, `/steer`, `/why`, `/model <id>`, `/export <file>`) have no candidates → Tab is a no-op with the toast `no completions for <arg>` (path completion stays deferred with the `@` list, §22). After a value is accepted the value hint (`<usd>`, `<n>`, `<dur>`) shows as ghost text.

### 5.4 "Popular" and "Recent" groups; recently-used ordering

Order for an empty query: **Suggested** (state-keyed, unchanged) → **Recent** (≤ 3 distinct commands from `host.history()?.records('workspace')` with `kind === 'command'`, newest first, computed **once at palette open** and cached on `paletteRef`) → **Popular** (the 16-command set in a fixed order: help, mode, model, cost, status, resume, new, panel, plan, diff, undo, theme, login, budget, jev, exit) → the rest in table order. Rows carry a dim right-hand tag (`Suggested` today; `recent` new); Popular rows carry no tag — their alias column is the cue. With a non-empty query the groups collapse into today's score order (Suggested first), so typing is never reordered by popularity. The `rewindMenu` filter (`palette.ts:143`) is unchanged.

### 5.5 Argument enum hints

`valueHints` exist only for `/budget` (`registry.ts:282–289`). Add titles for `/mode` (from the badge-word table, P5 — e.g. `jev-on   jev+llm: the generator writes, Jev decides every step`, `llm-jev   llm+jev · verified: candidate patches, tests verify, Jev arbitrates`), `/panel` (`d decisions · p plan · t timeline · s synth · off strip · full 12 rows`), `/transcript`, `/theme`, `/copy`, `/logout`, `/help`, `/decisions` stages. The sub-rows already render them (`palette.ts:218–228`); the palette then doubles as inline documentation.

### 5.6 Keyboard shortcuts that exist, and what should map to commands (task item c)

| Key(s) (`docs/KEYS.md`) | Equals command | Gap |
| --- | --- | --- |
| `?` / F1 (`global:help`) | `/help` | rebinding ignored (F10) |
| Ctrl+O (`global:detail`) | `/why` for the step + `/errors` (and acks `!n`) | `/errors` should ack too (F18) |
| Esc / Esc Esc while live | `/pause` / `/abort` | — |
| Ctrl+C live, empty draft | `/abort` | — |
| ↑ on the first row with steers queued | `/unsteer` | — |
| Alt+J / Alt+Shift+J / Alt+D/P/T/S, `[` `]` | `/panel`, `/panel full`, `/panel d\|p\|t\|s` | Alt+D pty finding (STATUS deviation 17) |
| Ctrl+G (`composer:externalEditor`) | `/editor` | — |
| `session:export` (unbound) | `/export` | — |
| — | `/cost`, `/status`, `/mode`, `/theme`, `/diff`, `/undo`, `/copy` | propose **unbound-by-default** actions `session:cost`, `session:status`, `session:mode`, `files:diff`, `files:undo`, `ui:copy` (like `session:export`) so a user can bind e.g. `"session:cost": "ctrl+x c"`; no default keys (every free printable is text, every free Ctrl is a terminal risk) |

### 5.7 Visual layout

**A — measured today, 24×80 boxed, `/` just typed** (`palette-tab.cap` frame 8):

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│ ▌ /help          keys by context, commands with one-liners, per-terminal no… │
│   /new           end the session; the next prompt starts a new one here      │
│   /resume        pick a session to continue, or continue <id|title>          │
│   /rename        set the session title (≤ 60 chars)                          │
│   /steer         queue a directive for the next step (…) (live only)         │
│   (1/37)  Tab completes · Enter runs an exact match · Esc closes ▼           │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev-only ──────────────────────────────────────────────────── r4-ws-etHi4F ─╮
│ › /help +36                                                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ palette                                  step 0/–  sess $0.00/1.25 ok  Tab ⇥ │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**B — proposed, 24×80 boxed, `/` after a run that changed files, history holds `/cost` and `/status`** (alias column, Suggested → recent → Popular; same 8-row card, same footer):

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│ ▌ /undo       u  restore the files a step changed (…)              Suggested │
│   /cost       c  run and session spend, per-step cost, pending caps   recent │
│   /status     s  run id, session id, step/max, stage, sandbox, wo…    recent │
│   /help       h  keys by context, commands with one-liners, per-termina…     │
│   /mode       m  engine mode: show, or set for the next run                  │
│   (1/37)  Tab completes · Enter runs an exact match · Esc closes ▼           │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────── r4-ws-etHi4F ─╮
│ › /undo +36                                                                  │
```

**B′ — proposed, `/m` typed** (alias pins `/mode`; `/model` stays one row down; enum sub-rows carry the new hints; the ghost is the alias arrow):

```
╭─ commands ───────────────────────────────────────────────────────────────────╮
│ ▌ /mode       m  engine mode: show, or set for the next run                  │
│   /model     ml  generator model for the next run only                       │
│   /mode jev-on                    jev+llm: the generator writes, Jev decides │
│   /mode llm-jev                   llm+jev · verified: patches tests verify,… │
│   /mode jev-only                  no generating LLM; code proposes, Jev dec… │
│   (1/6)  Tab completes · Enter runs /mode · Esc closes                       │
╰──────────────────────────────────────────────────────────────────────────────╯
│ › /m → /mode +5                                                              │
```

**C — measured today, 12×60 flat tier** (`palette-narrow.txt`; the palette takes 7 of the 10 dynamic rows, no card edges):

```
▌ /help          keys by context, commands with one-liners,…
  /new           end the session; the next prompt starts a …
  /resume        pick a session to continue, or continue <i…
  /rename        set the session title (≤ 60 chars)
  /steer         queue a directive for the next… (live only)
  /unsteer       take the newest queued steer b… (live only)
  (1/37)  Tab completes · Enter runs an exact match · Esc c…
› /help +36
jev-only · palette       step 0/–  sess $0.00/1.25 ok  Tab ⇥
```

**D — proposed, 12×60 flat tier** (alias column kept at 60 columns; tags shortened to fit; the row budget is identical to C):

```
▌ /undo       u  restore the files a step chang… Suggested
  /cost       c  run and session spend, per-step co…  recent
  /help       h  keys by context, commands with one-liner…
  /mode       m  engine mode: show, or set for the next run
  /model     ml  generator model for the next run only
  /panel      p  Jev panel: toggle, open a tab (d|p|t|s),…
  (1/37)  Tab completes · Enter runs an exact match · Esc c…
› /undo +36
jev+llm · palette        step 0/–  sess $0.00/1.25 ok  Tab ⇥
```

Cell widths in B/B′/D are indicative; the snapshot test (§8.4) fixes them exactly as `palette.test.ts:79–96` fixes frame F-K today.

---

## 6. How the docs are generated (task item d)

`scripts/gen-docs.mjs` loads the TypeScript registries through `tsx` (`loadRegistries`, `:52–75`) and renders six targets (`TARGETS`, `:27–34`): `docs/COMMANDS.md` (`renderCommandsMd :100–110` — aliases as `alias \`/x\`` in the first column, flags appended to Semantics), `docs/KEYS.md` (`renderKeysMd :83–97`), `man/jevcode.1` (`renderMan :158–268` — INTERACTIVE COMMANDS lists `/name, /alias` and `(avail)`; the ENVIRONMENT paragraph hard-codes the mode list and the default, `:229`), and `completions/jevcode.{bash,zsh,fish}` (`:279–342`) which cover **CLI flags only** — slash commands and their aliases never reach the shells (correct: they are typed inside the TUI). `node scripts/gen-docs.mjs --check` is run by `registry.test.ts:186`; `registry.test.ts:171–184` asserts every command and alias is a `COMMANDS.md` row; `:238–255` asserts the man page names every `/command`.

So **a new alias propagates automatically** to `COMMANDS.md` and the man page once `gen-docs.mjs` is re-run (the `--check` test fails until then). What does not propagate: the help block (hides aliases, `palette.ts:341–345`), `docs/TUI.md` and `README.md` (hand-written prose), the man ENVIRONMENT mode list (F2). P2 and P5 below add the alias column to the help block and derive the mode list/default from `ENGINE_MODES` + `DEFAULT_MODE`.

---

## 7. Test plan (task item e)

1. **Every command has a dispatch test and a handler test.** Extend `dispatch.test.ts:207` (already loops `COMMANDS` through `dispatchCommand`) with a source-scan assertion: for each `COMMANDS[i].name` there is (a) a `/name` literal in `test/unit/tui/commands/dispatch.test.ts` outside the loop and (b) a `case '<kind>'` in either `App.tsx` `runCommand` or `session.ts` `execute()` **and** a test file that drives that kind (`session.test.ts`, `app.test.tsx`, `round2-app.test.tsx`, `plain-composer.test.ts`); today `calibration`, `report`, `history`, `copy`, `trust`, `panel`, `transcript` would fail (b). Make `execute()` exhaustive with `default: assertNever(a)` so TypeScript enforces (b)'s first half.
2. **Alias uniqueness and pin rule** (`registry.test.ts`): aliases ∪ names unique (exists, `:95`); every alias matches `NAME_RE`; popular aliases ≤ 2 characters; for every alias `paletteMatches('/'+alias)[0].spec.name === owner`; `paletteGhost` for a non-prefix alias yields `{ arrow: '/owner' }`; `isExactCommand('/'+alias)`; `routeSubmit({ text: '/'+alias, overlay: 'palette' })` runs the owner.
3. **pty scenario per state for the popular set** (`test/pty/round2.pty.test.ts` + three `test/pty/smoke/commands-{idle,live,thinking}.steps`): idle after a mock run (`/h /m /c /s /r /n /p /pl /d /u /t /b /j`, each answered by its item or overlay, then Esc), live during a 200-step mock run (`/c /s /m /p /d /b /j` answer; `/u /r /n` answer `runs when the run is idle`; `/a` aborts), thinking under `JEVCODE_MOCK_JEV_MS=3000` (`/s /c /h` answer while `⠹ thinking`, `/n` toasts `one moment — still thinking`). Every scenario keeps the smoke's gates (0 clears, one `RESTORE`, no key bytes) and asserts the draft is empty after each answered command.
4. **Palette snapshot**: `paletteLines` fixtures at 24×80 (boxed: inner 76) and 12×60 for `''`, `/m`, `/b`, `/budget spend-cap` (argument mode) with the Suggested/recent/Popular states — pinned as frames in `docs/TUI-DESIGN-3.md` and read back by the test like `frameFKRows()` (`palette.test.ts:24–35`), so the doc and the renderer cannot drift.
5. **Identity**: `twins.pty.test.ts`-style assertion that `/help`, `/why <bad>`, `/decisions 3 risk`, `/theme light`, `/new` (no session) produce the same `[ui]` item text in the TUI `<Static>` rows and in `--plain` (the shared formatters of P4, P7, P9, P10, P11).
6. **Keybindings wiring**: `app.test.tsx` mounts with `bindings` from `loadKeybindings` of a temp file mapping `global:help` to `none` and asserts `?` inserts text; a pty scenario with `--keybindings` asserting the same, and `/help reload` swapping the binding live.
7. **Perf**: `src/perf/composer-latency.ts` `palette` series stays the gate (p95 < 16 ms, max < 50 ms) with the alias column and groups on; the `first-frame` probe (< 300 ms, no config before the frame) is untouched because nothing here runs before `/` is pressed; `render-lag` dynamic ≤ maxFps+1 because no new timer is added; `states palette` 24×80/12×60 (0 clears) re-recorded with the new rows.

---

## 8. Proposals

Each: **what** · **where** · **edge cases** · **tests** · **perf gate**.

1. **Tab completes arguments; never wipes a typed one (F4).** What: §5.3. Where: `App.tsx` `case 'complete'` (`:1372–1384`), `paletteRows` sub-row filtering (`palette.ts:218–228`), a `paletteArgState` on `paletteRef`. Edge cases: cursor in the middle of a token (complete the token under the cursor, keep the tail); a `run` title containing quotes (escape `"`); zero candidates (toast, no change); Shift+Tab wraps; a command with two enum args (`/decisions 5 ri` → stage candidates at index 1); `--flags` before positionals are skipped when counting `argIndex`. Tests: `app.test.tsx` new case after `:451` (`/budget sp` Tab → `/budget spend-cap `, Tab again cycles; `/budget spend-cap` Tab keeps the value), `dispatch.test.ts:219` extended, pty `commands-idle`. Perf: palette keystroke → frame p95 < 16 ms (`composer-latency` `palette`); candidates are ≤ 37 names, ≤ 8 values, ≤ steps, or the session index (≤ 1,000 titles → `rank` ≤ 1 ms per `fuzzy.test.ts`).
2. **Shortcut aliases with the pin rule, alias arrow ghost and alias column (F22, F23).** What: §5.1–5.2 tables; `paletteMatches` scores an exact alias hit 1000 and keeps prefix-alias hits at their name score instead of 0; `paletteGhost` returns `{ rest, more }` or `{ arrow: '/owner' }`; `paletteRows` gains the alias column (hidden < 50 columns); `helpLines` prints `/status, /s`. Where: `registry.ts` rows (24 alias strings), `palette.ts:133–180, 187–232, 341–345`, `Overlay.tsx:195–216` (`PaletteRowText` renders the alias dim), `Console.tsx:150–165` (ghost arrow), `App.tsx:1609–1613` (→ accepts an arrow ghost), regenerate `docs/COMMANDS.md` + `man/jevcode.1`. Edge cases: `/quit` keeps working; `/x` while idle offers `/exit` (any) — Enter exits, so the alias column must show `x` on the exit row to avoid surprise; `/a` idle is dim `(live only)`; `/h reload` still works; the Esc Esc rewind menu keeps its four rows; `--ascii` uses `->` for the arrow. Tests: §7.2, `palette.test.ts` new rows, `registry.test.ts:85` `EXPECTED` aliases, `submit.test.ts:40`. Perf: same 16 ms gate; ranking stays O(37).
3. **Popular and Recent groups (§5.4).** Where: `palette.ts` (`PaletteState.recent: readonly string[]`, `POPULAR` constant in `registry.ts`), `App.tsx` `openPalette` (`:824–833`) computes `recent` once from `bridge.host?.history()?.records('workspace')` (`FileHistoryStore.records`, `history.ts:77, 293`); `paletteState()` (`App.tsx:808–811`) passes it. Edge cases: `--no-history`/`JEVCODE_NO_HISTORY=1` (recall still works — `records` reads the loaded entries); a history entry for an alias (`/s`) resolves to its owner before de-duplication; an errored command is never in history (App appends only on success, `App.tsx:934, 1049–1052`); the plain composer has no palette (nothing to do). Tests: `palette.test.ts` group order; `app.test.tsx` with a fake `historyStore.records`. Perf: the history read happens at open, not per keystroke (the store is already loaded in the startup tick, `session.ts:3462–3482`); no first-frame impact.
4. **`/mode` echo (F1).** What: `const cur = live() && current !== null ? currentRunMode : baseMode;` (`session.ts:2774`) so the idle item reads `mode jev-only (next run: jev+llm)`, and after the pending mode is promoted at `run:start` (`:1883`) both words agree. Where: `session.ts:2774`. Edge cases: `pending.mode === baseMode` → `already`; llm-jev pending under jev-on live. Tests: `session.test.ts:126–150` (assert `mode jev-only (next run: jev+llm)`), `round2.pty.test.ts:367` (asserts the first word today only loosely). Perf: n/a (identity: the one string changes in the one place both renderers use).
5. **One mode table for the default flip (F2).** What: `export const DEFAULT_MODE: EngineMode = 'jev-on'` (owner decision; flip later to `'llm-jev'`) and `export const MODE_TABLE: Readonly<Record<EngineMode, { badge: ModeBadge; set: string; hint: string }>>` with `llm-jev → { badge: 'llm+jev · verified', set: MODE_LLM_JEV_SET, hint: 'candidate patches tests verify; Jev arbitrates' }`; `modeBadgeWord`/`MODE_*_SET`/`valueHints` of `/mode` read from it; `/mode` with no argument appends ` (default)` after the badge equal to `DEFAULT_MODE`; the palette sub-rows mark the default; `gen-docs.mjs:229` derives `ENGINE_MODES.join(' | ')` and `(${DEFAULT_MODE}, the default)`; `registry.ts:67` comment and `docs/TUI.md` Modes stop naming a default. Where: `src/tui/status/lines.ts:107–113`, `session.ts:241–244, 2792`, `registry.ts:67–73, 327–347`, `scripts/gen-docs.mjs:229`. Edge cases: `/llm off` = `jev-only` regardless of default; `--mode` flag and `JEVCODE_MODE` still override; the badge word table must keep `jev+llm` for `jev-on` (pty sentinels `BADGE_JEV_LLM`, `helpers.ts:82`). Tests: `registry.test.ts:123` strings, a test that greps `src/**`, `scripts/**`, `docs/COMMANDS.md`, `man/jevcode.1` for `, the default` outside the table; `gen-docs --check`. Perf: n/a.
6. **Plain twins for `/panel` and `/transcript`; exhaustive `execute()` (F3, G5).** What: `case 'panel'` prints `panelStrip`/`panelLines` rows for the requested tab (`src/tui/pane/model.ts` `panelLines`, size `open` = 6 / `full` = 12) as a `block('panel · <tab>')`; `case 'transcript'` in plain answers `transcript full (--plain is always full)`; in the TUI the host cases are reached only for `/Panel`-style spellings and the wizard-open path, where they should dispatch `extras.dispatch({ type: 'panel' … })` like `mode` does; add `default: assertNever(a)`. Where: `session.ts:2674–2858`, `plain-composer.ts:53` (`/transcript` stays refused or becomes the one-line answer — pick the answer, and set `plain: 'always full'` in the registry). Edge cases: no decisions yet → `(no decisions yet)`; `/panel s` before a synth run; `--ascii` glyphs. Tests: `session.test.ts` new; `plain-composer.test.ts:304`. Perf: identity gate — the panel rows are dynamic in the TUI and a `[ui]` block in plain; document that this item is plain-only (like the picker rows, `session.ts:2660`).
7. **`/theme` through the host (F5).** What: the App keeps applying the theme immediately (no round trip) **and** forwards the line to `host.command` so `themeOverride` is set, `/config` agrees, `applyConfig` preserves it, and the `[ui] theme <t> (new items and the dynamic region only)` item appears in both renderers. Where: `App.tsx:986–992` (call `h?.command(line)` after `bridge.notify()`), `session.ts:2811–2818` (`renderer.setUi` is idempotent for the App). Edge cases: no host yet (splash phase) → local only, item deferred; `NO_COLOR` → the note still prints; theme `ansi` on a truecolor terminal. Tests: `app.test.tsx` (host.commands contains `/theme light`; `bridge.ui.theme` survives a `setUi`), `session.test.ts:645` unchanged. Perf: identity gate (one shared string), zero clears (theme changes recolour, never re-layout).
8. **`/copy diff` copies a diff (F7).** What: for `what === 'diff'` the App asks the host: `host.command('/copy diff')` → the host builds `diffStatBlockFromGit(...)` (or `diffStepLines` for the last changed step) exactly as `/diff` does (`session.ts:2279–2336`), then `copyFn(text, redact, { osc52 })` and the toast; `/copy` and `/copy proposal` stay App-local. Where: `App.tsx:1038–1043`, `session.ts:2819–2832`. Edge cases: no run (`nothing to copy for diff`), not a git repo (fall back to the step pre-image diff), payload > 64 KiB (clipped, toast says so — `clipboard.ts:15`), no clipboard tool and no `--osc52` → `COPY_FAILED_TOAST`. Tests: `session.test.ts` with a fake `copy` dep asserting the payload starts with `diff`; `app.test.tsx` (G2). Perf: n/a (a command).
9. **`/decisions` honours `stage` and `n` identically (F6, F11).** What: either route `/decisions` and `/plan` to the host in the TUI (one source of truth, identity by construction), or make the App filter `paneStateOf(s).rows` by `action.stage` and take the last `n`. Recommended: host-routed, with the App keeping only the live-region commands (`steer`, `unsteer`, `pause`, `abort`, `exit`, `editor`, `copy last/proposal/draft`, `theme` display). Where: `App.tsx:974–985`, `session.ts:2547–2560`. Edge cases: while a run is live the host's `decisions` array is the current run's (kept 400, `DECISIONS_KEPT_FOR_COMMANDS`); after a greeting the pane shows intake rows the host keeps in `chatIntakes` — `/decisions` should include the last intake's rows when `currentStep() === 0`. Tests: `session.test.ts:563` extended with a stage filter; identity test §7.5. Perf: n/a.
10. **One `/why` failure text (F8).** What: `whyErrorText(ref, reason)` in `src/tui/why.ts` used by both; the App's local lookup keeps its fast path but falls through to the host when it finds nothing (the host has 400 decisions, the App only the pane projection). Where: `App.tsx:945–973`, `session.ts:2562–2578`. Tests: identity §7.5, `session-chat.test.ts:718`. Perf: n/a.
11. **One help formatter (F9).** What: `session.ts` `helpLines(topic, { live })` is deleted; the controller calls `palette.ts` `helpLines(columns(), { ascii, topic, bindings })` and marks `(idle only)`/`(live only)` per the live state like today's plain form (add `live?: boolean` to the palette formatter so both twins print the same tags). Where: `session.ts:954–972, 2688`, `palette.ts:302–360`. Edge cases: `columns()` on a pipe = 80; the ≤ 60-line ladder applies to plain too; `HELP_TERMINAL_NOTES` (`session.ts:190`) duplicated in `palette.ts:248` `HELP_NOTES` — keep one. Tests: `session.test.ts:541–549` (the `/exit  leave …` expectation changes to the two-space-indented form), `palette.test.ts:235`. Perf: identity gate; the block is a transcript item in both.
12. **Wire keybindings to the App; make `/help reload` real (F10).** What: `createSessionController` passes `keybindings.bindings` to the renderer (`renderer.setBindings?.(b)`) right after loading (`session.ts:3465`) and again in `case 'help' reload` (`:2680`); the App stores them in a ref used by `resolveKey` (`App.tsx:1739, 1743`) and `helpLines` (`:940, 1310`). Where: `App.tsx:317–323` (`Renderer` gains `setBindings?`), `:553`, `session.ts:3465, 2680`, `src/core/types.ts` `Renderer`. Edge cases: a chord in flight when the table swaps (reset `armed.chord`); reserved keys refused (already, `keybindings-file.ts`); `--keybindings` file missing → defaults + one log line. Tests: §7.6. Perf: `resolveKey` reads a Map — unchanged; composer p95 gate.
13. **`/trust` cancellable, no stale note (F17).** What: the trust card opened by `/trust` gets a `reason: 'trust'` reopen: Esc and Ctrl-C **close it** (like the `mode` wizard, `mode-switch.steps`) and resolve `null`; `case 'trust'` prints `trust unchanged (<decision>)` when `trustGate` returned without a new decision and only prints `workspace trusted (…)` on a fresh answer; `Enter` stays inert (no default, §6.2 spirit). Where: `tui-prompter.ts:194–207`, `Wizard.tsx` (the startup `onExit(2)` rule, STATUS deviation 13 only for `reason === 'missing'` at startup), `session.ts:2807–2810, 1568`. Tests: `app.test.tsx:1385` sibling for the trust reopen; pty `trust-esc` (this probe, expected exit 0). Perf: n/a.
14. **`/logout` label (F16).** What: `commandLogout` takes `io.labelled = false` (or the session's writer strips a leading `[setup] `). Where: `src/cli/login.ts:648, 662, 673`, `session.ts:2609`. Tests: `session.test.ts:1091–1098` assert the single label. Perf: n/a.
15. **Small item fixes: `/new` with no session, `/rename` cut notice, `/model` / `/provider` show forms (F12, F13, F15).** What: `/new` without a session → `[ui] no session yet — the next prompt starts one`; `/rename` appends ` (cut to 60 chars)` when `title.length > 60`; `/model` and `/provider` with no argument print `model <current> (next run: <pending>)`; setting either under `jev-only` appends ` — mode jev-only ignores the generator; /llm on to use it`; setting `/model` when the pending/base provider is `openrouter` and the id has no `/` (or vice versa) appends a soft warning, never an error (`ConfigError` at run start remains the hard check). Where: `session.ts:2690–2702, 2712–2718, 2763–2770`, `registry.ts:304–326` (`optional: true`), `dispatch.ts:333–347`. Tests: `session.test.ts:541–571`, `dispatch.test.ts:152`. Perf: n/a.
16. **Commands while thinking (F14).** What: `routeSubmit` gets `allowCommandsWhileSubmitting` (or the App skips the `submitting` guard for `isCommandLine(text)`); `dispatchCommand` sees `run: 'none'` while `chatThinking(s)` (a chat request is not a run); idle-only commands during thinking answer the toast `one moment — still thinking` (`STILL_THINKING_TOAST`) instead of `Esc pauses first`; `/exit` while thinking cancels the request and exits. Where: `App.tsx:1074–1077, 1090`, `submit.ts:150`, `dispatch.ts:225`. Edge cases: `/steer` while thinking → `needs a live run`; a command Enter must not clear `thinking`; a reply landing mid-command keeps ordering (`say()` rows after the command's block). Tests: `round2-app.test.tsx:89` extended; pty `commands-thinking` (§7.3). Perf: intake bubble/reply p95 gates unchanged (no extra render).
17. **Draft-keeping rule (F21).** What: keep the draft for fixable errors (unknown command, tokeniser, bad argument) and **clear it** for availability errors (`needs a live run`, `runs when the run is idle`, `not available in --plain`) and for `[ui] error:` results of a successfully dispatched command (as `/why` already does). Where: `App.tsx:1100–1102` (`case 'error'`: clear when `decision.text` matches the availability sentences — better: `DispatchResult` gains `keepDraft: boolean`), `dispatch.ts:83–93`. Edge cases: the palette overlay closes on a cleared draft; history never records the errored line. Tests: `submit.test.ts:32`, `app.test.tsx:451` (`/budgett` keeps), a new case (`/undo` live clears). Perf: n/a. **Owner decision needed** (changes a §4.9 sentence).
18. **`/errors` acks `!n` (F18).** What: the host's `errors` block is followed by `extras.dispatch({ type: 'ack-errors' })`. Where: `session.ts:2839–2841`. Tests: `app.test.tsx:1263` sibling for `/errors`. Perf: n/a.
19. **Test additions of §7** (G1–G5) as their own commit before the behaviour changes, so every proposal above lands against a failing test.

---

## 9. Constraint check per proposal

| Constraint | Touched by | How it holds |
| --- | --- | --- |
| First frame < 300 ms, zero network before it | none | the palette, history and aliases are consulted only after `/` is pressed; `keybindings.bindings` is already read in the post-first-frame tick |
| Zero clears outside shrink resizes | 1, 2, 3 | the palette stays ≤ `CAP.palette` 8 rows; the alias column changes no row count |
| Composer keystroke → frame p95 < 16 ms (D-F) | 1, 2, 3, 12 | ranking stays O(37) per key; Recent is computed at open; `resolveKey` swaps a Map reference |
| Dynamic frames ≤ maxFps+1 | all | no new timers or animations |
| `--plain` / `transcript.log` / TUI identity | 4, 6, 7, 9, 10, 11, 15 | every changed item string moves into one formatter shared by both renderers with a test |
| Keys never printed or logged | 8 (clipboard), 13 (trust card) | `/copy` still goes through `redact`; the trust card prints no key |
| No auto-approve | 13 | Enter stays inert on the trust card; only `1/2/3` answer |
| Reduced motion / SR | 2, 3 | text-only changes; SR draws the same rows |
| Flat tier < 16 rows; SSH fps 15 | 2, 3 | mock D fits 12×60 with today's 7-row budget; alias column hidden < 50 columns |
| No new dependency; strict types | all | `Record<EngineMode, …>` tables and `assertNever` only |

---

## 10. Open questions for the owner

1. **F21 / P17** — do availability errors keep the draft (design §4.9 today) or clear it? Measured chains show the kept draft turning the next command into `/steer x/pause`.
2. **P2 aliases `x` and `a`** — `x` for `/exit` mirrors Vim habits but `x` in the picker is "delete"; `a` for `/abort` is a one-letter alias for a destructive live command (the palette dims it idle; Enter still runs it live). Keep, or drop both?
3. **P5** — should `/mode` with no argument show ` (default)` next to the badge equal to `DEFAULT_MODE`, and should the palette sub-row for the default mode be pinned first?
4. **P6** — `/transcript` in `--plain`: keep the `n/a` refusal or answer `transcript full (--plain is always full)`? The registry row's `plain` column has to say one of the two.
5. **P9** — host-routed `/decisions` and `/plan` (identity by construction, one extra round trip ~1 ms) versus App-local with a duplicated filter.
6. **F10 / P12** — this is a round-2 gap outside "commands" proper; it is listed here because `/help reload` is a command that currently reports success for nothing. Confirm R4 owns the fix or hand it to the keys topic.
7. **`/steer` shortcut** — the popular list in the task omits it; `st` is ambiguous with `status` and Enter-while-live already steers. Leave unaliased?
