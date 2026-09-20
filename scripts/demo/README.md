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
