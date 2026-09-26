#!/usr/bin/env python3
"""Render one take of the README demo as an animated GIF and a still.

    render.py <take-dir> --out docs/media/demo.gif --poster docs/media/demo.png [options]

<take-dir> is what `record.sh` wrote: `capture.bin` (every byte the terminal received),
`timing.jsonl` (when each byte arrived, and the typist's marks) and `meta.json`.

The bytes are replayed through the terminal emulator of scripts/demo/side-by-side/render.py,
extended here with what an interactive session also uses: the cursor (DECTCEM and the DECSCUSR
shape), and synchronized output (mode 2026), so a frame is only ever sampled between two
complete repaints, as a terminal that supports the mode shows it. Nothing is drawn that the
terminal did not receive, and time is not stretched: a frame is shown for exactly as long as
the screen stood still in the capture, to the GIF's 10 ms resolution (`--fps` sets how finely
the capture is sampled). What is trimmed is the time before the typist's first key (all but a
short lead-in) and everything after the shell's first prompt once the session has exited (the
typed `exit` that ends the recording); that last frame, the prompt under the console box, is
then held for `--hold` seconds before the loop restarts.

Text is drawn cell by cell on the terminal grid, so no run of glyphs can drift off it. Braille,
block elements and the light box-drawing set are drawn as shapes filling the cell, as most
terminal emulators draw them (Menlo has no braille, and a font's box glyphs leave gaps between
rows once the line is taller than the font); everything else comes from the font.

Before anything is drawn, every state the screen reached in the shown span is checked: the screen
after each chunk the terminal received, and after each complete repaint when one chunk carried
several. The check looks for escape debris, replacement characters, a torn console box and, on
the last state, a shell prompt inside the box instead of below it; any problem stops the render
(`--allow-problems` overrides, `--ignore-sync` shows what the check catches without mode 2026).

Requires Pillow. Fonts: Menlo, else SF Mono, else DejaVu Sans Mono; Apple Symbols and Arial
Unicode fill any glyph the first font lacks, and Apple Color Emoji (or Noto Color Emoji) draws a
colour emoji into its cells. A character no font draws stops the render (`--allow-problems`
overrides).
"""
from __future__ import annotations

import argparse
import codecs
import importlib.util
import json
import os
import re
import sys
from typing import Optional

from PIL import Image, ImageChops, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def _side_by_side():
    """The shared terminal emulator (one copy of it in the repository)."""
    path = os.path.join(HERE, "..", "side-by-side", "render.py")
    spec = importlib.util.spec_from_file_location("jevcode_side_by_side_render", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


sbs = _side_by_side()


def _steps():
    """The keystroke plan, for the shell prompt it waits on (one definition of it in the repository)."""
    spec = importlib.util.spec_from_file_location("jevcode_demo_session_steps", os.path.join(HERE, "steps.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


steps = _steps()

# --------------------------------------------------------------------------------------
# colours: the background the theme's contrast was measured on, and the theme's own `code`
# foreground (src/tui/theme.ts); `dim` is the alpha scripts/gen-brand.mjs uses for it
# --------------------------------------------------------------------------------------

BG = (0x1E, 0x1E, 0x1E)
FG = (0xE5, 0xE5, 0xE5)
CHROME = (0x26, 0x26, 0x26)
CHROME_RULE = (0x36, 0x36, 0x36)
CHROME_TEXT = (0x8E, 0x8E, 0x8E)


def dim_opacity() -> float:
    try:
        text = open(os.path.join(REPO, "scripts", "gen-brand.mjs"), encoding="utf-8").read()
        m = re.search(r"const DIM_OPACITY = ([0-9.]+)", text)
        if m:
            return float(m.group(1))
    except OSError:
        pass
    return 0.45


DIM = dim_opacity()


def blend(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


# --------------------------------------------------------------------------------------
# terminal: the shared emulator plus the cursor and synchronized output
# --------------------------------------------------------------------------------------


class Term(sbs.Screen):
    def __post_init__(self) -> None:
        super().__post_init__()
        self.cursor_visible = True
        self.cursor_shape = 0
        self.sync = False
        self.frozen = None

    def csi(self, raw: str, final: str) -> None:
        if raw.startswith("?") and final in "hl":
            on = final == "h"
            for p in raw[1:].split(";"):
                if p == "25":
                    self.cursor_visible = on
                elif p == "2026":
                    if on and not self.sync:
                        self.frozen = self.live_view()
                        self.sync = True
                    elif not on:
                        self.sync = False
                        self.frozen = None
            return
        if final == "q" and re.fullmatch(r"[0-9]*", raw):
            self.cursor_shape = int(raw or 0)  # DECSCUSR (CSI Ps SP q)
            return
        super().csi(raw, final)

    def live_view(self):
        grid = tuple(tuple(row) for row in self.grid)
        cursor = None
        if self.cursor_visible:
            cursor = (min(self.row, self.rows - 1), min(self.col, self.cols - 1), self.cursor_shape)
        return grid, cursor

    def view(self):
        """What a terminal honouring mode 2026 shows: the last complete repaint."""
        return self.frozen if self.sync else self.live_view()


def load_timing(path: str):
    chunks, marks, sends = [], {}, []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            r = json.loads(raw)
            op = r.get("op")
            if op == "chunk":
                chunks.append((float(r["t"]), int(r["off"]), int(r["n"])))
            elif op == "mark":
                marks[str(r.get("arg", ""))] = float(r["t"])
            elif op == "send":
                sends.append((float(r["t"]), int(r["off"]), str(r.get("arg", ""))))
    return chunks, marks, sends


ESU = b"\x1b[?2026l"


def screen_events(capture: bytes, chunks, rows: int, cols: int, until_off: Optional[int] = None):
    """Every change of the visible screen, with the arrival time of the chunk that made it.

    A chunk is fed in pieces that end at each end of a synchronized update (`ESC[?2026l`), so two
    complete repaints that reached the terminal in one read are two states, not one."""
    term = Term(rows, cols)
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    events = [(0.0, term.view())]
    for t, off, n in chunks:
        if until_off is not None and off >= until_off:
            break
        end = off + n if until_off is None else min(off + n, until_off)
        data = capture[off:end]
        start = 0
        while start < len(data):
            cut = data.find(ESU, start)
            stop = len(data) if cut < 0 else cut + len(ESU)
            term.feed(dec.decode(data[start:stop]))
            start = stop
            v = term.view()
            if v != events[-1][1]:
                events.append((t, v))
    return events


DEBRIS = re.compile(r"[\x00-\x1f\x7f\ufffd]|\[\?[0-9;]+[hl]|\[[0-9;]*[A-HJKm]\b")


def problems_in(view, cols: int) -> list[str]:
    """What would make a frame wrong: escape debris, replacement characters, a torn console box."""
    grid, cursor = view
    text = ["".join(c[0] for c in row) for row in grid]
    found = []
    for r, line in enumerate(text):
        if DEBRIS.search(line):
            found.append(f"row {r}: debris in {line.rstrip()!r}")
    tops = [r for r, line in enumerate(text) if line.startswith("╭")]
    bottoms = [r for r, line in enumerate(text) if line.startswith("╰")]
    if len(tops) != len(bottoms):
        found.append(f"box tops at rows {tops}, bottoms at rows {bottoms}")
    for top, bottom in zip(tops, bottoms):
        if not (text[top].rstrip().endswith("╮") and text[bottom].rstrip().endswith("╯")):
            found.append(f"box corners at rows {top}/{bottom}")
        if len(text[top].rstrip()) != cols or len(text[bottom].rstrip()) != cols:
            found.append(f"box width at rows {top}/{bottom}")
        for r in range(top + 1, bottom):
            if text[r][:1] not in ("│", "├") or text[r][cols - 1] not in ("│", "┤"):
                found.append(f"row {r}: box side broken in {text[r].rstrip()!r}")
    if cursor is not None and not (0 <= cursor[0] < len(grid) and 0 <= cursor[1] < cols):
        found.append(f"cursor off screen at {cursor}")
    return found


def prompt_problems(view, prompt: str) -> list[str]:
    """The last state: the shell's prompt must be below the console box, where the session left the cursor."""
    grid, _ = view
    text = ["".join(c[0] for c in row) for row in grid]
    rows = [r for r, line in enumerate(text) if prompt in line]
    bottoms = [r for r, line in enumerate(text) if line.startswith("╰")]
    found = []
    if not rows:
        found.append(f"no shell prompt {prompt!r} on the last screen")
    elif bottoms and rows[-1] <= bottoms[-1]:
        found.append(f"row {rows[-1]}: the shell prompt is inside the console box: {text[rows[-1]].rstrip()!r}")
    elif not text[rows[-1]].startswith(prompt):
        found.append(f"row {rows[-1]}: the shell prompt does not start at column 0: {text[rows[-1]].rstrip()!r}")
    return found


def view_at(events, t: float):
    lo, hi = 0, len(events) - 1
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if events[mid][0] <= t:
            lo = mid
        else:
            hi = mid - 1
    return events[lo][1]


# --------------------------------------------------------------------------------------
# fonts and glyphs
# --------------------------------------------------------------------------------------

PRIMARY = [
    ("/System/Library/Fonts/Menlo.ttc", 0, 1),
    ("/System/Library/Fonts/SFNSMono.ttf", 0, 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 0, 0),
]
FALLBACK = [
    "/System/Library/Fonts/Apple Symbols.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
]
# colour emoji, drawn from the font's own bitmaps at one of its strike sizes and scaled into the cells
EMOJI = [
    ("/System/Library/Fonts/Apple Color Emoji.ttc", 160),
    ("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", 109),
]
UI_FONTS = ["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"]


class Fonts:
    def __init__(self, cell_w: int, cell_h: int):
        path = next((p for p in PRIMARY if os.path.exists(p[0])), None)
        if path is None:
            raise SystemExit("render.py: no monospace font found (Menlo, SF Mono or DejaVu Sans Mono)")
        self.path = path[0]
        probe = ImageFont.truetype(path[0], 100, index=path[1])
        advance = probe.getlength("M") / 100.0
        # the size whose advance is exactly one cell, as a terminal sizes its grid from the font
        self.size = cell_w / advance
        self.regular = ImageFont.truetype(path[0], self.size, index=path[1])
        try:
            self.bold = ImageFont.truetype(path[0], self.size, index=path[2])
        except OSError:
            self.bold = self.regular
        self.fallbacks = [ImageFont.truetype(p, self.size) for p in FALLBACK if os.path.exists(p)]
        ascent, descent = self.regular.getmetrics()
        self.baseline = int(round((cell_h - (ascent + descent)) / 2 + ascent))
        self._missing: dict = {}
        self.name = os.path.basename(self.path)
        self.emoji = None
        for p, size in EMOJI:
            if os.path.exists(p):
                try:
                    self.emoji = ImageFont.truetype(p, size)
                    break
                except OSError:
                    continue
        # characters no font could draw: reported, and a reason not to render
        self.unknown: set = set()

    def _notdef(self, font) -> bytes:
        key = ("notdef", id(font))
        if key not in self._missing:
            m = font.getmask("\U000F0001")
            self._missing[key] = bytes(m) + repr(m.size).encode()
        return self._missing[key]

    def has(self, font, ch: str) -> bool:
        key = (id(font), ch)
        if key not in self._missing:
            m = font.getmask(ch)
            self._missing[key] = (bytes(m) + repr(m.size).encode()) != self._notdef(font)
        return self._missing[key]

    def pick(self, ch: str, bold: bool):
        """The first text font with a glyph for `ch`, or None."""
        first = self.bold if bold else self.regular
        if self.has(first, ch):
            return first
        for f in self.fallbacks:
            if self.has(f, ch):
                return f
        return None

    def emoji_tile(self, ch: str, w: int, h: int, bg) -> Optional[Image.Image]:
        """A colour emoji fitted into its cells (two, for a wide one), centred, as a terminal draws it."""
        if self.emoji is None:
            return None
        size = int(self.emoji.size)
        probe = Image.new("RGBA", (size * 3, size * 2), (0, 0, 0, 0))
        try:
            ImageDraw.Draw(probe).text((0, 0), ch, font=self.emoji, embedded_color=True)
        except (OSError, ValueError):
            return None
        box = probe.getbbox()
        if box is None:
            return None
        glyph = probe.crop(box)
        k = min(w / glyph.width, h * 0.94 / glyph.height)
        glyph = glyph.resize((max(1, round(glyph.width * k)), max(1, round(glyph.height * k))), Image.LANCZOS)
        t = Image.new("RGB", (w, h), bg)
        t.paste(glyph, ((w - glyph.width) // 2, (h - glyph.height) // 2), glyph)
        return t


def ui_font(size: float):
    for p in UI_FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


SS = 4  # supersampling for the drawn shapes


def _shape_tile(ch: str, w: int, h: int, fg, bg) -> Optional[Image.Image]:
    """Braille, block elements and light box drawing, drawn to fill the cell."""
    o = ord(ch)
    W, H = w * SS, h * SS
    if 0x2800 <= o <= 0x28FF:
        im = Image.new("RGB", (W, H), bg)
        d = ImageDraw.Draw(im)
        bits = o - 0x2800
        dots = [(0, 0, 0x01), (0, 1, 0x02), (0, 2, 0x04), (1, 0, 0x08),
                (1, 1, 0x10), (1, 2, 0x20), (0, 3, 0x40), (1, 3, 0x80)]
        r = min(W / 4.0, H / 8.0) * 0.72
        for cx, cy, bit in dots:
            if bits & bit:
                x = W * (0.25 + 0.5 * cx)
                y = H * (0.125 + 0.25 * cy)
                d.ellipse([x - r, y - r, x + r, y + r], fill=fg)
        return im.resize((w, h), Image.LANCZOS)
    if 0x2580 <= o <= 0x259F:
        im = Image.new("RGB", (W, H), bg)
        d = ImageDraw.Draw(im)

        def rect(x0, y0, x1, y1, colour=fg):
            d.rectangle([round(x0 * W), round(y0 * H), round(x1 * W) - 1, round(y1 * H) - 1], fill=colour)

        if o == 0x2580:
            rect(0, 0, 1, 0.5)
        elif 0x2581 <= o <= 0x2588:
            rect(0, 1 - (o - 0x2580) / 8.0, 1, 1)
        elif 0x2589 <= o <= 0x258F:
            rect(0, 0, (0x2590 - o) / 8.0, 1)
        elif o == 0x2590:
            rect(0.5, 0, 1, 1)
        elif o in (0x2591, 0x2592, 0x2593):
            rect(0, 0, 1, 1, blend(bg, fg, {0x2591: 0.25, 0x2592: 0.5, 0x2593: 0.75}[o]))
        elif o == 0x2594:
            rect(0, 0, 1, 1 / 8.0)
        elif o == 0x2595:
            rect(7 / 8.0, 0, 1, 1)
        else:
            quads = {0x2596: "3", 0x2597: "4", 0x2598: "1", 0x2599: "134", 0x259A: "14", 0x259B: "123",
                     0x259C: "124", 0x259D: "2", 0x259E: "23", 0x259F: "234"}[o]
            boxes = {"1": (0, 0, 0.5, 0.5), "2": (0.5, 0, 1, 0.5), "3": (0, 0.5, 0.5, 1), "4": (0.5, 0.5, 1, 1)}
            for q in quads:
                rect(*boxes[q])
        return im.resize((w, h), Image.LANCZOS)
    # light box drawing: which of the four arms each glyph has (up, right, down, left)
    arms = {
        "─": "rl", "│": "ud", "┌": "rd", "┐": "ld", "└": "ur", "┘": "ul", "├": "urd", "┤": "uld",
        "┬": "rld", "┴": "url", "┼": "urld", "╴": "l", "╵": "u", "╶": "r", "╷": "d",
    }
    rounded = {"╭": ("d", "r"), "╮": ("d", "l"), "╯": ("u", "l"), "╰": ("u", "r")}
    if ch in arms or ch in rounded:
        im = Image.new("RGB", (W, H), bg)
        d = ImageDraw.Draw(im)
        lw = max(SS, int(round(W / 8.0)))  # one pixel at an 8-pixel cell
        cx, cy = W // 2, H // 2
        half = lw // 2

        def arm(a):
            if a == "u":
                d.rectangle([cx - half, 0, cx - half + lw - 1, cy + half], fill=fg)
            elif a == "d":
                d.rectangle([cx - half, cy - half, cx - half + lw - 1, H - 1], fill=fg)
            elif a == "l":
                d.rectangle([0, cy - half, cx + half, cy - half + lw - 1], fill=fg)
            elif a == "r":
                d.rectangle([cx - half, cy - half, W - 1, cy - half + lw - 1], fill=fg)

        if ch in arms:
            for a in arms[ch]:
                arm(a)
        else:
            vert, horiz = rounded[ch]
            r = W / 2.0
            # the straight part of the vertical arm, then a quarter circle into the horizontal one
            ox = cx - half + (lw - 1) / 2.0
            oy = cy - half + (lw - 1) / 2.0
            ax = ox + (r if horiz == "r" else -r)
            ay = oy + (r if vert == "d" else -r)
            if vert == "d":
                d.rectangle([cx - half, int(ay), cx - half + lw - 1, H - 1], fill=fg)
            else:
                d.rectangle([cx - half, 0, cx - half + lw - 1, int(ay)], fill=fg)
            box = [ax - r - lw / 2.0, ay - r - lw / 2.0, ax + r + lw / 2.0, ay + r + lw / 2.0]
            start = {("d", "r"): 180, ("d", "l"): 270, ("u", "l"): 0, ("u", "r"): 90}[(vert, horiz)]
            d.arc(box, start, start + 90, fill=fg, width=lw)
        return im.resize((w, h), Image.LANCZOS)
    return None


class Painter:
    def __init__(self, fonts: Fonts, cell_w: int, cell_h: int):
        self.fonts = fonts
        self.w = cell_w
        self.h = cell_h
        self.cache: dict = {}

    def colours(self, cell):
        _, fg, bg, bold, dim, inverse = cell
        fgc = fg or FG
        bgc = bg or BG
        if inverse:
            fgc, bgc = bgc, fgc
        if dim:
            fgc = blend(bgc, fgc, DIM)
        return fgc, bgc

    def tile(self, cell, wide: bool = False) -> Image.Image:
        key = (cell, wide)
        t = self.cache.get(key)
        if t is not None:
            return t
        ch = cell[0]
        fgc, bgc = self.colours(cell)
        w = self.w * (2 if wide else 1)
        t = _shape_tile(ch, w, self.h, fgc, bgc) if ch.strip() else None
        if t is None and ch.strip():
            font = self.fonts.pick(ch, bool(cell[3]))
            if font is None:
                t = self.fonts.emoji_tile(ch, w, self.h, bgc)
                if t is None:
                    self.fonts.unknown.add(ch)
                    font = self.fonts.regular
            if t is None:
                t = Image.new("RGB", (w, self.h), bgc)
                ImageDraw.Draw(t).text((0, self.fonts.baseline), ch, font=font, fill=fgc, anchor="ls")
        if t is None:
            t = Image.new("RGB", (w, self.h), bgc)
        self.cache[key] = t
        return t

    def paint(self, im: Image.Image, view, x0: int, y0: int) -> None:
        grid, cursor = view
        for r, row in enumerate(grid):
            y = y0 + r * self.h
            n = len(row)
            for c in range(n):
                cell = row[c]
                ch = cell[0]
                if ch == "" or (ch == " " and cell[2] is None and not cell[5]):
                    continue
                wide = c + 1 < n and row[c + 1][0] == ""
                im.paste(self.tile(cell, wide), (x0 + c * self.w, y))
        if cursor is not None:
            r, c, shape = cursor
            x, y = x0 + c * self.w, y0 + r * self.h
            d = ImageDraw.Draw(im)
            if shape in (5, 6):  # bar
                d.rectangle([x, y + 1, x + max(1, self.w // 6) - 1, y + self.h - 2], fill=FG)
            elif shape in (3, 4):  # underline
                d.rectangle([x, y + self.h - 2, x + self.w - 1, y + self.h - 1], fill=FG)
            else:  # block: the cell under it, inverted
                cell = grid[r][c]
                inv = (cell[0] or " ", cell[1], cell[2], cell[3], cell[4], not cell[5])
                im.paste(self.tile(inv), (x, y))


# --------------------------------------------------------------------------------------
# the picture
# --------------------------------------------------------------------------------------


class Layout:
    def __init__(self, rows: int, cols: int, cell_w: int, cell_h: int, scale: int, title: str):
        self.s = scale
        self.cw, self.ch = cell_w * scale, cell_h * scale
        self.pad_x = 14 * scale
        self.bar = 30 * scale
        self.pad_top = 10 * scale
        self.pad_bottom = 12 * scale
        self.width = self.pad_x * 2 + cols * self.cw
        self.height = self.bar + self.pad_top + rows * self.ch + self.pad_bottom
        self.fonts = Fonts(self.cw, self.ch)
        self.painter = Painter(self.fonts, self.cw, self.ch)
        self.base = Image.new("RGB", (self.width, self.height), BG)
        d = ImageDraw.Draw(self.base)
        d.rectangle([0, 0, self.width - 1, self.bar - 1], fill=CHROME)
        d.rectangle([0, self.bar - scale, self.width - 1, self.bar - 1], fill=CHROME_RULE)
        f = ui_font(12 * scale)
        d.text((self.width // 2, self.bar // 2), title, font=f, fill=CHROME_TEXT, anchor="mm")

    def frame(self, view) -> Image.Image:
        im = self.base.copy()
        self.painter.paint(im, view, self.pad_x, self.bar + self.pad_top)
        return im


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("take")
    ap.add_argument("--out", required=True, help="the GIF")
    ap.add_argument("--poster", help="a PNG of the screen just before /exit is typed")
    ap.add_argument("--fps", type=int, default=25, help="how often the capture is sampled")
    ap.add_argument("--cell-width", type=int, default=8)
    ap.add_argument("--cell-height", type=int, default=17)
    ap.add_argument("--scale", type=int, default=1, help="pixels per point in the GIF")
    ap.add_argument("--poster-scale", type=int, default=2)
    ap.add_argument("--lead-in", type=float, default=0.8, help="seconds kept before the first key")
    ap.add_argument("--hold", type=float, default=3.0, help="seconds the last frame is held before the loop")
    ap.add_argument("--colors", type=int, default=256)
    ap.add_argument("--title", default="", help="the text in the title bar (default: from meta.json)")
    ap.add_argument("--allow-problems", action="store_true",
                    help="render even when a screen state has escape debris or a torn console box")
    ap.add_argument("--ignore-sync", action="store_true",
                    help="sample mid-repaint, as a terminal without mode 2026 would (to see what the check catches)")
    args = ap.parse_args()
    if args.ignore_sync:
        Term.view = Term.live_view

    meta = json.load(open(os.path.join(args.take, "meta.json"), encoding="utf-8"))
    rows, cols = int(meta["rows"]), int(meta["columns"])
    capture = open(os.path.join(args.take, "capture.bin"), "rb").read()
    for needle in (b"sk-", b"OPENROUTER_API_KEY", b"TYPESAFE_API_KEY", b"Bearer "):
        if needle in capture:
            raise SystemExit(f"render.py: the capture contains {needle!r}; refusing to render")
    chunks, marks, sends = load_timing(os.path.join(args.take, "timing.jsonl"))

    # The end: the shell's first prompt after the session's own teardown on /exit (bracketed paste
    # off). The prompt coming back is part of the exit, so it is drawn; what follows it (the typed
    # `exit` that ends the recording) is not.
    exit_sent = marks.get("exit-sent")
    if exit_sent is None:
        raise SystemExit("render.py: the take has no exit-sent mark (did the session finish?)")
    exit_off = max(off for t, off, _ in sends if t <= exit_sent + 1)
    teardown = capture.find(b"\x1b[?2004l", exit_off)
    if teardown < 0:
        raise SystemExit("render.py: no teardown after /exit in the capture")
    prompt = re.compile(steps.PROMPT.encode()).search(capture, teardown)
    if prompt is None:
        raise SystemExit("render.py: no shell prompt after the session's teardown in the capture")
    cut_off = prompt.end()
    end_t = next(t for t, off, n in chunks if off + n >= cut_off)

    events = screen_events(capture, chunks, rows, cols, until_off=cut_off)
    # the shell's prompt is the first thing drawn; the picture starts with it on screen
    start_t = max(chunks[0][0], marks["first-key"] - args.lead_in * 1000.0)

    # Every state the screen reached in the shown span is checked, not only the sampled ones, and on
    # the last one the shell's prompt must be below the console box.
    shown_states = [(t, v) for t, v in events if t <= end_t]
    bad = [(t, p) for t, v in shown_states for p in [problems_in(v, cols)] if p]
    last_problems = prompt_problems(shown_states[-1][1], prompt.group(0).decode("utf-8", "replace"))
    if last_problems:
        bad.append((shown_states[-1][0], last_problems))
    for t, p in bad[:20]:
        sys.stderr.write(f"render.py: screen at {t:.0f} ms: {'; '.join(p[:3])}\n")
    if bad and not args.allow_problems:
        raise SystemExit(f"render.py: {len(bad)} of {len(shown_states)} screen states have problems; not rendering")

    step = 1000.0 / args.fps
    times = []
    t = start_t
    while t < end_t:
        times.append(t)
        t += step
    times.append(end_t)

    # consecutive identical screens become one frame; boundaries are rounded to the GIF's 10 ms
    frames_views, bounds = [], []
    for t in times:
        v = view_at(events, t)
        if frames_views and v == frames_views[-1]:
            continue
        frames_views.append(v)
        bounds.append(t - start_t)
    total_ms = end_t - start_t
    durations = []
    for i in range(len(bounds)):
        a = round(bounds[i] / 10.0) * 10
        b = round((bounds[i + 1] if i + 1 < len(bounds) else total_ms) / 10.0) * 10
        durations.append(max(20, b - a))
    durations[-1] += int(round(args.hold * 1000))

    run = next((r for r in meta.get("runs", []) if r.get("steps", 0) > 1), None) or (meta.get("runs") or [{}])[-1]
    title = args.title or (
        f"jevcode · {run.get('model') or 'default model'} via {run.get('provider') or 'default provider'}"
        " · live recording, real time"
    )
    layout = Layout(rows, cols, args.cell_width, args.cell_height, args.scale, title)
    rgb = [layout.frame(v) for v in frames_views]
    # a character no font could draw would be a box in the picture, not what the terminal showed
    if layout.fonts.unknown:
        names = ", ".join(f"U+{ord(c):04X}" for c in sorted(layout.fonts.unknown))
        sys.stderr.write(f"render.py: no font draws {names}\n")
        if not args.allow_problems:
            raise SystemExit("render.py: characters with no glyph; not writing the GIF")

    # one palette for every frame, so an unchanged pixel keeps its index and only the changed
    # rectangle of each frame is stored. Maximum coverage keeps rare colours (an emoji's shading, a
    # status word) apart instead of merging them into the common ones; then each entry is set to
    # the most common colour it stands for, so the background and the text colours are exact.
    picks = sorted(set([0, len(rgb) - 1] + [int(i * (len(rgb) - 1) / 11) for i in range(12)]))
    sheet = Image.new("RGB", (layout.width, layout.height * len(picks)))
    for k, i in enumerate(picks):
        sheet.paste(rgb[i], (0, k * layout.height))
    pal = sheet.quantize(colors=args.colors, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE)
    counts = sheet.getcolors(1 << 24)
    strip = Image.new("RGB", (len(counts), 1))
    strip.putdata([c for _, c in counts])
    commonest: dict = {}
    for (n, c), i in zip(counts, strip.quantize(palette=pal, dither=Image.Dither.NONE).getdata()):
        if i not in commonest or n > commonest[i][0]:
            commonest[i] = (n, c)
    flat = list(pal.getpalette()[: 3 * args.colors])
    for i, (_, c) in commonest.items():
        flat[3 * i: 3 * i + 3] = list(c)
    pal = Image.new("P", (1, 1))
    pal.putpalette(flat)
    quant = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in rgb]
    # what the palette costs, over every pixel of every frame: the share drawn in exactly the colour
    # the terminal had, the largest change in any channel, and the frame with most pixels off by 40+
    errors = [0] * 256
    far = 0
    for f, q in zip(rgb, quant):
        d = ImageChops.difference(f, q.convert("RGB")).split()
        h = ImageChops.lighter(ImageChops.lighter(d[0], d[1]), d[2]).histogram()
        far = max(far, sum(h[40:]))
        errors = [a + b for a, b in zip(errors, h)]
    quant[0].save(args.out, save_all=True, append_images=quant[1:], duration=durations, loop=0,
                  optimize=False, disposal=1)

    poster_t = None
    if args.poster:
        poster_t = marks.get("poster", end_t) - 1.0
        big = Layout(rows, cols, args.cell_width, args.cell_height, args.poster_scale, title)
        still = big.frame(view_at(events, poster_t))
        # the still keeps every colour it was drawn with (a PNG has no palette limit to meet)
        still.save(args.poster, optimize=True)

    size = os.path.getsize(args.out)
    print(json.dumps({
        "gif": args.out, "bytes": size, "mb": round(size / 1e6, 2), "frames": len(quant),
        "size": [layout.width, layout.height], "font": layout.fonts.name, "fontSize": round(layout.fonts.size, 2),
        "dimOpacity": DIM, "sampledFps": args.fps,
        "screenStatesChecked": len(shown_states), "screenStatesWithProblems": len(bad),
        "startMs": round(start_t, 1), "endMs": round(end_t, 1),
        "teardownMs": round(next(t for t, off, n in chunks if off + n > teardown), 1),
        "shownSeconds": round(total_ms / 1000.0, 2), "holdSeconds": args.hold,
        "gifSeconds": round(sum(durations) / 1000.0, 2),
        "paletteExactShare": round(errors[0] / sum(errors), 4),
        "paletteMaxChannelError": max(i for i, n in enumerate(errors) if n),
        "palettePixelsOff40MaxPerFrame": far,
        "poster": args.poster, "posterMs": None if poster_t is None else round(poster_t, 1),
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
