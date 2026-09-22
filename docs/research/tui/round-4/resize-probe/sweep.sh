#!/bin/bash
for g in "$@"; do
  r=${g%x*}; c=${g#*x}
  TIMEOUT=15 ./run.sh "boot-${r}x${c}" "$r" "$c" s_boot.steps chat --mock
done
