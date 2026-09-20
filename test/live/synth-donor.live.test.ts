/**
 * One live hole-filling check for the donor source (probe-donor §2, `bucketsort`): the donor
 * line `for i, count in enumerate(arr):` with `arr` as the hole, buggy line visible, one Choice
 * over the in-scope identifiers. Measured 13/13 top-1 on changed identifiers; here we only
 * require `counts` in the top-2 fillings. One request, well under a cent. Skipped unless
 * JEVCODE_LIVE=1 and OPENROUTER_API_KEY are set. Run once:
 *   env -u ANTHROPIC_API_KEY node --env-file=.env node_modules/.bin/vitest run --project live test/live/synth-donor.live.test.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Json, Question, StageName } from '../../src/core/types.js';
import { createJevDecider } from '../../src/jev/client.js';
import { fillHolesSequentially, identifierHoles } from '../../src/synth/donor/holes.js';
import type { HoleContext } from '../../src/synth/donor/holes.js';
import { analyse, blockAt, scopeAt } from '../../src/synth/py/structure.js';
import type { JevAsk, Site, SourceFile } from '../../src/synth/types.js';

const live = process.env['JEVCODE_LIVE'] === '1';
const apiKey = process.env['OPENROUTER_API_KEY'] ?? '';
const reason = !live ? 'JEVCODE_LIVE is not 1' : apiKey.length === 0 ? 'no OPENROUTER_API_KEY in the environment' : null;

describe.skipIf(reason !== null)(`donor hole filling live (${reason ?? 'enabled'})`, () => {
  it('fills the changed identifier of bucketsort with counts in the top-2', async () => {
    const redact = (s: string): string => (apiKey.length >= 8 ? s.split(apiKey).join('[REDACTED:key]') : s);
    const decider = createJevDecider({ baseUrl: 'https://openrouter.ai/api/alpha/decisions', apiKey, model: 'typesafe/jev-1.13-20260917', pinned: true }, { redact });
    const src = readFileSync(join(process.cwd(), 'bench', 'data', 'quixbugs', 'programs', 'bucketsort.py'), 'utf8');
    const file: SourceFile = { path: 'bucketsort.py', src, mod: analyse(src) };
    const line = file.mod.lines.findIndex((l) => l.includes('enumerate(arr)')) + 1;
    const b = blockAt(file.mod, line)!;
    const site: Site = {
      file,
      line,
      kind: 'replace',
      currentLine: file.mod.lines[line - 1]!,
      indent: '    ',
      block: { name: b.name, startLine: b.startLine, endLine: b.endLine },
      scope: scopeAt(file.mod, line),
      evidence: { notes: ['live test'] },
    };
    let cost = 0;
    const ask: JevAsk = async (stage: StageName, state: Json, questions: Record<string, Question>) => {
      const r = await decider.ask(state, questions, { signal: new AbortController().signal, stage, step: 1 });
      cost += r.usage.costUsd;
      return { answers: r.answers, rows: [], latencyMs: r.latencyMs };
    };
    const ctx: HoleContext = {
      ask,
      task: 'The function `bucketsort` in `bucketsort.py` has a bug that makes some tests in tests/ fail. Fix it without changing the tests.',
      failures: [
        { testId: 'bucketsort_0', call: 'bucketsort([3, 11, 2, 9, 1, 5], 12)', expected: '[1, 2, 3, 5, 9, 11]', actual: '[]' },
        { testId: 'bucketsort_1', call: 'bucketsort([3, 2, 4, 2, 3, 5], 6)', expected: '[2, 2, 3, 3, 4, 5]', actual: '[]' },
      ],
      functionListing: '',
      signal: new AbortController().signal,
    site,
    };
    const donor = 'for i, count in enumerate(arr):';
    const hole = identifierHoles(donor, site.scope).find((h) => h.name === 'arr')!;
    const r = await fillHolesSequentially(donor, [hole], site.scope, ctx, { width: 2, familySwaps: false });
    expect(r.requests).toBe(1);
    expect(r.fillings.map((f) => f.text)).toContain('for i, count in enumerate(counts):');
    expect(cost).toBeLessThan(0.05);
  }, 60_000);
});
