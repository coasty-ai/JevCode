// Fails the typecheck script if any `any` type appears in src/ or test/ (strict TypeScript, no `any`).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const roots = ['src', 'test', 'bench', 'perf'].filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
const re = /(?::\s*any\b|\bas\s+any\b|<any>|\bany\[\]|Array<any>|Record<[^,>]+,\s*any>|Promise<any>)/;
const bad = [];
function walk(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|mts)$/.test(e.name)) { const lines = readFileSync(p, 'utf8').split('\n'); lines.forEach((l, i) => { if (re.test(l) && !/no-any-ok/.test(l)) bad.push(`${p}:${i + 1}: ${l.trim()}`); }); } } }
roots.forEach(walk);
if (bad.length) { console.error('`any` is not allowed:\n' + bad.join('\n')); process.exit(1); }
console.log(`no-any: ok (${roots.join(', ')})`);
