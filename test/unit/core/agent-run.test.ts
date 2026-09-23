import { describe, expect, it } from 'vitest';

import { isReplyOnlyRun } from '../../../src/core/agent-run.js';
import type { StepAgentSummary, StepRecord } from '../../../src/core/types.js';
import { FINISHED_STOP_REASONS, exitCodeFor, isFinishedStop } from '../../../src/loop/stop.js';

const step = (agent?: StepAgentSummary): Pick<StepRecord, 'agent'> => (agent === undefined ? {} : { agent });
const finish = (calls: StepAgentSummary['calls'] = []): StepAgentSummary => ({ kind: 'finish', turn: 1, calls, seqAfter: 2 });

describe('AGENT-LOOP-DESIGN §A1: the reply-only run and the `answered` stop', () => {
  it('a run of one tool-less finish step is a reply; any observe/act/verify step, any call, or a legacy step is not', () => {
    expect(isReplyOnlyRun([step(finish())])).toBe(true);
    expect(isReplyOnlyRun([])).toBe(false);
    expect(isReplyOnlyRun([step()])).toBe(false);
    expect(isReplyOnlyRun([step({ kind: 'observe', turn: 1, calls: [], seqAfter: 1 }), step(finish())])).toBe(false);
    expect(isReplyOnlyRun([step({ kind: 'act', turn: 1, calls: [], seqAfter: 1 }), step(finish())])).toBe(false);
    expect(isReplyOnlyRun([step({ kind: 'verify', turn: null, calls: [], seqAfter: 1 }), step(finish())])).toBe(false);
    expect(isReplyOnlyRun([step(finish([{} as StepAgentSummary['calls'][number]]))])).toBe(false);
  });

  it('`answered` exits 0 and is a finished (non-resumable) stop, like complete and generator_done', () => {
    expect(exitCodeFor('answered')).toBe(0);
    expect(isFinishedStop('answered')).toBe(true);
    expect(isFinishedStop('complete')).toBe(true);
    expect(isFinishedStop('generator_done')).toBe(true);
    expect(isFinishedStop('stuck')).toBe(false);
    expect(FINISHED_STOP_REASONS).toEqual(['complete', 'generator_done', 'answered']);
  });
});
