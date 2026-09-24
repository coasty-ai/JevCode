#!/bin/sh
# Live demos 3 (review), 4 (loop detection under --no-network) and 5 (Ctrl-C then --resume),
# run sequentially on the shared demo workspace. Logs and run artefacts go to docs/live/.
set -u
cd "$(dirname "$0")/../.."
WS=/tmp/jevcode-demo
COMMON="--workspace $WS --provider openrouter --model anthropic/claude-sonnet-5"
save() { # <name> : copy the newest run dir's artefacts
  R=$(ls -td ~/.jevcode/runs/2026*/ | head -1); mkdir -p "docs/live/$1"; cp "$R"/transcript.log "$R"/steps.jsonl "$R"/decisions.jsonl "$R"/run.json "docs/live/$1/"; echo "$R" > "docs/live/$1/run-dir.txt"; echo "== $1 -> $R"; cut -c1-200 "$R/transcript.log" | tail -n 6; }

echo "### demo 3: review (untracked file removal), answer n"
scripts/demo/tui-run.exp docs/live/03-review.log n none 600 -- "Remove the untracked scratch file notes.txt." $COMMON --max-steps 4 --spend-cap 0.8 > /tmp/jevcode-demo-03.out 2>&1
save 03-review-declined; mv docs/live/03-review.log docs/live/03-review-declined/tui-pty.log

echo "### demo 4: loop detection (missing package, --no-network), answer y"
scripts/demo/tui-run.exp docs/live/04-loop.log y none 900 -- "Add a test that uses the hypothesis library to check calc.add is commutative, and make it pass." $COMMON --no-network --max-steps 8 --spend-cap 1.0 > /tmp/jevcode-demo-04.out 2>&1
save 04-loop-replan; mv docs/live/04-loop.log docs/live/04-loop-replan/tui-pty.log

echo "### demo 5a: Ctrl-C mid-run"
scripts/demo/tui-run.exp docs/live/05-resume-a.log y "step 2/" 900 -- "Add a one-line docstring to every function in calc/core.py, then run the tests." $COMMON --max-steps 8 --spend-cap 1.0 > /tmp/jevcode-demo-05a.out 2>&1
R=$(ls -td ~/.jevcode/runs/2026*/ | head -1); RID=$(basename "$R"); save 05-resume; mv docs/live/05-resume-a.log docs/live/05-resume/tui-pty-a.log; cp "$R/state.json" docs/live/05-resume/state-after-ctrl-c.json
echo "### demo 5b: --resume $RID"
scripts/demo/tui-run.exp docs/live/05-resume-b.log y none 900 -- --resume "$RID" --provider openrouter --model anthropic/claude-sonnet-5 > /tmp/jevcode-demo-05b.out 2>&1
cp "$R"/transcript.log "$R"/steps.jsonl "$R"/decisions.jsonl "$R"/run.json docs/live/05-resume/; mv docs/live/05-resume-b.log docs/live/05-resume/tui-pty-b.log
echo "== resumed transcript tail"; cut -c1-200 "$R/transcript.log" | tail -n 8
echo "### done"
