#!/usr/bin/env python3
"""Timestamped pseudo-TTY typist for the perf probes (TUI-DESIGN §18; src/perf/pty.ts `typist()`).

    pty_type.py <steps.json> <capture.bin> <timing.jsonl> -- <command> [args...]

Environment: PTY_ROWS / PTY_COLS set the geometry (default 24x80) — applied to the slave before the child execs, so the
first frame already has it; TERM defaults to xterm-256color when unset.

Why this exists next to scripts/pty/drive.exp: expect's `sleep` step drains the pty with `expect -timeout 0` once every
25 ms, and a Node child writes to a TTY synchronously, so a chatty child blocks in `write()` until the next drain —
measured 2026-09-21 at 40x120 on a live mocked run: 11 steps in 12 s and event-loop lag p50 114 ms during a drive.exp
`sleep`, versus 399 steps in 11 s and lag p50 1.1 ms during a blocking `expect` over the same run. This driver reads
the master continuously in a `select` loop (also while sleeping and while waiting for a pattern), so the child never
blocks on the terminal, and it records the arrival time of every chunk, so a frame's time is the time of the chunk that
completed it — no pattern-matching heuristics are needed to timestamp frames.

<steps.json>: a JSON array of objects:
  {"op":"expect","pattern":<python bytes regex>,"timeoutMs":N}   wait until the unconsumed output matches; consumes
                                                                 through the match; a timeout sends Ctrl-C twice and
                                                                 ends the run with exit 124
  {"op":"send","text":"..."}                                     write to the pty (the text is sent verbatim)
  {"op":"sleep","ms":N}                                          pause while draining the pty; the pause ends within
                                                                 0.1 ms of its deadline (see drain_for)
  {"op":"resize","rows":R,"columns":C}                           TIOCSWINSZ on the master: the kernel delivers SIGWINCH
  {"op":"mark","label":"..."}                                    a timestamp only
  {"op":"eof","timeoutMs":N}                                     wait for the child to exit

<timing.jsonl>: one line per completed step {"t":<ms since spawn, 0.1 ms resolution>,"step":n,"op":...,"arg":...}
("expect" records the arrival time of the chunk that completed the match; "send" and "resize" carry "off", the capture
byte offset at the moment of the write / the TIOCSWINSZ — every frame at or past that offset was written after it),
plus one line per read {"t":ms,"op":"chunk","off":<byte offset>,"n":<bytes>}.
The first line is the clock bridge {"t":ms,"op":"clock","step":0,"arg":"CLOCK_MONOTONIC_RAW","raw_ns":"N","raw_err_ns":E}:
the driver's "t" and CLOCK_MONOTONIC_RAW nanoseconds read at one instant (the midpoint of two raw reads bracketing the
monotonic read, as a decimal STRING: nanoseconds since boot pass 2^53 after ~104 days of uptime, beyond what a JSON
number keeps exactly; "raw_err_ns" is the bracket's width). On macOS that clock shares its base with Node's
`process.hrtime.bigint()` (measured 2026-09-23: three Python reads bracketed a Node read in every trial, while
`time.monotonic_ns()` differs from it by ~1.8e9 s), so a timestamp the child takes with hrtime maps onto this timeline as
t + (ns - raw_ns) / 1e6 — `src/perf/pty.ts` `toDriverMs`, used by the stream probe to line a streamed delta's emission
up with the frames that paint it. Where the clock is missing, "arg" is "unavailable" and no raw fields are written.
The child's exit code is the driver's exit code (128+n for a signal death); 124 = an expect step timed out.
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 5 or argv[3] != '--':
        sys.stderr.write(__doc__)
        return 2
    steps_file, capture_file, timing_file = argv[0], argv[1], argv[2]
    cmd = argv[4:]
    rows = int(os.environ.get('PTY_ROWS', '24'))
    cols = int(os.environ.get('PTY_COLS', '80'))
    with open(steps_file, 'r', encoding='utf-8') as fh:
        steps = json.load(fh)
    if 'TERM' not in os.environ or os.environ['TERM'] == '':
        os.environ['TERM'] = 'xterm-256color'

    pid, fd = pty.fork()
    if pid == 0:
        # child: the slave is fd 0/1/2; set the geometry before exec so the first frame already has it
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        try:
            os.execvp(cmd[0], cmd)
        except OSError as e:  # pragma: no cover - exec failure
            os.write(2, f'pty_type: exec failed: {e}\n'.encode())
            os._exit(127)

    t0 = time.monotonic()
    cap = open(capture_file, 'wb')
    tim = open(timing_file, 'w', encoding='utf-8')
    buf = bytearray()
    raw_clock = getattr(time, 'CLOCK_MONOTONIC_RAW', None)
    if raw_clock is not None:
        raw_a = time.clock_gettime_ns(raw_clock)
        mono = time.monotonic()
        raw_b = time.clock_gettime_ns(raw_clock)
        bridge = {'t': round((mono - t0) * 1000.0, 3), 'op': 'clock', 'step': 0, 'arg': 'CLOCK_MONOTONIC_RAW', 'raw_ns': str((raw_a + raw_b) // 2), 'raw_err_ns': raw_b - raw_a}
    else:  # pragma: no cover - every supported platform has it
        bridge = {'t': 0.0, 'op': 'clock', 'step': 0, 'arg': 'unavailable'}
    tim.write(json.dumps(bridge) + '\n')
    state = {'consumed': 0, 'total': 0, 'eof': False, 'last_chunk_t': 0.0, 'timed_out': False}

    def now() -> float:
        return round((time.monotonic() - t0) * 1000.0, 1)

    def record(step: int, op: str, arg: str, extra=None) -> None:
        rec = {'t': now(), 'step': step, 'op': op, 'arg': arg}
        if extra:
            rec.update(extra)
        tim.write(json.dumps(rec) + '\n')
        tim.flush()

    def pump(timeout: float) -> bool:
        """Read what the child wrote, waiting up to `timeout` seconds; False when nothing arrived or on EOF."""
        if state['eof']:
            return False
        try:
            ready, _, _ = select.select([fd], [], [], max(0.0, timeout))
        except InterruptedError:
            return False
        if fd not in ready:
            return False
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b''
        if not data:
            state['eof'] = True
            return False
        t = now()
        state['last_chunk_t'] = t
        buf.extend(data)
        cap.write(data)
        cap.flush()
        tim.write(json.dumps({'t': t, 'op': 'chunk', 'off': state['total'], 'n': len(data)}) + '\n')
        state['total'] += len(data)
        return True

    def drain_for(seconds: float) -> None:
        """Drain the pty until the deadline, honouring it to 0.1 ms.

        macOS coalesces timers: a single `select`/`sleep` of 30 ms returns after ~38 ms and one of 100 ms after ~109 ms
        (measured 2026-09-21, 20 samples each; 2 ms → 3 ms, 1 ms → 1.5 ms), which made a requested 30 ms send cadence
        run at 37 ms (27 keys/s, below Ink's maxFps 30 — the burst series then exercised nothing). Waiting in slices
        of at most 2 ms and polling (timeout 0) for the last millisecond lands the deadline within 0.1 ms (measured
        30.00 / 100.01 ms mean over 30 samples) while the pty keeps being drained.
        """
        deadline = time.monotonic() + seconds
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                return
            pump(min(left - 0.001, 0.002) if left > 0.003 else 0.0)
            if state['eof']:
                return

    def alive() -> bool:
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return False
        return wpid == 0

    def interrupt_twice() -> None:
        try:
            os.write(fd, b'\x03')
            drain_for(0.5)
            os.write(fd, b'\x03')
        except OSError:
            pass

    n = 0
    for step in steps:
        n += 1
        op = step.get('op')
        if op == 'expect':
            pattern = re.compile(str(step['pattern']).encode('utf-8'), re.DOTALL)
            timeout_s = float(step.get('timeoutMs', 60000)) / 1000.0
            deadline = time.monotonic() + timeout_s
            matched = False
            while True:
                m = pattern.search(bytes(buf[state['consumed']:]))
                if m:
                    state['consumed'] += m.end()
                    rec = {'t': state['last_chunk_t'], 'step': n, 'op': 'expect', 'arg': step['pattern']}
                    tim.write(json.dumps(rec) + '\n')
                    tim.flush()
                    matched = True
                    break
                if state['eof']:
                    record(n, 'eof-before-match', str(step['pattern']))
                    break
                left = deadline - time.monotonic()
                if left <= 0:
                    record(n, 'timeout', str(step['pattern']))
                    state['timed_out'] = True
                    interrupt_twice()
                    break
                pump(min(left, 0.25))
            if not matched:
                break
        elif op == 'send':
            text = str(step['text']).encode('utf-8')
            off = state['total']
            try:
                os.write(fd, text)
            except OSError:
                record(n, 'send-failed', str(step['text']))
                break
            record(n, 'send', str(step['text']), {'off': off})
        elif op == 'sleep':
            drain_for(float(step['ms']) / 1000.0)
            record(n, 'sleep', str(step['ms']))
            if state['eof']:
                record(n, 'eof-during-sleep', str(step['ms']))
                break
        elif op == 'resize':
            r, c = int(step['rows']), int(step['columns'])
            off = state['total']
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
            record(n, 'resize', f'{r} {c}', {'off': off})
        elif op == 'mark':
            record(n, 'mark', str(step.get('label', '')))
        elif op == 'eof':
            timeout_s = float(step.get('timeoutMs', 60000)) / 1000.0
            deadline = time.monotonic() + timeout_s
            while not state['eof'] and time.monotonic() < deadline:
                pump(min(0.25, deadline - time.monotonic()))
            if state['eof']:
                record(n, 'eof', '')
            else:
                record(n, 'timeout', 'eof')
                state['timed_out'] = True
                interrupt_twice()
        else:
            sys.stderr.write(f'pty_type: unknown step {step!r}\n')
            return 2

    if state['timed_out']:
        drain_for(10.0)
        if not state['eof'] and alive():
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            record(0, 'kill-on-timeout', 'SIGKILL')
            drain_for(5.0)
    # drain whatever is left and collect the exit status
    drain_for(0.2)
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    if os.WIFSIGNALED(status):
        code = 128 + os.WTERMSIG(status)
        record(0, 'signal', signal.Signals(os.WTERMSIG(status)).name)
    else:
        code = os.WEXITSTATUS(status)
    record(0, 'exit', str(code))
    cap.close()
    tim.close()
    try:
        os.close(fd)
    except OSError:
        pass
    return 124 if state['timed_out'] else code


if __name__ == '__main__':
    sys.exit(main())
