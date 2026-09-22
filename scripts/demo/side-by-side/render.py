#!/usr/bin/env python3
"""Render two pseudo-terminal captures side by side as an animated GIF.

    render.py <left-dir> <right-dir> --out <gif> [--poster <png>] [options]

Each directory is one `record.sh` run: `capture.bin` (the bytes the terminal received),
`timing.jsonl` (when each byte arrived) and `meta.json` (what the run did). The two panes both
start at their own t = 0 and replay at real speed divided by one shared factor, so the width of
the two bars is the measured difference and nothing else.

There is a small terminal emulator in here (`Screen`) because the capture is a byte stream, not
a list of pictures: the bytes have to be replayed through a screen to know what the terminal
showed at a given moment. It covers what the interface actually emits - cursor moves, line and
screen erases, scrolling, and SGR colour including the 256-colour and 24-bit forms.

Requires Pillow. Menlo is used when present (macOS); otherwise the built-in bitmap font.
"""
from __future__ import annotations

import argparse
import bisect
import codecs
import json
import math
import os
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from typing import Sequence

from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------------------
# colours
# --------------------------------------------------------------------------------------

BG = (13, 17, 23)
FG = (201, 209, 217)
PANEL = (22, 27, 34)
RULE = (48, 54, 61)
LABEL = (139, 148, 158)
GREEN = (63, 185, 80)
AMBER = (210, 153, 34)

ANSI16 = [
    (0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16),
    (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
    (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67),
    (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255),
]


def xterm256() -> list[tuple[int, int, int]]:
    table = list(ANSI16)
    levels = (0, 95, 135, 175, 215, 255)
    for r in levels:
        for g in levels:
            for b in levels:
                table.append((r, g, b))
    for i in range(24):
        v = 8 + i * 10
        table.append((v, v, v))
    return table


XTERM = xterm256()


def blend(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))  # type: ignore[return-value]


# --------------------------------------------------------------------------------------
# terminal
# --------------------------------------------------------------------------------------


@dataclass
class Pen:
    fg: tuple[int, int, int] | None = None
    bg: tuple[int, int, int] | None = None
    bold: bool = False
    dim: bool = False
    inverse: bool = False


BLANK = (" ", None, None, False, False, False)

CSI_RE = re.compile(r"\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])")


@dataclass
class Screen:
    rows: int
    cols: int
    grid: list[list[tuple]] = field(default_factory=list)
    row: int = 0
    col: int = 0
    pen: Pen = field(default_factory=Pen)
    saved: tuple[int, int] = (0, 0)
    pending: str = ""

    def __post_init__(self) -> None:
        self.grid = [[BLANK] * self.cols for _ in range(self.rows)]

    # -- helpers ------------------------------------------------------------------
    def cell(self) -> tuple:
        p = self.pen
        return (" ", p.fg, p.bg, p.bold, p.dim, p.inverse)

    def blank_row(self) -> list[tuple]:
        return [BLANK] * self.cols

    def scroll_up(self, n: int = 1) -> None:
        for _ in range(n):
            self.grid.pop(0)
            self.grid.append(self.blank_row())

    def index(self) -> None:
        if self.row >= self.rows - 1:
            self.scroll_up()
            self.row = self.rows - 1
        else:
            self.row += 1

    def put(self, ch: str) -> None:
        w = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if self.col + w > self.cols:
            self.col = 0
            self.index()
        p = self.pen
        self.grid[self.row][self.col] = (ch, p.fg, p.bg, p.bold, p.dim, p.inverse)
        if w == 2 and self.col + 1 < self.cols:
            self.grid[self.row][self.col + 1] = ("", p.fg, p.bg, p.bold, p.dim, p.inverse)
        self.col += w

    # -- SGR ----------------------------------------------------------------------
    def sgr(self, params: list[int]) -> None:
        i = 0
        if not params:
            params = [0]
        while i < len(params):
            n = params[i]
            if n == 0:
                self.pen = Pen()
            elif n == 1:
                self.pen.bold = True
            elif n == 2:
                self.pen.dim = True
            elif n == 7:
                self.pen.inverse = True
            elif n == 22:
                self.pen.bold = False
                self.pen.dim = False
            elif n == 27:
                self.pen.inverse = False
            elif 30 <= n <= 37:
                self.pen.fg = ANSI16[n - 30]
            elif n == 39:
                self.pen.fg = None
            elif 40 <= n <= 47:
                self.pen.bg = ANSI16[n - 40]
            elif n == 49:
                self.pen.bg = None
            elif 90 <= n <= 97:
                self.pen.fg = ANSI16[n - 90 + 8]
            elif 100 <= n <= 107:
                self.pen.bg = ANSI16[n - 100 + 8]
            elif n in (38, 48):
                target = "fg" if n == 38 else "bg"
                if i + 1 < len(params) and params[i + 1] == 5 and i + 2 < len(params):
                    setattr(self.pen, target, XTERM[params[i + 2] % 256])
                    i += 2
                elif i + 1 < len(params) and params[i + 1] == 2 and i + 4 < len(params):
                    setattr(self.pen, target, (params[i + 2] & 255, params[i + 3] & 255, params[i + 4] & 255))
                    i += 4
            i += 1

    # -- feed ---------------------------------------------------------------------
    def feed(self, text: str) -> None:
        s = self.pending + text
        self.pending = ""
        i = 0
        n = len(s)
        while i < n:
            ch = s[i]
            if ch == "\x1b":
                if i + 1 >= n:
                    self.pending = s[i:]
                    return
                nxt = s[i + 1]
                if nxt == "[":
                    m = CSI_RE.match(s, i)
                    if not m:
                        if n - i < 32:
                            self.pending = s[i:]
                            return
                        i += 1
                        continue
                    self.csi(m.group(1), m.group(3))
                    i = m.end()
                    continue
                if nxt == "]":
                    end = s.find("\x07", i)
                    st = s.find("\x1b\\", i)
                    if end < 0 and st < 0:
                        self.pending = s[i:]
                        return
                    cut = min(x for x in (end + 1 if end >= 0 else 1 << 30, st + 2 if st >= 0 else 1 << 30))
                    i = cut
                    continue
                if nxt in "()#*+":
                    if i + 2 >= n:
                        self.pending = s[i:]
                        return
                    i += 3
                    continue
                if nxt == "7":
                    self.saved = (self.row, self.col)
                elif nxt == "8":
                    self.row, self.col = self.saved
                elif nxt == "D":
                    self.index()
                elif nxt == "E":
                    self.col = 0
                    self.index()
                elif nxt == "M":
                    if self.row == 0:
                        self.grid.pop()
                        self.grid.insert(0, self.blank_row())
                    else:
                        self.row -= 1
                elif nxt == "c":
                    self.__post_init__()
                    self.row = self.col = 0
                    self.pen = Pen()
                i += 2
                continue
            if ch == "\r":
                self.col = 0
            elif ch == "\n":
                self.index()
            elif ch == "\b":
                self.col = max(0, self.col - 1)
            elif ch == "\t":
                self.col = min(self.cols - 1, (self.col // 8 + 1) * 8)
            elif ch in ("\x07", "\x00"):
                pass
            elif ch in ("\x0b", "\x0c"):
                self.index()
            else:
                self.put(ch)
            i += 1

    def csi(self, raw: str, final: str) -> None:
        priv = raw.startswith("?") or raw.startswith("<") or raw.startswith(">") or raw.startswith("=")
        body = raw[1:] if priv else raw
        params = [int(x) if x.isdigit() else 0 for x in body.split(";")] if body else []

        def p(idx: int, default: int = 1) -> int:
            if idx < len(params) and params[idx] > 0:
                return params[idx]
            return default

        if priv:
            return  # DECSET/DECRST: cursor visibility, bracketed paste, synchronized output
        if final == "m":
            self.sgr(params)
        elif final == "A":
            self.row = max(0, self.row - p(0))
        elif final == "B":
            self.row = min(self.rows - 1, self.row + p(0))
        elif final == "C":
            self.col = min(self.cols - 1, self.col + p(0))
        elif final == "D":
            self.col = max(0, self.col - p(0))
        elif final == "E":
            self.row = min(self.rows - 1, self.row + p(0))
            self.col = 0
        elif final == "F":
            self.row = max(0, self.row - p(0))
            self.col = 0
        elif final == "G" or final == "`":
            self.col = min(self.cols - 1, p(0) - 1)
        elif final in ("H", "f"):
            self.row = min(self.rows - 1, p(0) - 1)
            self.col = min(self.cols - 1, p(1) - 1)
        elif final == "J":
            mode = params[0] if params else 0
            if mode == 0:
                for c in range(self.col, self.cols):
                    self.grid[self.row][c] = self.cell()
                for r in range(self.row + 1, self.rows):
                    self.grid[r] = self.blank_row()
            elif mode == 1:
                for c in range(0, min(self.col + 1, self.cols)):
                    self.grid[self.row][c] = self.cell()
                for r in range(0, self.row):
                    self.grid[r] = self.blank_row()
            elif mode in (2, 3):
                self.grid = [self.blank_row() for _ in range(self.rows)]
        elif final == "K":
            mode = params[0] if params else 0
            if mode == 0:
                for c in range(self.col, self.cols):
                    self.grid[self.row][c] = self.cell()
            elif mode == 1:
                for c in range(0, min(self.col + 1, self.cols)):
                    self.grid[self.row][c] = self.cell()
            else:
                self.grid[self.row] = self.blank_row()
        elif final == "L":
            for _ in range(p(0)):
                self.grid.insert(self.row, self.blank_row())
                self.grid.pop()
        elif final == "M":
            for _ in range(p(0)):
                self.grid.pop(self.row)
                self.grid.append(self.blank_row())
        elif final == "P":
            k = p(0)
            row = self.grid[self.row]
            del row[self.col:self.col + k]
            row.extend([BLANK] * k)
        elif final == "@":
            k = p(0)
            row = self.grid[self.row]
            for _ in range(k):
                row.insert(self.col, BLANK)
            del row[self.cols:]
        elif final == "X":
            for c in range(self.col, min(self.cols, self.col + p(0))):
                self.grid[self.row][c] = self.cell()
        elif final == "S":
            self.scroll_up(p(0))
        elif final == "T":
            for _ in range(p(0)):
                self.grid.pop()
                self.grid.insert(0, self.blank_row())
        elif final == "s":
            self.saved = (self.row, self.col)
        elif final == "u":
            self.row, self.col = self.saved

    def snapshot(self) -> list[list[tuple]]:
        return [row[:] for row in self.grid]


# --------------------------------------------------------------------------------------
# replay
# --------------------------------------------------------------------------------------


def load_chunks(path: str) -> tuple[list[tuple[float, int, int]], dict[str, float]]:
    chunks: list[tuple[float, int, int]] = []
    marks: dict[str, float] = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r.get("op") == "chunk":
                chunks.append((float(r["t"]), int(r["off"]), int(r["n"])))
            elif r.get("op") == "mark":
                marks[str(r.get("arg", ""))] = float(r["t"])
            elif r.get("op") == "expect" and "run-end" not in marks:
                marks.setdefault("expect", float(r["t"]))
    return chunks, marks


def finish_time(chunks: Sequence[tuple[float, int, int]], marks: dict[str, float]) -> float:
    """When the run's last line reached the terminal."""
    return marks.get("run-end") or marks.get("expect") or (chunks[-1][0] if chunks else 0.0)


# What the session writes while it puts the terminal back: the cursor and bracketed-paste
# resets, then the plain-text summary. The pane freezes on the frame just before all that.
TEARDOWN = (b"jevcode: stopped", b"\x1b[?2004l")


def freeze_time(capture: bytes, chunks: Sequence[tuple[float, int, int]], finish: float) -> float:
    """The moment to hold: the last full interface repaint, before the session tears down."""
    last = finish
    for t, off, n in chunks:
        if t < finish:
            continue
        body = capture[off:off + n]
        if any(marker in body for marker in TEARDOWN):
            break
        last = t
    return last + 0.05


def replay(capture: bytes, chunks: Sequence[tuple[float, int, int]], rows: int, cols: int,
           times_ms: Sequence[float]) -> list[list[list[tuple]]]:
    """The screen as it stood at each time in `times_ms` (must be sorted, ms since spawn)."""
    screen = Screen(rows, cols)
    dec = codecs.getincrementaldecoder("utf-8")("replace")
    out: list[list[list[tuple]]] = []
    want = 0
    for t, off, n in chunks:
        while want < len(times_ms) and times_ms[want] < t:
            out.append(screen.snapshot())
            want += 1
        screen.feed(dec.decode(capture[off:off + n]))
    last = screen.snapshot()
    while want < len(times_ms):
        out.append(last)
        want += 1
    return out


# --------------------------------------------------------------------------------------
# drawing
# --------------------------------------------------------------------------------------


def load_font(size: int, index: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"):
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size, index=index)
            except OSError:
                try:
                    return ImageFont.truetype(path, size)
                except OSError:
                    continue
    return ImageFont.load_default()


@dataclass
class Pane:
    name: str
    subtitle: str
    grids: list[list[list[tuple]]]
    #: when the run's last line was printed - what the clock and the badge report
    finish_ms: float
    #: index of the held frame in `grids` (the last repaint before the session tore down)
    finish_idx: int
    badge: str
    badge_colour: tuple[int, int, int]


def draw_grid(img: ImageDraw.ImageDraw, grid: list[list[tuple]], x0: int, y0: int,
              cw: int, ch: int, regular, bold) -> None:
    for r, row in enumerate(grid):
        y = y0 + r * ch
        c = 0
        n = len(row)
        while c < n:
            cell = row[c]
            if cell[0] == "" or (cell[0] == " " and cell[2] is None):
                c += 1
                continue
            key = cell[1:]
            run = [cell[0]]
            c2 = c + 1
            while c2 < n and row[c2][1:] == key and row[c2][0] != "":
                run.append(row[c2][0])
                c2 += 1
            fg, bg, is_bold, is_dim, inverse = key
            fgc = fg or FG
            bgc = bg or BG
            if inverse:
                fgc, bgc = bgc, fgc
            if is_dim:
                fgc = blend(bgc, fgc, 0.55)
            text = "".join(run)
            if bgc != BG:
                img.rectangle([x0 + c * cw, y, x0 + c2 * cw - 1, y + ch - 1], fill=bgc)
            if text.strip():
                img.text((x0 + c * cw, y), text, font=(bold if is_bold else regular), fill=fgc)
            c = c2


def compose(panes: Sequence[Pane], idx: int, t_ms: float, cols: int, rows: int,
            cw: int, ch: int, fonts: dict, caption: str) -> Image.Image:
    regular, bold, ui, ui_bold, ui_small = (fonts["regular"], fonts["bold"], fonts["ui"],
                                            fonts["ui_bold"], fonts["ui_small"])
    pane_w = cols * cw
    pane_h = rows * ch
    pad = 14
    gap = 18
    head = 46
    foot = 30
    cap_h = 26
    width = pad * 2 + pane_w * 2 + gap
    height = pad + head + pane_h + foot + cap_h + pad // 2
    im = Image.new("RGB", (width, height), BG)
    d = ImageDraw.Draw(im)
    for i, pane in enumerate(panes):
        x0 = pad + i * (pane_w + gap)
        y_head = pad
        d.text((x0, y_head), pane.name, font=ui_bold, fill=FG)
        d.text((x0, y_head + 17), pane.subtitle, font=ui_small, fill=LABEL)
        y0 = pad + head
        d.rectangle([x0 - 4, y0 - 4, x0 + pane_w + 3, y0 + pane_h + 3], fill=PANEL, outline=RULE)
        # Past its own finish a pane holds the screen it finished on; the other keeps moving.
        draw_grid(d, pane.grids[min(idx, pane.finish_idx)], x0, y0, cw, ch, regular, bold)
        shown = min(t_ms, pane.finish_ms)
        y_foot = y0 + pane_h + 9
        d.text((x0, y_foot), f"{shown / 1000:6.1f} s", font=ui, fill=LABEL)
        if t_ms >= pane.finish_ms and pane.badge:
            bx = x0 + 70
            bw = int(d.textlength(pane.badge, font=ui_bold)) + 16
            d.rounded_rectangle([bx, y_foot - 3, bx + bw, y_foot + 16], radius=4,
                                fill=blend(BG, pane.badge_colour, 0.18), outline=pane.badge_colour)
            d.text((bx + 8, y_foot), pane.badge, font=ui_bold, fill=pane.badge_colour)
    d.text((pad, height - cap_h - 2), caption, font=ui_small, fill=LABEL)
    return im


# --------------------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------------------


def pane_from(dirpath: str, times: Sequence[float], rows: int, cols: int,
              name: str, subtitle: str) -> tuple[Pane, dict]:
    meta = json.load(open(os.path.join(dirpath, "meta.json"), encoding="utf-8"))
    capture = open(os.path.join(dirpath, "capture.bin"), "rb").read()
    if b"sk-" in capture:
        raise SystemExit(f"{dirpath}: the capture contains 'sk-'; refusing to render")
    chunks, marks = load_chunks(os.path.join(dirpath, "timing.jsonl"))
    finish = finish_time(chunks, marks)
    # One extra sample at the held moment: the session exits within about 50 ms of printing its
    # last line, so the frame the pane freezes on has to be taken then and not at the next tick
    # of the shared clock. Display frame i then reads grid min(i, finish_idx).
    held = freeze_time(capture, chunks, finish)
    finish_idx = bisect.bisect_left(list(times), held)
    sample = list(times[:finish_idx]) + [held] + list(times[finish_idx:])
    grids = replay(capture, chunks, rows, cols, sample)
    # "solved" is the task's own test oracle, not the stop reason the engine wrote down.
    solved = bool(meta.get("oraclePassed"))
    cost = sum(float(v) for v in (meta.get("costUsd") or {}).values())
    verb = "solved" if solved else str(meta.get("stopReason", "stopped")).replace("_", " ")
    badge = f"{verb} · {finish / 1000:.0f} s · ${cost:.4f}"
    return Pane(name, subtitle, grids, finish, finish_idx, badge, GREEN if solved else AMBER), meta


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("left")
    ap.add_argument("right")
    ap.add_argument("--out", required=True)
    ap.add_argument("--poster")
    ap.add_argument("--poster-width", type=int, default=1200)
    ap.add_argument("--factor", type=float, default=6.0, help="real seconds per displayed second")
    ap.add_argument("--fps", type=int, default=10)
    ap.add_argument("--font-size", type=int, default=10)
    ap.add_argument("--cell-width", type=int, default=6)
    ap.add_argument("--cell-height", type=int, default=13)
    ap.add_argument("--hold", type=float, default=2.0, help="seconds of still frame at the end")
    ap.add_argument("--colors", type=int, default=64)
    ap.add_argument("--left-name", default="jevcode  (default mode)")
    ap.add_argument("--right-name", default="jevcode --mode jev-off")
    ap.add_argument("--left-sub", default="the model proposes, the tests verify, Jev decides")
    ap.add_argument("--right-sub", default="the model decides every step on its own")
    ap.add_argument("--caption", default="")
    args = ap.parse_args()

    lmeta = json.load(open(os.path.join(args.left, "meta.json"), encoding="utf-8"))
    rows, cols = int(lmeta.get("rows", 30)), int(lmeta.get("columns", 100))

    def held_of(d: str) -> float:
        """The last moment either pane needs a sample for, so the shared clock reaches it."""
        capture = open(os.path.join(d, "capture.bin"), "rb").read()
        chunks, marks = load_chunks(os.path.join(d, "timing.jsonl"))
        return freeze_time(capture, chunks, finish_time(chunks, marks))

    span = max(held_of(args.left), held_of(args.right))
    step_ms = 1000.0 / args.fps
    n_frames = math.ceil(span / (args.factor * step_ms)) + 1
    times = [i * step_ms * args.factor for i in range(n_frames)]

    left, lm = pane_from(args.left, times, rows, cols, args.left_name, args.left_sub)
    right, rm = pane_from(args.right, times, rows, cols, args.right_name, args.right_sub)

    caption = args.caption or (
        f"QuixBugs {lmeta.get('task', '')} · one live run each, same model and same machine, "
        f"one after the other · replayed at 1/{args.factor:g} real speed · "
        "the clock counts seconds from launch"
    )
    fonts = {
        "regular": load_font(args.font_size, 0),
        "bold": load_font(args.font_size, 1),
        "ui": load_font(args.font_size + 1, 0),
        "ui_bold": load_font(args.font_size + 1, 1),
        "ui_small": load_font(args.font_size, 0),
    }

    frames: list[Image.Image] = []
    for i, t in enumerate(times):
        frames.append(compose([left, right], i, t, cols, rows, args.cell_width,
                              args.cell_height, fonts, caption))
    for _ in range(int(args.hold * args.fps)):
        frames.append(frames[-1])

    # One palette for every frame: sampled from a mid-run frame and the last one, so the
    # colours that appear late (the finished line, the badge) are in it.
    pal = Image.new("RGB", (frames[0].width, frames[0].height * 2))
    pal.paste(frames[min(len(frames) - 1, int(len(frames) * 0.35))], (0, 0))
    pal.paste(frames[-1], (0, frames[0].height))
    pal_img = pal.quantize(colors=args.colors, method=Image.Quantize.MEDIANCUT)

    quant = [f.quantize(palette=pal_img, dither=Image.Dither.NONE) for f in frames]
    quant[0].save(args.out, save_all=True, append_images=quant[1:],
                  duration=int(round(1000 / args.fps)), loop=0, optimize=True, disposal=1)

    if args.poster:
        # A still of the last frame at a fixed width, quantised so the file stays small.
        poster = frames[-1]
        w = args.poster_width
        h = int(round(poster.height * w / poster.width))
        small = poster.resize((w, h), Image.LANCZOS)
        small.quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(args.poster, optimize=True)

    size = os.path.getsize(args.out)
    print(json.dumps({
        "gif": args.out, "bytes": size, "mb": round(size / 1e6, 2),
        "frames": len(quant), "fps": args.fps, "factor": args.factor,
        "size": [frames[0].width, frames[0].height],
        "leftFinishMs": left.finish_ms, "rightFinishMs": right.finish_ms,
        "left": {k: lm.get(k) for k in ("runId", "stopReason", "steps", "wallMs", "costUsd")},
        "right": {k: rm.get(k) for k in ("runId", "stopReason", "steps", "wallMs", "costUsd")},
    }, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
