/** Offline: does the operator library generate the gold fix for each program? Prints a table; no Jev calls. */
import { loadProgram, programNames, compilable } from './quixbugs.ts';
import { mutateLine, mutateLineSecondOrder, normLine, statementTemplates } from './mutators.ts';

let first = 0, second = 0, n = 0;
const rows: string[] = [];
for (const name of programNames()) {
  const p = loadProgram(name);
  n++;
  const target = normLine(p.fixLine);
  let m1: ReturnType<typeof mutateLine>;
  if (p.mode === 'insert') {
    // candidates for insertion: every program line (re-indented to the anchor's block) and their mutants
    m1 = [];
    const indent = (p.buggyLine.match(/^\s*/)?.[0] ?? '') + (p.buggyLine.trimEnd().endsWith(':') ? '    ' : '');
    for (const l of p.lines) { const t = indent + l.trim(); m1.push({ text: t, op: 'donor_line' }); m1.push(...mutateLine(t, p.ctx)); }
    m1.push(...statementTemplates(p.ctx, indent));
  } else m1 = mutateLine(p.buggyLine, p.ctx);
  const hit1 = m1.find((m) => normLine(m.text) === target);
  const m2 = hit1 ? [] : mutateLineSecondOrder(p.buggyLine, p.ctx, m1, 20000);
  const hit2 = hit1 ?? m2.find((m) => normLine(m.text) === target);
  const ok = compilable(p, m1.map((m) => m.text));
  const nComp = ok.filter(Boolean).length;
  first += hit1 ? 1 : 0; second += hit2 ? 1 : 0;
  rows.push(`| ${name} | ${p.mode} | ${m1.length} | ${nComp} | ${hit1 ? 'yes (' + hit1.op + ')' : hit2 ? 'second-order (' + hit2.op + ')' : 'no'} | \`${p.fixLine.trim().replace(/\|/g, '\\|')}\` |`);
  console.error(`${name.padEnd(28)} ${p.mode.padEnd(7)} first=${String(m1.length).padStart(5)} compilable=${String(nComp).padStart(5)} fix: ${hit1 ? 'FIRST ' + hit1.op : hit2 ? 'SECOND ' + hit2.op : 'MISS'}  ${p.fixLine.trim()}`);
}
console.log('| program | mode | first-order mutants | compilable | gold fix generated | gold fix |\n| --- | --- | --- | --- | --- | --- |');
console.log(rows.join('\n'));
console.log(`\nfirst-order coverage ${first}/${n}, first+second-order ${second}/${n}`);
