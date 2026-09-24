// Vitest reporter used by ci.yml and release.yml next to the default one (`--reporter=default
// --reporter=./scripts/ci/retried-reporter.mjs`). CI retries a failing test up to twice, so a test that only
// passes on a retry would otherwise vanish from the log. This lists every retried test in the job summary and as
// a ::warning:: annotation on its file. It never changes the exit code.
import { appendFileSync } from 'node:fs';

/** One summary row per retried test, sorted by file then name; exported for the unit test. */
export function retriedRows(testModules) {
  const rows = [];
  for (const mod of testModules) {
    for (const test of mod.children.allTests()) {
      const d = test.diagnostic();
      if (!d || d.retryCount === 0) continue;
      const state = test.result().state;
      rows.push({ file: mod.relativeModuleId, name: test.fullName, retries: d.retryCount, outcome: state === 'passed' ? 'passed on retry' : state });
    }
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

/** The job-summary block; empty string when nothing was retried. */
export function summaryMarkdown(rows) {
  if (rows.length === 0) return '';
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    `### Unit tests retried in this run (${rows.length})`,
    '',
    'Each passed or failed only after a retry. A test that keeps appearing here is flaky: fix it rather than lean on the retry.',
    '',
    '| file | test | retries | outcome |',
    '| --- | --- | --- | --- |',
    ...rows.map((r) => `| ${cell(r.file)} | ${cell(r.name)} | ${r.retries} | ${r.outcome} |`),
    '',
  ];
  return lines.join('\n');
}

export default class RetriedReporter {
  onTestRunEnd(testModules) {
    const rows = retriedRows(testModules);
    if (rows.length === 0) return;
    for (const r of rows) {
      // workflow commands take %, CR and LF escaped in the message
      const msg = `${r.name} — ${r.outcome} after ${r.retries} ${r.retries === 1 ? 'retry' : 'retries'}`.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
      process.stdout.write(`::warning file=${r.file}::${msg}\n`);
    }
    const md = summaryMarkdown(rows);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary) appendFileSync(summary, md + '\n');
    else process.stdout.write(md + '\n');
  }
}
