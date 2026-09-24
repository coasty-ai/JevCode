# Round 3 · R1 — The TypeSafe pink theme

Research report for the round-3 request "get the pink colour theme from typesafe.ai and use it everywhere". Written against
HEAD `626fc40` (0.3.0, 2026-09-21). Every code reference is `file:line` at that commit. Every number in this document was
computed (script: WCAG 2.x relative luminance, CIE L\*a\*b\* + ΔE2000, Machado et al. 2009 CVD matrices at severity 1.0, the
xterm 6×6×6 cube) or measured (curl of typesafe.ai, SGR counts over the shipped pty captures). Nothing is estimated.

---

## 0. Summary

- **Palette confirmed on the live site** (605,701 bytes fetched 2026-09-21): background `#1e1e1e` (148 hex hits + 366 `rgb(30,30,30)`),
  text `#fefefe` / `#dedede` / `#e5e5e5`, primary pink `#f386a1` (47 `rgb(243,134,161)`), secondary `#d45bb6`, greys `#abbab9` /
  `#c4c4c4` / `#858585`, teal `#09aea1`, green `#03aa5c`. Fonts Inter, Die Grotesk C, JetBrains Mono. **New finding:** on the site
  `#d45bb6` is the *hover* link colour, the text-*selection* background and the 1.2 px border of the "primary" button, while
  `#f386a1` is a solid *block* background. That is a ready-made rule for the TUI: primary pink = rest/brand, secondary pink =
  active/focus/selected.
- **The theme engine needs no structural change.** `theme.ts` already carries a `ColorTriple` per role at three depths and every
  consumer goes through `textProps` (30 call sites in 10 files, all listed in §2). The work is a table swap plus one new role,
  three tiny consumer changes (the `[jevcode]` label, the composer prompt at rest, the splash fade) and the strings in §8.
- **Four defects found while reading** (§2.5): (1) the light theme inherits the dark `error` (`#F87171`, **2.74:1** on `#fefefe`) and
  `ok` (`#4ADE80`, **1.73:1**) — unreadable; (2) live rows, the banner and queue rows pass the boolean `color` instead of `depth`
  (`App.tsx:2030,2039,2058`), so `warn` paints `ESC[33m` there and `38;5;214` everywhere else (66 vs 171 SGRs in the shipped
  24×80 capture); (3) the `badge` marker is the literal `'jev-only'` (`theme.ts:108,127`), which hard-codes the default mode
  the owner has just decided to flip; (4) the `assistant` role exists but no consumer asks for it, so `[jevcode]` labels are dim.
- **The spec** (§3–§7): `dark` keeps its CLI id and becomes the TypeSafe palette ("TypeSafe pink"); accent `#f386a1` / 211 /
  `magentaBright` (6.93:1 on `#1e1e1e`), secondary `#d45bb6` / 169 / `magenta` (4.74:1; marker-grade on Solarized at 4.27:1);
  light accent `#be185d` / 125 (5.99:1 on `#fefefe`), light secondary `#831843` / 89 (chosen to avoid a 256-index collision
  that `#9d174d` would cause); error/warn/ok/block unchanged in hue; daltonized keeps the red→blue swap and the numbers show why
  it is enough (pink vs blue ΔE 34 for deuteranopes vs pink vs red ΔE 12).

---

## 1. Measured: typesafe.ai on 2026-09-21

`curl -sL https://typesafe.ai/` → 605,701 bytes (a Framer export; tokens inline as `--token-<uuid>` CSS custom properties).

### 1.1 Colour tokens and hit counts

| Token value | hex hits | `rgb()` hits | Site role (from the surrounding CSS) |
| --- | ---: | ---: | --- |
| `#1e1e1e` | 148 | 366 (+24 rgba α1, +11 rgba α0.86) | page background; `--selection-color: #1e1e1edb` (text colour inside a selection) |
| `#fefefe` | 28 | 35 + 16 | body text, `--framer-link-text-color`, link text background |
| `#dedede` | 1 | 60 | secondary body text |
| `#e5e5e5` | 6 | — | tertiary text |
| `#c4c4c4` | — | 15 | grey UI text |
| `#abbab9` | 2 | 1 | grey-teal panel background |
| `#858585` | (token only) | — | muted grey |
| **`#f386a1`** | 5 | **47** | **primary pink**: `background-color` of hero blocks / cards (solid pink panels) |
| **`#d45bb6`** | 4 | 2 | **secondary pink**: `--framer-link-hover-text-color`, `--framer-link-hover-text-background-color`, `--selection-background-color`, `--border-color` of the `data-framer-name="primary"` button (1.2 px) |
| `#09aea1` | 1 | — | teal accent |
| `#03aa5c` | 1 | — | green accent (`#03aa5cbd` at α0.74 as a variant) |
| `#000` / `#fff` | 41 / 5 | 5+3 / 37 | Framer defaults |

No third pink, no gradient, no pink text on the dark background — the site puts pink *behind* white text. The TUI cannot draw
backgrounds (TUI-DESIGN F2, "no backgrounds"), so pink becomes a foreground: that is why every pink below is contrast-checked as
text on `#1e1e1e`, black and Solarized `#002b36`.

### 1.2 Fonts and copy

`font-family: "Inter"` (42), `"Die Grotesk C Medium"` (14) / `Regular` (4), `'JetBrains Mono'` (6+3+3), `'Fragment Mono'` (3).
Copy present: "Decisions, not strings" (2), "More like code" (4), "Zero Hallucinations" (2), "Machine-native" (5), "System One" (13);
"Decisions API" is **not** in the HTML (0 hits — it may be on a sub-page; do not quote it as site copy).

---

## 2. Measured: the code at HEAD

### 2.1 `src/tui/theme.ts` (239 lines)

| What | Where | Fact |
| --- | --- | --- |
| Theme ids | `theme.ts:15-16` | `ThemeName = 'dark' \| 'light' \| 'daltonized' \| 'ansi'`; the same four literals are duplicated in `src/config/ui.ts:13` (`UI_THEMES`) and `src/tui/commands/registry.ts:65` (`THEMES`); default `DEFAULT_THEME = 'dark'` at `src/config/defaults.ts:27`; `themeFor` (`theme.ts:166-168`) falls back to `DARK` for any unknown name |
| Roles | `theme.ts:61-63` | 19 roles: `error warn ok block review steer dim accent secret chosen rule placeholder you assistant badge border borderFocus code sweep` |
| Triple | `theme.ts:66-70` | `{ ansi16: AnsiColor; ansi256?: number; truecolor?: '#rrggbb' }`; `colorAt` (`:181-185`) returns `#hex` at 24, `ansi256(n)` at 256 (or at 24 when no hex), the name otherwise |
| Marker rule | `theme.ts:85-86, 233-235` | every coloured role needs a text marker except `NO_MARKER_ROLES = {accent, dim, rule, placeholder, sweep, assistant}`; `you`, `badge`, `code` must have one |
| Dark table | `theme.ts:90-114` | accent `#7DD3FC/117/cyan`; badge = accent bold, marker `'jev-only'`; borderFocus `#38BDF8/74/cyan`; you `#A5B4FC/147/blueBright`; assistant *no colour*; code `#E2E8F0/254/whiteBright`; sweep `#E0F2FE/195/whiteBright`; error/block `#F87171/203/red`; warn/review/steer/secret `#FBBF24/214/yellow`; ok/chosen `#4ADE80/114/green` |
| Light table | `theme.ts:117-133` | `...DARK.roles` then overrides for warn/review/steer/secret/accent/ok/badge/borderFocus/you/code/sweep — **error, block and chosen are not overridden** (see §2.5) |
| Daltonized | `theme.ts:136-146` | error/block → `#60A5FA/75/blue`; ok/chosen → `#7DD3FC/117/cyan`; review stays amber |
| ANSI twin | `theme.ts:149-161` | derived mechanically from DARK: strips 256/truecolor, `dimColor:false`, dim roles → `gray` — **any new dark colour propagates automatically** |
| Validation | `theme.ts:219-239` | ANSI names only, `#rrggbb`, 0..255, `ansi` has no deep members and never dims, marker rules |

### 2.2 Depth detection and the render path

- `colorDepth` (`color-shim.ts:85-100`): 0 / 16 / 256 / 24 from `FORCE_COLOR`, `COLORTERM`, `TERM_PROGRAM`, `TERM`; never a query.
- The App computes `depth` once (`App.tsx:537`) and passes `color={depth}` to Transcript (`:2019`), RuleRow (`:2023`), SplashRow
  (`:2047`), Pane (`:2052`), Overlay (`:2066`), Console (`:2107`), Composer (`:2125`), StatusLine (`:2130`).
- Ink 7.1.1 `colorize.js` accepts a chalk name, `#rrggbb` (`chalk.hex`), `ansi256(n)` and `rgb()`; `Text.js:17-21` applies
  `chalk.dim` **before** the colour, so a dim role with a colour would emit `ESC[2m ESC[38;5;n m` — the tables keep dim roles
  colourless, which is right. chalk 5.6.2 derives its own level (`supports-color/index.js:34-170`); under vitest it is level 0, so
  unit tests observe roles through a `textProps` spy (`test/unit/tui/round2-app.test.tsx:28-40`), not bytes. The pty suite runs
  `TERM=xterm-256color`, so it sees `38;5;n`.

### 2.3 Every consumer of `textProps` / `themeFor` (grep at HEAD)

| File:line | Role(s) asked | Paints |
| --- | --- | --- |
| `App.tsx:2030` | `warn` (boolean `color`) | live rows while retrying |
| `App.tsx:2039` | `warn` (boolean `color`) | banner |
| `App.tsx:2058` | `dim` (boolean `color`) | queue rows |
| `App.tsx:2146-2155` | `rule`, `accent` | the rule row; `◆ jevcode 0.3.0` span in accent (`brandSpan`) |
| `App.tsx:2160-2185` | span roles from `splashFrame` | wordmark rows |
| `StatusLine.tsx:66-77` | `ok` / `warn` / `secret` | flat-tier status row (`statusRole`) |
| `Console.tsx:109` | `borderFocus` (live) / `border` (rest) | console box edges, divider, the `│` wraps |
| `Console.tsx:132` | `warn`, `dim` | hosted wizard body |
| `Console.tsx:142` | `steer` (live && active) else `{}` | composer prompt `› ` |
| `Console.tsx:165-166` | `dim`, `placeholder` | ghost, placeholder |
| `Console.tsx:182` | `accent` (hosted title) / `badge` | top-edge word |
| `Console.tsx:184` | `dim` | the dir |
| `Console.tsx:188` | `secret` | gate row |
| `Console.tsx:196` | `ok` / `warn` / `secret` | status compartment |
| `Composer.tsx:620,634,635` | `steer`, `dim`, `placeholder` | flat-tier composer |
| `Transcript.tsx:25` | `itemRole(item)` | (`itemColor`, kept for tests) |
| `Transcript.tsx:113` | `code` (fence) / `itemRole` | item body; `[you]` → `you`, `[jevcode]` → default (`theme.ts:203-210`) |
| `Transcript.tsx:115,128` | `dim` | **every** label, every detail line |
| `Pane.tsx:82-90,123` | `block review chosen warn dim` by marker; `accent` on the picker's selected row | Jev panel / picker |
| `Overlay.tsx:157,169-170,196-212,221` | card `edgeRole`/`bodyRole` (`warn`, `error`, `secret`), `border`, `dim` | cards, palette |
| `Review.tsx:131-136,153,183` | `block`/`review`, `secret`, `dim` | review header / card |
| `Wizard.tsx:312` | `warn`, `dim` | flat-tier wizard |
| `splash.ts:113-135` | `accent` (JEV), `dim` (CODE), `sweep` (head, band); fade 600 → no role, 650 → `dim` | wordmark spans |

`themeFor('dark')` is the default prop in StatusLine `:71`, Transcript `:23,136`, Pane `:116`, Overlay `:255`, Console `:102`,
Review `:116`, Composer `:611`, Wizard `:303`; the App resolves `themeFor(ui?.theme)` at `App.tsx:533`.

### 2.4 The bytes the shipped bundle writes (SGR counts, `docs/live/tui/round-2/*.cap`)

| SGR | 24×80 | 40×120 | Role |
| --- | ---: | ---: | --- |
| `ESC[38;5;74m` | 1,314 | 1,053 | `borderFocus` — the live console edge is **the most painted colour** in a session |
| `ESC[2m` / `ESC[22m` | 1,061 / 1,263 | 937 / 1,111 | `dim` labels, borders at rest, rule |
| `ESC[38;5;117m` | 286 | 254 | `accent` / `badge` |
| `ESC[1m` | 202 | 174 | badge bold, keys row |
| `ESC[38;5;214m` | 171 | 137 | `warn` family at depth 256 |
| `ESC[33m` | 66 | 53 | `warn` at **depth 16** — the `App.tsx:2030/2039` boolean path |
| `ESC[38;5;195m` | 60 | 60 | `sweep` (splash) |
| `ESC[38;5;147m` | 3 | 3 | `you` |

So the pink swap is dominated by two indices: the live edge (→ secondary) and the accent (→ primary).

### 2.5 Defects found (fixed by the proposals in §10)

1. **Light theme unreadable for error/ok.** `LIGHT` spreads `DARK.roles` (`theme.ts:120`) and never overrides `error`, `block`,
   `chosen`: `#F87171` on `#fefefe` = **2.74:1**, `#4ADE80` = **1.73:1** (WCAG AA body needs 4.5, markers 3.0). Fixed in §4.
2. **Depth split.** `App.tsx:2030,2039,2058` pass `color` (boolean → depth 16) while every sibling passes `depth`. Measured as the
   `ESC[33m` rows above. One-token fix each.
3. **Badge marker hard-codes the default mode.** `theme.ts:108,127` `marker: 'jev-only'`; pinned by `test/unit/tui/theme.test.ts:89`.
   The owner's decision requires no string that names the default; the badge *word* is already computed by `modeBadgeWord`
   (`src/tui/status/lines.ts:107-109`), the marker only has to be non-empty (`theme.ts:235`).
4. **`assistant` role is dead.** Defined (`theme.ts:107`) and validated, but `Transcript.tsx:115` colours every label `dim`. The
   pink brand voice needs this consumer.
5. **A 256 twin is not the nearest.** `ok` uses 114 (`#87d787`) for `#4ADE80`; the nearest cube cell is 78 (`#5fd787`, ΔE2000 2.72
   vs 114's larger error). Harmless, but the twins-identity test in §9 would catch it, so the table below fixes it.

---

## 3. (a) The default theme — "TypeSafe pink" (`ThemeName` stays `dark`)

**Naming decision.** The palette is called *TypeSafe pink*. Its CLI/config identifier stays `dark`: that keeps `--theme
dark|light|daltonized|ansi`, `JEVCODE_THEME`, `ui.theme`, `DEFAULT_THEME`, `/theme`'s enum (`registry.ts:394-399`), the man page,
completions, README row 285 and 37 pty scenarios untouched, and there is no cyan theme left to keep alive (the user wants pink
everywhere). A 5th name would add churn in six enum sites for no user benefit. The header comment of `theme.ts` and §4.9 of the
design doc name the palette.

**One new role: `accent2`** ("the secondary pink: active, selected, cooling") — added to `ColorRole`/`COLOR_ROLES` (`theme.ts:61,63`)
and to `NO_MARKER_ROLES` (`theme.ts:86`; decoration only). Everything else is the existing 19 roles.

### 3.1 The `dark` table (every role; **bold** = changed from HEAD)

| Role | truecolor | 256 | ansi16 | dim / bold | Marker | Paints (see §2.3) |
| --- | --- | ---: | --- | --- | --- | --- |
| `error` | `#F87171` | 203 | `red` | — | `error` | transcript error items, blocking card edges |
| `warn` | `#FBBF24` | 214 | `yellow` | — | `warning` | retrying live rows, banner, wizard hint, cards, status ≠ complete |
| `ok` | `#4ADE80` | **78** | `green` | — | `✓` | status once a run completed |
| `block` | `#F87171` | 203 | `red` | bold | `[block]` | pane rows, review card edges |
| `review` | `#FBBF24` | 214 | `yellow` | — | `[review]` | pane rows, review card edges |
| `steer` | `#FBBF24` | 214 | `yellow` | — | `>` | composer prompt **while a run is live** |
| `dim` | — | — | — | dim | `` | all labels except `[jevcode]`, details, queue rows, ghost, dir |
| `accent` | **`#f386a1`** | **211** | **`magentaBright`** | — | `` | brand row span, wordmark `JEV`, picker selected row, hosted console title, **composer prompt at rest** |
| `secret` | `#FBBF24` | 214 | `yellow` | — | `⚠ secret?` | gate row, review gate, status |
| `chosen` | **`#f386a1`** | **211** | **`magentaBright`** | — | `[chosen]` | pane decision rows ("Jev's pick" is a brand moment) |
| `rule` | — | — | — | dim | `─` | rule row fill |
| `placeholder` | — | — | — | dim | `…` | composer placeholder |
| `you` | **`#d45bb6`** | **169** | **`magenta`** | — | `[you]` | the human's message body |
| `assistant` | **`#f386a1`** | **211** | **`magentaBright`** | — | `[jevcode]` | **the `[jevcode]` label** (body stays default fg) |
| `badge` | **`#f386a1`** | **211** | **`magentaBright`** | bold | **`<mode>`** | console top-edge mode word |
| `border` | — | — | — | dim | `╭` | console edges at rest, cards |
| `borderFocus` | **`#d45bb6`** | **169** | **`magenta`** | — | `live` | console edges while a run is live |
| `accent2` (new) | **`#d45bb6`** | **169** | **`magenta`** | — | `` | splash fade step 1; optional palette `▌` selected marker |
| `code` | **`#e5e5e5`** | 254 | `whiteBright` | — | `╶` | fence rows and fenced body |
| `sweep` | **`#fbd0dc`** | **224** | `whiteBright` | — | `` | splash head `▓▒░` and the shimmer band |

Rationale per decision the brief left open:

- **Brand accent = `#f386a1`** on: `accent`, `badge`, `chosen`, `assistant`, the composer prompt at rest, the wordmark letters.
  6.93:1 on `#1e1e1e` — body-text grade, so the bold badge and the `[jevcode]` label are comfortably readable.
- **`you` = secondary `#d45bb6`**, not the primary: the site uses `#d45bb6` as the *selection* colour, which is what the user's own
  words are (their input, echoed). It keeps the two voices distinct in pink (ΔE 16.8 normal, 24.7 deuteranope, 19.3 protanope) and
  is AA body text on `#1e1e1e` (4.74:1); on Solarized dark it is 4.27:1 — marker grade (flagged in §6). The alternatives were
  rejected by the numbers: teal `#09aea1` collapses into the pink for protanopes (ΔE **6.0**); indigo `#A5B4FC` is off-palette;
  plain `#fefefe` loses the "two voices" read.
- **`borderFocus` = secondary.** The console edge while a run is live is the site's "primary button border" moment: the box is
  *active*. At rest it stays dim. This is 1,314 SGRs per session (§2.4), so the live console visibly turns magenta-pink — intended.
- **`chosen` = primary.** `[chosen]` is Jev's decision; pink is Jev's colour. `ok` stays green so "tests passed / run complete"
  never reads as brand. Pink `[chosen]` sits beside red `[block]` in the pane: ΔE 12.0 for deuteranopes with markers on both, and
  the `daltonized` theme moves block to blue (ΔE 34).
- **`sweep` = `#fbd0dc`**, a pale tint of the primary (L\* 87.4 vs 68.5) rather than the old icy `#E0F2FE`: the head reads as light
  catching pink letters, not a different colour. 224 (`#ffd7d7`) is its cube cell (ΔE 4.77).
- **`code` = `#e5e5e5`**: the site's tertiary text token, and 254 (`#e4e4e4`) is an exact 256 twin (ΔE 0.22) — better than the old
  `#E2E8F0`.
- **Error/warn/ok unchanged in hue**, as required. `#ef4444` was tested as a "more distinct red" and rejected: 4.43:1 on `#1e1e1e`
  (fails body). `#F87171` stays.

---

## 4. (b) The `light` variant (on `#fefefe`; also checked on white and Solarized light `#fdf6e3`)

| Role | truecolor | 256 | ansi16 | dim / bold | Marker | Contrast on `#fefefe` |
| --- | --- | ---: | --- | --- | --- | ---: |
| `error` | **`#b91c1c`** | **124** | `red` | — | `error` | 6.42 |
| `block` | **`#b91c1c`** | **124** | `red` | bold | `[block]` | 6.42 |
| `warn` / `review` / `steer` / `secret` | `#0369A1` | 25 | `blue` | — | as dark | 5.88 |
| `ok` | **`#15803d`** | **29** | `green` | — | `✓` | 4.97 |
| `accent` | **`#be185d`** | **125** | **`magenta`** | — | `` | 5.99 |
| `chosen` | **`#be185d`** | **125** | **`magenta`** | — | `[chosen]` | 5.99 |
| `you` | **`#831843`** | **89** | **`magenta`** | — | `[you]` | 9.57 |
| `assistant` | **`#be185d`** | **125** | **`magenta`** | — | `[jevcode]` | 5.99 |
| `badge` | **`#be185d`** | **125** | **`magenta`** | bold | `<mode>` | 5.99 |
| `borderFocus` | **`#831843`** | **89** | **`magenta`** | — | `live` | 9.57 |
| `accent2` | **`#831843`** | **89** | **`magenta`** | — | `` | 9.57 |
| `code` | **`#1e1e1e`** | **234** | `black` | — | `╶` | 16.53 |
| `sweep` | **`#831843`** | **89** | **`magenta`** | — | `` | 9.57 |
| `dim` `rule` `placeholder` `border` | — | — | — | dim | as dark | terminal-defined |

Notes: the light pinks use plain `magenta` (bright magenta on white is unreadable in most 16-colour palettes). `#9d174d` was
the first candidate for the light secondary but it shares cube cell **125** with `#be185d` — at depth 256 accent and secondary
would have been identical; `#831843` → 89 (`#87005f`) avoids the collision and is darker where a light theme wants the "active"
tone to be. `#166534` was rejected for `ok` (its cube cell 23 is `#005f5f`, ΔE 17.9 — teal, not green); `#15803d` → 29 (ΔE 7.6).
The old light `code` `#1E293B` maps to cell 17 (`#00005f`, ΔE 15.7 — navy); `#1e1e1e` → 234 (`#1c1c1c`) is exact and on-brand.

---

## 5. (c) Daltonized rules, with the simulation numbers

Method: Machado, Oliveira & Fernandes (2009) matrices, severity 1.0, applied in linear sRGB; distance = CIEDE2000 between the
*simulated* colours (normal-vision ΔE in brackets). ΔE < 10 = confusable at a glance; 10–20 = distinguishable side by side;
> 20 = clearly different.

### 5.1 Dark palette pairs

| Pair | Protanopia | Deuteranopia | Tritanopia | Normal |
| --- | ---: | ---: | ---: | ---: |
| accent `#f386a1` vs error `#F87171` | 17.0 | **12.0** | 6.9 | 11.4 |
| accent vs `#ef4444` (rejected red) | 27.3 | 18.9 | 16.3 | 19.8 |
| accent vs `#ff5f5f` (= cell 203) | 20.8 | 15.0 | 11.3 | 14.7 |
| accent vs warn `#FBBF24` | 35.3 | 24.5 | 12.0 | 47.1 |
| accent vs ok `#4ADE80` | 30.7 | **12.4** | 66.2 | 71.5 |
| accent vs daltonized error `#60A5FA` | 20.4 | **34.1** | 68.6 | 39.5 |
| accent vs teal `#09aea1` (rejected for `you`) | **6.0** | 16.5 | 60.5 | 59.7 |
| accent vs `you` `#d45bb6` | 19.3 | 24.7 | 9.5 | 16.8 |
| `you` `#d45bb6` vs error `#F87171` | 33.9 | 35.6 | 7.9 | 24.2 |
| `you` vs daltonized error `#60A5FA` | 15.5 | 12.2 | 68.0 | 39.2 |

Simulated appearance (deuteranope): `#f386a1` → `#b3af9f` (warm beige), `#F87171` → `#b3a66e`, `#4ADE80` → `#ccbf86`, `#d45bb6` →
`#8390b3` (slate blue), `#60A5FA` → `#6c9cf8`.

### 5.2 Rules

1. **Pink is never a *semantic* colour in the default theme.** `accent`, `badge`, `assistant`, `chosen`, `accent2`, `borderFocus`,
   `you` are identity/state roles whose meaning is always in a marker (`[chosen]`, `[you]`, `[jevcode]`, the mode word, `live`).
   Red/amber/green keep their markers (`error`, `[block]`, `[review]`, `✓`). A deuteranope who cannot split pink from salmon
   red (ΔE 12) still reads `[chosen]` vs `[block]`.
2. **`daltonized` = `dark` with the review/block family moved off red** (as today): `error`/`block` → `#60A5FA` / 75 / `blue`
   (pink vs blue: ΔE 34.1 deutan, 20.4 protan), `ok` → `#7DD3FC` / 117 / `cyan` (the freed-up old accent), `review` stays amber.
   `chosen` **stays pink** (was cyan): pink vs blue-block is the 34/20 pair. `you` stays `#d45bb6` (vs blue-error 12.2/15.5 —
   never on the same row, both marked). No pink is moved: the daltonized concern was pink-vs-red, and it is solved on the red side.
3. **Light theme caveat.** `#be185d` vs light error `#b91c1c`: 14.8 deutan / 27.9 protan — fine. `#be185d` vs light ok `#15803d`:
   **6.8** deutan — pink accent and the green `✓` collapse; harmless (both mean "good", the `✓` carries it) but documented. A
   `light` user with deuteranopia should be told `/theme daltonized` exists (dark background).
4. **Tritanopia** (≈0.01 % prevalence) folds pink into red (6.9) and `you` into red (7.9); the markers rule covers it; no theme.

---

## 6. (d) ANSI-16 twin and the 256-colour maths

### 6.1 xterm 256 cube

Cells 16–231: `idx = 16 + 36·r + 6·g + b` with each channel snapped to the nearest of `[0, 95, 135, 175, 215, 255]`; cells 232–255
are greys `8 + 10·k`. Nearest is confirmed by ΔE2000 over all 240 cells.

| Colour | rgb | channel snaps → levels | index arithmetic | cell | cell hex | ΔE2000 |
| --- | --- | --- | --- | ---: | --- | ---: |
| `#f386a1` primary | (243,134,161) | 243→255 [5], 134→135 [2], 161→175 [3] | 16 + 36·5 + 6·2 + 3 | **211** | `#ff87af` | 3.42 (next: 204 `#ff5f87` 7.77, 175 `#d787af` 7.86) |
| `#d45bb6` secondary | (212,91,182) | 212→215 [4], 91→95 [1], 182→175 [3] | 16 + 36·4 + 6·1 + 3 | **169** | `#d75faf` | 2.25 (next: 170 `#d75fd7` 5.85) |
| `#fbd0dc` sweep | (251,208,220) | [5,4,4] | 16 + 180 + 24 + 4 | **224** | `#ffd7d7` | 4.77 |
| `#e5e5e5` code | (229,229,229) | grey ramp | 232 + (228−8)/10 | **254** | `#e4e4e4` | 0.22 |
| `#4ADE80` ok | (74,222,128) | 74→95 [1], 222→215 [4], 128→135 [2] | 16 + 36 + 24 + 2 | **78** | `#5fd787` | 2.72 (HEAD's 114 `#87d787` is farther) |
| `#be185d` light accent | (190,24,93) | [3,0,1] | 16 + 108 + 0 + 1 | **125** | `#af005f` | 4.92 |
| `#831843` light secondary | (131,24,67) | [2,0,1] | 16 + 72 + 0 + 1 | **89** | `#87005f` | 8.64 |
| `#b91c1c` light error | (185,28,28) | [3,0,0] | 16 + 108 | **124** | `#af0000` | 4.77 |
| `#15803d` light ok | (21,128,61) | [0,2,1] | 16 + 12 + 1 | **29** | `#00875f` | 7.62 |
| `#1e1e1e` light code | (30,30,30) | grey ramp | 232 + 2 | **234** | `#1c1c1c` | ≈0 |
| `#09aea1` teal (unused) | (9,174,161) | [0,3,3] | 16 + 18 + 3 | 37 | `#00afaf` | 4.80 |
| `#03aa5c` green (unused) | (3,170,92) | [0,3,1] | 16 + 18 + 1 | 35 | `#00af5f` | 1.47 |

Unchanged twins: error 203, warn 214, daltonized blue 75 / cyan 117, light blue 25.

### 6.2 ANSI-16 mapping rule

- Primary family (`accent`, `badge`, `chosen`, `assistant`) → **`magentaBright`** (SGR 95); secondary family (`you`,
  `borderFocus`, `accent2`) → **`magenta`** (SGR 35). The lightness order matches (xterm defaults: `#ff00ff` L\* 60 vs `#cd00cd`
  L\* 44), so the "rest vs active" distinction survives inside tmux, which caps at 16 colours (TUI.md:596).
- Light theme: every pink → `magenta` (bright magenta on white has ~1.6:1 in default palettes).
- `sweep` → `whiteBright` (motion only); `code` → `whiteBright` dark / `black` light.
- The `ansi` theme is derived from `dark` at `theme.ts:149-161`, so it becomes: accent/badge/chosen/assistant `magentaBright`,
  you/borderFocus/accent2 `magenta`, error/block `red`, warn family `yellow`, ok `green`, dim roles `gray`, no dim anywhere.

---

## 7. (e) Contrast — every coloured role, three dark backgrounds

WCAG 2.x `(L₁ + 0.05) / (L₂ + 0.05)`. Body text ≥ 4.5:1; markers, edges, glyphs ≥ 3:1. `dim` is SGR 2 and terminal-defined
(most emulators halve the foreground; on `#1e1e1e` that lands around 4–5:1 for a `#dedede` default) — it is used for labels and
decoration only, never for a sentence the user must read.

| Role → truecolor | `#1e1e1e` (TypeSafe) | `#000000` | `#002b36` (Solarized dark) | Grade | Flag |
| --- | ---: | ---: | ---: | --- | --- |
| accent / badge / chosen / assistant `#f386a1` | **6.93** | 8.74 | 6.24 | body | — |
| you / borderFocus / accent2 `#d45bb6` | **4.74** | 5.97 | **4.27** | body on TypeSafe & black; **marker-grade on Solarized** | `you` body text on Solarized is 4.27 < 4.5 |
| sweep `#fbd0dc` | 12.03 | 15.16 | 10.84 | — | — |
| code `#e5e5e5` | 13.23 | 16.67 | 11.92 | body | — |
| error / block `#F87171` | 6.03 | 7.59 | 5.43 | body | — |
| warn / review / steer / secret `#FBBF24` | 9.99 | 12.58 | 8.99 | body | — |
| ok `#4ADE80` | 9.57 | 12.05 | 8.62 | body | — |
| daltonized error `#60A5FA` | 6.56 | 8.26 | 5.90 | body | — |
| daltonized ok `#7DD3FC` | (HEAD) | | | | unchanged |
| 256 cell 211 `#ff87af` | 7.41 | 9.34 | 6.67 | body | — |
| 256 cell 169 `#d75faf` | 4.88 | 6.15 | 4.39 | as `#d45bb6` | same flag |
| rejected `#ef4444` | **4.43** | 5.58 | 3.99 | fails body | rejected |
| rejected `#03aa5c` (site green) | 5.48 | 6.91 | 4.94 | body | not chosen: `#4ADE80` is 9.57 |

Light (`#fefefe` / `#ffffff` / `#fdf6e3`): accent `#be185d` 5.99 / 6.04 / 5.60; secondary `#831843` 9.57 / 9.65 / 8.94; error
`#b91c1c` 6.42 / 6.47 / 6.00; ok `#15803d` 4.97 / 5.02 / 4.65; blue `#0369A1` 5.88 / 5.93 / 5.50; code `#1e1e1e` 16.5 / 16.7 / 15.5.
For the record, the site's own pinks on white: `#f386a1` **2.38**, `#d45bb6` **3.49** — neither can be light-theme text, which is
why the light pinks are darkened, and why HEAD's inherited `#F87171` (2.74) / `#4ADE80` (1.73) must change.

Only one cell under a threshold in the shipped default: `you` on Solarized dark (4.27). Mitigation: the `[you]` marker is dim and
the human's lines are short; if the owner wants a hard pass, `you` can use `#e07fc9` (not on the site) — not recommended.

---

## 8. (f) Where pink must not go, and where the secondary goes

**Never pink** (the meaning colours and the quiet layer):

| Surface | Role | Why |
| --- | --- | --- |
| error items, blocking card, `[block]` rows, review-card edges when blocked | `error` / `block` (red) | danger stays red in every theme except `daltonized` (blue) |
| `[review]`, the live prompt while steering, the secret gate, retry rows, banner, toasts, wizard hint | `warn` / `review` / `steer` / `secret` (amber) | "attention" stays amber; the steering prompt must not look like the idle prompt |
| `✓`, "complete" status, tests-passed | `ok` (green) | success ≠ brand |
| every label except `[jevcode]`, detail lines, queue rows, ghost text, the dir, rules, borders at rest, placeholders, `… n more rows`, palette footer | `dim` family | the quiet layer is what makes pink read as an accent; colouring it pink would make "pink everywhere" mean "nothing stands out" |
| the `[jevcode]` **body**, live rows, step lines, `[run] start/end`, proposal items | default fg | the long text stays at the terminal's highest-contrast colour — "messages super easy to read" |
| code fences and fenced bodies | `code` (`#e5e5e5`) | monospace content is neutral |
| status compartment text | `ok`/`warn`/`secret` or none | the status is a fact, not a brand |
| the picker/palette rows other than the selection | bold / dim | ≤ 3 colours per row |

**Primary `#f386a1`** (rest / identity): brand row `◆ jevcode 0.3.0`, wordmark `JEV`, the mode badge (bold), `[jevcode]` label,
`[chosen]`, the composer prompt `›` when idle and focused, the picker's selected row, a hosted console title (`setup · generator
key`).

**Secondary `#d45bb6`** (active / selected / cooling): console edges while a run is live (`borderFocus`), the human's message body
(`you`), the wordmark's first fade step (`accent2`), optionally the `▌` selection marker in the palette and mention popup
(`Overlay.tsx:197,246` — today bold-only; a visual-only change).

**Rule of thumb for future surfaces:** if the element *is* JevCode/Jev, primary; if the element is *being acted on* (live,
selected, the user's own words), secondary; if it *means* something (good/bad/attention), the semantic hue; otherwise dim/default.

---

## 9. (g) Wordmark colour plan

Today (`splash.ts:113-135`, `App.tsx:2160-2185`): `JEV` = `accent`, `CODE` = `dim`, head `▓▒░` and the 6-cell band = `sweep`;
fade 600 ms drops `JEV` to default fg, fade 650 ms dims everything; settled = brand row with `◆ jevcode` in `accent`.

### 9.1 Tones (three fixed steps + dim; no gradient, no per-cell interpolation)

| Tone | Role | truecolor | 256 | ansi16 | L\* | Use |
| --- | --- | --- | ---: | --- | ---: | --- |
| light | `sweep` | `#fbd0dc` | 224 | `whiteBright` | 87.4 | the reveal head `▓▒░`, the shimmer band — "light on the letters" |
| primary | `accent` | `#f386a1` | 211 | `magentaBright` | 68.5 | the `J E V` letters (one tone: the mark stays a mark) |
| deep | `accent2` | `#d45bb6` | 169 | `magenta` | 56.9 | fade step 1: the letters "cool" after the light passes |
| quiet | `dim` | — | — | `gray` (ansi) | terminal | `CODE` throughout; fade step 2: everything |

The three L\* steps are 18.9 / 11.6 apart — large enough to read as depth at a glance, small enough to be one colour family. At
depth 16 the same story is `whiteBright → magentaBright → magenta → dim`, still four steps.

### 9.2 Schedule change (one line)

| t (ms) | Phase | HEAD | Proposed |
| --- | --- | --- | --- |
| 0–400 | reveal | JEV accent, CODE dim, head sweep | same roles, new colours |
| 450–550 | shimmer | band sweep over accent letters | same |
| 600 | fade 1 | JEV → *no role* (default fg) | JEV → **`accent2`** (`splash.ts:113`: `t >= FADE_2 ? 'dim' : 'accent2'`) |
| 650 | fade 2 | everything dim | same |
| 700 | settled | brand row, `◆ jevcode` accent | same |

Why: a pink mark that flashes to white text for 50 ms (HEAD) reads as a glitch; stepping to the deeper pink reads as the light
leaving. Same frame count, same changed-cell bound (one SGR change per row at 600 ms), so the dynamic-frames gate is unaffected.

The solid `█` cells in `#f386a1` are also the closest a terminal can get to the site's signature — a solid pink block with
`#1e1e1e` around it — without backgrounds (F2). R2's persistent wordmark should keep to the same three tones (idle sweep with
`sweep`, letters `accent`, `CODE` dim) so the hero frame never introduces a fourth pink.

---

## 10. (h) Every string that pins a colour name, hex or byte

| File:line | Today | Change |
| --- | --- | --- |
| `src/tui/theme.ts:1-8` | header names `--theme dark\|light\|daltonized\|ansi` | add "dark = TypeSafe pink (typesafe.ai palette, 2026-09-21)" |
| `src/tui/theme.ts:61,63,86` | 19 roles; `NO_MARKER_ROLES` | add `accent2` to both |
| `src/tui/theme.ts:93-112` | dark table | §3.1 |
| `src/tui/theme.ts:108,127` | `marker: 'jev-only'` | `marker: '<mode>'` |
| `src/tui/theme.ts:117-132` | light table | §4 (add `error`, `block`, `chosen`, `assistant`, `accent2` overrides) |
| `src/tui/theme.ts:136-145` | daltonized | drop the `chosen` override (inherits pink); keep error/block blue, ok cyan |
| `src/tui/splash.ts:2-3,100,113` | "JEV in accent … fade 600: JEV loses its accent" | fade 600 → `accent2` |
| `src/tui/Transcript.tsx:114-115` | every label `dim` | `[jevcode]` label → `assistant` |
| `src/tui/Console.tsx:142`, `src/tui/composer/Composer.tsx:620` | prompt `steer` only while live | `live && active ? steer : active ? accent : {}` |
| `src/tui/App.tsx:2030,2039,2058` | `color` | `depth` |
| `src/tui/App.tsx:2138-2141,2160` | comments "accent JEV, dim CODE, sweep head" | mention `accent2` fade |
| `test/unit/tui/theme.test.ts:62-66` | `colorAt` examples `cyan/117/#7DD3FC` | any triple works; switch to `magentaBright/211/#f386a1` for coherence |
| `test/unit/tui/theme.test.ts:89` | `badge.marker` = `'jev-only'` | `'<mode>'` |
| `test/unit/tui/theme.test.ts:91` | `assistant.color` undefined | defined (`#f386a1`) |
| `test/unit/tui/theme.test.ts:94-111` | the §4.9 table (`#7DD3FC/117/cyan`, `#38BDF8/74`, `#A5B4FC/147/blueBright`, `#E2E8F0/254`, `#E0F2FE/195`, light `#0369A1/25`, `#0284C7/31`, `#4338CA/61`, `#1E293B/236`, `#075985/24`, `ok 114`) | §3.1 / §4 values |
| `test/unit/tui/theme.test.ts:130-133` | `ansi256(117)`, `#7DD3FC`, `cyan` | `ansi256(211)`, `#f386a1`, `magentaBright` |
| `test/unit/tui/theme.test.ts:154` | deep-ansi fixture uses `#7DD3FC` | any hex |
| `test/unit/tui/splash.test.ts:143` | fade 1 has no `accent` spans | assert `accent2` spans on every row, no `accent` |
| `test/unit/tui/round2-app.test.tsx:109-111,165` | role probes (`border`, `borderFocus`, `steer`) | add idle-prompt `accent` and no `steer`; still `toContain` style — no byte pins |
| `test/unit/tui/round2-transcript.test.tsx:2` | comment "dim label" for `[jevcode]` | "pink `assistant` label" |
| `test/pty/helpers.ts:48` | comment `ESC[38;5;147mhi` | `38;5;169` |
| `test/pty/helpers.ts:73-75` (`echoStep`) | `expect › text` | `expect › ${SGR_GAP}text` — the idle prompt now closes an SGR before the body |
| `docs/TUI-DESIGN-2.md:1003-1016` | §4.9 table | §3.1 / §4 (add `accent2` row) |
| `docs/TUI-DESIGN-2.md:1450-1452,1490,1516-1518` | "JEV in accent", fade row "accent → default", brand row | `accent2` step |
| `docs/TUI.md:56` | "JEV in the accent colour" | "in TypeSafe pink" |
| `docs/TUI.md:272-273` | "`[you]` items in the `you` colour with a dim label, `[jevcode]` items with a dim label" | `[jevcode]` label pink |
| `docs/TUI.md:342-346` | colour paragraph | add one sentence naming the palette and the two pinks' roles |
| `docs/TUI.md:606-607`, `README.md:285`, `docs/COMMANDS.md:35` | `--theme dark\|light\|daltonized\|ansi` | unchanged ids; README may say "dark (TypeSafe pink)" |
| `docs/STATUS.md:901` | `╭─ ESC[1;38;5;117mjev-onlyESC[39;22m` | `ESC[1;38;5;211m<mode word>` |
| `docs/KEYS.md` | — | no colour strings (grep confirmed) |
| `docs/research/tui/round-2/design-visual.md:552-565`, `docs/research/tui/workflows/r3-design.js:39` | historical | leave |

No pty `.steps` file and no smoke script pins a colour byte (grep `38;` over `test/pty/**` → only the helper comment); the
sentinels use `SGR_GAP`. The perf key-frame matcher `composerEndsWithKey` (`src/perf/pty.ts:573`) tests `endsWith(key)` on the
composer row — the idle prompt's SGR sits *before* the body, so it still matches; verify on the first `npm run perf`.

---

## 11. (i) Test plan

1. **Theme table snapshot per depth** — new `test/unit/tui/theme-palette.test.ts`: for each theme × role × depth ∈ {16, 256, 24},
   `textProps(theme, role, depth)` compared to an inline golden table (`toMatchInlineSnapshot` or a literal object). Catches any
   accidental drift and documents the palette in one place. Pure; runs in < 5 ms.
2. **Contrast unit test** (same file): a 12-line WCAG luminance function; assert every `dark` truecolor ≥ 4.5 on `#1e1e1e` for the
   body roles {error, warn, ok, block, review, steer, secret, accent, chosen, you, assistant, badge, code} and ≥ 3.0 for
   {borderFocus, accent2, sweep}; every `light` truecolor with the same thresholds on `#fefefe`; every `daltonized` override on
   `#1e1e1e`. Would have failed HEAD's light theme (2.74 / 1.73).
3. **Twins identity**: (a) every `ansi256` member is within Euclidean RGB distance ≤ 48 of the cube/grey cell of its `truecolor`
   (fails HEAD's `ok` 114, passes 78); (b) within a theme, two roles with different `truecolor` never share an `ansi256` (the
   125 collision); (c) every pink role's `ansi16` ∈ {`magenta`, `magentaBright`}, `error`/`block` `red`, `ok` `green`, dark warn
   family `yellow`, light warn family `blue`; (d) `THEMES.ansi` equals `dark` with deep members stripped (extend the existing
   `theme.test.ts:71-92`).
4. **Role wiring** (extend `round2-transcript.test.tsx` with the `textProps` spy pattern of `round2-app.test.tsx:28-40`): a
   `[jevcode]` row asks `assistant` for its label and nothing for its body; a `[you]` row asks `dim` for its label and `you` for its
   body; `formatTranscriptItem` output is byte-identical to HEAD (identity, TUI-DESIGN-2 §9).
5. **Prompt state**: `round2-app.test.tsx` idle → probes contain `accent`, not `steer`; live+active → `steer`, not `accent`;
   composer inactive (overlay open) → neither.
6. **Splash**: `splash.test.ts:143` → at t = 600 every row has an `accent2` span over cells 0–22 and no `accent`; at t = 650
   `dim` only; frame counts unchanged.
7. **Depth split**: `round2-app` with a fake host reporting depth 256 and `retrying: true` → the live row's `textProps` call is made
   with `256`, not `true` (spy records the third argument).
8. **pty (new scenario `theme-pink.steps` + a case in `round2.pty.test.ts`)** at `TERM=xterm-256color`: the first frame contains
   `38;5;211` (brand row) and no `38;5;117`; after `run:start` the capture contains `38;5;169` (live edge) and no `38;5;74`; with
   `--theme light` the frame contains `38;5;125`; with `--theme ansi` it contains `ESC[95m` and no `38;5;`; with `NO_COLOR=1` no
   `38;` at all. Hygiene unchanged: zero clears, no key bytes (the existing `assertNoKeyBytes` helper).
9. **Docs gate**: a unit test greps `docs/TUI.md`, `docs/TUI-DESIGN-2.md` §4.9 and `docs/STATUS.md` for `7DD3FC|38BDF8|38;5;117|38;5;74`
   and fails if any remain after the swap (one-off, can be deleted after round 3 ships).

---

## 12. Proposals

1. **Swap the `dark` table to TypeSafe pink and add `accent2`.** *What:* the §3.1 table; `COLOR_ROLES` + `NO_MARKER_ROLES` gain
   `accent2`; header comment names the palette. *Where:* `src/tui/theme.ts:61-63,86,90-114`. *Edge cases:* `themeFor` fallback
   still `DARK`; the `ansi` derivation picks up every new member automatically (`:149-161`); `validateTheme` must still return `[]`
   for all four; `assistant` now has a colour → it is already in `NO_MARKER_ROLES` so the marker `[jevcode]` is decorative-safe.
   *Tests:* §11 items 1–3; update `theme.test.ts:89-111,130-133`. *Perf gate:* none touched (pure data; first frame does no I/O).
2. **Fix the `light` table** (error/block `#b91c1c`/124, ok `#15803d`/29, pinks `#be185d`/125 and `#831843`/89, code `#1e1e1e`/234).
   *Where:* `theme.ts:117-133`. *Edge cases:* the 125 collision avoided by `#831843`; light pinks use `magenta` not bright.
   *Tests:* §11 items 1–3 (contrast on `#fefefe`). *Perf gate:* none.
3. **Daltonized: keep red→blue, let `chosen` inherit pink.** *Where:* `theme.ts:136-146` (delete the `chosen` line).
   *Edge cases:* pink vs blue 34/20 ΔE; `you` vs blue 12.2/15.5 with markers. *Tests:* `theme.test.ts:113-120` + contrast for
   the overrides. *Perf gate:* none.
4. **Mode-neutral badge marker.** *What:* `marker: '<mode>'` in dark and light. *Where:* `theme.ts:108,127`; `theme.test.ts:89`.
   *Edge cases:* `validateTheme` only requires non-empty (`:235`); the rendered word still comes from `modeBadgeWord`
   (`status/lines.ts:107`), so flipping `DEFAULT_MODE` (`config/defaults.ts:44`) changes no theme string. *Tests:* a grep test that
   `src/tui/theme.ts` contains none of `jev-only|jev+llm|llm-jev|llm-only`. *Perf gate:* none.
5. **`[jevcode]` label in the `assistant` role.** *What:* `labelProps = item.label === '[jevcode]' ? textProps(theme,'assistant',color)
   : textProps(theme,'dim',color)`. *Where:* `src/tui/Transcript.tsx:115`. *Edge cases:* body stays default fg; `--plain` and
   `transcript.log` are text-only (identity holds — the change is SGR-only around the label); screen-reader mode renders the same
   text; `--ascii` unaffected; `NO_COLOR` → `{}`. *Tests:* §11 item 4; `round2-transcript.test.tsx` text assertions unchanged.
   *Perf gate:* static-append bytes/line rises by one SGR pair (≈ 11 bytes) per `[jevcode]` item — report-only metric; identity
   gate (`twins.pty.test.ts:96`) must stay green.
6. **Composer prompt pink at rest, amber while steering.** *What:* `promptProps = p.live === true && p.active ? steer : p.active ?
   accent : {}`. *Where:* `Console.tsx:142`, `Composer.tsx:620`. *Edge cases:* the wizard-hosted console has no prompt row; the
   `filter` mode prompt `› filter` takes the same props; `--plain` uses readline (no colour); `echoStep` needs `SGR_GAP`
   (`test/pty/helpers.ts:73-75`); the perf matcher `composerEndsWithKey` is unaffected (SGR precedes the body). *Tests:* §11 item 5;
   re-run the pty suite. *Perf gate:* **composer keystroke → frame p95 < 16 ms** (one extra `<Text>` span per composer row; D-F
   immediate path unchanged) — run `npm run perf` composer idle/live/palette/review.
7. **Splash fade step 1 → `accent2`.** *Where:* `splash.ts:113` (`jevRole`), comments `:2-3,100`; `App.tsx` comments. *Edge cases:*
   reduced motion / SR / `--plain` never render the splash; below 64 columns the brand row pulses glyphs only (`brandSpan` accent).
   *Tests:* §11 item 6. *Perf gate:* **dynamic frames ≤ maxFps + 1** and the "≤ 12 changed cells per frame" bound — unchanged frame
   count, one SGR change per row at 600 ms.
8. **Pass `depth` to live rows, banner and queue rows.** *Where:* `App.tsx:2030,2039,2058`. *Edge cases:* depth 0 → `{}` as before.
   *Tests:* §11 item 7. *Perf gate:* none (same span count); pty bytes change `ESC[33m` → `38;5;214`.
9. **Fix the `ok` 256 twin (114 → 78).** *Where:* `theme.ts:95,102`. *Tests:* §11 item 3a. *Perf gate:* none.
10. **Docs and comments sweep** per §10 (TUI.md, TUI-DESIGN-2 §4.9/§5, STATUS.md:901, helpers.ts:48). *Tests:* §11 item 9.
11. **Optional: `▌` selection marker in `accent2`** for the palette and mention popup (`Overlay.tsx:197,246`). Visual-only; skip
    if the row would exceed three colours (selected row is bold + accent2 marker + text = fine). *Perf gate:* palette composer
    latency scenario.

Recommended order: 1 → 2 → 3 → 4 → 9 (one PR: `theme.ts` + `theme.test.ts` + palette/contrast tests), then 5 → 8 → 7 → 6 (consumers,
each with its probe test), then 10, then 11 if wanted.

---

## 13. Risks

- **Terminal palettes vary at depth 16.** `magenta`/`magentaBright` are whatever the user's terminal says (Dracula `#ff79c6`,
  Solarized `#d33682`/`#6c71c4` — Solarized's *bright* magenta is violet). Inside tmux the whole brand is at the palette's mercy.
  Mitigation: depth 256 is detected for `*-256color` and 24-bit for iTerm/WezTerm/ghostty/vscode/`COLORTERM`, so the exact pinks
  reach most users; the `ansi` theme is the documented escape hatch.
- **`you` at 4.74:1 is AA, not AAA**, and 4.27 on Solarized dark. Human lines are short; if the owner wants AAA body text for the
  human voice the only on-palette option is the primary pink, which loses the two-voice read.
- **Pink `[chosen]` vs red `[block]` for deuteranopes** (ΔE 12) in the default theme relies on markers; `daltonized` is the fix
  and should be mentioned in the first `/help` or the wizard's last line (R3's call).
- **The live console edge in magenta** is the largest visual change (1.3k SGRs per session). It is deliberate (the site's primary
  border) but the owner has only seen pty captures; judge it in a real terminal before shipping.
- **`echoStep` SGR gap**: forgetting it fails ~30 pty scenarios at once; do proposal 6 together with the helper change.

## 14. Open questions

1. Should the four `ThemeName`s stay (recommended, zero churn) or should `dark` be aliased to a new `pink` id for discoverability
   in `/theme`? (A second id means six enum sites + man page + completions.)
2. Does the owner want `[you]` body in the secondary pink (recommended) or in plain bright text with only the `[you]` label pink?
3. Should `chosen` be pink in `light` too (as specified) given the deuteranope pink/green collapse there (ΔE 6.8)? Markers cover
   it; the alternative is light `chosen` = green.
4. Should the first `/help` mention `/theme daltonized` for colour-blind users now that the brand colour sits near red?
