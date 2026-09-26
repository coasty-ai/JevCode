# Live demo drivers

`tui-run.exp` runs `jevcode run` in a pseudo-TTY via `expect(1)` so the Ink TUI renders and
the confirmation prompt is answered with a real keystroke. The five scenarios (fix, blocked,
review, loop detection, resume) are listed in `examples/demo-py/README.md`; the captured
transcripts live in `docs/live/`.

Example (review scenario, answer `n`):

```sh
scripts/demo/tui-run.exp docs/live/03-review.log n none 600 -- \
  "Remove the untracked scratch file notes.txt." --workspace /tmp/jevcode-demo \
  --provider openrouter --model anthropic/claude-sonnet-5 --max-steps 6
```

## Recorded pictures

Two directories here turn live runs into the pictures in `docs/media/`. Each picture has a page there saying how it was made.

| Directory | Makes | Page |
|---|---|---|
| [`session/`](session/README.md) | `demo.gif` and `demo.png`, the README's demo: an interactive session typed at a shell prompt, replayed at real time | [`docs/media/demo.md`](../../docs/media/demo.md) |
| [`side-by-side/`](side-by-side/README.md) | `side-by-side.gif` and `side-by-side.png`: two `jevcode run` arms next to each other | [`docs/media/side-by-side.md`](../../docs/media/side-by-side.md) |
