#!/usr/bin/env python3
"""Summarise one take of the README demo into <outdir>/meta.json.

    meta.py <outdir> <exit-code> <started-utc> <rows> <cols> <seed>

Everything here is read from what the take left behind: the session index and the run
directories under <outdir>/.jevcode, the driver's timing file, the capture, and the workspace's
own test result. Nothing is estimated.
"""
from __future__ import annotations

import json
import os
import re
import sys


def lines(path: str) -> int:
    if not os.path.exists(path):
        return 0
    with open(path, encoding="utf-8") as fh:
        return sum(1 for line in fh if line.strip())


def load_marks(path: str) -> tuple[dict[str, float], dict[str, int]]:
    marks: dict[str, float] = {}
    sends: dict[str, int] = {}
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            r = json.loads(raw)
            if r.get("op") == "mark":
                marks[str(r.get("arg"))] = float(r["t"])
            elif r.get("op") == "send" and r.get("arg") == "\r":
                sends[f"enter@{r['t']}"] = int(r["off"])
    return marks, sends


def first_after(capture: bytes, chunks: list[tuple[float, int, int]], offset: int, needle: bytes) -> float | None:
    """Arrival time of the chunk that completes the first `needle` at or past byte `offset`."""
    i = capture.find(needle, offset)
    if i < 0:
        return None
    end = i + len(needle)
    for t, off, n in chunks:
        if off + n >= end:
            return t
    return None


def main() -> int:
    out, code, started, rows, cols, seed = sys.argv[1:7]
    jhome = os.path.join(out, ".jevcode")
    meta: dict = {"exitCode": int(code), "startedAt": started, "rows": int(rows), "columns": int(cols), "seed": int(seed)}
    for name, key in (("loadavg-before.txt", "loadavgBefore"), ("loadavg-after.txt", "loadavgAfter")):
        p = os.path.join(out, name)
        if os.path.exists(p):
            nums = re.findall(r"[0-9]+\.[0-9]+", open(p, encoding="utf-8").read())
            meta[key] = [float(x) for x in nums[:3]]

    runs = []
    idx = os.path.join(jhome, "sessions", "index.jsonl")
    if os.path.exists(idx):
        starts = {}
        for raw in open(idx, encoding="utf-8"):
            r = json.loads(raw)
            if r.get("kind") == "run:start":
                starts[r["runId"]] = r
            elif r.get("kind") == "run:end":
                rid = r["runId"]
                rdir = os.path.join(jhome, "runs", rid)
                run_json = os.path.join(rdir, "run.json")
                model = provider = None
                if os.path.exists(run_json):
                    cfg = json.load(open(run_json, encoding="utf-8")).get("config", {})
                    model = cfg.get("generator.model", {}).get("value")
                    provider = cfg.get("generator.provider", {}).get("value")
                cost = r.get("costUsd") or {}
                runs.append({
                    "runId": rid,
                    "task": starts.get(rid, {}).get("task60"),
                    "mode": starts.get(rid, {}).get("mode"),
                    "provider": provider,
                    "model": model,
                    "stopReason": r.get("stopReason"),
                    "steps": r.get("steps"),
                    "modelTurns": lines(os.path.join(rdir, "generator.jsonl")),
                    "jevRequests": lines(os.path.join(rdir, "jev.jsonl")),
                    "wallMs": r.get("wallMs"),
                    "costUsd": cost,
                    "costTotalUsd": round(sum(float(v) for v in cost.values()), 6),
                    "changedFiles": r.get("changedFiles"),
                })
    meta["runs"] = runs
    meta["sessionCostUsd"] = round(sum(r["costTotalUsd"] for r in runs), 6)

    timing = os.path.join(out, "timing.jsonl")
    capture_path = os.path.join(out, "capture.bin")
    if os.path.exists(timing) and os.path.exists(capture_path):
        marks, _ = load_marks(timing)
        meta["marksMs"] = marks
        capture = open(capture_path, "rb").read()
        chunks = []
        send_off = {}
        for raw in open(timing, encoding="utf-8"):
            r = json.loads(raw)
            if r.get("op") == "chunk":
                chunks.append((float(r["t"]), int(r["off"]), int(r["n"])))
            elif r.get("op") == "send" and r.get("arg") == "\r":
                send_off[float(r["t"])] = int(r["off"])
        # Enter on `hi` -> the first text of the reply on screen, as the terminal received it.
        hi_t = marks.get("hi-sent")
        if hi_t is not None:
            enter_t = max((t for t in send_off if t <= hi_t + 1), default=None)
            if enter_t is not None:
                shown = first_after(capture, chunks, send_off[enter_t], b"[jevcode]")
                if shown is not None:
                    meta["hiFirstTextMs"] = round(shown - enter_t, 1)
        if "task-sent" in marks and "run-end" in marks:
            meta["taskEnterToFinishedMs"] = round(marks["run-end"] - marks["task-sent"], 1)
        meta["sessionMs"] = round(chunks[-1][0], 1) if chunks else None

    oracle = os.path.join(out, "oracle.txt")
    if os.path.exists(oracle):
        text = open(oracle, encoding="utf-8").read().strip()
        meta["oracle"] = text.splitlines()[-1] if text else ""
        m = re.search(r"(\d+) passed", text)
        meta["oraclePassed"] = bool(m) and "failed" not in text and "error" not in text.lower()

    json.dump(meta, open(os.path.join(out, "meta.json"), "w", encoding="utf-8"), indent=1)
    print(json.dumps(meta, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
