/**
 * `src/perf/main.ts` pure parts: `driverLines` keeps only real pty driver processes out of a `pgrep -fl` listing (the
 * run records other agents' drivers alive at its start), not processes whose argv merely mentions the driver names.
 */
import { describe, expect, it } from 'vitest';
import { driverLines } from '../../../src/perf/main.js';

describe('driverLines', () => {
  it('keeps expect … drive.exp and python3 … pty_type.py processes, drops shells and editors that only mention them, truncates long lines', () => {
    const out = [
      '18589 expect scripts/pty/drive.exp /tmp/jevpty/chat1.steps /tmp/jevpty/chat1.cap /tmp/jevpty/chat1.timing 60 -- node bin/jevcode.js chat --mock',
      '21300 /usr/bin/expect -f scripts/pty/drive.exp .scratch/pty/run-review-y.steps .scratch/pty/out/run-review-y.cap 60 -- npx tsx .scratch/pty-session.tsx',
      '4242 /usr/bin/python3 /Users/x/JevCode/perf/drivers/pty_type.py /tmp/steps.json /tmp/cap.bin /tmp/t.jsonl -- node bin/jevcode.js chat --mock',
      '96817 /bin/zsh -c source snapshot.sh && python3 - <<EOF drive.exp pty_type.py',
      'new = "/** other pty drivers alive (`pgrep -fl drive.exp|pty_type.py`) */"',
      '7 vim src/perf/drive.exp.notes',
      '',
      `8 expect scripts/pty/drive.exp ${'x'.repeat(200)}`,
    ].join('\n');
    const lines = driverLines(out);
    expect(lines).toHaveLength(4);
    expect(lines[0]!.startsWith('18589 expect scripts/pty/drive.exp')).toBe(true);
    expect(lines[1]!.startsWith('21300 /usr/bin/expect -f scripts/pty/drive.exp')).toBe(true);
    expect(lines[2]!.startsWith('4242 /usr/bin/python3 ')).toBe(true);
    expect(lines[3]!).toHaveLength(160);
    expect(lines[3]!.endsWith('…')).toBe(true);
    expect(driverLines('')).toEqual([]);
  });
});
