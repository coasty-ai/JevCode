/** One cheap request to confirm the key, the model pin and the cost field. */
import { createJev } from './jev.mts';
import { choice } from '../../src/jev/questions.ts';
const jev = createJev(0.01);
const r = await jev.ask({ program: { L1: 'def f(x):', L2: '    return x + 1' }, tests: [{ input: [1], expected: 3 }] },
  { buggy_line: choice('Which line of `program` must change so `tests` pass?', { line_1: 'def f(x):', line_2: '    return x + 1' }) });
console.log(JSON.stringify({ model: r.model, answers: r.answers, costUsd: r.usage.costUsd, inputTokens: r.usage.inputTokens, latencyMs: r.latencyMs }));
