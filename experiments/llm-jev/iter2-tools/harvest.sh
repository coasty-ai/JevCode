#!/bin/zsh
# harvest per-run transcripts (not archived by --archive-runs) into <resultsdir>/transcripts/
D="$1"
[ -d "$D/runs" ] || { echo "no runs in $D"; exit 1; }
mkdir -p "$D/transcripts"
n=0; miss=0
for r in $(ls "$D/runs"); do
  t="$HOME/.jevcode/runs/$r/transcript.log"
  if [ -f "$t" ]; then cp "$t" "$D/transcripts/$r.log"; n=$((n+1)); else miss=$((miss+1)); echo "MISSING $r"; fi
done
echo "$D: harvested $n, missing $miss"
