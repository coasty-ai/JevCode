#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp "$SCRIPT_DIR/prog.py" /app/prog.py
python3 /solution/helper.py
echo done > /app/result.txt
