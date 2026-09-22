// jev-only-rungs-1-2.md §21.4 addendum ($0): the runner's exact django-15315 reproduction command, repeated under PYTHONHASHSEED=0 in the finished run's workspace and lane0.
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { buildReproScript, reproCommand, REPRO_SENTINEL } from '../../src/synth/oracle/runner.js';
const W = `${homedir()}/.jevcode/runs/bench-work/20260921-002827-57b7e1/django__django-15315/jev-only/workspace`;
const LANE = `${homedir()}/.jevcode/runs/20260921-010903-ovz3tdxe/tmp/synth/lane0`;
const chunks = ["from django.db import models\nf = models.CharField(max_length=200)\nd = {f: 1}\nclass Book(models.Model):\n\ttitle = f\nassert f in d"];
function verdict(cmd: string, cwd: string): string {
  const out = execSync(cmd, { cwd, encoding: 'utf8', shell: '/bin/zsh', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const i = out.lastIndexOf(REPRO_SENTINEL);
  const j = JSON.parse(out.slice(i + REPRO_SENTINEL.length)) as { results: { source: string; exception: { type: string; message: string } | null; environment?: boolean }[] };
  const a = j.results.find((r) => r.source.includes('assert f in d'));
  const env = j.results.filter((r) => r.environment).length;
  return a === undefined ? `no-assert-record(env=${env})` : a.exception === null ? 'PASS' : `${a.exception.type}${env > 0 ? `(env=${env})` : ''}`;
}
const N = Number(process.argv[2] ?? '16');
for (const [label, ws, extra] of [['workspace', W, {}], ['lane0 (PYTHONPATH=lane, workspace venv)', LANE, { python: `${W}/.venv/bin/python`, env: { PYTHONPATH: LANE } }]] as const) {
  const script = buildReproScript(chunks, { workspace: ws, packageName: 'django', framework: 'django' });
  const cmd = reproCommand(script, { workspace: ws, ...extra });
  const counts = new Map<string, number>();
  for (let k = 0; k < N; k++) { const v = verdict(cmd, ws); counts.set(v, (counts.get(v) ?? 0) + 1); }
  console.log(`${label}: ${[...counts.entries()].map(([k, v]) => `${k} ×${v}`).join(', ')} (of ${N}; command prefix: ${cmd.slice(cmd.indexOf('PYTHONDONT'), cmd.indexOf('PYTHONDONT') + 70)}…)`);
}
