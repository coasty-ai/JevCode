/** Emits the hand-written tokenizer's output (copied from slot-probe.mts) for every code line of QuixBugs, for comparison with CPython tokenize. */
import { readFileSync, readdirSync } from 'node:fs';
const ROOT = '/tmp/quixbugs';
const TOKEN_RE = /\s*(?:(?<str>[rbfuRBFU]{0,2}(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"))|(?<num>\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)|(?<name>[A-Za-z_]\w*)|(?<op>\*\*=|\/\/=|>>=|<<=|\.\.\.|->|\*\*|\/\/|<<|>>|<=|>=|==|!=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|:=|[-+*\/%@&|^~<>=()\[\]{},:.;]))/y;
function tokenize(line: string): string[] | null {
  const src = line.replace(/#.*$/, '').trim(); const out: string[] = []; TOKEN_RE.lastIndex = 0;
  while (TOKEN_RE.lastIndex < src.length) {
    const m = TOKEN_RE.exec(src); if (!m || m[0] === '') { if (src.slice(TOKEN_RE.lastIndex).trim() === '') break; return null; }
    const g = m.groups!; out.push((g['str'] ?? g['num'] ?? g['name'] ?? g['op'])!);
  }
  return out;
}
function codeOnly(src: string): string[] { const i = src.indexOf('\n"""'); return (i > 0 ? src.slice(0, i) : src).replace(/\s+$/, '').split('\n'); }
const out: Record<string, (string[] | null)[]> = {};
for (const f of readdirSync(`${ROOT}/python_programs`).filter((f) => f.endsWith('.py') && !f.endsWith('_test.py'))) {
  const lines = codeOnly(readFileSync(`${ROOT}/python_programs/${f}`, 'utf8')).filter((l) => l.trim() !== '' && !/^\s*#/.test(l));
  out[f] = lines.map(tokenize);
}
console.log(JSON.stringify(out));
