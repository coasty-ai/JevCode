/** tui/secrets/gate-lines.ts (TUI-DESIGN §4.10, §10.2, §24; §19.0 row O7): gate strings singular/plural/exact. */
import { describe, expect, it } from 'vitest';
import { createRedactor, detectSecrets } from '../../../../src/core/redact.js';
import type { SecretHit } from '../../../../src/core/types.js';
import { stringWidth } from '../../../../src/tui/composer/width.js';
import {
  ATTACH_ANYWAY_ROW,
  GATE_ARM_MS,
  GATE_DISMISS_TIP,
  SECRET_BADGE,
  SECRET_BADGE_ASCII,
  editorRefusalToast,
  gateAccepts,
  gateLabels,
  gateLines,
  gatePlainPrompt,
  gateRefusalLine,
  secretAckText,
} from '../../../../src/tui/secrets/gate-lines.js';

const ANT = 'sk-ant-api03-abcdefghijklmnopqrstuv_-x';
const AWS = 'AKIAIOSFODNN7EXAMPLE';
const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const hit = (label: string, family = 'x', start = 0, end = 20, warnOnly = false): SecretHit => ({ family, label, start, end, warnOnly });

describe('gateLines (§24 Overlays)', () => {
  it('singular', () => {
    expect(gateLines(detectSecrets(`deploy with ${ANT}`))).toEqual(['Looks like this contains a secret (sk-ant-…). Send anyway? y/N']);
    expect(gateLines(detectSecrets(`aws ${AWS}`))).toEqual(['Looks like this contains a secret (AKIA…). Send anyway? y/N']);
  });

  it('plural with the distinct labels in order and the hit count', () => {
    expect(gateLines(detectSecrets(`${ANT} ${GHP} ${AWS}`))).toEqual(['Looks like this contains 3 secrets (sk-ant-…, ghp_…, AKIA…). Send anyway? y/N']);
    expect(gateLines([hit('sk-ant-…'), hit('sk-ant-…', 'x', 30, 60)])).toEqual(['Looks like this contains 2 secrets (sk-ant-…). Send anyway? y/N']);
    expect(gateLabels([hit('a'), hit('b'), hit('a')])).toEqual(['a', 'b']);
  });

  it('exact: `your <NAME>`; mixed exact + pattern falls back to the plural form with the `your …` label', () => {
    const r = createRedactor([{ name: 'OPENROUTER_API_KEY', value: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123' }]);
    const exactOnly = detectSecrets('use sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 please', r);
    expect(gateLines(exactOnly)).toEqual(['Looks like this contains your OPENROUTER_API_KEY. Send anyway? y/N']);
    const mixed = detectSecrets(`use sk-or-v1-abcdefghijklmnopqrstuvwxyz0123 and ${AWS}`, r);
    expect(gateLines(mixed)).toEqual(['Looks like this contains 2 secrets (your OPENROUTER_API_KEY, AKIA…). Send anyway? y/N']);
    const two = createRedactor([{ name: 'A_KEY', value: 'alpha-secret-0001' }, { name: 'B_KEY', value: 'bravo-secret-0002' }]);
    expect(gateLines(detectSecrets('alpha-secret-0001 bravo-secret-0002', two))).toEqual(['Looks like this contains your A_KEY, B_KEY. Send anyway? y/N']);
  });

  it('empty hits → no row; a columns cap truncates with … measured in cells', () => {
    expect(gateLines([])).toEqual([]);
    const row = gateLines(detectSecrets(`${ANT} ${GHP} ${AWS}`), 40)[0]!;
    expect(Array.from(row).length).toBe(40);
    expect(row.endsWith('…')).toBe(true);
    // an exact hit named after a wide-character variable: cells, not code points
    const wide = createRedactor([{ name: '日本語のキー変数名', value: 'alpha-secret-0001' }]);
    const wideRow = gateLines(detectSecrets('alpha-secret-0001', wide), 30)[0]!;
    expect(stringWidth(wideRow)).toBeLessThanOrEqual(30);
    expect(wideRow.endsWith('…')).toBe(true);
    expect(gateLines(detectSecrets(ANT), NaN)[0]).toBe('Looks like this contains a secret (sk-ant-…). Send anyway? y/N');
    expect(gateLines(detectSecrets(ANT), 0)[0]).toContain('Send anyway? y/N');
  });

  it('never leaks the secret: no row contains more than the label prefix', () => {
    for (const s of [ANT, AWS, GHP]) {
      const rows = gateLines(detectSecrets(`x ${s} y`)).join('\n');
      expect(rows).not.toContain(s.slice(8));
    }
  });
});

describe('twins and constants', () => {
  it('plain prompt, refusal line, editor toast, secret-ack text', () => {
    const hits = detectSecrets(ANT);
    expect(gatePlainPrompt(hits)).toBe('jevcode: looks like this contains a secret (sk-ant-…); type y to send, anything else to cancel:');
    expect(gatePlainPrompt(detectSecrets(`${ANT} ${AWS}`))).toBe('jevcode: looks like this contains 2 secrets (sk-ant-…, AKIA…); type y to send, anything else to cancel:');
    const r = createRedactor([{ name: 'MY_TOKEN', value: 'alpha-secret-0001' }]);
    expect(gatePlainPrompt(detectSecrets('alpha-secret-0001', r))).toBe('jevcode: looks like this contains your MY_TOKEN; type y to send, anything else to cancel:');
    expect(gateRefusalLine(hits)).toBe('jevcode: the task contains a secret (sk-ant-…); refusing to start (exit 2)');
    expect(gateRefusalLine(detectSecrets(`${ANT} ${AWS}`))).toBe('jevcode: the task contains a secret (sk-ant-…, AKIA…); refusing to start (exit 2)');
    expect(gateRefusalLine([])).toBe('jevcode: the task contains a secret (); refusing to start (exit 2)');
    expect(editorRefusalToast(hits)).toBe('editor: the draft contains a secret (sk-ant-…); remove it or send it first');
    expect(secretAckText(1)).toBe('sent 1 secret to the generator on request');
    expect(secretAckText(3)).toBe('sent 3 secrets to the generator on request');
    expect(secretAckText(NaN)).toBe('sent 0 secrets to the generator on request');
  });

  it('constants are the §24 / §4.10 strings', () => {
    expect(GATE_DISMISS_TIP).toBe('Tip: put it in .env and refer to it by name');
    expect(ATTACH_ANYWAY_ROW).toBe('Attach anyway? y/N');
    expect(SECRET_BADGE).toBe('⚠ secret?');
    expect(SECRET_BADGE_ASCII).toBe('! secret?');
    expect(SECRET_BADGE).not.toContain('️');
    expect(GATE_ARM_MS).toBe(150);
  });

  it('gateAccepts: only y/Y, only on an armed frame, never within 150 ms of the Enter', () => {
    expect(gateAccepts('y', 1000, 1010, 1200)).toBe(true);
    expect(gateAccepts('Y', 1000, 1010, 1150)).toBe(true);
    expect(gateAccepts('y', 1000, 1010, 1149)).toBe(false);
    expect(gateAccepts('y', 1000, null, 1200)).toBe(false);
    expect(gateAccepts('y', 1000, 1300, 1200)).toBe(false);
    expect(gateAccepts('n', 1000, 1010, 1200)).toBe(false);
    expect(gateAccepts('\r', 1000, 1010, 1200)).toBe(false);
    expect(gateAccepts('yes', 1000, 1010, 1200)).toBe(false);
    expect(gateAccepts('y', NaN, 1010, 1200)).toBe(false);
    expect(gateAccepts('y', 1000, 1010, Infinity)).toBe(false);
  });
});
