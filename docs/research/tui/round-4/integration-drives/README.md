# Integration drives — round 4 (2026-09-22)

The `scripts/pty/drive.exp` captures behind `docs/STATUS.md`'s "Driven against the real product" table. Every
drive is hermetic (`--mock`, a temp `JEVCODE_HOME`, a temp workspace, no network); the captures are gzipped.

| drive | geometry | what it shows |
| --- | --- | --- |
| `a-hero-24x80` | 24×80 → 40×120 → 12×60 → 60×200 → 24×80 + a 20-event storm | 0 clears after the first frame, 0 `ESC[3J`, **0 torn frames** over 18 frames carrying a box (widths 60 / 80 / 120 / 200) |
| `a-rows-cycle` | 24 → 8 → 16 → 24 → 40 → 24 → 12 → 24 rows | 1 clear for three shrinks (≤ 1 per shrink segment), 0 `ESC[3J` |
| `b-fs-24x80` | 24×80, `--renderer fullscreen` | `ESC[?1049h`, 0 `ESC[3J`, `/scrollback`'s primary-screen print and its `-- end of transcript …` row, the on-exit dump |
| `b-fs-scroll` | 24×80, `--renderer fullscreen`, a 12-step run | PgUp → 73 % → 46 %, PgDn → 73 %, Ctrl+Home → 0 %, Ctrl+End → 100 %, `▲ 41 earlier rows · PgUp` |
| `c-idle-40` | 24×40 | all eleven §3 command blocks; **no row wider than 40 cells** |
| `d-palette` | 24×80 | `/` opens the full list, Enter walks `(1/41) → (3/41)` with the ghost following the marker, Tab accepts, a zero-match token answers the toast and never submits |
| `e-review-edit` | 24×80, `JEVCODE_MOCK_REVIEW_AT=4` | the §6 card with an `edit` action: `edit scratch_0.py +1 −1 "…"`, `╶──── scratch_0.py`, `@@ -1 +1 @@`, and the outcome row `· 1 file +1 −1 · judge 0.90 · …` |

Read one with:

```sh
gunzip -c docs/research/tui/round-4/integration-drives/<name>/capture.bin.gz | sed -E $'s/\x1b\\[[0-9;?]*[A-Za-z]//g'
```
