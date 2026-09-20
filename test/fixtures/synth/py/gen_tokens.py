"""Regenerate the *.tokens.json fixtures from CPython's tokenize module (run with python3 >= 3.8, < 3.12).

Each entry is [type, string, startLine, startCol, endLine, endCol] with the ENCODING token dropped.
The TypeScript tokenizer in src/synth/py/tokenize.ts is tested against these files.
"""
import io
import json
import sys
import tokenize
from pathlib import Path

HERE = Path(__file__).parent


def tokens(src: str):
    out = []
    for t in tokenize.tokenize(io.BytesIO(src.encode("utf8")).readline):
        if t.type == tokenize.ENCODING:
            continue
        out.append([tokenize.tok_name[t.type], t.string, t.start[0], t.start[1], t.end[0], t.end[1]])
    return out


def main():
    names = sys.argv[1:] or sorted(p.name for p in HERE.glob("*.py") if p.name != "gen_tokens.py")
    for name in names:
        with open(HERE / name, encoding="utf8", newline="") as fh:
            src = fh.read()
        out = HERE / (Path(name).stem + ".tokens.json")
        out.write_text(json.dumps(tokens(src), ensure_ascii=False, indent=0) + "\n", encoding="utf8")
        print(f"{out.name}: {len(json.loads(out.read_text()))} tokens (python {sys.version.split()[0]})")


if __name__ == "__main__":
    main()
