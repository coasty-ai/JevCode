/**
 * `EngineOptions.autonomy` — the product acts on its own by default: a `review` risk verdict is approved without asking
 * (the reason kept in the step's notes and transcript), `block` still stops; `'review'` puts the verdict to the confirmer
 * as before; a child agent (depth 1) never auto-approves (ORCHESTRATION-DESIGN §2.5(c) row 29).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './fakes.js';
import { alwaysDecline, makeEngine, riskAll, turn } from './fakes.js';

const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
async function build(...args: Parameters<typeof makeEngine>): Promise<Harness> { const h = await makeEngine(...args); harnesses.push(h); return h; }

const reviewTurn = turn({ kind: 'run', command: 'pip install x' });
const reviewRisk = { rules: [riskAll({ 2: 1 })] };
const oneStep = { maxSteps: 1 };

describe('autonomy', () => {
  it("'full' (the product default, also what an absent option means): the review verdict is approved without asking, the command runs, the reason is recorded", async () => {
    const h = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, confirmer: alwaysDecline, autonomyDefault: true, limits: oneStep });
    await h.engine.run();
    expect(h.sandbox.commands.some((c) => c.includes('pip install x'))).toBe(true);
    expect(h.of('confirm:resolved')).toHaveLength(0);
    expect(h.of('transcript').some((e) => String(e.text).includes('auto-approved (autonomy: full)'))).toBe(true);
  });

  it("'review': the confirmer decides, exactly as before", async () => {
    const h = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, confirmer: alwaysDecline, engine: { autonomy: 'review' }, limits: oneStep });
    await h.engine.run();
    expect(h.sandbox.commands.some((c) => c.includes('pip install x'))).toBe(false);
    expect(h.of('confirm:resolved')).toHaveLength(1);
  });

  it('a child agent never auto-approves, whatever the option says: the review parks the run', async () => {
    const h = await build({ turns: [reviewTurn], deciderOptions: reviewRisk, confirmer: alwaysDecline, engine: { autonomy: 'full', orchestration: { depth: 1, slug: 'child' } }, limits: oneStep });
    const result = await h.engine.run();
    expect(result.stopReason).toBe('human_pause');
    expect(h.sandbox.commands).toEqual([]);
  });
});
