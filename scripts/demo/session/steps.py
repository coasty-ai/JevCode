#!/usr/bin/env python3
"""Write the keystroke plan for the README demo session (perf/drivers/pty_type.py steps).

    steps.py [--seed N] > steps.json

The scene: at a shell prompt, type `jevcode`; say `hi` and wait for the reply; ask it to
`fix the failing tests` and wait for the run to finish; type `/exit`; leave the shell.

Keys go in one at a time at a human pace: a base delay plus a jitter drawn from a seeded
generator, so two recordings with the same seed type identically and nothing depends on the
machine's clock. Every wait for the program is an `expect` on what the program itself printed,
never a fixed sleep, so a slow reply is recorded as slow and a fast one as fast. The only
sleeps are the typist's own pauses: between keys, before Enter, and while a person would be
reading the screen.
"""
from __future__ import annotations

import argparse
import json
import random
import sys

# A run ended when its finished line reached the terminal (src/tui/plain.ts RUN_END_PATTERN),
# with an SGR run allowed between the words.
SGR = r"(?:\x1b\[[0-9;]*m)*"
DOT = r"(?:·|-)"
SEP = rf"{SGR} {SGR}{DOT}{SGR} {SGR}"
RUN_END = rf"finished{SEP}[a-z_]+{SEP}[0-9]+ steps"
# The idle composer's placeholder after a reply or a run (src/tui/composer/Composer.tsx).
IDLE = r"Follow-up, question"
# The console is attached once the session meter is in the status row (test/pty/helpers.ts).
ATTACHED = r"sess \$"
# The session puts the terminal back on exit: bracketed paste off (src/tui restoreTerminal).
TEARDOWN = r"\x1b\[\?2004l"
PROMPT = r"demo-py \$ "


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--hi", default="hi")
    ap.add_argument("--task", default="fix the failing tests")
    ap.add_argument("--reply-timeout-ms", type=int, default=60_000)
    ap.add_argument("--run-timeout-ms", type=int, default=180_000)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    steps: list[dict] = []

    def sleep(ms: float) -> None:
        steps.append({"op": "sleep", "ms": int(round(ms))})

    def mark(label: str) -> None:
        steps.append({"op": "mark", "label": label})

    def expect(pattern: str, timeout_ms: int = 20_000) -> None:
        steps.append({"op": "expect", "pattern": pattern, "timeoutMs": timeout_ms})

    def type_text(text: str) -> None:
        """One key at a time: 70-140 ms apart, a little longer after a space."""
        for i, ch in enumerate(text):
            steps.append({"op": "send", "text": ch})
            if i < len(text) - 1:
                sleep(70 + rng.random() * 70 + (45 if ch == " " else 0))

    def enter(pause_ms: float) -> None:
        sleep(pause_ms)
        steps.append({"op": "send", "text": "\r"})

    expect(PROMPT)
    sleep(700)
    mark("first-key")
    type_text("jevcode")
    enter(380)
    mark("launched")
    expect(ATTACHED)
    sleep(1300)

    type_text(args.hi)
    enter(420)
    mark("hi-sent")
    expect(IDLE, args.reply_timeout_ms)
    mark("hi-answered")
    sleep(1500)

    type_text(args.task)
    enter(450)
    mark("task-sent")
    expect(RUN_END, args.run_timeout_ms)
    mark("run-end")
    expect(IDLE, 20_000)
    mark("run-idle")
    sleep(3200)

    mark("poster")
    type_text("/exit")
    enter(650)
    mark("exit-sent")
    expect(TEARDOWN, 20_000)
    mark("exited")
    expect(PROMPT, 10_000)
    sleep(300)
    steps.append({"op": "send", "text": "exit\r"})
    steps.append({"op": "eof", "timeoutMs": 10_000})

    json.dump(steps, sys.stdout, indent=1)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
