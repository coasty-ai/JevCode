import { wrapBody, joinWrapped } from '../src/tui/transcript/wrap.js';
const LABEL_GUTTER = 10;
const bw = (c: number, l: string) => Math.max(1, Math.floor(c) - Math.max(LABEL_GUTTER - 1, l.length) - 1);
const t = 'replan change_approach p=0.80 c=0.76 impossible=0.05: After repeating the same run command with the same result 3 times, Jev directs `change_approach` (p=0.80, task_impossible=0.05): keep the goal but reach it a different way: a different fix, file, or technique than the repeated one.';
console.log('cols bodyW rows identity leadingSpaceRows');
for (const c of [10,12,16,20,24,30,32,36,40,50,60,80,100,120]) {
  const w = bw(c, '[step 4]');
  const rows = wrapBody(t, w);
  const lead = rows.filter((r) => r.startsWith(' ')).length;
  console.log(`${String(c).padStart(4)} ${String(w).padStart(5)} ${String(rows.length).padStart(4)} ${joinWrapped(rows) === t ? 'ok  ' : 'LOST'} ${lead}`);
  if (c === 40 || c === 60) for (const r of rows) console.log(`      |${'.'.repeat(LABEL_GUTTER)}${r}|`);
}
