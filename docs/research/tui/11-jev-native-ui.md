# 11 — A Jev-native terminal UI: surfacing calibrated decisions, risk, plans and search progress

Status: research notes for the interactive-TUI design, written 2026-09-20. Every external claim carries its
URL and the fetch date; repo facts carry a file path (and line numbers where they matter). Items that could
not be verified from a primary source are marked **UNVERIFIED** with what was tried. Sibling notes:
`docs/research/01-ink-stack.md` (Ink 7.1.1 rendering model, `useInput` gotchas) and
`docs/research/05-cli-architectures.md` (Codex/Claude Code/Gemini architecture, permission modes) are
cross-referenced, not repeated.

## 0. Method

Read first (all in this repo, 2026-09-20): `README.md`; `docs/DESIGN.md` §5 (Jev integration, lines
1867–2209), §6 (step loop, 2210–2505), §10 (TUI, 2896–2974), §12 (performance, 3029–3111), §13 (bench,
3112–3349); `docs/JEV-ONLY-DESIGN.md` §1–2 and §5; `src/jev/confidence.ts`; `src/loop/stages/risk.ts`;
`src/tui/{App,useEngine,Decisions,StatusLine,Confirm,Transcript}.tsx`; `src/tui/plain.ts`;
`src/cli/{main.tsx,args.ts}`; `src/core/types.ts` (Decision, RiskAssessment, Plan, EngineEvent, StepRecord,
StepTiming, RunResult); `src/checkpoint/store.ts`; `src/synth/**` (the `synth` events actually emitted).

Fetched (WebFetch/curl, 2026-09-20): Unicode `NamesList.txt` and `EastAsianWidth.txt` (18.0.0), Wikipedia
Block Elements / Braille Patterns / Words of estimative probability, `holman/spark`, `sindresorhus/sparkly`,
`tqdm/std.py`, `rich/progress_bar.py`, `asciimoo/drawille`, `kroitor/asciichart`, Sherman Kent's CIA PDF,
Guo et al. 2017, Naeini et al. 2015, Murphy & Winkler 1977, Hullman et al. 2019, Correll & Gleicher 2014,
Padilla/Kay/Hullman 2021 (Crossref abstract), Kay et al. 2016 and Fernandes et al. 2018 (metadata only),
WCAG 2.1 SC 1.4.1, no-color.org, `gh config` manual, GitHub's accessibility blog, `charmbracelet/huh`,
k9s README, lazygit keybindings, `git log` docs, GitHub Actions workflow commands, GitLab job-log sections,
Buildkite log groups, `gh run view`, Terraform `plan`, opencode permissions docs + `packages/tui/src/routes/
session/permission.tsx` + `packages/opencode/src/permission/index.ts`, Claude Code permissions and
interactive-mode docs, Codex `codex-rs/tui/src/bottom_pane/approval_overlay.rs` + `keymap.rs`, Gemini CLI
`ToolConfirmationMessage.tsx` + `BaseSelectionList.tsx`, Warp issue #9696.

Measured (scratch scripts in `/tmp/jevtui/`, Node 22.23.2, this machine): glyph widths through Ink's own
`string-width` 8.2.2; string-building and `stringWidth` cost of bar rows; Ink re-render cost of a 12-row
pane with and without bar glyphs via `ink-testing-library` 4.0.0 (repo `node_modules`, nothing installed).

## 1. What exists per step (the data the UI can draw)

| Stage / event | Fields available to the TUI | Where |
| --- | --- | --- |
| `decision` (one per question, 3–4 requests per step) | `step, stage, id, question (instructions + criteria), answer (noul p \| choice + probabilities + confidence \| score + probabilities + legend), probability, confidence (harness), verdict? (ok/review/block/chosen/overridden/fallback), latencyMs (parent request), requestHash, servedModel?` | `src/core/types.ts` lines 152–169 |
| `jev:request` (one per HTTP request) | `step, stage, requestHash, latencyMs, questions, usage {inputTokens, outputTokens, costUsd, calls}, model, attempts` — "the metric source for Jev latency" | `types.ts` 171–181 |
| `intent` | `intent` (effective), `answer` (raw, may be `none_of_these`), `probability`, `confidence` | `types.ts` 814 |
| `context` | `files[], bytes, candidates` (one Noul per candidate went to Jev; selection p ≥ 0.5, cap 12 files / 60 KB) | `types.ts` 815; DESIGN §5.5 |
| `proposal` | `proposal.goal`, `action` (edit/write/patch/run/read/done), `plan` draft | `types.ts` 821 |
| `risk` | `risk.dims[destructive\|out_of_scope\|plan_mismatch\|irreversible] = { risk, probability (P argmax level), expected, tailMass, bound: 'expected'\|'tail', confidence, level }`, `risk.risk`, `verdict` (bands 0.3 / 0.7), `reason` (names the dimension(s) at the max, the level text, the bound, Jev confidence) | `types.ts` 218–233; `src/loop/stages/risk.ts` `assessRisk` |
| `confirm:request` / `confirm:resolved` | `{ id, step, proposal, risk }`; `{ approved, aborted }` | `types.ts` 425–430, 823–824 |
| `exec:start/output`, `outcome` | status `executed \| noop \| blocked \| declined \| failed \| interrupted`, `exec { exitCode, killedBy, truncated, orphans, durationMs }`, `changedFiles` | `types.ts` 96–104 |
| `judge` | `succeeded, errorPresent, newInfo` (probabilities), `tests` (parsed counts or judged p), `doneClaims[] { text, judged, accepted }`, `completion` (task_complete p) | `types.ts` 235–252 |
| `plan` | `done[] (evidence step, judged p)`, `remaining[]`, `unverified[]` (0.3 ≤ p < 0.7), `openProblems[]`, `harnessProblems[] { kind: replan\|rejected_claim\|stale_plan, text, step }`, plus `rejectedDone[]`, `unverifiedDone[]` | `types.ts` 55–70, 828 |
| `loop:tripped`, `replan` | `signature, occurrences`; `directive { move, probability, confidence, taskImpossible, text }` | `types.ts` 207–214, 829–830 |
| `stage:start/end`, `step:end` | per-stage `ms`; `StepRecord.timing { generatorMs, jevMs, execMs, harnessMs, totalMs }`, `loopSignatures[]`, `usage`, `decisions[]`, `jevRequests[]` | `types.ts` 264–297, 810–811, 832 |
| `status` | `step/maxSteps, wallMs/maxWallMs, stage, spend { generator, jev, capUsd, exceeded }, stopReason` | `types.ts` 796–804 |
| `synth` (jev-only) | `phase: string, detail: string, candidates?, tested?` — phases actually emitted today: `verify` (`src/synth/sieve/runner.ts:435`, `candidates: dispatched, tested: outcomes.length`), `directive` (`src/synth/search/directive.ts:132`), `stale_sites` (`directive.ts:286`), and a generic emitter at `src/synth/search/index.ts:247`; the design also names a per-step `ledger` line (`docs/JEV-ONLY-DESIGN.md` §5.2) | `types.ts` 807 |

Harness arithmetic the UI must show faithfully (`src/jev/confidence.ts`): Choice confidence
`(p_chosen − 1/n)/(1 − 1/n)`; Score confidence `1 − Σ_k p_k·|k − k*| / U_n` with `U_5 = 1.2`; Noul
confidence is *derived* `|2p − 1|` and the pane labels it so (`Decisions.tsx` `DERIVED_LABEL`); risk per
dimension is `max(E[k]/(n−1), P(k ≥ 3))` for harm dimensions and tail mass only for alignment dimensions,
computed in integer hundredths (`riskFromProbabilities`, `mode: 'harm' | 'alignment'`); verdict `block` iff
`r100 ≥ 70·(n−1)`, `review` iff `≥ 30·(n−1)`. Wire probabilities are two-decimal (DESIGN §5.3) and the
measured answer noise is sd 0.020–0.026 in the 0.55–0.80 band and 0.000 at 0.98–0.99
(`docs/research/06-jev-shapes-and-question-design.md` rule 6, citing `JR/REPORT.md:145`).

What is *not* emitted today and matters for the proposals: loop-signature counts below the trip (only
`loop:tripped` at 3, `types.ts` 829; but `step:end` carries `loopSignatures[]`, so the TUI can count);
a structured sieve-vs-rank flag on `synth` (only free text `detail`); the human's approve/decline is in
`confirm:resolved` and in `steps.jsonl` as `outcome.status === 'declined'`, not in `decisions.jsonl`.

Rendering contract already in force (DESIGN §10, §12; `App.tsx`): `<Static>` for committed items; dynamic
region ≤ `rows − 2` made of fixed-height `overflow="hidden"` boxes (status 1, rule 1, live 2, confirm header
6 + preview ≤ 8, decisions ≤ 12, decisions shrink first); one `useInput` gated by
`Boolean(isRawModeSupported)`; keys `y`/`n`/Ctrl-C only; ≤ 20 fps live coalescing; zero `\x1b[2J` after the
first frame (gate at rows 12 and 40). Ink 7.1.1's `shouldClearTerminalForFrame` (`node_modules/ink/build/
ink.js` lines 89–101) clears whenever `previousOutputHeight > viewportRows` or the frame is overflowing with
a previous frame, and then writes `ansiEscapes.clearTerminal + this.fullStaticOutput + outputToRender`
(line 768) — every proposal below is costed against that budget.

## 2. What makes a Jev-decides harness unique, and what that implies for the UI

1. **The decisions are the product.** In Claude Code/Codex/opencode the model's prose is the primary
   content and approvals are exceptions. In JevCode every control-flow choice is a *typed question* with a
   *calibrated probability* and a *rubric*, made 10–30 times per step (DESIGN §5.5: intent Choice + 5 paired
   Nouls + `plan_still_valid`; one Noul per candidate file; 4 Scores + `matches_intent`; 4–12 judge Nouls).
   The transcript already commits one line per stage; the decisions pane is the only place the *reasoning*
   is visible. Implication: decision rows deserve first-class visual treatment (bars, markers, drill-down),
   not a debug dump.
2. **Probabilities are two-decimal and noisy at ±0.02.** Rendering more precision than the wire carries, or
   implying that 0.69 and 0.71 differ, would misrepresent Jev (research 06 rule 6). Implication: bars with
   at most ~10–20 cells, two decimals, explicit band markers, and a "near a threshold" flag rather than false
   precision.
3. **Thresholds are code, not Jev.** Bands 0.3/0.7 for risk, 0.85 for completion, 0.7/0.3 for plan claims,
   0.5 for context selection and paired-Noul floors (DESIGN §5.4 rule 6). Implication: the UI must show *which
   rule* consumed each number (verdict marker, bound used, threshold), the way `terraform plan` shows the
   action symbol and a summary before anything runs (https://developer.hashicorp.com/terraform/cli/commands/plan,
   fetched 2026-09-20: `+` create, `-` destroy, `~` update in-place, `-/+` replace; "The plan command alone does
   not actually carry out the proposed changes").
4. **The reviewer approves an action Jev already scored.** The human is a second gate for the 0.3–0.7 band
   only; nothing is auto-approved (DESIGN §6 risk policy; README "no auto-approve"). Implication: the review
   prompt must show Jev's *why* (level text, bound, confidence per dimension), and must not offer any
   remembered approval — a remembered rule would bypass a per-action calibrated gate (see §3.5 and §4j).
5. **Three renderers must agree line for line** (TUI `<Static>`, `--plain`, `transcript.log`; DESIGN §10).
   Implication: every new visual has a one-line text form first; bars are decoration over that text, never the
   only carrier (WCAG 1.4.1, §3.3).
6. **Jev-only mode has no prose stream at all**: the live region shows the last `synth` line
   (`App.tsx` `liveLines`). Implication: search progress (sieve vs rank, candidates/tested, phase, test runs)
   is the primary live content and needs a structured event, not a string.
7. **Budgets are first-class and code-owned** (spend cap, wall, steps, replans; DESIGN §6 Budgets).
   Implication: cost/latency belong in the status line as meters against caps, in the k9s header style
   (cluster CPU/MEM at a glance; https://raw.githubusercontent.com/derailed/k9s/master/README.md, fetched
   2026-09-20).
8. **Everything is checkpointed and auditable** (`decisions.jsonl`, `jev.jsonl`, `steps.jsonl`;
   `src/checkpoint/store.ts` lines 32–34). Implication: a `/why` drill-down and a `/calibration` summary can
   be computed from files, offline, with zero engine changes.

## 3. Prior art

### 3.1 Bars and sparklines in a terminal cell grid

Glyph inventory (primary: Unicode 18.0.0 `NamesList.txt`, https://www.unicode.org/Public/UCD/latest/ucd/NamesList.txt,
fetched 2026-09-20): `2581 LOWER ONE EIGHTH BLOCK` … `2587 LOWER SEVEN EIGHTHS BLOCK`, `2588 FULL BLOCK`;
`2589 LEFT SEVEN EIGHTHS BLOCK` … `258F LEFT ONE EIGHTH BLOCK`; `2591 LIGHT SHADE`, `2592 MEDIUM SHADE`,
`2593 DARK SHADE`; `2800 BRAILLE PATTERN BLANK` … `28FF BRAILLE PATTERN DOTS-12345678` (256 patterns; the
chart note reads "When braille patterns are punched, the filled circles shown here correspond to punch
impression"). Wikipedia adds the practical caveat that "the block does not contain a space character of its
own and ASCII space may or may not render at the same width as Block Elements glyphs"
(https://en.wikipedia.org/wiki/Block_Elements, fetched 2026-09-20) and that "The current Unicode charts, and
some fonts, use empty circles to indicate dots that are not punched" in braille
(https://en.wikipedia.org/wiki/Braille_Patterns, fetched 2026-09-20).

Width classes (primary: `EastAsianWidth.txt` 18.0.0, https://www.unicode.org/Public/UCD/latest/ucd/EastAsianWidth.txt,
fetched 2026-09-20): `2580..258F ; A` (ambiguous), `2590..2591 ; N`, `2592..2595 ; A`, `2500..254B ; A`
(light/heavy box drawing, i.e. the `─` already used for `RULE_CHAR`), `2800..28FF ; N`, `25A0..25A1 ; A`
(■ □), `25B2..25B3 ; A`, `25BC..25BD ; A`, `25C6..25C8 ; A`, `25CB ; A` (○), `2610..2613 ; N` (☐ ☑ ☒),
`26A0 ; N` (⚠). Ink measures with `stringWidth(text)` and no options (`node_modules/ink/build/output.js:19`),
and `string-width` 8.2.2 defaults to `ambiguousIsNarrow = true` (`node_modules/string-width/index.js:156`),
so every glyph above is counted as one cell. **Measured** (2026-09-20, `/tmp/jevtui/width.mjs` through the
repo's `string-width`): `▁▂▃▄▅▆▇█`, `▏▎▍▌▋▊▉█`, `░▒▓`, `⠀⣀⣤⣶⣿⡇⢸`, `─│┼╭╮╰╯━╸╺`, `✓✗●○◆◇▲▼■□`, `☐☑☒`
all width 1 per glyph; `⚠️` (U+26A0 + VS16) is width **2**, so use bare `⚠` or ASCII `!`. Risk: in a CJK
locale a terminal may draw the `A`-class blocks double-width while Ink lays them out as one cell → misaligned
rows. JevCode already accepts this for `─`; an `--ascii` theme is the mitigation (§4, §6).

Sparkline prior art: `holman/spark` defines `ticks=(▁ ▂ ▃ ▄ ▅ ▆ ▇ █)`, scales `(((n−min)<<8)/f)` with
`f=((max−min)<<8)/(ticks−1)` and on a flat series switches to `ticks=(▅ ▆)` (min==max rescale)
(https://raw.githubusercontent.com/holman/spark/master/spark, fetched 2026-09-20). `sindresorhus/sparkly`
uses the same eight ticks, takes `options.minimum/maximum` (defaulting to the finite min/max) and renders
non-finite values as a space (https://raw.githubusercontent.com/sindresorhus/sparkly/main/index.js, fetched
2026-09-20). Lesson: per-frame min–max rescaling makes consecutive frames incomparable; JevCode should pin
the scale (e.g. 0–1000 ms for Jev latency, 0–cap for spend). Progress bars: tqdm's default charset is
`" " + ''.join(map(chr, range(0x258F, 0x2587, -1)))` (left-eighth blocks) with ASCII fallback
`" 123456789#"`, and picks the partial cell with `divmod(int(frac * N_BARS * nsyms), nsyms)`
(https://raw.githubusercontent.com/tqdm/tqdm/master/tqdm/std.py, fetched 2026-09-20). Rich uses `━` with
half-cells `╸`/`╺`, falls back to `-`/` ` when `options.legacy_windows or options.ascii_only`, and names
styles `bar.back`, `bar.complete`, `bar.finished`, `bar.pulse`
(https://raw.githubusercontent.com/Textualize/rich/master/rich/progress_bar.py, fetched 2026-09-20). Line
charts: asciichart's default symbols are `'┼', '┤', '╶', '╴', '─', '╰', '╭', '╮', '╯', '│'` with an 11-char
label pad and `x.toFixed(2)` labels (https://raw.githubusercontent.com/kroitor/asciichart/master/asciichart.js,
fetched 2026-09-20). Braille pixel plotting (2×4 dots per cell) is drawille's approach, tested only on a few
fonts/terminals ("Terminus, Fixed, DejaVuSansMono", "rxvt-unicode";
https://raw.githubusercontent.com/asciimoo/drawille/master/README.md, fetched 2026-09-20).

Braille rendering hazards (why braille is not the default here): Warp #9696 "Braille block (U+2800–U+28FF)
renders with right-side gap when font glyphs don't fill cell", measuring "roughly 24% empty padding on right
side of every cell" in Meslo/Menlo/SF Mono and noting xterm.js and Ghostty draw braille synthetically
(https://github.com/warpdotdev/warp/issues/9696, fetched 2026-09-20); on macOS embedded apps can resolve
"Apple Braille" to the `Outline6Dot` face that outlines every unset dot (https://github.com/kshivang/BossTerm/issues/407,
search result 2026-09-20, **UNVERIFIED** beyond the issue title/summary). JevCode's spinner
(`StatusLine.tsx` `SPINNER_FRAMES = ['⠋','⠙',…]`) is exactly this glyph range.

**Measured cost** (2026-09-20, `/tmp/jevtui/{width,render-bench}.mjs`): building 12 decision rows with
10-cell eighth-block bars costs 0.95 µs per frame (vs 0.20 µs without); `stringWidth` on a 62-column bar row
is 18.9 µs per call; re-rendering a 12-row `<Box overflow="hidden">` pane of `<Text wrap="truncate">` rows
through `ink-testing-library` takes 3.13 ms without bars and 3.74 ms with bars and a trailing 8-tick
sparkline (+0.6 ms, +20 %). The perf gate is render p95 < 5 ms (DESIGN §12), so bars are affordable but not
free; the decisions pane changes only 3–4 times per step, so the cost lands far below the 20 fps coalescer.

### 3.2 Communicating probabilities and uncertainty

- **Words must carry numbers.** Sherman Kent's chart (CIA, *Words of Estimative Probability*, 1964; PDF
  https://www.cia.gov/resources/csi/static/Words-of-Estimative-Probability.pdf, downloaded and text-extracted
  2026-09-20): "100% certainty … 93% Give or take almost 6% Almost certain; 75% Give or take about 12%
  Probable; 50% Give or take about 10% Chances about even; 30% Give or take about 10% Probably not; 7% Give
  or take about 5% Almost certainly not; 0% Impossibility", introduced as "The case for consistent,
  unambiguous usage of a few key odds expressions"; he recounts a reader asking "what did you people mean by
  the expression `serious possibility'? What kind of odds did you have in mind?" while his own estimate was
  "around 65 to 35". The IPCC scale (virtually certain >99 %, very likely >90 %, likely >66 %, about as
  likely as not 33–66 %, unlikely <33 %, very unlikely <10 %, exceptionally unlikely <1 %) is quoted from
  https://en.wikipedia.org/wiki/Words_of_estimative_probability (fetched 2026-09-20); the primary AR5
  guidance note is **UNVERIFIED** here (https://www.ipcc.ch/site/assets/uploads/2017/08/AR5_Uncertainty_Guidance_Note.pdf
  returned 403 to WebFetch; the 3.4 MB PDF downloaded via curl but its text is glyph-encoded and my
  zlib/`Tj` extractor found none of the scale words). Takeaway for JevCode: show the number always; a word
  band is an optional *addition* in the drill-down and screen-reader text, never a replacement.
- **Reliability (calibration) is measured by binning forecasts and comparing to observed frequency.**
  Murphy & Winkler, "Reliability of subjective probability forecasts of precipitation and temperature",
  *Applied Statistics* 26(1):41–47, 1977 (https://academic.oup.com/jrsssc/article/26/1/41/6953771, fetched
  2026-09-20) established that forecasters "can formulate such forecasts in a reliable manner" using exactly
  this reliability-diagram method. Guo, Pleiss, Sun, Weinberger, "On Calibration of Modern Neural Networks",
  ICML 2017 (https://arxiv.org/abs/1706.04599, fetched 2026-09-20) frames "confidence calibration — the
  problem of predicting probability estimates representative of the true correctness likelihood" and finds
  "temperature scaling — a single-parameter variant of Platt Scaling — is surprisingly effective". Expected
  Calibration Error (the binned |accuracy − confidence| average) originates in Naeini, Cooper, Hauskrecht,
  "Obtaining Well Calibrated Probabilities Using Bayesian Binning", AAAI 2015
  (https://ojs.aaai.org/index.php/AAAI/article/view/9602, fetched 2026-09-20; abstract fetched, the ECE
  formula is in the body — **UNVERIFIED** as a quote). These give `/calibration` its shape (§4i).
- **Evaluate decisions, not just perception.** Hullman, Qiao, Correll, Kale, Kay, "In Pursuit of Error: A
  Survey of Uncertainty Visualization Evaluation", IEEE TVCG 25(1), 2019 (abstract via
  https://api.semanticscholar.org/graph/v1/paper/DOI:10.1109/TVCG.2018.2864889, fetched 2026-09-20): existing
  practice "focuses on Performance and Satisfaction-based measures that assume more predictable and
  statistically-driven judgment behavior than is suggested by research on human judgment and decision
  making" and shows "a bias toward evaluating performance as accuracy rather than decision quality". For
  JevCode the decision is approve/decline; the UI metric is whether reviewers decline the actions Jev put in
  the 0.3–0.7 band for the right dimension.
- **Frequency-framed, discrete encodings beat densities and bare intervals for lay decisions.** Kay, Kola,
  Hullman, Munson, "When (ish) is My Bus?", CHI 2016 (DOI 10.1145/2858036.2858558) and Fernandes, Walls,
  Munson, Hullman, Kay, "Uncertainty Displays Using Quantile Dotplots or CDFs Improve Transit
  Decision-Making", CHI 2018 (DOI 10.1145/3173574.3173718): titles/authors/venues verified via Crossref and
  Semantic Scholar (fetched 2026-09-20); both abstracts were "elided" by the publisher in those APIs and the
  authors' PDF URLs returned 404, so the dot-count findings are **UNVERIFIED** here. Correll & Gleicher,
  "Error Bars Considered Harmful: Exploring Alternate Encodings for Mean and Error", IEEE TVCG 20(12):2142–2151,
  2014 (project page https://graphics.cs.wisc.edu/Papers/2014/CG14/, fetched 2026-09-20) argue for "gradient
  plots (which use transparency to encode uncertainty) and violin plots (which use width) as better
  alternatives … than bar charts with error bars". Padilla, Kay, Hullman, "Uncertainty Visualization",
  *Wiley StatsRef* 2021 (DOI 10.1002/9781118445112.stat08296; abstract via https://api.crossref.org/works,
  fetched 2026-09-20): "reasoning with uncertainty is challenging for novices and experts alike" and the
  chapter details "the best practices in uncertainty visualization and the psychology behind how each
  approach supports viewers' judgments". Terminal consequence: a Score's five-level distribution should be
  shown as five small bars (a discrete "dotplot" of mass per level), never as a single point with an error
  bar; a Noul is one bar plus its derived confidence; a Choice is one bar per option.

### 3.3 Colour, text markers, screen readers

- WCAG 2.1 SC 1.4.1: "Color is not used as the only visual means of conveying information, indicating an
  action, prompting a response, or distinguishing a visual element"
  (https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html, fetched 2026-09-20). The current pane already
  pairs colour with `[review]`/`[block]` text markers (`Decisions.tsx` `verdictMarker`); every new visual
  keeps a text twin.
- `NO_COLOR`: "Command-line software which adds ANSI color to its output by default should check for a
  `NO_COLOR` environment variable that, when present and not an empty string (regardless of its value),
  prevents the addition of ANSI color"; "User-level configuration files and per-instance command-line
  arguments should override the `NO_COLOR` environment variable" (https://no-color.org/, fetched 2026-09-20).
  **Verified locally 2026-09-20:** chalk 5.6.2 (`node_modules/chalk`) contains no `NO_COLOR` reference; its
  vendored `supports-color` honours `FORCE_COLOR` ("true"→1, "false"→0, numeric 0–3) and `--no-color`/
  `--color=false` argv flags (`node_modules/chalk/source/vendor/supports-color/index.js` lines 20–43); Ink's
  `Text`, `colorize` and `render-border` import that chalk. So JevCode must translate `NO_COLOR` itself
  (set `process.env.FORCE_COLOR = '0'` before the dynamic `import('../tui/App.js')` in `src/cli/main.tsx`).
- GitHub CLI's accessibility settings: `accessible_colors` "whether customizable, 4-bit accessible colors
  should be used {enabled | disabled}", `accessible_prompter` "whether an accessible prompter should be used",
  `spinner` "whether to use an animated spinner as a progress indicator {enabled | disabled} (default
  enabled)" (https://cli.github.com/manual/gh_config, fetched 2026-09-20); rationale: "Speech synthesis
  screen readers do not handle this well" (spinners), and "Non-alphanumeric visual cues and uses of constant
  screen redraws for visual or other effects can be tricky to correctly interpret as speech"
  (https://github.blog/engineering/user-experience/building-a-more-accessible-github-cli/, fetched
  2026-09-20). Charm's `huh`: "Accessible forms will drop TUIs in favor of standard prompts, providing better
  dictation and feedback of the information on screen for the visually impaired"
  (https://raw.githubusercontent.com/charmbracelet/huh/main/README.md, fetched 2026-09-20).
- Ink 7.1.1 has this built in: "To enable it, you can either pass the `isScreenReaderEnabled` option to the
  `render` function or set the `INK_SCREEN_READER` environment variable to `true`"; `useIsScreenReaderEnabled()`
  lets a component swap output; `aria-label` replaces a visual (the readme's example is a progress bar
  labelled "Progress: 50%"); `aria-role` includes `progressbar`, `list`, `listitem`, `table`, `timer`
  (`node_modules/ink/readme.md` lines 2500–2520 and 3005–3103, read 2026-09-20). JevCode's `--plain`
  renderer is the `huh`/`gh` "drop the TUI" path; the TUI itself should honour `INK_SCREEN_READER`.

### 3.4 Decision logs and audit views

- k9s: header with context/cluster/CPU/MEM; command mode `:pod`, `:ctx`, `:ns`; `:pulses` (or `pu`) opens
  a dashboard of sparkline charts; keys `ctrl-d` delete, `d` describe, `l` logs, `esc` back, `?` help, `/`
  filter, `shift-f` port-forward (https://raw.githubusercontent.com/derailed/k9s/master/README.md, fetched
  2026-09-20). Pattern to borrow: one-letter view switches, a help key, filter with `/`.
- lazygit: `?` "Open keybindings menu"; `<tab>` switches panes, `[`/`]` switch tabs within a pane; `+` "Next
  screen mode (normal/half/fullscreen)", `_` "Prev screen mode"; `@` "View command log options"
  (https://raw.githubusercontent.com/jesseduffield/lazygit/master/docs/keybindings/Keybindings_en.md, fetched
  2026-09-20). Pattern: a *command log* pane that shows what the tool ran, and screen modes that resize a
  pane instead of scrolling the terminal.
- `git log --graph`: "Draw a text-based graphical representation of the commit history on the left hand side
  of the output"; `--oneline` = `--pretty=oneline --abbrev-commit`; `--decorate[=short|full|auto]`; `%h`,
  `%d`, `%s` (https://git-scm.com/docs/git-log, fetched 2026-09-20). Pattern: a fixed-width left gutter that
  encodes structure (here: step/stage) with the payload to the right.
- CI step views: GitHub Actions `::group::{title}` … `::endgroup::` "display as expandable entries in the
  step log", `::warning file=…,line=…::`, `::add-mask::{value}` (https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions,
  fetched 2026-09-20); GitLab `"\e[0Ksection_start:UNIX_TIMESTAMP:SECTION_NAME\r\e[0K" + HEADER` /
  `"\e[0Ksection_end:…\r\e[0K"`, `[collapsed=true]` (https://docs.gitlab.com/ci/jobs/job_logs/, fetched
  2026-09-20); Buildkite `--- ` collapsed group, `+++ ` expanded, `~~~ ` de-emphasised, `^^^ +++` re-opens a
  previous group after a failure (https://buildkite.com/docs/pipelines/configure/managing-log-output, fetched
  2026-09-20); `gh run view --verbose` "Show job steps", `--log-failed` "View the log for any failed steps"
  (https://cli.github.com/manual/gh_run_view, fetched 2026-09-20). Pattern: group markers in the *text*
  stream so the plain renderer and `transcript.log` gain structure too; failures re-open their group.

### 3.5 How opencode, Claude Code, Codex and Gemini CLI show tool approvals

- **opencode** (TS/SolidJS TUI on `@opentui/solid`, `packages/tui/package.json` name `@opencode-ai/tui`):
  the permission route renders `title="Permission required"` with
  `options={{ once: "Allow once", always: "Allow always", reject: "Reject" }}`, `escapeKey="reject"`,
  `fullscreen`; choosing `always` opens a second prompt titled `"Always allow"` whose body is either
  `"This will allow " + permission + " until OpenCode is restarted."` or "This will allow the following
  patterns until OpenCode is restarted" with the pattern list, options `{ confirm: "Confirm", cancel:
  "Cancel" }`, `escapeKey="cancel"`; edits show a `<diff>` component (unified under 120 columns, split
  above) (https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/tui/src/routes/session/permission.tsx,
  fetched 2026-09-20). Server side the reply enum is `once | always | reject` and `always` stores patterns
  (`packages/opencode/src/permission/index.ts` lines 121–163, same fetch). Docs: actions `"allow"`, `"ask"`,
  `"deny"`; permission keys include `read, edit, glob, grep, bash, task, skill, lsp, question, webfetch,
  websearch, external_directory, doom_loop`; the prompt offers "once", "always", "reject" and suggests
  patterns like `git status*` (https://opencode.ai/docs/permissions/, fetched 2026-09-20). Keybind
  `"permission.prompt.fullscreen": "ctrl+f"` (https://opencode.ai/docs/keybinds/, fetched 2026-09-20).
- **Claude Code**: the prompt offers **Yes**, **Yes, and don't ask again**, **No**; "Yes, and don't ask
  again" for a Bash command saves a rule to `.claude/settings.local.json` that "applies to future sessions
  anywhere in that repository"; on some prompts only one-time approval is offered "only when the prompt can
  show you everything they would allow"; `Tab` on Yes/No opens a comment field and "**No**: Claude Code
  sends your comment to Claude as the reason for the denial" (https://code.claude.com/docs/en/permissions,
  fetched 2026-09-20). Keys: `Esc` "On a permission prompt, `Esc` declines the action, the same as **No**
  without a comment"; `Shift+Tab` "Cycle permission modes" through `default` (Manual), `acceptEdits`, `plan`,
  `bypassPermissions`, `auto`; `Ctrl+O` "Toggle transcript viewer … Shows detailed tool usage and execution,
  with a timestamp and the model used"; `Ctrl+T` toggles the task checklist; `Ctrl+L` redraws
  (https://code.claude.com/docs/en/interactive-mode, fetched 2026-09-20). Modes table (`default`,
  `acceptEdits`, `plan`, `auto`, `dontAsk` "Auto-denies every call that would otherwise prompt",
  `bypassPermissions`) is already recorded in research 05 §3.3.
- **Codex** (Rust TUI): `approval_overlay.rs` header — "Approval modal rendering and decision routing for
  high-risk operations … 1. Selection always emits an explicit decision event back to the app. 2. MCP
  elicitation keeps `Esc` mapped to `Cancel`, even with custom keybindings, so dismissal never silently
  becomes 'continue without info'." Option labels: `"Yes, proceed"` / `"Yes, just this once"`, `"Yes, and
  don't ask again for commands that start with \`{prefix}\`"`, `"Yes, and don't ask again for this command
  in this session"`, `"No, continue without running it"`, `"No, and tell Codex what to do differently"`;
  patch approvals: `"Yes, and don't ask again for these files"`
  (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs,
  fetched 2026-09-20). Default keys: `approve: y`, `approve_for_session: a`, `approve_for_prefix: p`,
  `deny: d`, `decline: Esc, n`, `cancel: c` (https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/keymap.rs
  lines 1929–1934, fetched 2026-09-20). The list view also accepts digits to jump to items
  (`list_selection_view.rs` `to_digit(10)`, same fetch). Approval presets and the `AskForApproval` enum are
  in research 05 §2.3.
- **Gemini CLI** (Ink): edit prompts offer "Allow once", "Allow for this session", "Allow for this file in
  all future sessions", "Modify with external editor", "No, suggest changes (esc)"; shell prompts "Allow
  once", "Allow for this session", "Allow this command for all future sessions", "No, suggest changes (esc)";
  outcomes `ProceedOnce | ProceedAlways | ProceedAlwaysAndSave | ProceedAlwaysTool | ProceedAlwaysServer |
  ModifyWithEditor | Cancel`; Esc → `Cancel`; edits render a diff in a bordered box, commands a highlighted
  code block (https://raw.githubusercontent.com/google-gemini/gemini-cli/main/packages/cli/src/ui/components/messages/ToolConfirmationMessage.tsx,
  fetched 2026-09-20). Its list marks the selected item `●`, numbers items `1.`…`9.` for direct selection and
  shows `▲`/`▼` scroll arrows (…/shared/BaseSelectionList.tsx, fetched 2026-09-20).

Common ground across all four: Esc is always the safe "no"; the preview (diff or command) sits inside the
prompt; there is an "explain/redirect" decline that carries a reason back to the model. Where JevCode
differs: none of the four shows *why* the action was flagged (Codex/Claude rely on static policy, opencode on
patterns, Gemini on tool type); JevCode has four calibrated dimensions with rubric text — the prompt should
lead with them. And all four offer some "always" — JevCode must not (§4j).

## 4. Proposals for JevCode, ranked

| Rank | Proposal | Why this rank | New engine data? | Dynamic rows |
| --- | --- | --- | --- | --- |
| 1 | (j) review prompt keys + never-offer list | safety gate; every other pane is optional | none | 0 (reorders existing rows) |
| 2 | (b) risk gauge with why | the content of the review prompt | none (`risk.dims` has it) | +2 (8 vs 6 header rows), offset by reclaiming the 2 live rows |
| 3 | (a) decision rows with bars | the everyday view of "Jev decides" | none | 0 (+1 optional tab header) |
| 4 | (h) `/why` drill-down | audit any decision from `Decision.question/answer`; committed to `<Static>` | none | 0 |
| 5 | (c) plan ledger pane | the persistent plan is the harness's memory; today only counts are shown | none | shares the tabbed pane |
| 6 | (e) loop / replan display | the recovery path is invisible until it trips | count from `step:end.loopSignatures` (TUI-side) | +1 banner while active |
| 7 | (d) step timeline | where the 8 s per step goes; makes "harness < 50 ms" visible | none (`stage:end`, `step:end`) | shares the tabbed pane |
| 8 | (f) jev-only synth progress | the only live content in jev-only | structured `synth` fields (contract change) | 0 (reuses the 2 live rows) |
| 9 | (g) cost/budget meters + Jev latency sparkline | k9s-style at-a-glance budget | none (`status`, `jev:request`) | 0 (status line, ≥ 100 cols) |
| 10 | (i) `/calibration` summary | offline, from `decisions.jsonl` + `steps.jsonl` (+ bench `tasks.jsonl`) | none | 0 (committed block) |
| — | (k) plain / screen-reader variants | cross-cutting requirement for 1–10 | none | 0 |

Conventions used by every sketch below. `bar(p, w)`: `round(p·w·8)` eighths, full cells `█`, the partial
cell one of `▏▎▍▌▋▊▉` (left-eighth blocks, the tqdm charset, §3.1), track `·` (U+00B7); ASCII theme
(`--ascii` / `JEVCODE_ASCII=1` / auto when `TERM=dumb`): `#` fill, `-` track, tqdm's `" 123456789#"` for the
partial cell. Probabilities print with `p2()` (two decimals, `plain.ts`), never more. `~` after a confidence
marks the harness-derived Noul confidence (replaces the 7-char ` derived` label; legend in the pane header).
Verdict text markers stay exactly as today (`[ok]`, `[review]`, `[block]`, `chosen`, `overridden`,
`fallback`). Colours as today (red block, yellow review/overridden/fallback, dim ok/chosen), plus the bar
*track* coloured by band so the 0.3/0.7 bands read without a ruler; with `NO_COLOR` the ruler row appears.
Every visual has a one-line plain twin (§4k) that is what `--plain` and `transcript.log` print.

### 4a. Decision rows with inline probability bars and confidence

80 columns (the pane header replaces nothing: it is the existing rule row with text):

```
decisions  s7  c~ = derived |2p−1|           [d] decisions [p] plan [t] time [?]
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen
s7 intent   can_edit         noul   ████████▏·  0.81  c 0.62~
s7 intent   plan_still_valid noul   ████████▊·  0.88  c 0.76~
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     out_of_scope     L0     ██████████  1.00  c 1.00   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     irreversible     L0     █████████▌  0.95  c 0.96   [ok]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
```

120 columns (adds the request latency and the chosen option/level text, truncated):

```
decisions  s7  c~ = derived |2p−1|                                          [d] decisions [p] plan [t] timeline [?] help
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  "change source files"
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]       244ms  changes files whose previous content…
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]   244ms  skips a planned verification step
```

Data: exactly the `Decision` row (`probability`, `confidence`, `verdict`, `answer.type`, `latencyMs`, and
for the text column `question.criteria[choice]` / `question.criteria[level]` — for Scores the level text is
`RISK_LEVEL_TEXTS[dim][level]`, `src/loop/stages/risk.ts`). For a Score row the bar shows `probability` =
P(argmax level) — the same number the pane shows today — not the risk; the risk lives in the gauge (§4b) and
the verdict marker. Rows cost: unchanged (`DECISIONS_KEPT = 12`, `useEngine.tsx`); the header line is the
existing rule row. Plain twin: `[step 7] decision risk plan_mismatch L2 p=0.44 c=0.61 [review]` (today
`decision` events yield no transcript item, `plain.ts` `itemsFromEvent` default branch; add an opt-in
`--decisions` flag for `--plain`). Screen-reader twin: with `useIsScreenReaderEnabled()` true, render the
plain twin and put `aria-label="probability 0.44 of 1"` on the bar (Ink readme, §3.3). Why bars at all when
the numbers are there: a column of 12 aligned bars lets the eye find the one low/high value (the 0.44 among
0.9s) in a way twelve `p=` tokens do not; the eighth-cell precision (0.0125) is finer than the two-decimal
wire so no information is lost, and coarser than the ±0.02 noise so none is invented.

### 4b. Risk gauge for the four dimensions in the review prompt, with why

The confirm header grows from 6 to 8 rows (title, keys, ruler, four gauges, `matches_intent`), the two
`dimText` rows and the `reason` row are replaced (the reason text is the gauge's last column, and the full
`risk.reason` is already committed to scrollback as the `risk` transcript item). The keys line moves to row
2 so it survives truncation at rows 12 (today `confirmHeaderLines` puts it last; with the `take()` order in
`computeLayout` a 7-row header on a 6-row grant would drop it). While a confirm is pending the live region is
empty (`useEngine.tsx` clears it on `proposal`), so `computeLayout` should grant those 2 rows to the box:
net dynamic cost 0 at rows ≥ 24.

80 columns:

```
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve  [n] decline  [d] decline+note  [e] expand  [w] why  [esc] decline
dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)
destructive   L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
out_of_scope  L0  ··········  0.00 tail 0.98  directly does what…
plan_mismatch L2  ████▍·····  0.44 tail 0.61  skips a planned verification step
irreversible  L0  ··········  0.00 exp  0.96  no lasting effect, or restorable…
matches_intent    ████████▊·  0.88 noul 0.76~ the action is an instance of the…
  --- old
  return datetime.strptime(s, FMT)
  +++ new
  return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)
```

120 columns (adds P(level), E[k] and tail mass so the bound is checkable by eye):

```
review  step 7  risk 0.44 (tail on plan_mismatch)  edit src/a.py  "make parse_date timezone-aware"             jev 244ms
[y] approve  [n] decline  [d] decline+note  [e] expand preview  [w] why  [esc] decline
dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k≥3)
destructive    L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recoverable…
out_of_scope   L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]` or `task`…
plan_mismatch  L2  ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step
irreversible   L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git…
matches_intent     ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent…
```

Data: `ConfirmRequest.risk.dims[d] = { risk, probability, expected, tailMass, bound, confidence, level }`
(`types.ts` 218–226), `RISK_LEVEL_TEXTS[d][level]` (`risk.ts`), the `matches_intent` Noul from the risk
stage's `decision` rows (the same request; `risk.ts` `buildRiskQuestions`). The ruler `0  ┆   ┆ 1` puts `┆`
in cells 3 and 7: with a 10-cell bar the 0.3/0.7 boundaries fall exactly on cell boundaries, so a tick glyph
cannot sit *on* the boundary — the coloured track (cells 0–2 dim, 3–6 yellow, 7–9 red) is the precise
encoding and the ruler is the `NO_COLOR` approximation; a 20-cell bar at 120 columns would put ticks in
cells 6 and 14 with the same caveat. Why a per-dimension gauge and not one risk number: the verdict is
`max` over dimensions and the bound differs per dimension (`harm` = max(E, tail), `alignment` = tail only,
`confidence.ts`); a reviewer who sees "plan_mismatch 0.44 tail L2 skips a planned verification step" can
decide in one glance whether to approve, which a bare `risk=0.44 review` cannot support. Plain twin: today's
`confirmHeaderLines` (already one line per two dimensions; extend to one line per dimension carrying
`level`, `risk`, `bound`, `conf` and the level text truncated to 300 chars, the same clip as `reason`).

### 4c. Plan ledger pane

80 columns (a tab of the decisions pane, key `p`; same 12-row budget):

```
plan  done 2  remaining 3  unverified 1  problems 2  (accept ≥ .7, reject < .3)
[x] add failing test for parse_date                s4  done_0 0.91
[x] fix parse_date tz handling                     s6  done_0 0.78
[?] update CHANGELOG                               s7  done_1 0.52  unverified
[ ] run full suite
[ ] remove debug print in utils.py
[!] replan s6 change_approach: try tz-aware parsing instead of string ops
[!] rejected_claim s5: "tests pass" done_0 0.12
```

120 columns adds an evidence column (`tests 41p/0f/0e` from the judging step's `JudgeResult.tests`) and the
generator's `openProblems` in a right-hand column. Markers are ASCII `[x] [ ] [?] [!]` (ballot boxes
`☐☑☒` are width-1 and `N`-class, §3.1, but font coverage is the weaker link; offer them in the unicode
theme only). Data: the `plan` event (`Plan.done[].evidence { step, judged }`, `remaining`, `unverified`,
`openProblems`, `harnessProblems[] { kind, text, step }`, `rejectedDone`, `unverifiedDone`; `types.ts`
55–70). Why: DESIGN §6 makes the plan the generator's only persistent memory and gives it three bands
(≥ 0.7 accepted, 0.3–0.7 unverified, < 0.3 rejected) — the pane shows the band each item sits in and the
harness-owned problems the generator is being told about, which today appear only as counts in the `plan`
transcript line. Plain twin: today's `plan done=2 remaining=3 …` line plus, under `--plain --plan`, one
indented line per item in the same `[x]/[ ]/[?]/[!]` form.

### 4d. Step timeline

80 columns (tab `t`; two rows per step, most recent first, 12-row budget = 6 steps):

```
time  s7  intent .21s  ctx .24s  propose 6.1s  risk .23s  exec 1.2s  judge .19s
      s7  ICPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXXJ  total 8.2s  h 31ms
      s6  ICPPPPPPPPPPPPPPPPPPPPPRXXXXXXXXXXXXXXXJ  total 7.4s  h 24ms
```

120 columns (one row per step, with tokens and cost):

```
time s7  I .21s C .24s P 6.1s R .23s X 1.2s J .19s  ICPPPPPPPPPPPPPPPPPPPPPPPPPRXXXXXJ  8.2s  h 31ms  gen 5.4k  $0.032
```

The proportional strip is letters (I C P R X J) sized `round(ms/total·N)`, N = 40 at 80 columns (two-row
form) and 30 at 120 (one row), ASCII by
construction (no glyph risk); colours per stage are decoration. Data: `stage:end { stage, ms }` for the six
stages (`types.ts` 811), `step:end.record.timing { generatorMs, jevMs, execMs, harnessMs, totalMs }` and
`usage` (`types.ts` 264–270, 832). Why: the README's budget story ("harness overhead under 50 ms per step",
Jev ~170–250 ms per request, generator dominates) becomes visible per step, and a slow `exec` (test suite)
versus a slow `propose` (generator) is diagnosable without reading `steps.jsonl`. In jev-only the `P`
segment is the synthesizer's search (`propose [synth]` in the status line today). Plain twin:
`[step 7] timing intent=210ms context=240ms propose=6100ms risk=230ms exec=1200ms judge=190ms total=8200ms harness=31ms`
(one line at `step:end`, opt-in).

### 4e. Loop and replan display

One dynamic banner row, present only while a signature count is ≥ 2 or a replan directive is active
(`harnessProblems` contains `kind: 'replan'`), allocated after `live` and before the pane (80 columns):

```
loop  run:pytest -q›exit 1  x2/3   replan 1/5 s6 change_approach p .61 imp .12
```

At 120 columns the signature is shown un-abbreviated (`run:<sha12>:<sha12>` plus the normalised command)
and the paired-Noul values of the replan Choice (`can_change_approach 0.72` …). Data: `loop:tripped
{ signature, occurrences }` and `replan { directive { move, probability, confidence, taskImpossible, text } }`
exist (`types.ts` 829–830); counts *below* the trip are not emitted, but `step:end.record.loopSignatures[]`
(0–3 per step, `types.ts` 288) lets the reducer count occurrences since the last `replan` (DESIGN §6: counts
reset on trip), so no engine change is required; `max_replans` comes from config via `run:ready`/`status`
(`maxSteps` is there; `maxReplans` is not — add it to `run:ready` or read `RunCounters.replans` at
`run:end`). Why: the loop detector is the harness's own judgement about the generator, and a reviewer seeing
`x2/3` can decline the next identical action before the third strike. Transcript items `loop tripped:` and
`replan …` already exist and stay as the plain twin.

### 4f. Jev-only synthesis progress

The two live rows (empty of generator text in jev-only, `App.tsx` `liveLines` shows the last `synth` line)
become a two-row synth strip (80 columns):

```
synth  goal 2/3 test_kth kth.py  site kth.py:12  SEEDS mutation d1 → templates
sieve  verify  tested 37/137 ██▋·······  27%  t_run 0.9s x8 lanes  runs 41 jev 3
```

120 columns adds the ledger (`fixed 1  open 2  parked 0`), the queue key of the current candidate
(`base passed 39/41, p 0.62, source templates`) and the current test command. Data today: `synth { phase,
detail, candidates?, tested? }` where the only structured counts are on `phase: 'verify'`
(`src/synth/sieve/runner.ts:435`: `candidates: dispatched, tested: outcomes.length`); the mode (SIEVE vs RANK,
`docs/JEV-ONLY-DESIGN.md` §2.4), the goal index, the site and the source live in the free-text `detail`.
Proposal (contract change, `types.ts` 807): `synth` gains optional structured fields
`mode?: 'sieve' | 'rank'`, `goal?: { index, total, tests: string, path }`, `site?: string`,
`source?: string`, `runs?: number`, `tRunMs?: number`, `lanes?: number`, `jevRequests?: number`, and `phase`
becomes a closed union (`baseline | localize | enumerate | rank | verify | arbitrate | commit | ledger |
directive | stale_sites | widened`). Until then the strip renders `detail` verbatim. Why: in jev-only the
user is watching a search, and the sieve-vs-rank decision is the design's central claim (§2.4 of the Ledger +
Sieve design); the transcript keeps one `synth <phase>: <detail> (candidates=…, tested=…)` line per event as
the plain twin (`plain.ts` `synthText`).

### 4g. Cost/budget meters and Jev latency sparkline

Status line at 120 columns (unchanged text at < 100 columns):

```
step 7/40  ⠹ risk  wall 4m12s/30m ██▏·······  cost $0.31/$2.00 █▌········  jev p50 237ms ▂▃▂▅▂▂▇▃▂▁▂▃  gen 5.5k jev 28k
```

Data: `status.spend { generator.costUsd, jev.costUsd, capUsd, exceeded }`, `status.wallMs/maxWallMs`
(`types.ts` 796–804); latency from `jev:request.latencyMs`, one tick per HTTP request, last 12 requests,
**fixed scale 0–1000 ms** (p95 was 547 ms live, README; per-attempt timeout 10 s, DESIGN §5.1) so frames
are comparable — the opposite of spark's per-series min–max (§3.1); values above the scale clamp to `█`
and a request that failed/retried renders as a space (sparkly's non-finite rule). p50 is nearest-rank over
the same raw list the bench uses (`RunResult.jevLatencyMs`, `types.ts` 334; DESIGN §13). Rows cost: 0. The
spinner's braille frames should be swapped for `|/-\` when `--ascii`, `INK_SCREEN_READER`, or
`JEVCODE_SPINNER=0` (the `gh` `spinner` setting, §3.3), and the sparkline is dropped in those modes. Plain
twin: the existing `[step 7] … ` status is not a transcript item; `run:end` prints cost split, and a
`jev latency p50/p95` figure could join it.

### 4h. `/why` drill-down for any decision

Committed to `<Static>` as a transcript item with a multi-line `detail` (bounded by
`TRANSCRIPT_DETAIL_MAX_LINES = 60`, `plain.ts`) — the readme is explicit that `<Static>` "only renders new
items in the `items` prop and ignores items that were previously rendered", so a drill-down must be a *new*
item, never an edit of a row. Selection: `w` then a digit `1`–`9` (Gemini's `showNumbers`, Codex's digit
shortcuts, §3.5) over the visible pane rows, or `/why <stage>.<id>` / `/why s7.risk.plan_mismatch` from the
composer once one exists. Sketch at 80 columns:

```
[step 7] why risk.plan_mismatch  request a1b2c3d4  244ms  jev-1.13-20260917
  How far is `proposal.action` from `plan` and `intent`?
  score, 5 levels; alignment dimension → tail bound
  L0 ██████▏···  0.62  matches `intent` and the plan
  L1 ██▍·······  0.24  matches the plan, different order
  L2 █▏········  0.10  skips a planned verification step
  L3 ▍·········  0.04  ignores the plan's open problems, or claims completion…
  L4 ··········  0.00  contradicts the plan, repeats a step `recent` shows…
  argmax L0 p=0.62  E[k]=0.56→0.14  P(k≥3)=0.04  bound=tail  risk=0.04 [ok]
  confidence = 1 − Σ p_k·|k−k*| / U_5 = 1 − 0.56/1.2 = 0.53
  wire: two decimals; noise sd 0.020–0.026 in the 0.55–0.80 band (research 06)
```

For a Noul the block shows instructions, `criteria.true.definition` + examples, `criteria.false.definition`
+ examples, `p`, `|2p−1|` and which rule consumed it (e.g. `context: selected (p ≥ 0.5)`; `plan_still_valid:
< 0.3 adds stale_plan`); for a Choice, one bar per option including `none_of_these`, the paired Noul next to
each option, and the resolution rule that fired (`chosen`/`overridden`/`fallback`, DESIGN §6 Choice
resolution). Data: all of it is on the `Decision` row (`question`, `answer`, `probability`, `confidence`,
`verdict`, `latencyMs`, `requestHash`, `servedModel`) — zero engine change. 120 columns: the level texts are
not truncated. Plain twin: the same block (it *is* text) under `--plain` via `--why <id>` at run end or
`jevcode why <run-id> <step> <id>` reading `decisions.jsonl`.

### 4i. `/calibration` summary

Offline over `~/.jevcode/runs/*/decisions.jsonl` joined with `steps.jsonl` (and the bench's `tasks.jsonl`
when present), rendered as a text reliability table in the Murphy & Winkler / Guo style (§3.2). The numbers
below are **illustrative placeholders**, not measurements (80 columns):

```
[run] calibration  31 runs  4,812 decisions  1,204 with a label
labels: review→reviewer answer 412   done_j→later evidence 388
        task_complete→bench pass 29   succeeded→exit/tests 375
bin        n    mean p   observed  reliability (observed vs mean p)
0.0–0.1  310    0.04     0.03      ▏
0.3–0.4  128    0.35     0.41      ████
0.6–0.7   96    0.65     0.58      ██████
0.8–0.9  201    0.85     0.88      █████████
0.9–1.0  469    0.97     0.96      ██████████
ECE 0.031 (10 equal-width bins)   near-threshold (|p−t| ≤ 0.03): 57 (1.2%)
  risk@.30 21  risk@.70 6  complete@.85 30  plan@.70 12  context@.50 88
unlabelled (no ground truth): 3,608 answers; sharpness: 71% outside 0.2–0.8
```

Labels that exist: (1) `review` verdicts vs the reviewer's answer (`confirm:resolved.approved` /
`outcome.status === 'declined'` in `steps.jsonl`) — the only *human* label; (2) `done_<j>` acceptance vs a
later step's parsed test result for the same claim (weak, but automatic); (3) `task_complete` vs bench
`pass` (`bench/results/*/tasks.jsonl`, `RunResult.stopReason === 'complete'`); (4) `succeeded` vs
`exec.ok`/`tests.allPassed` when parsed. Everything else (intent, context, `matches_intent`) has no ground
truth and gets a sharpness histogram plus the near-threshold count, which is the actionable number given the
±0.02 noise (research 06 rule 6: "A threshold at 0.5 on an answer near 0.5 will flip between runs").
`docs/STATUS.md` already names the first use: "jev-on solved tasks in the live bench but rarely reached
`task_complete ≥ 0.85` … Lowering the threshold or accepting a targeted run as evidence is a calibration
choice to make from the recorded decisions" (read 2026-09-20). Rows cost: 0 (committed block). Plain twin:
`jevcode calibration [--runs-dir] [--since]` prints the same block.

### 4j. Review prompt keys, and what must never be offered

Keys while `pendingConfirm !== null` (all others ignored, as today; a pasted multi-character string is one
`input` and matches none of them):

| Key | Effect | Precedent |
| --- | --- | --- |
| `y` | approve this action, once | Codex `approve: y`; Claude **Yes**; opencode "Allow once" |
| `n`, `Esc` | decline; outcome `declined by reviewer: <risk reason>` (DESIGN §6) | Codex `decline: Esc, n`; Claude "`Esc` declines the action"; Gemini "(esc)" |
| `d` | decline **with a one-line note** appended to the declined reason so the generator sees the human's reason | Codex "No, and tell Codex what to do differently"; Claude's `Tab` comment field ("sends your comment to Claude as the reason for the denial") |
| `e` | expand the preview to the whole budget for this frame (decisions pane → 0 rows), `e` again collapses | Claude `Ctrl+O` transcript viewer; opencode `permission.prompt.fullscreen: ctrl+f` |
| `w` + digit | `/why` block for one of the four dimensions or `matches_intent` (§4h) | none of the four show why |
| `Ctrl-C` | abort the run (existing) | — |

Never offered, and why: **no "always"/"don't ask again"/"for this session"** (Codex `a`/`p`, Claude "Yes,
and don't ask again", opencode "Allow always", Gemini "Allow for this session") — JevCode's review band is a
per-action calibrated verdict; a remembered rule would execute future actions Jev scored 0.3–0.7 without a
gate, contradicting DESIGN §6 ("there is no auto-approve") and the bench definition (`reviews` are declines).
**No Enter-as-approve default and no highlighted default option**: Codex/Gemini/opencode use a selection list
where Enter picks the highlighted item; JevCode should require the literal `y`. **No approval on timeout**:
the non-TTY confirmer declines after `confirmTimeoutMs` (`useEngine.tsx` `createTuiConfirmer`), never the
reverse. **No mode cycling that removes the gate** (Claude `Shift+Tab` → `bypassPermissions`/`auto`; Codex
`--dangerously-bypass-approvals-and-sandbox`): the closest safe analogue is a *decline-only* automation
("decline every review of kind X without asking") and even that changes bench semantics, so it is an open
question, not a proposal. **No approval of a second pending request**: a new request while one is pending
declines the first (`createTuiConfirmer` "declined (never approved) rather than left hanging"). The `d` note
is user text: it must pass `config.redact` before it reaches the window entry, `transcript.log` or
`steps.jsonl`, and the `JEVCODE_TRACE` hook must stop logging `input=${JSON.stringify(input)}` (`App.tsx`
`useInput`) once any key can be part of typed text — log the key *class* (`ctrl-c`, `y`, `char`) instead.

Plain mode keeps `[step 7] [y] approve  [n] decline  [d] decline+note > ` on the readline (`plain.ts`
`CONFIRM_KEYS_LINE`), `d` followed by the note on the same line; `yes`/`no` remain accepted; five invalid
answers still decline (`READLINE_MAX_PROMPTS`).

### 4k. Plain and screen-reader variants (summary)

| Visual | `--plain` / `transcript.log` line | `INK_SCREEN_READER=true` in the TUI |
| --- | --- | --- |
| decision row with bar | `[step 7] decision risk plan_mismatch L2 p=0.44 c=0.61 [review]` (opt-in `--decisions`) | same text; `aria-role="listitem"`, bar replaced by `aria-label="probability 0.44"` |
| risk gauge | one line per dimension: `[step 7] confirm … plan_mismatch L2 risk=0.44 tail c=0.61 "skips a planned verification step"` | same lines; the ruler row is dropped |
| plan ledger | `[step 7] plan [x] … s4 done_0 0.91` one per item (opt-in `--plan`) | same; `aria-role="list"` |
| timeline | `[step 7] timing intent=210ms … total=8200ms harness=31ms` | text row only, no letter strip |
| loop/replan banner | existing `loop tripped:` / `replan …` items plus `[step 7] loop run:… x2/3` | same text |
| synth strip | existing `synth <phase>: <detail> (candidates=…, tested=…)` | same text |
| status meters / sparkline | not a transcript item; `run:end` carries cost; add `jev p50/p95` | text status without bars; spinner replaced by `working` (gh's rule) |
| `/why`, `/calibration` | identical blocks (they are text) | identical |

Two rules make this cheap: build every pane from a `lines: string[]` function shared with `plain.ts`
(as `confirmHeaderLines` already is), and put glyph selection behind one `theme` object
(`unicode | ascii`) chosen once at startup from `--ascii`, `JEVCODE_ASCII`, `TERM=dumb`, `NO_COLOR` (colour
off, glyphs on) and `INK_SCREEN_READER` (glyphs off, spinner off).

## 5. Height-budget accounting (rows − 2, `computeLayout` order: status, rule, live, confirm, pane)

| Terminal | Budget | No confirm pending | Confirm pending (proposals 4b + reclaimed live rows) |
| --- | --- | --- | --- |
| rows 12 | 10 | status 1 + rule/tab header 1 + live 2 + pane 6 = 10 (today: pane 6) | status 1 + rule 1 + live 0 + confirm header 8 (title, keys, ruler, 4 gauges, matches_intent) = 10; preview 0; pane 0 (today: header 6, preview 0, pane 0). Keys line is row 2, so it survives if the header is cut to 6. |
| rows 24 | 22 | status 1 + rule 1 + live 2 + pane 12 = 16, +1 loop banner when active = 17 (5 spare) | status 1 + rule 1 + confirm 8 + preview 8 = 18 → pane 4 (today: 1+1+2+6+8 = 18 → pane 4). Same pane rows as today. |
| rows 40 | 38 | 1 + 1 + 2 + 12 (+1) = 17; at ≥ 120 columns two tabs side by side in the same 12 rows | 1 + 1 + 8 + 8 = 18 → pane 12 |

Zero-clear discipline is preserved: every new pane is a fixed-height `<Box overflow="hidden">` with
`<Text wrap="truncate">` rows, `/why` and `/calibration` are appended to `<Static>` (never re-rendered),
the banner is one row, and the `e` (expand) key trades pane rows for preview rows inside the same budget.
The 20 fps coalescer is untouched: bars are computed inside the render from reducer state, not on the event
path; the measured cost is +0.6 ms per 12-row re-render (§3.1), against a 5 ms p95 gate.

## 6. ADOPT

| # | What JevCode should do | Why | Source |
| --- | --- | --- | --- |
| A1 | Keep `y`/`n`, add `Esc` = decline, `d` = decline with a redacted note, `e` = expand preview, `w`+digit = why; put the keys line second in the confirm header | Esc-as-safe-no is universal; a reason back to the model exists in Codex and Claude Code; the keys line must survive truncation at rows 12 | §3.5 sources; `App.tsx` `computeLayout`, `plain.ts` `confirmHeaderLines` |
| A2 | Never offer "always"/"session"/"prefix" approval, Enter-default, or approve-on-timeout | per-action calibrated gate; DESIGN §6 "no auto-approve"; bench counts reviews as declines | DESIGN §6, §13; Codex `keymap.rs` 1929–1934 and Claude/opencode/Gemini labels (§3.5) as the anti-pattern |
| A3 | Per-dimension risk gauge rows in the confirm box: `dim  L<k>  bar(risk)  risk  bound  conf  level text`, replacing the two `dimText` rows and the reason row; reclaim the 2 empty live rows while pending | the verdict is `max` over dimensions with different bounds; the level text is the why | `confidence.ts` `riskFromProbabilities`; `risk.ts` `RISK_LEVEL_TEXTS`, `assessRisk`; Correll & Gleicher on discrete alternatives to a single bar with error |
| A4 | Decision rows: 10-cell eighth-block bar of `probability`, two-decimal `p`, `c`, `~` for derived Noul confidence, existing text markers and colours | finds the odd value in a column; precision 0.0125 sits between the two-decimal wire and the ±0.02 noise | tqdm charset; research 06 rule 6; WCAG 1.4.1 (text twin kept) |
| A5 | `/why` as a committed `<Static>` item with the full probability table, criteria, formula and rule consumed | zero engine change; `<Static>` never re-renders old items; audit trail matches `decisions.jsonl` | Ink readme `<Static>` note; `types.ts` `Decision` |
| A6 | Tabbed dynamic pane (`d` decisions, `p` plan, `t` timeline, `s` synth) inside the existing 12-row budget; `[`/`]` cycle; `?` help | lazygit tabs/screen modes and k9s one-letter views; no extra rows | lazygit Keybindings_en.md; k9s README |
| A7 | Loop banner from `step:end.loopSignatures` counts (`x2/3`) and the active replan directive | the recovery path is otherwise invisible until the third strike | `types.ts` 288, 829–830; DESIGN §6 loop detection |
| A8 | Status meters (wall, cost/cap) and a Jev latency sparkline with a **fixed** 0–1000 ms scale from `jev:request`, only at ≥ 100 columns | comparable frames; the bench uses the same raw list | spark min–max pitfall; sparkly non-finite rule; DESIGN §13 `jevLatencyMs` |
| A9 | Map `NO_COLOR` → `process.env.FORCE_COLOR='0'` before `import('../tui/App.js')`; honour `INK_SCREEN_READER`; add `--ascii`/`JEVCODE_ASCII` and `JEVCODE_SPINNER=0` | chalk 5.6.2 has no `NO_COLOR` support (verified); Ink has screen-reader mode; `gh` disables spinners for screen readers | no-color.org; `node_modules/chalk/source/vendor/supports-color/index.js`; Ink readme §Screen Reader Support; `gh config` |
| A10 | Use `▏▎▍▌▋▊▉█` + `·` for bars, ASCII `[x] [ ] [?] [!]` for the ledger, letters for the timeline strip; keep braille only for the opt-in unicode spinner | `A`-width blocks already accepted for `─`; braille has documented font gaps; letters need no glyph support | EastAsianWidth 18.0.0; Warp #9696; measured widths |
| A11 | Structured `synth` event fields (`mode`, `goal`, `site`, `source`, `runs`, `tRunMs`, `lanes`, `jevRequests`; closed `phase` union) | the sieve-vs-rank decision is the design's core and is currently a string | `types.ts` 807; `sieve/runner.ts:435`; JEV-ONLY-DESIGN §2.4 |
| A12 | `jevcode calibration` / `/calibration` over `decisions.jsonl` + `steps.jsonl` (+ bench `tasks.jsonl`): reliability bins, ECE, near-threshold counts | STATUS.md names the first calibration question; labels exist for review, done_j, task_complete, succeeded | Murphy & Winkler 1977; Guo et al. 2017; Naeini et al. 2015; `docs/STATUS.md` |
| A13 | Plain twins for every visual (`--decisions`, `--plan`, timing line) and a shared `lines()` per pane | three transcripts must agree; screen readers get text | DESIGN §10; `huh` accessible mode; GitHub CLI accessibility blog |
| A14 | Trace only key *classes* in `JEVCODE_TRACE` once any key can be text | "keys never appear in logs" | `App.tsx` `useInput` trace line |

## 7. REJECT

| What not to do | Why |
| --- | --- |
| Braille sparklines/bars as the default | 24 % right-side gaps in Meslo/Menlo/SF Mono (Warp #9696), hollow-dot faces on macOS (BossTerm #407, UNVERIFIED detail), font-dependent; block elements measure identically in `string-width` and have none of these reports |
| Per-frame min–max rescaled sparklines (spark style) | consecutive frames not comparable; a flat series rescales to `▅ ▆` |
| Any remembered approval ("always", "session", "prefix", "these files") or Enter-default | bypasses the per-action calibrated gate; changes bench semantics; DESIGN §6 |
| Approve-on-timeout, or approving a superseded pending request | fail-open; today's confirmer declines in both cases |
| A single risk bar with an "error bar" for confidence | hides which dimension and bound fired; Correll & Gleicher's critique of mean+error encodings; the four-gauge form is the discrete alternative |
| Word-only probability bands ("likely") in rows | Kent's case: words without numbers are ambiguous; use numbers, words only as an addition in `/why` and screen-reader text |
| Three-decimal probabilities or bars finer than 1/8 cell | wire is two-decimal; noise sd 0.020–0.026; implies precision Jev does not have |
| Colour as the only band encoding | WCAG 1.4.1; `NO_COLOR` users; keep `[review]`/`[block]` and the ruler row |
| Editing an existing `<Static>` row to show a drill-down | Ink ignores changes to previously rendered items; replaying static output is the clear-terminal path |
| Panes that grow with content (plan items, timeline steps) | violate the `rows − 2` budget → `\x1b[2J` replay of the whole transcript (Ink `shouldClearTerminalForFrame`) |
| Emoji with variation selectors (`⚠️`) | measures 2 cells in `string-width` 8.2.2 while many terminals draw 1; use `⚠` or `!` |
| Putting the keys line last in a taller confirm header | at rows 12 it is the row that gets cut |
| A Claude-style permission-mode cycle (`Shift+Tab`) in JevCode | its safe end states (`plan`, `dontAsk`) are declines; its unsafe ones (`bypassPermissions`, `auto`) remove the gate |

## 8. OPEN QUESTIONS

1. Decline-only automation ("decline every review whose max dimension is `plan_mismatch` at L3 without
   asking") never executes anything, but it changes `reviews`/`declined` counts and the generator's
   feedback loop. Offer it as a flag (`--auto-decline <dim>`) or not at all?
2. The `d` note travels into the window entry the generator reads and into `steps.jsonl`. Beyond
   `config.redact`, should it be length-capped (600 chars like window output) and should Jev's risk state see
   it (`recent[i].notes`) on the next step?
3. `A`-class (ambiguous-width) block glyphs: auto-select the ASCII theme when `LANG`/`LC_ALL` is CJK, or
   trust the terminal? Needs a test in a CJK-locale terminal (not available here).
4. Bars of `probability` in decision rows versus bars of `risk` in gauge rows: is showing two different
   quantities with the same glyph confusing? Alternative: rows show the risk bar for risk-stage Scores too and
   print `P(lvl)` as text.
5. `/why` for the context stage (up to 300 Nouls per step) — one block per file is too long; a ranked table
   of the top-k selected/rejected files with `p` is the likely form, but the cutoff (k) is unstudied.
6. `/calibration` labels: is reviewer approve/decline a *truth* label for the review band, or a preference?
   Murphy & Winkler's reliability assumes an observed outcome; here the outcome is another judgement.
7. Structured `synth` fields (A11) are a contract change to `EngineEvent`; who owns the `phase` union across
   `src/synth/**`, and should `mode` be recorded per step in `SearchTrace` for the bench too?
8. `useIsScreenReaderEnabled()` covers the TUI; should `--plain` be forced when `INK_SCREEN_READER=true`
   (the `huh`/`gh` "drop the TUI" model), given `--plain` already has every twin?
9. Ink measurement vs terminal rendering of `·` (U+00B7) as the bar track: Latin-1, width 1 everywhere, but
   some fonts draw it faintly; `░` (U+2591, `N`-class) is the alternative — pick by a quick screenshot test.
10. The IPCC primary scale and the two CHI dotplot papers could not be quoted from primary sources
    (403/404/elided abstracts). If word bands are ever added to `/why`, re-fetch the AR5 guidance note through
    a browser session and record the exact ranges.

## 9. Verification log (all 2026-09-20)

Fetched OK: unicode.org NamesList.txt, EastAsianWidth.txt; en.wikipedia.org Block_Elements,
Braille_Patterns, Words_of_estimative_probability; raw.githubusercontent.com holman/spark `spark`,
sindresorhus/sparkly `index.js`, tqdm `tqdm/std.py`, Textualize/rich `rich/progress_bar.py`,
asciimoo/drawille README, kroitor/asciichart `asciichart.js`, derailed/k9s README, jesseduffield/lazygit
`docs/keybindings/Keybindings_en.md`, charmbracelet/huh README, openai/codex `docs/config.md` (index only),
`codex-rs/tui/src/bottom_pane/approval_overlay.rs`, `…/list_selection_view.rs`, `codex-rs/tui/src/keymap.rs`,
anomalyco/opencode `packages/tui/package.json`, `packages/tui/src/routes/session/permission.tsx`,
`packages/opencode/src/permission/index.ts`, google-gemini/gemini-cli `ToolConfirmationMessage.tsx`,
`BaseSelectionList.tsx`; cia.gov Words-of-Estimative-Probability.pdf (curl + zlib text extraction);
arxiv.org/abs/1706.04599; ojs.aaai.org AAAI 9602; academic.oup.com jrsssc 26/1/41; graphics.cs.wisc.edu
CG14 project page; api.semanticscholar.org (Hullman 2019 abstract; Kay 2016 / Fernandes 2018 metadata);
api.crossref.org (Padilla/Kay/Hullman 2021 abstract; Correll & Gleicher 2014 metadata); w3.org WCAG 1.4.1;
no-color.org; cli.github.com gh_config, gh_run_view; github.blog accessible-github-cli; git-scm.com git-log;
docs.github.com workflow commands; docs.gitlab.com job_logs; buildkite.com managing-log-output;
developer.hashicorp.com terraform plan; opencode.ai docs/permissions, docs/keybinds; code.claude.com
docs/en/permissions, docs/en/interactive-mode; github.com/warpdotdev/warp/issues/9696.

Failed / UNVERIFIED: ipcc.ch AR5 guidance PDF (403 via WebFetch; PDF downloaded via curl but text is
glyph-encoded), archive.ipcc.ch AR4 ch1s1-6 (403), ipcc.ch AR6 WG1 chapter-1 (403); mjskay.com PDFs (404),
idl.cs.washington.edu / idl.uw.edu paper pages (301 → 404), dl.acm.org and annualreviews.org (403),
osf.io/ebd6r (empty page; download redirected to a signed storage URL, not followed), visualization.ischool.uw.edu
(DNS), Semantic Scholar 429 on two requests; api.github.com directory listings (403/429 rate limit; `gh` not
installed) — replaced by direct raw-path probes; cli.github.com/manual/gh_help_accessibility (404) — replaced
by gh_config; developers.openai.com/codex/security (308 → learn.chatgpt.com/docs/security, wrong page);
philarchive.org KENWOE (403); unicode.org chart PDFs (redirect chain, PDF unparseable) — replaced by
NamesList.txt. Not attempted: paid APIs, `npm install`, any git operation.

Measurements (this machine, Node 22.23.2, `/tmp/jevtui/width.mjs` and `render-bench.mjs` importing the
repo's `string-width` 8.2.2, `ink` 7.1.1, `react` 19.3.0, `ink-testing-library` 4.0.0): glyph widths as in
§3.1; 12 bar rows built in 0.95 µs; `stringWidth` 18.9 µs per 62-column bar row; 12-row pane re-render
3.13 ms (text) vs 3.74 ms (bars + sparkline).
