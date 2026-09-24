# JevCode TUI round 2 — visual and motion design (Designer A: D-D, D-E)

Written 2026-09-21 against the tree at HEAD `080331a` (`src/tui/App.tsx` 2,033 lines, `src/tui/layout.ts` 151,
`src/tui/theme.ts` 157, `src/tui/status/lines.ts` 538, `src/tui/composer/Composer.tsx` 597, `src/tui/Transcript.tsx`
88, `src/tui/Pane.tsx` 86, `src/tui/Review.tsx` 128, `src/tui/Overlay.tsx` 203, `src/tui/useEngine.tsx` 860,
`src/tui/plain.ts` 891, Ink 7.1.1 in `node_modules/ink/build/*`), `docs/TUI-DESIGN.md` (cited as `TD §n` / frame
`F-X`), `docs/research/tui/01-opencode.md` (`OC §n`), `docs/research/tui/00-SUMMARY.md` (`Ann` rows),
`docs/research/tui/08-ink7-internals.md` (`INK §n`), `docs/research/tui/12-accessibility-robustness-testing.md`
(`ACC §n`) and `perf/results/latest.json` (measured 2026-09-21T10:57Z, all gates `pass: true`). Every line number is
from that tree. Product decisions D-A…D-E of the round-2 brief are fixed inputs; this document designs **D-D (visual
redesign) and D-E (every existing gate stays)** in depth and names, where D-D touches them, the hooks the D-A/D-B/D-C
designers must provide (§12). Nothing here reopens TD's fifteen decisions: one modal slot, one `computeLayout`,
`<Static>` as the only scrollback writer, zero clears after the first frame, the pure `lines()` twins, no new runtime
dependency.

Notation: frames are captioned `**G-X. … W×H (D dynamic rows[; S scrollback rows above])**` exactly like TD §2.3's
`F-X` captions, so `test/unit/tui/layout/layout.test.ts:350–420` (`readFrames`) measures them unchanged once it is
pointed at this file too (§10.11). Dynamic rows are everything from the rule row downwards; scrollback rows are
`<Static>` lines shown only where they matter. `›` is the composer prompt (`>` under `--ascii`); `╭ ╮ ╰ ╯ │ ─ ├ ┤`
are cli-boxes' `round` set (the glyphs Ink's `borderStyle="round"` draws, `node_modules/cli-boxes/boxes.json`
`round`), `+ - |` under `--ascii` (research 06 line 521: Ink `classic` is the ASCII border).

## 0. What is crowded today, by line

| Symptom the user named | Where it comes from | What changes |
| --- | --- | --- |
| "why is it so crowded" — seven dense bracketed lines per step | `itemsFromEvent` (`plain.ts:276–345`) yields one `<Static>` line for `intent`, `context`, `synth`, `proposal`, `risk`, `outcome`, `judge`, `plan` and the TUI shows every one (`Transcript.tsx:60–72`) | one `[step N] …` summary line per step in the TUI by default (§4.3); the stage lines stay in `transcript.log` and `--plain` and are the Jev panel's material |
| a 12-row decisions pane pinned open after every run (F-B) | `paneWant = CAP.pane` whenever `state.ready !== null \|\| state.done !== null` (`App.tsx:1723`) | the panel is **collapsed to its one-line strip on the rule row by default** (0 pane rows), opens to ≤ 6 rows, expands to 12 on request (§5) |
| a packed status line and a packed placeholder | `statusLineText` (`status/lines.ts:516`) and `PLACEHOLDERS.task` = `Describe the task…   / commands · @ files · ? help · Enter runs` (`Composer.tsx:48`) | the status row moves into the console's own compartment with the same three zones; placeholders shrink to one clause (§3.4) |
| nothing frames the input | the composer is a bare `> ` row (`Composer.tsx:35`, `App.tsx:1841`) and the status line sits directly under it | a rounded console box holds the composer, the mode badge (top edge) and the status bar (bottom compartment) (§3) |
| the review looks like a log dump (F-G) | `reviewHeaderLines` rows are drawn as eight plain rows (`Review.tsx:104–127`) | a rounded review card whose top edge carries the title; keys, gauges and preview inside (§6.1) |
| no moment of arrival | the first frame is the header line, a rule and the prompt (F-A; `app.test.tsx:231`) | a ≤ 700 ms wordmark reveal in the pane slot, settling into a brand rule row; the sentinel and the composer are in frame 1 (§8) |

The opencode structure this copies (OC §2.1 prompt: a bordered multi-line textarea; OC §2.3: "The prompt header shows
the agent name (or `Shell`) and model", footer "left = working directory; right = `△ N Permission(s)` … a muted
`/status` hint"; OC §2.2: tool blocks "collapsed", reasoning "a single line throughout, so the layout never shifts";
OC §2.4: dialogs as bordered `DialogSelect` boxes; OC §8 items 5–7) maps one-to-one: header → the badge in the
console's top edge, textarea → the console's composer compartment, footer → the status compartment, collapsed tool
blocks → the one-line step summaries, dialogs → cards.

## 1. Thesis

Three moves, each inside TD's machinery:

1. **The transcript becomes a conversation.** Every `<Static>` row keeps its exact `formatTranscriptItem(item)` text
   (`plain.ts:397`), so `transcript.log`, `--plain` and the TUI stay line-identical; what changes is *which kinds the
   TUI shows by default* (one `[step N]` line per step, the human's `[you]` bubbles, the `[jevcode]` replies, run start
   and end, errors, `[ui]`/`[setup]` lines) and *how a row is dressed* (a dim label span, a hanging indent for the body,
   one blank spacer row between turns, no colour on prose). The per-stage lines are not lost: they are what the Jev
   panel and `/decisions` show, and `/transcript full` turns them back on for new items.
2. **Everything interactive lives in one rounded console, everything modal in a rounded card.** The console's top edge
   carries the mode badge and the workspace name, its lower compartment is the status bar (three zones unchanged), and
   the composer, the wizard, the picker filter and the secret-gate row render *inside* it. The review, follow-up,
   exit/undo confirms, blocking panes and the palette render as cards in the one modal slot directly above the console.
   Border rows are counted rows: the console costs 3 (top, divider, bottom), a card 2; TD's `computeLayout` gains one
   field (`chrome`) and two caps and keeps its allocation order and every invariant (§2).
3. **A 700 ms arrival, then quiet.** The wordmark reveals inside the pane slot from the very first frame — the same
   frame that already carries the console with its `step 0/` sentinel — at 20 fps through Ink's own `useAnimation`
   timer, and settles into a brand rule row. Any keystroke, engine event or reduced-motion setting ends it at once. It
   is the only animation added; the spinner rules of TD §7.4 stand.

Net row arithmetic at 80×24 (budget 22): today's idle-after-run frame F-B spends 15 dynamic rows; the redesign spends
**6** (rule strip 1 + console 5). A pending review spends 22 today (F-G) and **19** with the card and a collapsed panel
(§9 G-G). The transcript, not the machinery, gets the screen.

## 2. Layout: chrome tiers, caps, `computeLayout` 1.1

### 2.1 Chrome tiers

Boxes cost rows, so they exist only where rows exist. `chromeRows(rows, columns, screenReader)` (pure, `layout.ts`):

| Tier | When | Console | Cards | Splash form |
| --- | --- | --- | --- | --- |
| **boxed** | `rows ≥ 16 && columns ≥ 40 && !screenReader` | top edge + divider + bottom edge = **3 rows** (`CAP.chrome`) | `+2` rows each (top edge with title, bottom edge) | 5-row wordmark when `columns ≥ 64`, else the one-line brand row |
| **flat** | otherwise (rows 8–15, or a screen reader) | 0 extra rows: today's `> ` row over today's status row | 0 extra rows: today's row layouts (F-G…F-I, F-P, F-W) | one-line brand row on the rule (rows ≥ 8), nothing below |
| **minsize / static-only** | TD §2.1 unchanged | — | — | none |

The tier is a function of geometry alone, never of remaining budget, so a box is never half-drawn: on a resize from
24 to 12 rows the whole frame switches to flat in the same commit the renderer's early `resize` listener already
forces (`App.tsx:1917–1924`), inside the one clear a shrink is allowed (TD §18 "Zero clears"). Screen-reader mode is
flat by construction (borders are noise for a reader; TD §14.2).

### 2.2 Caps

```ts
// src/tui/layout.ts — additions and changed values (TD §2.1 CAP, A109)
export const CAP = {
  live: 2, queue: 2,
  pane: 12,            // unchanged: the panel's `full` size and the picker
  panel: 6,            // NEW: the panel's `open` size (D-D: "never taller than 6 rows unless expanded")
  reviewHeader: 8,     // unchanged: flat tier
  reviewCard: 9,       // NEW: boxed tier — title in the top edge + 7 header rows + bottom edge (§6.1)
  preview: 8,
  wizard: 4, followup: 5, secret: 1, blocking: 4, palette: 8, undo: 1, exitConfirm: 1, minsize: 1,
  card: 2,             // NEW: rows a card adds around a flat overlay (blocking, undo, exitConfirm; palette folds its footer, §6.3)
  composer: 6, composerTall: 8, banner: 1,
  chrome: 3,           // NEW: the console's top edge, divider and bottom edge in the boxed tier
  splash: 5,           // NEW: wordmark rows (drawn in the pane slot while the splash runs, §8)
} as const;
export const BOXED_MIN_ROWS = 16;
export const WORDMARK_MIN_COLUMNS = 64;
export function chromeRows(rows: number, columns: number, screenReader: boolean): 0 | 3;
```

`overlayWant` in the boxed tier (`Overlay.tsx:44–70` `overlayWant`): review `CAP.reviewCard` (9); followup 5
(already a box — `followupLines`, `review/lines.ts:297–312`, draws `┌ title ─┐`; it switches to the round glyphs and
loses nothing); blocking `min(6, rows + 2)`; undo 3; exitConfirm 3; palette 8 (the card's two edges replace the
footer row and one list row, §6.3); secret 1 (drawn inside the console, §3.5); wizard `wizardRows` unchanged (the
wizard renders inside the console; the console's chrome is already counted). In the flat tier every want is TD's.

### 2.3 `computeLayout` 1.1

```ts
// src/tui/layout.ts — TD §2.1's function with one new field; the allocation order is TD's with `chrome` after the
// composer floor (a half box is never drawn: chrome is 0 or 3 by tier and never yields), the yield order is its reverse
export interface LayoutInput { /* …TD §2.1… */ chrome: 0 | 3 }          // from chromeRows(rows, columns, screenReader)
export interface Layout { /* …TD §2.1… */ chrome: number }              // top edge + divider + bottom edge, or 0
export const YIELD_ORDER: readonly (keyof Layout)[] = ['pane', 'banner', 'live', 'preview', 'queue', 'composer', 'overlay'];  // unchanged: chrome, rule, status never yield

export function computeLayout(i: LayoutInput): Layout {
  const rows = size(i.rows), columns = size(i.columns);
  const budget = Math.max(0, rows - 2);
  let rem = budget;
  const take = /* TD §2.1 */;
  const z: Layout = { budget, degraded: 'none', status: 0, rule: 0, live: 0, banner: 0, pane: 0, queue: 0, overlay: 0, preview: 0, composer: 0, chrome: 0, total: 0 };
  if (rows < 3) { z.degraded = 'static-only'; return z; }
  if (rows < MIN_ROWS || columns < MIN_COLUMNS) { z.degraded = 'minsize'; z.status = take(1); z.overlay = take(CAP.minsize); z.composer = take(1); z.total = budget - rem; return z; }
  z.status = take(1);                                                        // 1 never yields (the console's status compartment in the boxed tier)
  z.rule = take(1);                                                          // 2 never yields at rows ≥ 8 (the panel strip / brand row)
  if (i.overlay !== 'wizard') z.composer = take(1);                          // 3 composer floor (the wizard IS the input: refund, TD D1)
  z.chrome = i.chrome === 3 && rows >= BOXED_MIN_ROWS ? take(3) : 0;         // 3b NEW: the console's three edge rows; whole or absent
  z.overlay = take(i.overlay === 'none' ? 0 : i.overlayWant);                // 4 modal slot (a card's want already includes its two edges)
  const cap = COLLAPSING.has(i.overlay) ? 1 : rows >= 40 ? CAP.composerTall : CAP.composer;
  if (i.overlay !== 'wizard') z.composer += take(Math.min(i.composerWant, cap) - 1);   // 5 composer growth
  z.queue = take(Math.min(i.queueWant, CAP.queue));                          // 6
  z.preview = i.overlay === 'review' ? take(Math.min(i.previewWant, i.expanded ? rem : CAP.preview)) : 0;   // 7 (inside the card, above its bottom edge)
  z.live = i.overlay === 'review' ? 0 : take(Math.min(i.liveWant, CAP.live)); // 8
  z.banner = take(Math.min(i.bannerWant, CAP.banner));                       // 9
  z.pane = i.expanded ? 0 : take(Math.min(i.paneWant, CAP.pane));            // 10 pane yields first; paneWant is 0 (collapsed) · 6 (open) · 12 (full/picker) · 5 (splash)
  z.total = budget - rem;
  return z;
}
export function composerTop(l: Layout): number { return l.rule + l.live + l.banner + l.pane + l.queue + l.overlay + l.preview + (l.chrome > 0 ? 1 : 0); }  // the console's top edge is above the draft rows
```

Where the three chrome rows come from, in TD's own terms: they are taken **after the composer floor and before the
overlay** (step 3b), so under pressure the yield order stays pane → banner → live → preview → queue → composer growth
→ overlay → composer-to-1 and chrome never yields — exactly like status and rule. That is honest only because the tier
guarantees room: in the boxed tier `rows ≥ 16`, budget ≥ 14, and the fixed rows are status 1 + rule 1 + composer 1 +
chrome 3 = 6, leaving ≥ 8 — the full review card ladder needs 3 (title edge, keys, bottom edge) and the full card 9
is whole from rows 17 (14 − 6 = 8 → the ladder drops the ruler at rows 16, §6.1). Invariants (all in
`layout.test.ts`, extended): `total ≤ budget`; `status === 1` at rows ≥ 3; `chrome ∈ {0, 3}` and `chrome === 3 ⇒
rows ≥ 16`; `composer ≥ 1` at rows ≥ 5 unless wizard; a non-wizard overlay of want `w` is whole whenever `rows ≥
max(8, w + 5)` in the flat tier and `rows ≥ w + 8` in the boxed tier (review card 9 → rows ≥ 17; at rows 16 it gets 8
and the ladder drops the ruler); the wizard `rows ≥ max(8, w + 4)` flat / `w + 7` boxed; `computeLayout ≤ 5 µs`.

### 2.4 Allocation table (rule·live·banner·pane·queue·overlay·preview·composer·chrome·status = total of budget)

| State (wants) | rows 12 (b 10, flat) | rows 16 (b 14, boxed) | rows 24 (b 22, boxed) | rows 40 (b 38, boxed) |
| --- | --- | --- | --- | --- |
| splash running (pane = splash 5 at ≥ 64 cols; brand row only at rows 12) | 1·0·0·0·0·0·0·1·0·1 = 3 | 1·0·0·5·0·0·0·1·3·1 = 11 | 11 | 11 |
| idle after the splash (panel collapsed) | 3 | 1·0·0·0·0·0·0·1·3·1 = 6 | 6 | 6 |
| idle after a run, panel collapsed (F-B was 15) | 3 | 6 | 6 | 6 |
| idle after a run, panel open (pane 6) | 1·0·0·6·0·0·0·1·0·1 = 9 | 1·0·0·6·0·0·0·1·3·1 = 12 | 12 | 12 |
| idle after a run, panel full (pane 12) | 1·0·0·7·0·0·0·1·0·1 = 10 | 1·0·0·8·0·0·0·1·3·1 = 14 | 1·0·0·12·0·0·0·1·3·1 = 18 | 18 |
| idle, 6-row draft, panel collapsed | composer 6 = 8 | composer 6 = 11 | 11 | 11 |
| live, jev-only synth line (live 1), panel collapsed | 1·1·0·0·0·0·0·1·0·1 = 4 | 1·1·0·0·0·0·0·1·3·1 = 7 | 7 | 7 |
| live, streaming (live 2), panel open (6) | 1·2·0·5·0·0·0·1·0·1 = 10 | 1·2·0·5·0·0·0·1·3·1 = 13 | 1·2·0·6·0·0·0·1·3·1 = 14 | 14 |
| live, 2 queued, 3-row draft, panel open | 1·1·0·2·2·0·0·3·0·1 = 10 | 1·2·0·2·2·0·0·3·3·1 = 14 | 1·2·0·6·2·0·0·3·3·1 = 18 | 18 |
| review pending (card 9, preview 4), panel collapsed | flat: header 7 → 1·0·0·0·0·7·0·1·0·1 = 10 (F-H) | 1·0·0·0·0·8·0·1·3·1 = 14 (ruler dropped) | 1·0·0·0·0·9·4·1·3·1 = 19 | 19 |
| review pending, panel open (6) | as above | as above | 1·0·0·3·0·9·4·1·3·1 = 22 | 1·0·0·6·0·9·4·1·3·1 = 25 |
| review + `e` (preview 30) | 10 | 14 | 1·0·0·0·0·9·7·1·3·1 = 22 | 1·0·0·0·0·9·23·1·3·1 = 38 |
| palette open (card 8) | 1·0·0·0·0·7·0·1·0·1 = 10 | 1·0·0·0·0·8·0·1·3·1 = 14 | 14 | 14 |
| onboarding wizard (3 rows in the console; composer refunded) | 1·0·0·0·0·3·0·0·0·1 = 5 (F-M) | 1·0·0·0·0·3·0·0·3·1 = 8 | 8 | 8 |
| follow-up confirm (box 5) | 1·0·0·0·0·5·0·1·0·1 = 8 | 1·0·0·0·0·5·0·1·3·1 = 11 | 11 | 11 |
| exit confirm / undo (card 3) | 1·0·0·0·0·1·0·1·0·1 = 4 | 1·0·0·0·0·3·0·1·3·1 = 9 | 9 | 9 |
| blocking pane (card 6) | 1·0·0·0·0·4·0·1·0·1 = 7 (F-U) | 1·0·0·0·0·6·0·1·3·1 = 12 | 12 | 12 |
| secret gate (1 row inside the console, 3-row draft) | 1·0·0·0·0·1·0·3·0·1 = 6 | 1·0·0·0·0·1·0·3·3·1 = 9 | 9 | 9 |
| picker (pane 12, composer = filter in the console) | 1·0·0·7·0·0·0·1·0·1 = 10 | 1·0·0·8·0·0·0·1·3·1 = 14 | 1·0·0·12·0·0·0·1·3·1 = 18 | 18 |

At rows 40 and 50 only the composer cap changes (8), as in TD §2.2; the region never exceeds 25 rows without `e`.
Columns change row contents, never row counts, except the 40-column minimum and the 64-column wordmark rule.

## 3. The console (composer box + badge + status compartment)

### 3.1 Rows

Boxed tier, `columns` wide, inner width `W = columns − 4` (`│ ` + text + ` │`):

```
╭─ <badge>[ · next run] ──…── <dir> ─╮      top edge: mode badge left, workspace basename right (OC §2.3 header/footer)
│ › <draft row 0 or placeholder>     │      composer rows (1..cap; continuation rows `  `); the secret gate row, when up, sits above them (§3.5)
│   <draft row k>                    │
├────────────────────────────────────┤      divider
│ <statusLineText(state, W)>         │      status compartment: TD §7.4's three zones, unchanged text, at width W
╰────────────────────────────────────╯      bottom edge
```

```ts
// src/tui/console.ts (NEW, pure; the shared lines() of the console for Ink, --plain frame tests and --ascii)
export interface ConsoleInput {
  columns: number;                       // terminal width; inner width is columns − 4
  badge: string;                         // modeBadge(mode, pending) — `jev-only` · `jev+llm` · `llm-only`, with ` · next run` when pending (§3.3)
  dir: string;                           // basename(cwd) (sessionDirName, App.tsx:2027); '' hides the right label
  title?: string | null;                 // replaces the badge while the console hosts something else: `setup · generator key`, `sessions · filter` (§3.6)
  body: readonly string[];               // composer rows (composerView(...).rows), wizard rows, or the picker filter row — already ≤ W cells each
  gate?: string | null;                  // §3.5: the secret-gate row (gateLines(hits, W)[0]) drawn above the body
  status: string;                        // statusLineText(state, W, opts)
  glyphs?: GlyphSet;
}
export function consoleTopEdge(badge: string, dir: string, columns: number, g?: GlyphSet): string;   // `╭─ jev-only ──…── proj ─╮`, badge and dir truncated by truncateCells so the edge is exactly `columns` cells
export function consoleRow(text: string, columns: number, g?: GlyphSet): string;                      // `│ ` + fitCells(text, columns − 4) + ` │`
export function consoleDivider(columns: number, g?: GlyphSet): string;                                 // `├` + `─`×(columns − 2) + `┤`
export function consoleBottom(columns: number, g?: GlyphSet): string;                                  // `╰` + `─`×(columns − 2) + `╯`
export function consoleLines(i: ConsoleInput): string[];                                               // top, gate?, body…, divider, status, bottom — exactly body.length + (gate ? 1 : 0) + 4 rows
export function consoleInnerWidth(columns: number): number;                                            // Math.max(1, columns − 4)
```

The `Console.tsx` component (§10.4) draws `consoleLines()` as `<Text wrap="truncate">` rows inside a
`<Box flexDirection="column" height={n} overflow="hidden">`, colouring the edges with the `border` role, the badge
with `badge`, the status text per `StatusLine.tsx:61–63`'s rules, and placing the single cursor at
`{ x: 2 + view.cursor.x, y: top + 1 + gateRows + view.cursor.row }` — the `2` is `│ `, the `1` the top edge. Why text
rows rather than `<Box borderStyle="round">`: Ink's border cannot carry a title in its top edge (`render-border.js:36–40`
repeats `box.top` across the whole content width), the twins (`--plain` frame tests, `--ascii`, SR) read strings, and
TD's frame-parity test compares strings; `followupLines` (`review/lines.ts:303–308`) already draws its box this way
with `g.boxTopLeft…`. The glyph table gains the round corners and the tee pieces (§7.5) and the ASCII twin maps them
to `+ - |` (`+` for `├`/`┤`), the same picture Ink's `classic` style draws.

Flat tier: no console. The composer rows and the status row render as today (`App.tsx:1828–1848`), but the composer
prompt is `› ` (§3.4) and the badge appears at the start of the status row's left zone, before the mode word:
`jev-only · idle` (§3.3), so the mode is always visible.

### 3.2 Column budget

Inner width `W = columns − 4`: 76 at 80 columns, 116 at 120, 36 at the 40-column minimum. `composerView` is called
with `columns: W` (its gutter arithmetic is unchanged), `draftRows(text, chips, W, PROMPT)` feeds `composerWant`,
`statusLineText(state, W, opts)` builds the status compartment. The status drop order (`status/lines.ts:364`) applies
at `W`: at 80 columns idle the right zone `step 0/–  sess $0.00/1.25 ok  ? help` (36 cells) fits; live in jev-only
`⠹ propose [synth]` (17) + `step 3/40 0m41s  run $0.00/0.25 ok  sess $0.00/1.25 ok  ? help` (62) is 81 > 76, so
`? help` drops first (§9 G-E). The git zone and sparkline thresholds (`GIT_ZONE_MIN_COLUMNS = 100`,
`SPARKLINE_MIN_COLUMNS = 100`, `status/lines.ts:108–111`) are compared against `W`, so they appear from 104 terminal
columns in the boxed tier (a deliberate, documented shift of 4; the 120-column frames still carry both).

### 3.3 Mode badge

```ts
// src/tui/status/lines.ts (additions)
export type ModeBadge = 'jev-only' | 'jev+llm' | 'llm-only';
export function modeBadgeWord(mode: EngineMode): ModeBadge;                     // jev-only → 'jev-only'; jev-on → 'jev+llm'; jev-off → 'llm-only'
export function modeBadge(mode: EngineMode, pending: EngineMode | null): string; // `jev-only`; `jev+llm · next run` while /mode set a different mode for the next run
```

The badge is text (the marker is the word itself, TD §14.1 "marker or word beside every colour") coloured with the
`badge` role (accent, bold) in the console's top edge, and prefixed to the left zone in the flat tier
(`leftZoneText`: `${badge} · ${word}`, dropped to the word alone when the row is short — the drop order gains `badge`
before `help`). Source of truth: `UiState.modeBadge: { mode: EngineMode; pending: EngineMode | null }` fed by a new
action `{ type: 'mode'; mode: EngineMode; pending: EngineMode | null }` that the controller dispatches after
`resolveConfig` and on every `/mode` (D-A owns the command; §12). Before the controller speaks — i.e. in the first
frame — the App shows the launch-resolved mode: `--mode` flag > `JEVCODE_MODE` env > `jev-only`, computed in
`resolveLaunchSettings` (argv + env, no file — TD §16's launch class) as `launch.modeHint`; a file that sets another
mode updates the badge at `setUi` (~100 ms later, one frame). `run:start.mode` (`useEngine.tsx` `resetForRun`) also
sets `modeBadge.mode` and clears `pending`.

### 3.4 Composer: prompt glyph and placeholders

`PROMPT` becomes `'› '` (U+203A, one cell) with `'> '` under `--ascii` (`glyphs.prompt`); `--plain`'s readline stays
`> ` (`plain-composer.ts`, cooked mode). Continuation rows stay two spaces; the picker filter row is `› filter: `.
Placeholders (TD §24 "Header and placeholders" is amended; every twin prints these exactly):

| `ComposerMode` | New placeholder (≤ 100 inner cells) | ≥ 100 inner cells appends |
| --- | --- | --- |
| `task` | `Say hi, ask a question, or describe a task…` | `   / commands · @ files` |
| `followup` | `Follow-up, question, or /command…` | `   ↑ history · Esc Esc menu` |
| `steer` | `Type to steer the next step…  Esc pauses` | `   Esc Esc aborts` |
| `review` | `(review pending — keys in the card; d opens a note)` / short `(review pending)` below 16 rows | — |
| `followupWait` `exitWait` `blocked` `filter` `done` | unchanged | — |

`placeholderFor(mode, rows, innerColumns)` gains the width argument; `? help` stays the discoverable path (status
right zone) and `?`/F1 on an empty draft appends the help block (TD §3.2). The `>` prompt turned yellow while live
(`Composer.tsx:566`) stays as the `steer` role on `›`.

### 3.5 Rows the console hosts besides the draft

- **Secret gate** (`overlay === 'secret'`, 1 row): `⚠ Looks like this contains a secret (sk-ant-…). Send anyway? y/N`
  (`gateLines(hits, W)[0]`, `secrets/gate-lines.ts`) is drawn as the first inner row, above the draft rows, in the
  `secret` role — the gate is about the draft, so it sits with it. Layout: `overlay = 1` as today; the Overlay
  component draws nothing for `secret` in the boxed tier and the App hands the row to `<Console gate>`. Keys, arming
  (`GATE_ARM_MS`, `App.tsx:82`) and the `⚠ secret?` status badge are unchanged (F-V's `•` masking holds).
- **Wizard** (TD §11.1): the wizard's 2–4 rows replace the composer rows (`composer` refunded, `overlay = wizardRows`);
  the top edge reads `╭─ setup · <step> ─…` with `<step>` ∈ `provider` · `generator key` · `jev key` · `verify` ·
  `trust`; the masked field row is `› •••••` (`maskedFieldRow` with the `›` prompt); the status left zone is `setup`.
  The `d` note field of a review stays in the review card's row 2 (TD §6.3).
- **Picker filter** (TD §8.4): `› filter: par_` as the single body row; the top edge reads `╭─ sessions · filter ─…`
  and the picker rows fill the pane slot (12) as today.
- **Collapsed composer under a review** (TD §6.2): one dim inactive row `│ › (review pending — keys in the card; d opens a note) │`.

### 3.6 Why not box the status bar separately

A separate 3-row boxed status bar plus a 2-edge composer box costs +4 rows over today; the console shares edges and
costs +3, and the divider keeps a multi-row draft from being read as status text (a status inside the same compartment
as the draft was rejected for that reason). A cheaper variant — status text written *on* the bottom edge with `─`
fill — costs +1 but puts the numbers on a dim rule where they scan badly; rejected. The console is the literal reading
of D-D ("a boxed status bar with three zones and a mode badge") and matches OC §2.3's header/textarea/footer stack.

## 4. The transcript as a conversation

### 4.1 The identity rule, restated for round 2

Every row the TUI commits to `<Static>` is `glyphTwin(formatTranscriptItem(item))` (`Transcript.tsx:52–55`,
`plain.ts:397`) — unchanged, byte for byte. Two things are new and both are declared, not smuggled:

1. **A default kind filter.** `UiState.transcript: 'compact' | 'full'` (default `compact`). In `compact` the TUI hides
   items of the stage kinds `intent`, `context`, `synth`, `proposal`, `risk`, `outcome`, `judge`, `plan` and the
   `run:ready` line; it shows `step` (new, §4.3), `run:start`, `run:end`, `confirm:resolved`, `error`, `transcript`,
   `loop:tripped`, `replan`, `steer:*`, `pause`, `budget`, `retry`, `notice`, `workspace`, `blocking`, `secret-ack`,
   `ui` and the chat labels. `transcript.log` and `--plain` always carry every item; `--plain` is therefore the `full`
   twin. The filter is decided **when the item is appended** (`appendItems`, `useEngine.tsx:387–391`, stamps
   `hidden: true` from the mode at that time), so the array `<Transcript>` receives (`items.filter(i => !i.hidden)`) is
   itself append-only and index-stable, which is what Ink's `<Static>` requires (A25: "Replacing the items array
   renders 0 new items"). `/transcript full|compact` therefore applies to **new items only**, like `/theme` (R4).
2. **Decoration that never changes text.** A blank spacer row above a turn, a dim label span, a hanging indent, a
   bullet on reply detail lines, code-fence rows drawn as thin rules — colour, margin and glyph twins only. The
   comparison in `app.test.tsx:299` ("transcript rows match formatTranscriptItem line for line") keeps passing when
   run in `full` mode with blank rows skipped (§10.11); a new test asserts the `compact` subsequence rule.

### 4.2 Bubbles

Labels `[you]` and `[jevcode]` join `UiLabel` (`types.ts:1100`; D-C owns the items, this section owns their look).

| Item | Static rows (Ink) | Colour | Plain twin |
| --- | --- | --- | --- |
| `[you] <text>` | spacer row (marginTop 1) · `[you]` dim + ` ` + text in the `you` role (accent); continuation rows hang under the text column (a flex row: label box, then a `flexGrow` body box that wraps at the commit width, A33) | `you` | `[you] <text>` |
| `[jevcode] <text>` (+ `detail` lines) | spacer · `[jevcode]` dim + ` ` + text (default colour, no bold); each `detail` line as its own row under the text column, prefixed `· ` when it is a fact line (§4.4), verbatim otherwise; fenced code (` ``` ` lines) renders the fence rows as a dim `╶──── <lang>` / `╶────` rule and the code rows indented two cells in the `code` role | default; `dim` label | `[jevcode] <text>` then each detail line indented two spaces (D-C contract: chat `detail` is written to all three sinks, §12) |
| `[step N] …` | no spacer; label dim, text default; the verdict word coloured by `itemRole` (`theme.ts:129–134`: `[review]` warn, `[block]` error) | as today | unchanged |
| `[run] start …` / `[run] end …` | spacer above; `[run]` dim; the `end` text in `ok`/`warn` by stop reason (`StatusLine.tsx:62` rule reused) | as today | unchanged |
| `[ui]` `[setup]` `[config]` `[sandbox]` | no spacer; label dim; text dim unless level ≥ warn | as today | unchanged |

Spacer rows are part of the item's own `<Box marginTop={1}>`, so `<Static>` still appends one item per commit and one
frame per item (TD §18 "static" class); a spacer adds one empty line to that frame's bytes (≈ 0 B of content). The
header item (`sessionHeaderItem`, `plain.ts:750`) renders dim with no spacer and keeps its text (the first-frame test
`app.test.tsx:231` holds).

### 4.3 The step summary line

`step:end` yields nothing today (`plain.ts:276` comment: events that feed the panes only yield `[]`). It gains one item
of the new kind `'step'` so the line exists in all three sinks:

```ts
// src/tui/plain.ts (additions)
export type TranscriptKind = /* …existing… */ | 'step';
/** `[step N] <intent> <kind> <target ≤ 40>[ "<goal ≤ 32>"] · risk <r> <verdict> · <outcome> · <evidence> · judge <p> · <wall> · <cost>` */
export function stepSummaryText(r: StepRecord, costUsd?: { generator: number; jev: number }): string;
```

Fields, in order, separated by ` · `, each omitted when its source is null (a step interrupted at `intent` prints
`[step 3] interrupted at intent (human_abort)`):

| Segment | Source | Form |
| --- | --- | --- |
| intent + action | `r.intent`, `describeAction(r.proposal.action)` (`plain.ts:142`) | `edit src/a.py`, `run $ pytest -q`, `read tests/test_kth.py, kth.py`, `done <summary ≤ 40>`; the goal in quotes only when the kind is `edit`/`write`/`patch` and ≤ 32 chars fit within 80 cells |
| risk | `r.risk.risk`, `r.risk.verdict` | `risk 0.12 ok` · `risk 0.44 [review]` · `risk 0.81 [block]` (the bracketed verdict words are `itemRole`'s markers) |
| review outcome | the step's `confirm:resolved` (folded by the reducer, not in `StepRecord`; the plain twin prints it as its own line, so `stepSummaryText` omits it — the TUI's compact filter keeps `confirm:resolved` visible) | — |
| outcome | `r.outcome.status`, `r.outcome.changedFiles.length` | `1 file` / `2 files` when files changed; `declined`, `failed`, `skipped`, `blocked` when the status is not `executed`; nothing for a plain executed step (a judged step implies execution) |
| evidence | `r.judge.tests` when `source === 'parsed'` | `tests 41p/0f/0e` |
| judge | `r.judge.succeeded`, `r.completion` | `judge 0.89`; `complete 0.93` appended when `completion ≥ thresholds.complete` |
| wall | `r.timing.totalMs` | `1.2s` (one decimal below 10 s, else `12s`, `1m02s` via `wallText`) |
| cost or tokens | `costUsd` when the event carries it, else `r.usage` | `$0.004` (three decimals, `usd()`); jev-only shows `$0.0004` with four when < $0.001; without cost: `jev 1.4k` / `gen 5.4k jev 1.4k` (`kShort`) |

`costUsd` is an optional addition to the `step:end` event (`{ type: 'step:end'; record: StepRecord; costUsd?: … }`,
`types.ts:1130`; the engine has the meter — §12 lists it as a contract request). The line is clipped at
`TRANSCRIPT_TEXT_MAX` like every item. `<Static>` rows are word-wrapped by Ink at the commit width (A33), never
truncated, so a long summary takes two rows at 80 columns: the segments are ordered so that the action and the risk
verdict come first and the wall clock and cost are what wraps (G-E1 shows the two-row case, G-E2 the one-row case at
120). The target is cut to 40 cells and the goal to 32 so a `read`/`run` step and most edits fit one row at 120
columns; at 80 columns an edit with a goal and test evidence wraps by design.

### 4.4 Reply bodies

A `[jevcode]` item's `text` is the first line (≤ 600 chars, one line); `detail` carries continuation lines. For a
`question_about_this_tool` reply (D-C) the detail lines are facts, one per line, each starting with `· `; the TUI keeps
the bullet (it is text) and aligns them under the body column. A `question_about_the_code` summary may contain fenced
code; the plain twin prints the fences verbatim, the TUI draws fence rows as `╶──── py` / `╶────` (dim) and the code
rows two cells in, `code` role — the only place a `<Static>` row's *text* is glyph-substituted beyond `--ascii`, and it
is limited to lines that are exactly a fence (`/^```\w*$/`). Bounded by `TRANSCRIPT_DETAIL_MAX_LINES` (60).

### 4.5 What the transcript looks like across a task (compact)

```
[you] make the failing test pass

[run] start r1 mode=jev-only task: make the failing test pass
[step 1] read tests/test_kth.py, kth.py · risk 0.02 ok · judge 0.71 · 0.9s · $0.0004
[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 40p/1f/0e · judge 0.52 · 1.6s · $0.0006
[step 3] run $ pytest -q · risk 0.03 ok · tests 41p/0f/0e · judge 0.94 · complete 0.91 · 2.1s · $0.0005
[run] end complete steps=3 wall=0m05s cost=$0.002 (gen $0.000, jev $0.002)

[jevcode] Done — kth.py guards k > len(xs); 41 tests pass. /diff shows the change, /undo reverts it.
```

The closing `[jevcode]` line is D-C's run epilogue as a bubble (today's `[ui] stopped — …` items keep their form for
non-complete stops).

## 5. The Jev panel

### 5.1 Three sizes

`UiState.panel: 'collapsed' | 'open' | 'full'` (default `collapsed`; reset to `collapsed` at `run:start`; the picker
forces `full` for its lifetime). `paneWant` (`App.tsx:1723`) becomes
`pickerOpen ? PICKER_PANE_WANT : splash === 'running' ? CAP.splash : panel === 'open' ? CAP.panel : panel === 'full' ? CAP.pane : 0`.

| State | Rule row | Pane rows | How |
| --- | --- | --- | --- |
| collapsed | the **strip** (§5.2) | 0 | default; `Alt+J`, `/panel off`, `Esc` on an empty draft while open |
| open | today's tab header (`paneRuleRow`, `pane/model.ts:337`) with `▾ ` before the tab name | ≤ 6; the 6th row is `  … N more rows · /panel full expands` when the tab has more | `Alt+J`, `/panel`, `/panel d\|p\|t\|s`, `[`/`]` on an empty draft (they also open a collapsed panel) |
| full | same header, `▾` | ≤ 12 (TD's pane) | `/panel full`, `Alt+Shift+J`; the review's `e` still zeroes the pane (TD §6.1) |

The `sideBySide` rule (`pane/model.ts:305`, F-D) applies only in `full`. `defaultTab` (`model.ts:300`) still picks `s`
during a jev-only propose and `d` otherwise — it selects which tab opens, not whether the panel opens.

### 5.2 The strip (collapsed form, one row on the rule)

```ts
// src/tui/pane/model.ts (addition)
/** `─── ▸ jev s7 · 12 decisions · risk 0.44 [review] · plan 2/5 · jev 231ms ──── [d] [p] [t] [s] ──` */
export function panelStrip(state: PaneState & { latencies: readonly (number | null)[] }, columns: number, g?: GlyphSet): string;
```

Left label, `·`-separated, dropped from the right when short: `▸ jev s<step>` · `<n> decisions` (rows of the current
step in `byStep`) · `risk <max risk of this step> <verdict word>` (the marker words `ok`/`[review]`/`[block]`) · `plan
<done>/<done+remaining>` · `jev <p50 ms of the last 12>ms` (≥ 100 columns). Right label: `[d] [p] [t] [s]` at < 100
columns, `[d]ecisions [p]lan [t]ime [s]ynth` at ≥ 100 (TD §7.2's convention: **bracketed letters are labels, not
keys** — TD §3.1's rule that `d p t s` insert text stands; D-D's "[d]/[p]/[t]/[s]" is read under that same
convention). Before any run the rule row is the brand row `─── jevcode 0.2.0 ─────…` (§8.6); with no decisions yet it
is `─── ▸ jev · no decisions yet ──── [d] [p] [t] [s] ──`. Built with `ruleRow(left, right, columns, g)`
(`glyphs.ts:271`), truncated by cells, never wider than `min(columns, 400)`.

### 5.3 Keys and commands

| Binding (`keys/bindings.ts`) | Default | Context | Action |
| --- | --- | --- | --- |
| `global:panelToggle` | `meta+j` | global | collapsed ↔ open (remembers the last tab) |
| `global:panelFull` | `meta+shift+j` | global | open/collapsed → full; full → open |
| `global:panelDecisions` / `panelPlan` / `panelTimeline` / `panelSynth` | `meta+d` / `meta+p` / `meta+t` / `meta+s` | global | open the panel on that tab (a second press on the same tab collapses it) |
| `global:paneNext` / `panePrev` (existing) | `]` / `[` on an empty draft | global | cycle tabs; opens a collapsed panel |
| `global:escape` (existing) | `escape` on an empty idle draft | global | first Esc collapses an open panel before arming Esc Esc (TD §3.3 S0 row gains this precondition) |

Alt chords arrive as `ESC` + letter and are already re-dispatched as Meta by the 30 ms re-buffer (`App.tsx:86`,
TD §3.3); Terminal.app needs "Use Option as Meta key", iTerm2 "Esc+" — documented in `docs/TUI.md`'s terminal notes;
`/panel` and `[`/`]` are the universal path. `/panel [d|p|t|s|off|full]` joins `commands/registry.ts` (category
`inspect`, `availableDuringTask: 'any'`, plain twin: prints the rows `paneLines` would show); `/decisions [n] [stage]`
is unchanged (appends rows as a `[ui]` item, `App.tsx:856–861`).

### 5.4 Open form (6 rows) and the `more` row

```ts
export function panelLines(state: PaneState, rows: number, columns: number, overlay: PaneOverlay, opts: PaneOptions & { size: 'open' | 'full' }): string[];
// size 'open': paneLines(...) cut to rows − 1 when the tab has more than `rows` lines, plus `  … <hidden> more rows · /panel full expands` (dim); else paneLines(...) as today
```

The decisions tab in `open` shows the **newest** rows (the last 5 of `DECISIONS_KEPT = 12`), so the strip's
`risk 0.44 [review]` and the visible rows agree on the current step.

## 6. Cards

One builder for every modal, so the review, the follow-up box, the confirms, the blocking pane and the palette share
one picture:

```ts
// src/tui/card.ts (NEW, pure)
export function cardTop(title: string, columns: number, g?: GlyphSet): string;      // `╭─ <title ≤ columns − 6> ─…─╮`; '' title → `╭──…──╮`
export function cardRow(text: string, columns: number, g?: GlyphSet): string;       // `│ ` + fitCells(text, columns − 4) + ` │`
export function cardBottom(columns: number, g?: GlyphSet): string;                  // `╰──…──╯`
export function cardLines(title: string, body: readonly string[], columns: number, g?: GlyphSet): string[];  // body.length + 2 rows
```

Colours: the card's edges take the role of its meaning — review `review` (yellow) or `block` (red, bold) by
`req.risk.verdict` (as `Review.tsx:105`), follow-up and undo `warn`, exit confirm `warn`, blocking `error`, palette
`border` (dim). Inner rows keep their existing colours. In the flat tier every card degrades to today's rows (F-G…F-I,
F-P/F-Q, F-U, F-W, F-K).

### 6.1 Review card

Boxed want `CAP.reviewCard = 9` plus the preview rows inside:

| Row | Content | Source |
| --- | --- | --- |
| top edge | `╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py "make parse_date timezone-aware" ─╮`, title truncated to `columns − 6` cells (at 80 the goal is cut: G-G); at ≥ 120 the title adds ` · jev 244ms` and `(tail on plan_mismatch)` | `reviewTitle` (`review/lines.ts:100`) reformatted with ` · ` separators — `reviewCardTitle(req, columns, g)` |
| 2 | keys `[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline` (76 cells, fits `W = 76`); ≥ 120: `REVIEW_KEYS_120`; the `d` note field replaces this row (TD §6.3) | `reviewKeys` |
| 3 | ruler | `reviewRuler(W)` |
| 4–7 | the four gauge rows, level text truncated to `W` | `gaugeRow(req, dim, W)` |
| 8 | `5 matches_intent …` | `matchesIntentRow(req, W)` |
| 9…9+k−1 | `k` preview rows (`layout.preview`), indented two cells, tail `…[k more preview lines · e expands]` | `reviewPreviewLines(confirmPreviewLines(req), k, W − 2)` |
| bottom edge | `╰──…──╯` | `cardBottom` |

```ts
// src/tui/review/lines.ts (addition) and src/tui/Review.tsx
export function reviewCardTitle(req: ConfirmRequest, columns: number, g?: GlyphSet): string;
/** boxed ladder: n ≥ 9 full · 8 drop the ruler · 7 drop matches_intent · 6..4 title edge, keys, n − 3 compact rows, bottom edge · 3 title edge, keys, bottom edge · n ≤ 2 → the flat ladder (title, keys) */
export function reviewCardLines(req: ConfirmRequest, n: number, previewRows: number, columns: number, g?: GlyphSet, note?: ReviewNote | null): string[];
```

The ladder's cut is still a function, never Ink clipping (TD §6.1). The composer collapses to one inactive row inside
the console (TD §6.2), the spinner freezes (A50), the live rows are reclaimed (A42), arming and deferral are untouched
(`App.tsx:602–641`). Invariants of TD §6.2 (only `y` approves, Enter inert, no default, a paste never matches) do not
depend on the card and stay tested by `app.test.tsx:342–461`.

### 6.2 Follow-up, exit confirm, undo, blocking

- **Follow-up** (`followupLines`, 5 rows): the same box with round glyphs (`g.roundTopLeft…`) and the title in the top
  edge as today (`╭─ follow-up would exceed the session cap ─…─╮`); rows unchanged.
- **Exit confirm** (`EXIT_CONFIRM_ROW`, `Overlay.tsx:27`) → `cardLines('exit?', [EXIT_CONFIRM_ROW], columns)` (3 rows).
- **Undo prompt** → `cardLines('undo', [row], columns)` (3 rows).
- **Blocking pane** (`blockingLines(req, n − 2, W)`) → `cardLines(title, rows, columns)` where the title is the pane's
  first row (`jev: key rejected (HTTP 401 — "User not found.")`) and the body the rest (F-U's rows 2–4), ≤ 6 rows.

### 6.3 Palette card

`cardLines('commands', rows, columns)` where `rows = paletteRows(query, state, selected, 6, W)` — the two edges replace
the footer's separate row and one list row so the card is still ≤ 8 rows (A34); the footer `(i/N)  Tab completes ·
Enter runs an exact match · Esc closes` is the last inner row. The mention popup reuses it with the title `files`.
Matched-grapheme bolding (`PaletteRowText`, `Overlay.tsx:97–119`) applies inside `cardRow`'s padding.

## 7. Theme: accent palette, depth detection, markers

### 7.1 Depth detection (pure, argv + env + stream, no query)

```ts
// src/tui/color-shim.ts (additions)
export type ColorDepth = 0 | 16 | 256 | 24;
/** `--no-color` / NO_COLOR / TERM=dumb → 0 (colorEnabled, color-shim.ts:49); FORCE_COLOR 3 → 24, 2 → 256, 1 → 16;
 *  COLORTERM ∈ {truecolor, 24bit} → 24; TERM_PROGRAM iTerm.app · WezTerm · ghostty · vscode → 24, Apple_Terminal → 256;
 *  TERM matching /-256(color)?$/ or `alacritty` · `xterm-kitty` · `wezterm` · `foot` → 256; else 16 */
export function colorDepth(opts: ColorEnabledOptions): ColorDepth;
```

This mirrors chalk's own `supports-color` order (`node_modules/chalk/source/vendor/supports-color/index.js:130,
146–169`), which is what Ink's chalk instance uses to *downsample* any `#rrggbb` it is handed (`colorize.js:19–22` →
`chalk.hex`), so a wrong detection can only lose fidelity, never produce a bad escape. Inside tmux `COLORTERM` is
usually stripped and `TERM=tmux-256color` → 256 (TD §14.1 "16 colours inside tmux" is relaxed to "what TERM says";
256 is safe in tmux ≥ 2.2). No terminal query is ever sent (A112).

### 7.2 Palette

`ColorSpec.color` widens from one `AnsiColor` to a triple; `textProps(theme, role, depth)` picks the member for the
detected depth and `{}` at depth 0 (markers stay, TD §14.1):

```ts
// src/tui/theme.ts
export interface ColorTriple { readonly ansi16: AnsiColor; readonly ansi256?: number; readonly truecolor?: `#${string}` }
export interface ColorSpec { readonly color?: ColorTriple; readonly dimColor?: boolean; readonly bold?: boolean; readonly marker: string }
export type ColorRole = /* …existing 12… */ | 'you' | 'assistant' | 'badge' | 'border' | 'borderFocus' | 'code' | 'sweep';
export function textProps(theme: Theme, role: ColorRole, depth: ColorDepth): { color?: string; dimColor?: boolean; bold?: boolean };  // color is 'cyan' | 'ansi256(117)' | '#7DD3FC' by depth
```

| Role | dark: truecolor / 256 / 16 | light | daltonized | ansi | Marker |
| --- | --- | --- | --- | --- | --- |
| `accent` (existing) | `#7DD3FC` / 117 / `cyan` | `#0369A1` / 25 / `blue` | as dark | `cyan` | '' (decoration) |
| `badge` (new) | accent, bold | accent, bold | accent, bold | `cyan`, bold | the word |
| `border` (new) | dim | dim | dim | `gray` | the box glyphs |
| `borderFocus` (new; the console while a run is live) | `#38BDF8` / 74 / `cyan` | `#0284C7` / 31 / `blue` | as dark | `cyan` | — (a run's status word is the marker) |
| `you` (new) | `#A5B4FC` / 147 / `blueBright` | `#4338CA` / 61 / `blue` | as dark | `blueBright` | `[you]` |
| `assistant` (new) | default fg | default | default | default | `[jevcode]` |
| `code` (new) | `#E2E8F0` / 254 / `whiteBright` | `#1E293B` / 236 / `black` | as dark | `whiteBright` | the fence rows |
| `sweep` (splash head, new) | `#E0F2FE` / 195 / `whiteBright` | `#075985` / 24 / `blue` | as dark | `whiteBright` | — (motion only; absent under reduced motion) |
| `error` `warn` `ok` `block` `review` `steer` `secret` `chosen` (existing) | 16-colour names unchanged; 256/truecolor twins `#F87171`/203, `#FBBF24`/214, `#4ADE80`/114 …; `light`/`daltonized` swaps as `theme.ts:87–115` | | | | unchanged |

`validateTheme` (`theme.ts:137–147`) gains: every `ansi16` is an `AnsiColor`; a `truecolor` member is `/^#[0-9a-f]{6}$/i`;
an `ansi256` member is 0..255; `ansi` theme has no `truecolor`/`ansi256` members and never dims; roles `you`,
`badge`, `code` carry a marker. The depth is computed once at mount (`App.tsx:472` next to `colorEnabled`) and again at
`setUi` for `ui.noColor`; `/theme` swaps the table for new items and the dynamic region only (R4).

### 7.3 Backgrounds

None (F2). "Bubbles" are label + gutter + spacing, never a background block; opencode's user-message background is
deliberately not copied (TD §14.1 "no backgrounds").

### 7.4 Ambiguous-width glyphs

Every new glyph is one cell under the repo's `cellWidth` (`glyphs.ts:205`, EAW ambiguous = 1, as the existing
`█▏▎…`): `╭ ╮ ╰ ╯ ├ ┤ › ▸ ▾ ╶ ▓ ▒ ░`. Nothing with VS16, no emoji.

### 7.5 Glyph table additions (`glyphs.ts` `GlyphSet`)

| Key | Unicode | ASCII | Used by |
| --- | --- | --- | --- |
| `roundTopLeft` `roundTopRight` `roundBottomLeft` `roundBottomRight` | `╭ ╮ ╰ ╯` | `+` | console, cards, follow-up box |
| `teeLeft` `teeRight` | `├ ┤` | `+` | console divider |
| `prompt` | `›` | `>` | composer, wizard field, picker filter |
| `chevronRight` `chevronDown` | `▸ ▾` | `>` `v` | panel strip / header |
| `fence` | `╶` | `-` | code-fence rules in replies |
| `shade3` `shade2` `shade1` | `▓ ▒ ░` | `# + .` | splash sweep head |
| `brand` | `◆` | `*` | brand rule row |

`glyphTwin` (`glyphs.ts:189`) picks them up automatically (pairwise table); `--ascii` frames therefore draw
`+--- jev-only ------ proj -+` boxes.

## 8. Startup splash

### 8.1 The wordmark

Seven 5-row block letters, 56 cells wide, two-tone: `JEV` in `accent`, `CODE` in `dim` (the camel case of "JevCode"
without lowercase blocks). Centred in the pane slot (`⌊(columns − 56) / 2⌋` cells of indent) when `columns ≥ 64`;
otherwise the one-line brand row on the rule (§8.6) carries the whole splash.

```
    ██ ███████ ██    ██  ██████  ██████  ██████  ███████
    ██ ██      ██    ██ ██      ██    ██ ██   ██ ██
    ██ █████   ██    ██ ██      ██    ██ ██   ██ █████
██  ██ ██       ██  ██  ██      ██    ██ ██   ██ ██
 ████  ███████   ████    ██████  ██████  ██████  ███████
```

`--ascii`: `#` for `█`. Screen reader: never drawn (the brand row's `aria-label` is `JevCode 0.2.0`).

```ts
// src/tui/splash.ts (NEW, pure)
export const SPLASH_MS = 700;                    // total; the final frame lands at or before this
export const SPLASH_INTERVAL_MS = 50;            // 20 fps ≤ maxFps 30 (TD §14.1); 15 fps under SSH (launch.fps 15 → 67 ms)
export const WORDMARK: readonly string[];        // 5 rows × 56 cells, `█` and spaces
export const WORDMARK_CELLS = 56;
export type SplashPhase = 'reveal' | 'shimmer' | 'fade' | 'settled';
export interface SplashFrame { rows: string[]; spans: readonly { row: number; from: number; to: number; role: ColorRole }[]; phase: SplashPhase }
/** the frame at elapsed `t` ms for a terminal `columns` wide: rows are exactly CAP.splash strings ≤ columns cells (or [] once settled / when columns < 64) */
export function splashFrame(t: number, columns: number, g?: GlyphSet): SplashFrame;
/** the brand row: `─── ◆ jevcode 0.2.0 ─────…` (`ruleRow`), the `◆` in accent; the one-line splash form pulses this glyph through shade1..3 over 8 frames */
export function brandRow(version: string, columns: number, t: number | null, g?: GlyphSet): string;
```

### 8.2 Schedule

Twenty-frame budget at 50 ms (fourteen frames land inside 700 ms; the rest are slack for a throttled machine — the
phase is computed from **elapsed time**, never from a frame count, so a slow terminal skips frames instead of running
long):

| Frame | t (ms) | Phase | What changes vs the previous frame |
| --- | --- | --- | --- |
| 0 | 0 (first frame) | reveal | columns 0–6 of the wordmark (the `J`) in `accent`; the 3-cell sweep head at columns 7–9 in `shade3 shade2 shade1`; everything else blank. The console, badge and status compartment with `step 0/–` are complete in this same frame |
| 1–8 | 50–400 | reveal | the revealed edge advances by 7 cells per frame (`⌈56 · t / 400⌉`), the head moves with it: 5 rows × ≤ 10 changed cells per frame |
| 9–11 | 450–550 | shimmer | the wordmark is complete; a 6-cell highlight band in `sweep` runs left → right once (position `(t − 450) / 100 · 56`); ≤ 12 changed cells per frame |
| 12 | 600 | fade | `JEV` accent → default, `CODE` dim → dim (no change): one SGR change per row |
| 13 | 650 | fade | every letter → `dim` |
| 14 | 700 | settled | the five rows are removed (pane slot → 0) and the rule row becomes the brand row; from here `splash === 'done'` and nothing ticks |

The one-line form (columns < 64, or rows 8–15): the brand row's `◆` cycles `░ ▒ ▓ ◆` twice over 400 ms (8 frames),
then holds; no pane rows are used.

### 8.3 Rendering path and cost inside Ink

- **Timer.** `useMotion(active)` in a new `src/tui/motion.ts` wraps Ink's `useAnimation({ interval: SPLASH_INTERVAL_MS, isActive })`
  (`node_modules/ink/build/hooks/use-animation.js`): one shared timer, ticks coalesced inside Ink's render-throttle
  window (`use-animation.js:41–49` skip ticks while `currentTime < nextRenderTime`), so the splash can never exceed
  `maxFps` — the `dynamic ≤ maxFps + 1` gate (TD §18) holds by construction. `motion.ts` is the third module allowed
  to drive time (TD §14.2's `setInterval(` grep passes as written — Ink owns the interval; the grep test gains
  `useAnimation(` with the same allow-list). Codex's centralised `motion.rs` (ACC §1, PR #20564) is the precedent.
- **Bytes.** Standard log-update rewrites the dynamic region per frame (INK §1.2): rule 1 + wordmark 5 + console 5 =
  11 rows ≈ 1.0 KB (`08 §11`: 1,436 B per key at 22 rows), 15 frames ≈ 15 KB over 700 ms; under `--render-mode
  incremental` only the ≤ 5 changed rows are written (INK §1.2, ≈ 250 B per frame). The *content* diff per frame is
  ≤ 12 cells, which is what "each frame a tiny diff" means for the two modes.
- **First frame.** Frame 0 is the first frame: `render()` mounts with `splash: 'running'`, `elapsed = 0`, and the
  layout grants `pane = 5` (boxed tier) or 0 (flat). It carries `step 0/–` in the status compartment, so
  `perf/first-frame.ts:57` (`SENTINEL = 'step 0/'`, searched in the accumulated bytes) is satisfied by the same frame.
  Cost: today's first frame (chat 24×80 cold p95 110 ms, `perf/results/latest.json` `firstFrame`) plus five 56-cell
  rows and four edge rows — well under 300 ms; zero network (nothing new touches I/O).
- **Cancel.** The reducer sets `splash: 'done'` on the first `{ type: 'key' }` (dispatched at the top of `handleKey`,
  `App.tsx:1525`), on `run:start`, `confirm:request`, any `overlay` change, `blocking:request`, and on `tick` once
  `nowMs − mountedAt ≥ SPLASH_MS`. The keystroke itself still reaches the composer — the splash never delays input;
  frame `k+1` shows the typed character in the console and no wordmark.
- **Reduced motion / screen reader / plain.** `launch.reducedMotion` (new launch member: `--no-animation` >
  `JEVCODE_REDUCED_MOTION` > `screenReader`; the file key `reducedMotion` stays a session setting and, when true,
  snaps the splash to `done` at `setUi`) or `launch.screenReader` → the App mounts with `splash: 'done'` and the brand
  row static; `--plain` has no splash (its first line is the header, `plainFirstLine`, unchanged); `--ascii` draws the
  `#` wordmark with `# + .` heads.
- **Resize during the splash.** The pane slot recomputes; below 64 columns the wordmark rows vanish and the brand row
  continues from the same elapsed time; a shrink in rows is Ink's one allowed clear (TD §18).
- **Settling into the header.** The `<Static>` header item stays what it is (`[run] jevcode session · proj | step
  0/– starting`, first scrollback line, dim): the splash settles into the **brand rule row**, not into `<Static>`
  (prepending to `<Static>` later would move index 0, which Ink's `<Static>` cannot follow — `Transcript.tsx:79–81`).

### 8.4 What the splash never does

No network, no file read, no `<Static>` write, no clear, no cursor hide beyond Ink's per-frame rule (TD §18 "Cursor
and hide/show"), no motion after 700 ms, no motion under reduced motion, nothing when `rows < 8`.

### 8.5 Cost against the gates

| Gate | Effect | Where measured |
| --- | --- | --- |
| first frame < 300 ms | +5 short rows and 4 edge rows in frame 0; the sentinel is in frame 0 | `perf/first-frame.ts` (`chat` series, unchanged sentinel) |
| `dynamic ≤ maxFps + 1` | 20 fps for 700 ms, coalesced by Ink's throttle | `render-lag.ts` frame classes (the first second of every series now includes the splash) |
| zero clears | region grows to 11 rows then shrinks to 6: a height *decrease* of the dynamic region is `eraseLines(previousLineCount)` + fewer lines, never a clear | `render-lag.ts` `CLEAR_RE`, `test/pty/smoke/splash.steps` |
| keystroke → frame p95 < 16 ms | a key during the splash cancels it in the same reducer step | `composer-latency.ts` `idle` series (its first keys land during the splash) |
| lag p95 < 5 ms | 15 renders of ≤ 11 rows in 700 ms, idle otherwise | `render-lag.ts` (warm-up 500 ms already covers most of it; the gate is on the typing window) |

### 8.6 Brand row

`─── ◆ jevcode 0.2.0 ─────…` (`ruleRow('◆ jevcode 0.2.0', '', columns)`, version from `src/version.ts`), `◆` and
`jevcode` in `accent`, the rest `rule` (dim). It is the idle rule row until the first `run:ready`, after which the
panel strip takes the rule row (§5.2).

## 9. Frames

Legend as in TD §2.3. Every fenced block is measured by the caption test (§10.11): rows ≤ columns cells, dynamic row
count = caption, dynamic ≤ rows − 2.

**G-A1. Splash frame 0 (t = 0, the first frame), 80×24 (11 dynamic rows; 1 scrollback row above; the `J` and the sweep head are the only wordmark cells; the console with `step 0/–` is complete)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ▓▒░
                ██ ▓▒░
                ██ ▓▒░
            ██  ██ ▓▒░
             ████  ▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-A2. Splash mid frame (t ≈ 300 ms, frame 6), 80×24 (11 dynamic rows; 1 scrollback row above; 42 of 56 columns revealed, head at 42–44)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────
                ██ ███████ ██    ██  ██████  ██████  ██▓▒░
                ██ ██      ██    ██ ██      ██    ██ ██▓▒░
                ██ █████   ██    ██ ██      ██    ██ ██▓▒░
            ██  ██ ██       ██  ██  ██      ██    ██ ██▓▒░
             ████  ███████   ████    ██████  ██████  ██▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-A3. Splash settled (t = 700 ms) = idle after the splash, 80×24 (6 dynamic rows; 3 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting
[sandbox] seatbelt — writes confined to the workspace and run dirs
[ui] recent: "fix parse_date tz" · 2 h ago  (Enter continues, /resume browses)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-A4. Splash mid frame, 120×40 (11 dynamic rows; 1 scrollback row above; the wordmark is centred at 32 cells; the status compartment gains the git zone and the sparkline at W = 116)**

```
[run] jevcode session · proj | step 0/– starting
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
                                    ██ ███████ ██    ██  ██████  ██████  ██▓▒░
                                    ██ ██      ██    ██ ██      ██    ██ ██▓▒░
                                    ██ █████   ██    ██ ██      ██    ██ ██▓▒░
                                ██  ██ ██       ██  ██  ██      ██    ██ ██▓▒░
                                 ████  ███████   ████    ██████  ██████  ██▓▒░
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                    step 0/–  sess $0.00/1.25 ok  ⎇ main  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-B. Idle after the splash, 120×24 (6 dynamic rows; 2 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting
[sandbox] seatbelt — writes confined to the workspace and run dirs
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                    step 0/–  sess $0.00/1.25 ok  ⎇ main  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-C1. A chat exchange (greeting), 80×24 (6 dynamic rows; 6 scrollback rows above; the blank rows are the bubbles' spacers; `[you]` and `[jevcode]` are dim labels, the `you` text in the `you` role)**

```
[run] jevcode session · proj | step 0/– starting

[you] hi

[jevcode] Hi. Jev decides every step here — ask about this tool or the code, or
          describe a task and I'll run it.
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The reply line is one item: `[jevcode] Hi. Jev decides every step here — ask about this tool or the code, or describe
a task and I'll run it.` (117 chars) wrapped by Ink at the commit width with the hanging indent; `--plain` prints it as
one line. The intake cost lands in the session meter (`sess $0.00/1.25` moves at the fourth decimal; `usd2` shows it
from $0.01).

**G-C2. The same exchange, 120×24 (6 dynamic rows; 5 scrollback rows above)**

```
[run] jevcode session · proj | step 0/– starting

[you] hi

[jevcode] Hi. Jev decides every step here — ask about this tool or the code, or describe a task and I'll run it.
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                    step 0/–  sess $0.00/1.25 ok  ⎇ main  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-D1. A question about the tool, 80×24 (6 dynamic rows; 10 scrollback rows above; the reply is one item whose `detail` lines are the `·` facts)**

```
[you] what can you do here?

[jevcode] I work on proj in jev-only mode: Jev decides, code proposes, tests
          verify — no generating LLM.
          · workspace proj (main, clean) · sandbox seatbelt
          · Jev via TypeSafe (native), jev-1.13.0 · 110 ms p50
          · last run: none yet in this session
          · say what to change and I'll run it; ask about the code and I'll
            read, not write
          · /mode jev-on adds an LLM for the next run (needs a generator key)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-D2. The same reply, 120×24 (6 dynamic rows; 8 scrollback rows above)**

```
[you] what can you do here?

[jevcode] I work on proj in jev-only mode: Jev decides, code proposes, tests verify — no generating LLM.
          · workspace proj (main, clean) · sandbox seatbelt
          · Jev via TypeSafe (native), jev-1.13.0 · 110 ms p50
          · last run: none yet in this session
          · say what to change and I'll run it; ask about the code and I'll read, not write
          · /mode jev-on adds an LLM for the next run (needs a generator key)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                    step 0/–  sess $0.00/1.25 ok  ⎇ main  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-E1. A task run, live, jev-only, panel collapsed, 80×24 (7 dynamic rows: strip 1 + live 1 + console 5; 7 scrollback rows above; the status row dropped `? help` at W = 76)**

```
[you] make the failing test pass

[run] start r1 mode=jev-only task: make the failing test pass
[step 1] read tests/test_kth.py, kth.py · risk 0.02 ok · judge 0.71 · 0.9s ·
$0.0004
[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 40p/1f/0e ·
judge 0.52 · 1.6s · $0.0006
─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ──────── [d] [p] [t] [s] ──
synth sieve: tested 37/137 candidates (candidates=137, tested=37)
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Type to steer the next step…  Esc pauses                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⠹ propose [synth]     step 3/40 0m41s  run $0.00/0.25 ok  sess $0.00/1.25 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-E2. The same run, 120×24 (7 dynamic rows; 5 scrollback rows above; the strip gains the words and `jev 110ms`; the status keeps `? help`, the git zone and the sparkline)**

```
[you] make the failing test pass

[run] start r1 mode=jev-only task: make the failing test pass
[step 1] read tests/test_kth.py, kth.py · risk 0.02 ok · judge 0.71 · 0.9s · $0.0004
[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 40p/1f/0e · judge 0.52 · 1.6s · $0.0006
─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 · jev 110ms ─────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
synth sieve: tested 37/137 candidates (candidates=137, tested=37)
╭─ jev-only ──────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Type to steer the next step…  Esc pauses   Esc Esc aborts                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⠹ propose [synth]      step 3/40 0m41s  run $0.00/0.25 ok  sess $0.00/1.25 ok  ⎇ main · 1~  jev ▂▁▂▁▁▂▁▂▁▁▁▂  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-F1. The Jev panel open (6 rows) after run 7, 80×24 (12 dynamic rows: header 1 + pane 6 + console 5; 2 scrollback rows above; the sixth pane row is the `more` row)**

```
[run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
[ui] stopped — max_steps (exit 4) · raise: /budget max-steps 14, then /resume
─── ▾ decisions s7 · c~ derived |2p−1| ──── [d]ecisions [p]lan [t]ime [s]ynth ──
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~
  … 7 more rows · /panel full expands
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4           step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-F2. The panel open, 120×24 (12 dynamic rows; 2 scrollback rows above; rows gain `latencyMs` and `consumedBy` as in F-J)**

```
[run] end max_steps steps=7 wall=4m12s cost=$0.310 (gen $0.281, jev $0.029)
[ui] stopped — max_steps (exit 4) · raise: /budget max-steps 14, then /resume
─── ▾ decisions s7 · c~ derived |2p−1| ───────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]       244ms  band 0.3/0.7 (expected)
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]   244ms  band 0.3/0.7 (tail)
s7 risk     matches_intent   noul   █████████▌  0.95  c 0.90~             244ms  < 0.3 → appended to the reason
s7 judge    succeeded        noul   ████████▉·  0.89  c 0.78~             198ms  reported
s7 complete task_complete    noul   ██████▊···  0.68  c 0.36~             198ms  ≥ 0.85 → stop
  … 7 more rows · /panel full expands
╭─ jev+llm ───────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Follow-up, question, or /command…                                                         ↑ history · Esc Esc menu │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle exit 4                           step 7/7 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-G1. The review card, 80×24 (19 dynamic rows: strip 1 + card 13 (title edge, keys, ruler, 4 gauges, matches, 4 preview, bottom edge) + console 5 with the composer collapsed; 2 scrollback rows above; the title is cut at 74 cells)**

```
[step 6] run $ pytest -q tests/test_a.py · risk 0.03 ok · tests 40p/1f/0e ·
judge 0.61 · 2.4s · $0.031
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] ──────────── [d] [p] [t] [s] ──
╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py "make parse_date timez… ─╮
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ dimension     lvl 0  ┆   ┆ 1  risk bnd  conf  Jev's dominant level (why)     │
│ 1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…  │
│ 2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task a… │
│ 3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification… │
│ 4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restora… │
│ 5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of…  │
│   --- old                                                                    │
│   return datetime.strptime(s, FMT)                                           │
│   +++ new                                                                    │
│   return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)              │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › (review pending — keys in the card; d opens a note)                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ review               step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-G2. The review card, 120×40 (25 dynamic rows: header 1 + pane 6 (panel open) + card 13 with the `P(l) E[k] tail` columns + console 5; 1 scrollback row above; the title carries the whole goal and `jev 244ms`)**

```
[step 6] run $ pytest -q tests/test_a.py · risk 0.03 ok · tests 40p/1f/0e · judge 0.61 · 2.4s · $0.031
─── ▾ decisions s7 · c~ derived |2p−1| ───────────────────────────────────── [d]ecisions [p]lan [t]imeline [s]ynth ─────
s7 intent   intent           edit   ██████▍···  0.64  c 0.55   chosen     231ms  choice resolution → intent edit
s7 context  src/a.py         noul   ███████▊··  0.78  c 0.56~             198ms  selected iff p ≥ 0.5
s7 risk     destructive      L1     █████████·  0.90  c 0.93   [ok]       244ms  band 0.3/0.7 (expected)
s7 risk     plan_mismatch    L2     ████▍·····  0.44  c 0.61   [review]   244ms  band 0.3/0.7 (tail)
s7 risk     matches_intent   noul   ████████▊·  0.88  c 0.76~             244ms  < 0.3 → appended to the reason
  … 7 more rows · /panel full expands
╭─ review · step 7 · risk 0.44 (tail on plan_mismatch) · edit src/a.py "make parse_date timezone-aware" · jev 244ms ───╮
│ [y] approve  [n] decline  [d] decline+note  [e] expand preview  [w]1-5 why  [esc] decline         [ctrl-c] abort run │
│ dimension      lvl  0  ┆   ┆ 1  risk  bnd   P(l)  E[k]  tail  conf   Jev's dominant level (why); E[k]/4; tail = P(k… │
│ 1 destructive  L1  ██▌·······  0.25  exp   0.90  0.25  0.00  0.93   changes files whose previous content is recover… │
│ 2 out_of_scope L0  ··········  0.00  tail  1.00  0.00  0.00  0.98   directly does what `plan.remaining[0]`/`task` a… │
│ 3 plan_mismatch L2 ████▍·····  0.44  tail  0.61  0.35  0.44  0.61   skips a planned verification step                │
│ 4 irreversible L0  ··········  0.00  exp   0.95  0.01  0.00  0.96   no lasting effect, or restorable with one git c… │
│ 5 matches_intent   ████████▊·  0.88  noul  —     —     —     0.76~  the action is an instance of the intent `edit`   │
│   --- old                                                                                                            │
│   return datetime.strptime(s, FMT)                                                                                   │
│   +++ new                                                                                                            │
│   return datetime.strptime(s, FMT).replace(tzinfo=timezone.utc)                                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › (review pending — keys in the card; d opens a note)                                                                │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ review                               step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ⎇ main ↑2 · 1~  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-H1. The mode badge after `/mode jev-on` with a generator key configured (`jev+llm · next run`), 80×24 (6 dynamic rows; 3 scrollback rows above)**

```
[you] /mode jev-on

[ui] mode: jev+llm for the next run (this session stays jev-only until then)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev+llm · next run ────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-H2. The same, 120×24 (6 dynamic rows; 3 scrollback rows above)**

```
[you] /mode jev-on

[ui] mode: jev+llm for the next run (this session stays jev-only until then)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ jev+llm · next run ────────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ › Say hi, ask a question, or describe a task…                                                   / commands · @ files │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ idle                                                                    step 0/–  sess $0.00/1.25 ok  ⎇ main  ? help │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-I1. `/mode jev-on` with no generator key: the wizard's generator step inside the console, 80×24 (8 dynamic rows: rule 1 + console 7 (top edge, 3 wizard rows, divider, status, bottom edge); 2 scrollback rows above)**

```
[you] /mode jev-on
[ui] mode: jev+llm needs a generator key — enter it below (Esc keeps jev-only)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ setup · generator key ─────────────────────────────────────────────── proj ─╮
│ Anthropic API key (ANTHROPIC_API_KEY)                                        │
│ › ••••••••••••••••••••                                                       │
│ 20 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back     │
├──────────────────────────────────────────────────────────────────────────────┤
│ setup                                                               step 0/– │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The wizard is `reopenWizard('generator.apiKey', runLive)` (`App.tsx:1592–1594` → `onboardingReducer` `reopen`,
`reducer.ts:213–217`); when no provider resolves it opens at `provider` (`╭─ setup · provider ─…`, F-M's three rows
inside the console). Ctrl-C with no run exits 2 as today (TD D2); Esc steps back and the pending `/mode` is dropped
with `[ui] mode: kept jev-only`. The status left zone is `setup` (TD §24).

**G-I2. The same, 120×24 (8 dynamic rows; 2 scrollback rows above)**

```
[you] /mode jev-on
[ui] mode: jev+llm needs a generator key — enter it below (Esc keeps jev-only)
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────────────────────────────────────────────
╭─ setup · generator key ─────────────────────────────────────────────────────────────────────────────────────── proj ─╮
│ Anthropic API key (ANTHROPIC_API_KEY)                                                                                │
│ › ••••••••••••••••••••                                                                                               │
│ 20 chars · Enter saves · Backspace · Ctrl-U clears · paste ok · Esc back                                             │
├──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ setup                                                                                                       step 0/– │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**G-J. Flat tier: idle after the splash, 80×12 (3 dynamic rows; 2 scrollback rows above; the badge leads the status left zone)**

```
[run] jevcode session · proj | step 0/– starting
[sandbox] seatbelt — writes confined to the workspace and run dirs
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
› Say hi, ask a question, or describe a task…
jev-only · idle                            step 0/–  sess $0.00/1.25 ok  ? help
```

**G-K. Flat tier: the live run of G-E1, 80×12 (4 dynamic rows: strip 1 + live 1 + composer 1 + status 1; 5 scrollback rows above)**

```
[run] start r1 mode=jev-only task: make the failing test pass
[step 1] read tests/test_kth.py, kth.py · risk 0.02 ok · judge 0.71 · 0.9s ·
$0.0004
[step 2] edit kth.py "guard k > len" · risk 0.12 ok · 1 file · tests 40p/1f/0e ·
judge 0.52 · 1.6s · $0.0006
─── ▸ jev s3 · 9 decisions · risk 0.10 ok · plan 1/3 ──────── [d] [p] [t] [s] ──
synth sieve: tested 37/137 candidates (candidates=137, tested=37)
› Type to steer the next step…  Esc pauses
⠹ propose [synth]     step 3/40 0m41s  run $0.00/0.25 ok  sess $0.00/1.25 ok
```

**G-L. Flat tier: the review of G-G1, 80×12 (10 dynamic rows; the flat ladder at 7 = F-H with the strip on the rule)**

```
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] ──────────── [d] [p] [t] [s] ──
review  step 7  risk 0.44 (tail)  edit src/a.py "make parse_date timezone-aware"
[y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline
1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…
2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task asks
3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification step
4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restorable
5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of the…
› (review pending)
review           step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok  ? help
```

**G-M. Boxed tier at rows 16 (the threshold): the review card at 80×16 (14 dynamic rows: strip 1 + card 8 (ruler dropped, no preview) + console 5)**

```
─── ▸ jev s7 · 12 decisions · risk 0.44 [review] ──────────── [d] [p] [t] [s] ──
╭─ review · step 7 · risk 0.44 (tail) · edit src/a.py "make parse_date timez… ─╮
│ [y] approve [n] decline [d] decline+note [e] expand [w]1-5 why [esc] decline │
│ 1 destructive L1  ██▌·······  0.25 exp  0.93  changes files whose previous…  │
│ 2 out_of_scope L0 ··········  0.00 tail 0.98  directly does what the task a… │
│ 3 plan_mismatch L2 ████▍·····  0.44 tail 0.61  skips a planned verification… │
│ 4 irreversible L0 ··········  0.00 exp  0.96  no lasting effect, or restora… │
│ 5 matches_intent  ████████▊·  0.88 noul 0.76~ the action is an instance of…  │
╰──────────────────────────────────────────────────────────────────────────────╯
╭─ jev+llm ───────────────────────────────────────────────────────────── proj ─╮
│ › (review pending)                                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ review               step 7/40 4m12s  run $0.31/2.00 ok  sess $0.31/10.00 ok │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-N. A 6-row draft in the console at 80×40 (11 dynamic rows: brand 1 + console 10 (top, 6 draft rows, divider, status, bottom); the chip and the `↓1` marker as in F-T)**

```
─── ◆ jevcode 0.2.0 ────────────────────────────────────────────────────────────
╭─ jev-only ──────────────────────────────────────────────────────────── proj ─╮
│ › Next, make the CLI accept an ISO timestamp with an explicit offset and add │
│   a regression test for "2026-09-20T12:00:00+02:00". Keep the public         │
│   signature of parse_date unchanged; add a keyword-only argument             │
│   `assume_utc=True`. Update the docstring and CHANGELOG.                     │
│   [Pasted #1, 42 lines]                                                      │
│   (the previous run's notes are in the paste above)                       ↓1 │
├──────────────────────────────────────────────────────────────────────────────┤
│ idle                                    step 0/–  sess $0.00/1.25 ok  ? help │
╰──────────────────────────────────────────────────────────────────────────────╯
```

**G-O. `--ascii` twin of G-A3, 80×24 (6 dynamic rows; 1 scrollback row above)**

```
[run] jevcode session - proj | step 0/- starting
--- * jevcode 0.2.0 ------------------------------------------------------------
+- jev-only ------------------------------------------------------------ proj -+
| > Say hi, ask a question, or describe a task...                              |
+------------------------------------------------------------------------------+
| idle                                    step 0/-  sess $0.00/1.25 ok  ? help |
+------------------------------------------------------------------------------+
```

## 10. Component and file changes, with tests

Owner slots follow TD §20 (O9 for Ink components and `App.tsx`, O3 for layout/keys/commands, O4 for pane/review
builders, O5 for status, O10 for `plain.ts`). Every pure builder gets its `lines()` test; every component change its
ink-testing-library test; the gates their pty/perf rows.

### 10.1 `src/tui/layout.ts` (O3)

Change: `CAP` gains `panel`, `reviewCard`, `card`, `chrome`, `splash`; `BOXED_MIN_ROWS`, `WORDMARK_MIN_COLUMNS`,
`chromeRows()`; `LayoutInput.chrome`, `Layout.chrome`; step 3b; `composerTop` adds the top edge.
Tests (`test/unit/tui/layout/layout.test.ts`): the exhaustive sweep (`:133`) gains `chrome ∈ {0, 3}` as a dimension;
new invariants `chrome === 3 ⇒ rows ≥ 16`, `chrome + status + rule + composerFloor ≤ 6`, boxed overlay wholeness
`rows ≥ w + 8`; the §2.4 table rows as `it.each`; the ≤ 5 µs bound re-measured with the extra branch; `readFrames`
also reads this file (§10.11).

### 10.2 `src/tui/glyphs.ts` (O4)

Change: the seven glyph groups of §7.5 in `UNICODE`, `ASCII` and `SR`.
Tests (`test/unit/tui/glyphs.test.ts`): every new glyph is one cell; `glyphTwin` maps each round corner to `+`; the
pairwise-table test covers the new keys.

### 10.3 `src/tui/console.ts` (NEW, O9-pure) and `src/tui/card.ts` (NEW, O4)

Tests (`test/unit/tui/console.test.ts`, `test/unit/tui/card.test.ts`): every row is exactly `columns` cells for
columns 40..400 (fast-check style sweep like `buffer.property.test.ts`), badge and dir truncate before the fill goes
negative, `consoleLines(...).length === body.length + gate + 4`, `cardLines(title, body).length === body.length + 2`,
a title longer than `columns − 6` ends in `…`, `--ascii` rows are pure ASCII.

### 10.4 `src/tui/Console.tsx` (NEW, O9)

```tsx
export interface ConsoleProps {
  buffer: TextBuffer; columns: number; height: number /* layout.composer + layout.chrome + layout.status */; top: number; scrollTop: number;
  cursor: (pos: CursorPosition | undefined) => void; active: boolean; mode: ComposerMode; rows: number; live?: boolean;
  spans?: readonly Span[]; ghost?: { rest: string; more: number } | null; searchRow?: string | null;
  badge: string; dir: string; title?: string | null; gate?: string | null;
  status: StatusLineState; statusOptions: StatusLineOptions;
  wizard?: { state: OnboardingState; trust: TrustInputs | null } | null;   // renders the wizard rows as the body (the composer is refunded)
  glyphs?: GlyphSet; theme?: Theme; depth?: ColorDepth; onScroll?: (n: number) => void;
}
export function Console(p: ConsoleProps): React.JSX.Element;   // boxed tier only; App.tsx renders <Composer> + <StatusLine> in the flat tier as today
```

Tests (`test/unit/tui/console.test.tsx`): the frame's dynamic rows equal `consoleLines()` byte for byte (SGR
stripped); the cursor lands at `{ x: 2 + cursorX, y: top + 1 + cursorRow }` (read back through the stub stdout's last
cursor sequence as `composer.test.tsx` does); the gate row shifts the cursor by one; the wizard body places the cursor
on the masked row; `height.test.tsx` gains boxed rows (16, 24, 40) asserting `dyn.length === computeLayout(...).total`.

### 10.5 `src/tui/composer/Composer.tsx` (O9)

Change: `PROMPT` → `PROMPT_UNICODE = '› '` / `PROMPT_ASCII = '> '` with `promptFor(g)`; `placeholderFor(mode, rows, innerColumns)`;
`PLACEHOLDERS` per §3.4. `plain-composer.ts` keeps `> `.
Tests (`test/unit/tui/composer.test.tsx`, `composer/rows.test.ts`): gutter width unchanged (2 cells); placeholder
strings verbatim; the ≥ 100 suffix appears only at width ≥ 100; the `--ascii` prompt is `> `. The pty steps
`s1-clear.steps` (`expect > half a thought`) and `resize.steps` (`expect > a draft that survives`) change to
`expect half a thought` / `expect a draft that survives` (the glyph is not what they test).

### 10.6 `src/tui/status/lines.ts` (O5) and `src/tui/StatusLine.tsx` (O9)

Change: `modeBadgeWord`, `modeBadge`; the flat tier's `leftZoneText` prefix `${badge} · ` and its `badge` drop before
`help`; `StatusLineState.modeBadge?`. `StatusLine.tsx` is unchanged in the flat tier and unused in the boxed tier
(the console draws the compartment through `statusLineText`).
Tests (`test/unit/tui/status/lines.test.ts`): badge words for the three modes; `· next run` when pending; the drop
order with `badge` at 40..80 columns; the sentinel survives at every width; snapshot rows of G-A3/G-E1/G-F1's status
compartments at `W = 76` and `116`.

### 10.7 `src/tui/Transcript.tsx` (O9) and `src/tui/plain.ts` (O10)

Change: `TranscriptItem.hidden?: boolean` (renderer-local flag, never written to the log); `isChatItem(item)`,
`spacerBefore(item)`, `TranscriptRow` as a flex row (label box + body box) with `marginTop`; fence-row decoration;
`'step'` kind and `stepSummaryText` (§4.3); `BARE_NOTICE_KINDS` unchanged.
Tests (`test/unit/tui/transcript.test.tsx`): the visible text of every row equals `formatTranscriptItem(item)` after
stripping SGR and skipping blank rows; a `[jevcode]` item with 3 detail lines renders 1 + 3 rows with the hanging
indent at `'[jevcode] '.length`; fence rows become `╶────` rules and the code rows are indented two cells; a run's
items in `compact` show one `[step N]` row per step and no `intent`/`risk`/… rows; `full` shows all;
`test/unit/tui/plain.test.ts`: `stepSummaryText` for a full record, an interrupted record, jev-only cost formatting,
the 40/32-cell cuts; the plain renderer prints the `step` line and every stage line (the `full` twin).

### 10.8 `src/tui/pane/model.ts`, `src/tui/Pane.tsx` (O4/O9)

Change: `panelStrip`, `panelLines(size)`, `▾ ` in `paneRuleRow` when open/full; `Pane` gains `size`.
Tests (`test/unit/tui/pane/model.test.ts`, `pane.test.tsx`): strip ≤ columns at 40..400, drop order of its segments,
`[d] [p] [t] [s]` below 100 columns and the words at ≥ 100; `open` shows the newest 5 rows + the `more` row when 12
rows exist, all 6 rows otherwise; `full` equals today's `paneLines`; `pane/frames.test.ts` adds G-F1/G-F2/G-G2's pane
rows to its parity set (bars compared as a class, as it already does).

### 10.9 `src/tui/Review.tsx`, `src/tui/review/lines.ts`, `src/tui/Overlay.tsx` (O4/O9)

Change: `reviewCardTitle`, `reviewCardLines` with the boxed ladder; `Review` draws the card in the boxed tier and TD's
rows in the flat tier; `Overlay` wraps followup/exit/undo/blocking/palette in `cardLines`; `secret` draws nothing in
the boxed tier (the console hosts it); `overlayWant` per §2.2.
Tests (`test/unit/tui/review/lines.test.ts`): ladder for n = 9..2 at 80 and 120 columns (row counts, the title edge
first, the bottom edge last, `…` on the cut title); `review.test.tsx`/`overlay.test.tsx`: G-G1/G-G2/G-M rows byte for
byte from `workedRequest`; the `d` note field still replaces row 2 inside the card and masks its spans; the palette
card is ≤ 8 rows with the footer as its last inner row; `app.test.tsx:342–461` (review invariants) rerun in the boxed
tier: only `y` approves, Enter inert, paste never matches, Ctrl-C with an empty draft aborts.

### 10.10 `src/tui/theme.ts`, `src/tui/color-shim.ts` (O9)

Change per §7.1–7.2.
Tests (`test/unit/tui/theme.test.ts`): `colorDepth` truth table (NO_COLOR, FORCE_COLOR 0..3, COLORTERM truecolor/24bit,
TERM_PROGRAM × version, TERM 256color, tmux-256color, dumb, xterm); `textProps` returns `'#…'` at 24, `'ansi256(n)'` at
256, the name at 16, `{}` at 0; `validateTheme` rejects a bad hex, a 256 index out of range, an `ansi` theme with
truecolor members, a coloured role without a marker; every theme validates.

### 10.11 `src/tui/splash.ts`, `src/tui/motion.ts` (NEW, O9), `src/tui/useEngine.tsx`, `src/tui/App.tsx`

Change: `UiState` gains `splash: 'running' | 'done'`, `mountedAt`, `panel`, `transcript`, `modeBadge`; `UiAction`
gains `splash:done`, `panel`, `transcript`, `mode`; the transition table adds the cancel rows of §8.3; `App.tsx`
computes `chrome`, `paneWant`, renders `<Console>` or the flat pair, routes the Alt chords and `/panel`, `/transcript`;
`createTuiRenderer` reads `launch.reducedMotion`/`launch.modeHint`.
Tests: `test/unit/tui/splash.test.ts` — `splashFrame(t)` rows are exactly 5 (or 0 at < 64 columns / t ≥ 700), each
≤ columns cells, the revealed edge is monotone in `t`, the changed-cell count between consecutive 50 ms frames ≤ 12,
`--ascii` frames are ASCII; `reducer.test.ts` — every cancel row (`key`, `run:start`, `confirm:request`, `overlay`,
`blocking:request`, `tick` past 700 ms) flips `splash` to `done` exactly once; `app.test.tsx` — the first frame contains
`step 0/` and the first wordmark column, a key at t = 100 ms removes the wordmark and shows the typed character in the
same frame, `reducedMotion`/`screenReader` mount with the brand row and no wordmark, no `setInterval` outside
`spinner.ts`/`retry.ts` and no `useAnimation` outside `motion.ts` (the grep test, extended); `layout.test.ts`'s
`readFrames` reads `docs/research/tui/round-2/design-visual.md` as a second document and asserts every `G-*` frame's
widths and row counts.

### 10.12 `src/tui/keys/bindings.ts`, `src/tui/commands/registry.ts` (O3)

Change: the five `global:panel*` actions (§5.3); `/panel`, `/transcript`. `scripts/gen-docs.mjs` regenerates
`docs/KEYS.md`/`docs/COMMANDS.md`/man/completions; `registry.test.ts` and `bindings.test.ts` keep them in sync.
Tests (`test/unit/tui/keys/resolve.test.ts`): `meta+d` on a non-empty draft opens the panel and inserts nothing;
`d` alone inserts text (TD §3.1, `app.test.tsx:283` stays); Esc on an empty draft with the panel open collapses it and
does not arm Esc Esc; `commands/parse.test.ts`: `/panel full`, `/panel off`, `/transcript compact`.

### 10.13 pty and perf (O10)

- `test/pty/smoke/splash.steps` (24×80, `chat --mock`): `expect step 0/` → `sleep 0.1` → `send h` → `expect › h` →
  the capture must not contain a wordmark row after the key (`grep -c '████' ≤ frames before the key`), 0 clears,
  `restores=1`; `splash-reduced.steps` with `JEVCODE_REDUCED_MOTION=1`: no `███` anywhere.
- `test/pty/smoke/chrome-tiers.steps` (24×80 → resize 12×60 → 24×80): the boxed rows vanish and return; clears ≤ 1 in
  the shrink segment (TD §18), 0 elsewhere.
- `src/perf/first-frame.ts`: unchanged sentinel; add the `depth` env matrix (`COLORTERM=truecolor`, unset) to the
  `chat` series so truecolor SGR cost is in the number.
- `src/perf/render-lag.ts` / `composer-latency.ts`: unchanged gates; the report gains a `splash` row (frames and
  bytes in the first 700 ms) and the `dynamic` class is asserted ≤ 31 in that bucket too.
- `src/perf/states.ts`: scenarios `review-card`, `palette-card`, `wizard-console`, `secret-console` at 24×80 and the
  flat `review` at 12×60 (0 clears each).

## 11. Gate ledger (D-E)

| Gate | How the redesign keeps it | Evidence to produce |
| --- | --- | --- |
| first frame < 300 ms, zero network | frame 0 = splash frame 0 + console; no new I/O before `firstFrame()`; `launch.modeHint`/`reducedMotion` are argv + env | `perf/first-frame.ts` `chat` 40×120 · 24×80 · 8×40, `JEVCODE_ASSERT_NO_NETWORK=1`; `splash.steps` |
| zero clears after the first frame outside shrink segments | no alt screen, no `ESC[2J`; the region never exceeds the budget (`computeLayout` still bounds every row incl. chrome); the splash shrink is a height decrease inside the budget | `render-lag.ts` `CLEAR_RE`, `states.ts` new scenarios, `chrome-tiers.steps` |
| lag p95 net < 5 ms | fewer `<Static>` commits per step (1 instead of ~7) — the storm gets *smaller*; the splash adds 15 renders in the warm-up | `render-lag.ts` rows 40/12/reduced at `JEVCODE_MOCK_STEP_MS=200` |
| composer keystroke → frame p95 < 16 ms | the console adds 4 fixed rows to the region (≤ 6 → 10 idle); 08 §11 measured 0.30 → 0.97 ms render time from 6 to 22 rows, so the budget holds; a key during the splash cancels it in the same commit | `composer-latency.ts` idle/live/palette |
| dynamic fps ≤ maxFps + 1 | the splash ticks through Ink's `useAnimation` (coalesced by the render throttle); spinner rules unchanged | `render-lag.ts` frame classes incl. the first second |
| `transcript.log` / `--plain` / TUI line identity | every TUI row is `formatTranscriptItem(item)` verbatim; the default view is a declared kind filter with `--plain` as the `full` twin; the `step` line is an engine item in all three | `app.test.tsx:299` in `full`; new compact-subsequence test; `plain.test.ts` |
| no new runtime dependency | `ink` + `react` only; cli-boxes' glyphs are copied into `glyphs.ts` as literals, not imported | `package.json` `dependencies` empty (`pack:check`) |
| keys never in logs | nothing new logs; the wizard rows inside the console are still `maskedFieldRow(length)` | `test/unit/tui/onboarding/*`, `wizard.test.tsx` |
| review invariants (no auto-approve) | the card changes drawing only; `resolveKey`, deferral, arming, `createTuiConfirmer` untouched | `app.test.tsx:342–461`, `review-y.steps`, `review-d.steps` |
| rows − 2 budget at every geometry | `computeLayout` invariants extended for `chrome`; `height.test.tsx` at 12/16/24/40 | `layout.test.ts`, `height.test.tsx` |

## 12. Hooks this design needs from D-A / D-B / D-C (contract additions, all optional or new members)

1. `UiLabel` gains `'[you]' | '[jevcode]'` (`types.ts:1100`); `[jevcode]` items may carry `detail` and, for chat labels
   only, the plain renderer and `recordTranscript` write the detail lines (two-space indented) so a reply is on the
   record — D-C owns the writer change (`plain.ts:876–878` local items, the engine's `notice ui` path for live runs).
2. `EngineEvent` `step:end` gains `costUsd?: { generator: number; jev: number }` (`types.ts:1130`) so
   `stepSummaryText` prints money; absent → tokens.
3. `UiAction { type: 'mode'; mode: EngineMode; pending: EngineMode | null }` dispatched by the controller after
   `resolveConfig` and on `/mode` (D-A); `LaunchSettings.modeHint?: EngineMode` and `LaunchSettings.reducedMotion`
   (argv + env only; `resolveLaunchSettingsWithSources`, `launch.ts:96`).
4. The `[ui] mode: …` item texts of G-H/G-I (`mode: jev+llm for the next run (this session stays jev-only until then)`,
   `mode: jev+llm needs a generator key — enter it below (Esc keeps jev-only)`, `mode: kept jev-only`) and the closing
   `[jevcode]` run epilogue of §4.5 are D-A/D-C strings; this document fixes their placement and dressing only.
5. `TranscriptKind` gains `'step'` and `itemsFromEvent` handles `step:end` (§4.3) — `plain.ts` (O10), shared by all
   three sinks.

## 13. Glossary additions (exact strings; every twin prints these)

**Console.** top edge `╭─ <badge> ─…─ <dir> ─╮` · badges `jev-only` · `jev+llm` · `llm-only` · pending ` · next run` ·
titles `setup · provider` · `setup · generator key` · `setup · jev key` · `setup · verify` · `setup · trust` ·
`sessions · filter` · `rewind · filter` · prompt `› ` (`> ` ascii) · placeholders `Say hi, ask a question, or describe
a task…` · `Follow-up, question, or /command…` · `Type to steer the next step…  Esc pauses` · suffixes `   / commands ·
@ files` · `   ↑ history · Esc Esc menu` · `   Esc Esc aborts` · `(review pending — keys in the card; d opens a note)`.

**Rule row.** brand `─── ◆ jevcode <version> ───…` · strip `─── ▸ jev s<N> · <n> decisions · risk <r> <ok|[review]|[block]> · plan <a>/<b>[ · jev <ms>ms] ─── [d] [p] [t] [s] ──` (≥ 100: `[d]ecisions [p]lan [t]imeline [s]ynth`) · `─── ▸ jev · no decisions yet ───` · open header `─── ▾ decisions s7 · c~ derived |2p−1| ──── [d]ecisions [p]lan [t]ime [s]ynth ──` · more row `  … <n> more rows · /panel full expands`.

**Cards.** review title `review · step <N> · risk <r> (<bound>) · <kind> <target> "<goal>"` (120: `(tail on <dim>)`,
` · jev <ms>ms`) · `exit?` · `undo` · `commands` · `files` · follow-up `follow-up would exceed the session cap` (unchanged
text, round box).

**Transcript.** `[you] <text>` · `[jevcode] <text>` · `[step N] <intent> <kind> <target>[ "<goal>"] · risk <r> <verdict> · <outcome> · tests <p>p/<f>f/<e>e · judge <p>[ · complete <c>] · <wall> · $<cost>|jev <k>` · `[step N] interrupted at <stage> (<reason>)` · fence rule `╶──── <lang>` / `╶────`.

**Keys and commands.** `Alt-J` toggle panel · `Alt-Shift-J` full · `Alt-D` `Alt-P` `Alt-T` `Alt-S` tabs · `/panel [d|p|t|s|off|full]` · `/transcript [compact|full]`.

**Splash.** wordmark rows (§8.1) · brand `◆ jevcode <version>` · sweep head `▓▒░` (`#+.` ascii).
