#!/bin/bash
mkdir -p /logs/verifier
if [ -f /app/apt-packages.txt ] && [ -s /app/apt-packages.txt ]; then
  apt-get install -y something
fi
python3 /app/prog.py --output /output/result.json
setpriv --reuid nobody --regid nogroup --clear-groups env HOME=/tmp python3 /tests/check.py
status=$?
if [ "$status" -eq 0 ]; then
  printf '{"reward": 1}\n' > /logs/verifier/reward.json
else
  printf '{"reward": 0}\n' > /logs/verifier/reward.json
fi
exit 0
