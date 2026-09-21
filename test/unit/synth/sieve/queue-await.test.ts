/**
 * The awaitable VerifyQueue of llm-jev (docs/LLM-JEV-DESIGN.md §4.8): `open()` puts it in streaming mode,
 * `next()` hands the best job or waits for the next `add`, `close()` releases every waiter with null; never
 * opened, `next()` on an empty queue is null at once. Plus the two §6.1 additions: the vocabulary check is
 * bypassed for `llm` candidates and `SOURCE_ORDER_PRIOR.llm` is the default-path place.
 */
import { describe, expect, it } from 'vitest';

import { SOURCE_ORDER_PRIOR, VerifyQueue, jobFor, vocabulariesOf } from '../../../../src/synth/sieve/queue.js';
import { GCD_BUGGY, GCD_OTHER_TEST, GCD_TEST } from '../search/controller-fakes.js';
import { candidate, committedBase, siteAt, sourceFile, summary } from '../search/helpers.js';

const file = sourceFile('gcd.py', GCD_BUGGY);
const base = committedBase(file, summary({ failing: [GCD_TEST], passing: [GCD_OTHER_TEST] }));
const site = siteAt(file, 5);

describe('VerifyQueue streaming', () => {
  it('never opened: next() pops the best job, then resolves null at once on empty', async () => {
    const q = new VerifyQueue();
    expect(await q.next()).toBeNull();
    q.add(jobFor(candidate(site, 'return gcd(b, a % b)', { id: 'a' }), base));
    q.add(jobFor(candidate(site, 'return gcd(a, b % a)', { id: 'b', prior: 0.9 }), base));
    expect((await q.next())?.candidate.id).toBe('b');
    expect((await q.next())?.candidate.id).toBe('a');
    expect(await q.next()).toBeNull();
    expect(q.streaming).toBe(false);
  });

  it('opened: next() waits for an add, an add wakes the longest waiter, close() releases the rest with null', async () => {
    const q = new VerifyQueue();
    q.open();
    expect(q.streaming).toBe(true);
    const first = q.next();
    const second = q.next();
    let settled = 0;
    void first.then(() => (settled += 1));
    await Promise.resolve();
    expect(settled).toBe(0);
    q.add(jobFor(candidate(site, 'return gcd(b, a % b)', { id: 'a' }), base));
    expect((await first)?.candidate.id).toBe('a');
    // the second waiter is still pending; the queue holds nothing
    expect(q.size).toBe(0);
    q.close();
    expect(await second).toBeNull();
    expect(q.streaming).toBe(false);
    expect(await q.next()).toBeNull();
    // a job added after the close is popped by a later next() without waiting
    q.add(jobFor(candidate(site, 'return gcd(a, b % a)', { id: 'c' }), base));
    expect((await q.next())?.candidate.id).toBe('c');
  });

  it('a job that arrives while nobody waits stays in key order for the next pop', async () => {
    const q = new VerifyQueue();
    q.open();
    q.add(jobFor(candidate(site, 'return gcd(b, a % b)', { id: 'low', prior: 0.2 }), base));
    q.add(jobFor(candidate(site, 'return gcd(a, b % a)', { id: 'high', prior: 0.9 }), base));
    expect(q.toArray().map((j) => j.candidate.id)).toEqual(['high', 'low']);
    expect((await q.next())?.candidate.id).toBe('high');
    q.close();
    expect((await q.next())?.candidate.id).toBe('low');
    expect(await q.next()).toBeNull();
  });
});

describe('the llm source in the queue (§6.1, §4.7 step 6)', () => {
  it('the vocabulary pre-check drops a mutant naming an unknown identifier but lets the same text through as an llm candidate', () => {
    const vocab = vocabulariesOf(new Map([[file.path, file]]), [], 'fix gcd');
    const q = new VerifyQueue({ vocab });
    expect(q.add(jobFor(candidate(site, 'return helper_x(b, a % b)', { id: 'm', source: 'mutation' }), base))).toBe('vocab');
    expect(q.add(jobFor(candidate(site, 'return helper_x(b, a % b)', { id: 'l', source: 'llm' }), base))).toBe('queued');
    expect(q.dropped.vocab).toBe(1);
  });

  it('SOURCE_ORDER_PRIOR.llm is 0.35 and is the default sourcePrior of an llm job without its own prior', () => {
    expect(SOURCE_ORDER_PRIOR.llm).toBe(0.35);
    const j = jobFor(candidate(site, 'return gcd(b, a % b)', { id: 'l', source: 'llm' }), base);
    expect(j.sourcePrior).toBe(0.35);
    expect(j.p).toBe(0.35);
  });
});
