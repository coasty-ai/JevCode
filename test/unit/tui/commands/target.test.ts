/**
 * TUI-DESIGN-5 §2.5 / §10 (R5-2): the target grammar — one resolver, one table, and the **order** asserted rather
 * than the result. Every row of the table below exists to pin a rung of
 *
 *   reserved word → exact run id → exact session id → unique id suffix or substring (≥ 8) →
 *   `device:<label[#id4]|id8>` → exact title → unique title prefix → a bare device label
 *
 * against a fold where the same text would match at more than one rung, so a reordering of the resolver fails here
 * and not in a pty. Pure: no ledger, no clock, no I/O (§2.1 rule 2).
 *
 * **Every run id is `RUN_ID_RE`-shaped** (`<YYYYMMDD>-<HHMMSS>-<8 random>`, `src/checkpoint/run-id.ts:21`), which
 * is the whole point of the fix pass on this file: the synthetic ids the first draft used hid two real defects —
 * the leading eight characters are the DATE and identical for every run of the day (so a head-8 candidate list
 * read `20260921, 20260921, 20260921`), and the trailing eight random characters, which CO §5.3 says are "what
 * humans copy", resolved to `notFound`.
 */
import { describe, expect, it } from 'vitest';
import { emptyFold } from '../../../../src/coordination/index.js';
import type { Fold } from '../../../../src/coordination/index.js';
import type { SelfIdentityView } from '../../../../src/core/types.js';
import { RUN_ID_RE } from '../../../../src/checkpoint/run-id.js';
import {
  ID_PREFIX_MIN,
  RESERVED_TARGETS,
  TARGET_CANDIDATE_MAX,
  ambiguousTargetMessage,
  resolveTarget,
  reservedShadowNote,
  shortPrefixMessage,
  targetRefusalJson,
  unavailableScopeMessage,
  unknownDeviceMessage,
  unknownTargetMessage,
  type TargetResult,
} from '../../../../src/tui/commands/target.js';
import { makeDevice, makeHeartbeat } from '../../coordination/helpers.js';

const MBP = 'k3q7m2ab';
const AIR = 'zz5wq7cd';

/** one addressable session: `[runId, sessionId, title, deviceLabel, deviceId]` */
type Row = [string, string, string, string, string];

const LIVE_ROWS: readonly Row[] = [
  // A, B and C share the DATE head `20260921` — the fragment a head-8 resolver would have called an id8
  ['20260921-140233-rpywkq2v', 'sa00001100aaaa', 'fix parse_date', 'mbp', MBP],
  // B's SESSION id is A's RUN id: the exact-run-id rung must win
  ['20260921-141500-mq4t7xkd', '20260921-140233-rpywkq2v', 'migrate loader', 'air', AIR],
  // C's TITLE is B's RUN id: the exact-run-id rung must win over the exact-title rung
  ['20260921-142211-c3ccccc7', 'sc00003300cccc', '20260921-141500-mq4t7xkd', 'mbp', MBP],
  // D and E are titled with reserved words: the word always wins and the note names them by id (§12 S43)
  ['20260922-090000-dd44dddd', 'sd00004400dddd', 'all', 'air', AIR],
  ['20260922-091500-ee55eeee', 'se00005500eeee', 'self', 'mbp', MBP],
  // F and G share a date AND a title prefix; their TAILS differ, so the S44 list names two usable candidates
  ['20260923-093000-ffaa3333', 'sf00006600ffff', 'docs sweep', 'mbp', MBP],
  ['20260923-093000-ffbb3333', 'sg00007700gggg', 'docs tidy', 'air', AIR],
  // H's TITLE is the 8-character TAIL of its own run id: the id rung must win, with `matchedBy` to prove it
  ['20260924-101010-hh345677', 'sh00008800hhhh', 'hh345677', 'mbp', MBP],
  // I's TITLE is four characters long and is also a fragment of B's run id (`…-141500-…`): the short-id refusal
  // must NOT short-circuit the title rungs (§12 S43b is deferred)
  ['20260925-110000-planzzzz', 'si00009901iiii', '1500 plan', 'mbp', MBP],
];
/** six more rows behind one date, so the ≤ 5 candidate cap and `truncated` have something to cap */
const MANY: readonly Row[] = Array.from({ length: 6 }, (_, i) => [`20260920-10000${i}-zzmmmmm${i + 2}`, `sz9999990000${i}`, `many ${i}`, 'mbp', MBP] as Row);
const GONE_ROWS: readonly Row[] = [['20260926-120000-crashzzz', 'sj00009900jjjj', 'crashed one', 'air', AIR]];

function beat(row: Row, pid: number): ReturnType<typeof makeHeartbeat> & { arrivalMono: number } {
  const [runId, sessionId, title60, label, deviceId] = row;
  return { ...makeHeartbeat({ runId, sessionId, title60, label, deviceId, pid }), arrivalMono: 0 };
}

function fixture(): Fold {
  const fold = emptyFold({ wallMs: 0, monoMs: 0 });
  let pid = 900;
  for (const row of [...LIVE_ROWS, ...MANY]) fold.live.set(row[0], beat(row, pid++));
  for (const row of GONE_ROWS) fold.gone.set(row[0], { ...beat(row, pid++), goneAtMono: 0 });
  for (const [deviceId, label] of [
    [MBP, 'mbp'],
    [AIR, 'air'],
    ['dd111111', 'dup'],
    ['dd222222', 'dup'],
  ] as const) {
    fold.devices.set(deviceId, { ...makeDevice({ deviceId, label }), lastSeen: '2026-09-22T12:00:00.000Z', syncLagMs: null, ignored: false, cloned: false });
  }
  return fold;
}

const self: SelfIdentityView = { deviceId8: MBP, label: 'mbp', sameDeviceCount: 2 };
const fold = fixture();
const resolve = (text: string): TargetResult => resolveTarget(text, fold, self);

/** the compact shape the table asserts: kind, then `matchedBy` (resolved) or the message (refused) */
function shape(r: TargetResult): string {
  if (r.kind === 'resolved') return `resolved:${r.matchedBy}:${r.target.kind}:${r.id8 ?? '-'}`;
  if (r.kind === 'ambiguous') return `ambiguous:${r.candidates.length}:${r.truncated}`;
  return `notFound:${r.message}`;
}

describe('resolveTarget (TUI-DESIGN-5 §2.5)', () => {
  it('every fixture run id is `RUN_ID_RE`-shaped, so the table exercises the ids the product actually mints', () => {
    for (const [runId] of [...LIVE_ROWS, ...MANY, ...GONE_ROWS]) expect(runId, runId).toMatch(RUN_ID_RE);
    // and the head-8 of every one of them is the same four-digit year + month, which is why id8 is the TAIL
    expect(new Set([...LIVE_ROWS, ...MANY, ...GONE_ROWS].map(([r]) => r.slice(0, 6))).size).toBe(1);
  });

  it.each<[input: string, want: string, why: string]>([
    // ---- rung 1: the reserved words, which beat a session titled the same (§12 S43) ----
    ['all', 'resolved:reserved:all:-', 'the reserved word wins over the session titled "all"'],
    ['ALL', 'resolved:reserved:all:-', 'case-folded'],
    ['  all  ', 'resolved:reserved:all:-', 'trimmed'],
    ['self', 'resolved:reserved:self:-', 'the reserved word wins over the session titled "self"'],
    ['Self', 'resolved:reserved:self:-', 'case-folded'],
    ['tree', `notFound:${unavailableScopeMessage('tree')}`, 'D-AE: parsed, refused — no referent in this build'],
    ['agents', `notFound:${unavailableScopeMessage('agents')}`, 'D-AE'],
    ['agent:tui-rows', `notFound:${unavailableScopeMessage('agent:tui-rows')}`, 'D-AE'],
    ['AGENT:tui-rows', `notFound:${unavailableScopeMessage('AGENT:tui-rows')}`, 'case-folded before the scope check'],
    // ---- rung 2: an exact run id, ahead of an exact SESSION id that equals it ----
    ['20260921-140233-rpywkq2v', 'resolved:runId:run:rpywkq2v', "A's run id beats B's session id"],
    ['20260921-141500-mq4t7xkd', 'resolved:runId:run:mq4t7xkd', "B's run id beats C's title"],
    ['20260921-142211-c3ccccc7', 'resolved:runId:run:c3ccccc7', 'a plain exact run id'],
    ['20260926-120000-crashzzz', 'resolved:runId:run:crashzzz', 'a gone session is still addressable (§7 row 3)'],
    ['20260923-093000-ffaa3333', 'resolved:runId:run:ffaa3333', 'exact beats the date that is ambiguous'],
    ['20260923-093000-ffbb3333', 'resolved:runId:run:ffbb3333', 'the other exact run id of the same date'],
    // ---- rung 3: an exact session id ----
    ['sa00001100aaaa', 'resolved:sessionId:session:rpywkq2v', 'exact session id'],
    ['sc00003300cccc', 'resolved:sessionId:session:c3ccccc7', 'exact session id'],
    ['sj00009900jjjj', 'resolved:sessionId:session:crashzzz', 'a gone session by session id'],
    // ---- rung 4: a unique id SUFFIX or substring of at least ID_PREFIX_MIN characters (CO §5.3) ----
    ['c3ccccc7', 'resolved:idPrefix:run:c3ccccc7', 'the trailing 8 random characters — what a human copies'],
    ['crashzzz', 'resolved:idPrefix:run:crashzzz', "a gone session's tail"],
    ['142211-c3ccccc7', 'resolved:idPrefix:run:c3ccccc7', 'a longer suffix'],
    ['20260921-142211', 'resolved:idPrefix:run:c3ccccc7', 'a unique substring that is not a suffix'],
    ['rpywkq2v', 'ambiguous:2:false', "A's run id and B's session id are the same string: a suffix sees both"],
    ['sc000033', 'resolved:idPrefix:session:c3ccccc7', 'an 8-character SESSION-id fragment resolves to the session'],
    ['hh345677', 'resolved:idPrefix:run:hh345677', "the id rung beats the session titled 'hh345677'"],
    ['142211', `notFound:${shortPrefixMessage('142211')}`, '6 characters is refused, never guessed'],
    ['r', `notFound:${shortPrefixMessage('r')}`, 'one character is refused'],
    ['20260923', 'ambiguous:2:false', 'two runs behind one date'],
    ['20260921', 'ambiguous:3:false', "the date head that a head-8 id8 would have listed three times as '20260921'"],
    ['20260920', 'ambiguous:5:true', `six behind one date: capped at ${TARGET_CANDIDATE_MAX}, truncated`],
    // ---- rung 5: device:<label[#id4]|id8> ----
    ['device:mbp', `resolved:device:device:${MBP}`, 'the label the device published'],
    ['device:air', `resolved:device:device:${AIR}`, 'another device'],
    ['device:AIR', `resolved:device:device:${AIR}`, 'labels are case-folded'],
    ['device:dup', 'ambiguous:2:false', 'two devices share a label'],
    ['device:dup#dd11', 'resolved:device:device:dd111111', 'CO §5.3 / edge row 42: the `#id4` form the refusal points at'],
    ['device:dup#dd22', 'resolved:device:device:dd222222', 'the other one'],
    ['device:dd111111', 'resolved:device:device:dd111111', 'a bare device id8 is the other way out of an ambiguous label'],
    ['device:dup#zz', `notFound:${unknownDeviceMessage('dup#zz')}`, 'an `#id4` that matches neither'],
    ['device:nope', `notFound:${unknownDeviceMessage('nope')}`, 'no such device'],
    ['device:', `notFound:${unknownDeviceMessage('')}`, 'an empty label'],
    // ---- rung 6: an exact title ----
    ['fix parse_date', 'resolved:title:title:rpywkq2v', 'exact title'],
    ['FIX PARSE_DATE', 'resolved:title:title:rpywkq2v', 'titles are case-folded'],
    ['crashed one', 'resolved:title:title:crashzzz', "a gone session's title"],
    ['docs sweep', 'resolved:title:title:ffaa3333', 'exact beats the shared title prefix'],
    // ---- rung 7: a unique title prefix ----
    ['fix parse', 'resolved:titlePrefix:title:rpywkq2v', 'a unique title prefix'],
    ['migrate', 'resolved:titlePrefix:title:mq4t7xkd', 'another unique title prefix'],
    ['docs ', 'ambiguous:2:false', 'two titles behind one prefix'],
    ['1500', 'resolved:titlePrefix:title:planzzzz', "a 4-character title that is also a fragment of B's run id still resolves (S43b is deferred)"],
    // ---- rung 8: a bare device label — §2.6's `/pause mbp`, the ordinary case ----
    ['mbp', `resolved:device:device:${MBP}`, "§2.6: `/pause mbp` is the ordinary case, and it is a device, not a session"],
    ['MBP', `resolved:device:device:${MBP}`, 'case-folded'],
    ['air', `resolved:device:device:${AIR}`, 'the other device by bare label'],
    ['dup', 'ambiguous:2:false', 'a bare label two devices share refuses the same way `device:dup` does'],
    // ---- nothing matched ----
    ['nothing-here', `notFound:${unknownTargetMessage('nothing-here')}`, 'unknown'],
    ['', `notFound:${unknownTargetMessage('')}`, 'empty'],
    ['    ', `notFound:${unknownTargetMessage('')}`, 'whitespace only'],
  ])('%s → %s (%s)', (input, want) => {
    expect(shape(resolve(input))).toBe(want);
  });

  it('a reserved word that shadows a real session names it by id (§12 S43), and nothing else carries a note', () => {
    const all = resolve('all');
    expect(all.kind === 'resolved' && all.note).toBe(reservedShadowNote('all', 'dd44dddd'));
    expect(reservedShadowNote('all', 'dd44dddd')).toBe('"all" is a reserved target — the session titled "all" is dd44dddd');
    const s = resolve('self');
    expect(s.kind === 'resolved' && s.note).toBe(reservedShadowNote('self', 'ee55eeee'));
    // with no such session there is no note at all — never an empty string, never a sentence about nothing
    const bare = resolveTarget('all', emptyFold({ wallMs: 0, monoMs: 0 }), self);
    expect(bare).toEqual({ kind: 'resolved', target: { kind: 'all' }, matchedBy: 'reserved', id8: null });
    expect('note' in bare).toBe(false);
    expect(resolve('fix parse_date')).not.toHaveProperty('note');
    expect(RESERVED_TARGETS).toEqual(['all', 'self', 'tree', 'agents']);
    expect(ID_PREFIX_MIN).toBe(8);
  });

  it('an ambiguous id lists at most five candidates, in the §12 S44 sentence, each one a target the resolver accepts', () => {
    const two = resolve('20260923');
    expect(two.kind).toBe('ambiguous');
    if (two.kind !== 'ambiguous') throw new Error('unreachable');
    expect(two.candidates).toEqual([
      { id8: 'ffaa3333', title60: 'docs sweep', label: 'mbp' },
      { id8: 'ffbb3333', title60: 'docs tidy', label: 'air' },
    ]);
    expect(two.message).toBe('2 sessions match "20260923" — ffaa3333, ffbb3333');
    expect(two.truncated).toBe(false);
    // the whole point of the tail: every candidate is distinct AND feeding one back in resolves
    for (const c of two.candidates) expect(shape(resolve(c.id8)), c.id8).toBe(`resolved:idPrefix:run:${c.id8}`);
    // the date that a head-8 id8 would have listed three times as one string
    const three = resolve('20260921');
    if (three.kind !== 'ambiguous') throw new Error('unreachable');
    expect(three.message).toBe('3 sessions match "20260921" — rpywkq2v, mq4t7xkd, c3ccccc7');
    expect(new Set(three.candidates.map((c) => c.id8)).size).toBe(3);
    const many = resolve('20260920');
    if (many.kind !== 'ambiguous') throw new Error('unreachable');
    expect(many.candidates).toHaveLength(TARGET_CANDIDATE_MAX);
    expect(many.truncated).toBe(true);
    expect(many.message).toBe(ambiguousTargetMessage('20260920', 6, many.candidates.map((c) => c.id8), true));
    expect(many.message.endsWith(' …')).toBe(true);
    expect(many.message.startsWith('6 sessions match "20260920" — ')).toBe(true);
  });

  it('CO §5.3 edge row 42: an ambiguous `device:` refusal names candidates that are themselves accepted targets', () => {
    const dup = resolve('device:dup');
    if (dup.kind !== 'ambiguous') throw new Error('unreachable');
    expect(dup.candidates).toEqual([
      { id8: 'dd111111', title60: '', label: 'dup' },
      { id8: 'dd222222', title60: '', label: 'dup' },
    ]);
    for (const c of dup.candidates) {
      expect(shape(resolve(`device:${c.id8}`)), c.id8).toBe(`resolved:device:device:${c.id8}`);
      expect(shape(resolve(`device:dup#${c.id8.slice(0, 4)}`)), c.id8).toBe(`resolved:device:device:${c.id8}`);
    }
    // the bare-label form refuses identically, so `/pause dup` is never a silently different answer
    expect(resolve('dup')).toEqual({ ...dup, text: 'dup', message: dup.message.replace('"device:dup"', '"dup"') });
  });

  it('§13.3: a refusal serialises the `TargetResult` fields, never a re-modelled shape', () => {
    const amb = resolve('20260923');
    if (amb.kind !== 'ambiguous') throw new Error('unreachable');
    expect(targetRefusalJson(amb)).toEqual({ ok: false, reason: 'ambiguous', candidates: amb.candidates, message: amb.message });
    const nf = resolve('nothing-here');
    if (nf.kind !== 'notFound') throw new Error('unreachable');
    expect(targetRefusalJson(nf)).toEqual({ ok: false, reason: 'notFound', message: nf.message });
    expect(targetRefusalJson(nf)).not.toHaveProperty('candidates');
  });

  it('§7 row 2: an unopened fold answers the reserved words and refuses everything else — never a throw, never a spinner', () => {
    const empty = emptyFold({ wallMs: 0, monoMs: 0 });
    expect(resolveTarget('all', empty, self)).toMatchObject({ kind: 'resolved', target: { kind: 'all' } });
    expect(resolveTarget('self', empty, self)).toMatchObject({ kind: 'resolved', target: { kind: 'self' } });
    expect(resolveTarget('20260921-140233-rpywkq2v', empty, self)).toMatchObject({ kind: 'notFound' });
    // this device's own label still resolves — by `device:` and bare — so `/tell <me>` is never a dead end before the ledger opens
    expect(resolveTarget('device:mbp', empty, self)).toEqual({ kind: 'resolved', target: { kind: 'device', label: 'mbp' }, matchedBy: 'device', id8: MBP });
    expect(resolveTarget('mbp', empty, self)).toEqual({ kind: 'resolved', target: { kind: 'device', label: 'mbp' }, matchedBy: 'device', id8: MBP });
  });

  it('is pure: the fold is never mutated and two calls agree', () => {
    const before = JSON.stringify([...fold.live.keys()], null, 0);
    const a = resolve('docs sweep');
    const b = resolve('docs sweep');
    expect(a).toEqual(b);
    expect(JSON.stringify([...fold.live.keys()], null, 0)).toBe(before);
    expect(fold.inbox).toHaveLength(0);
  });

  it('target.ts reaches coordination only through the facade, and only as a type (§2.1 rule 1 / rule 3a, gate G-R5-1)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../../../../src/tui/commands/target.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/import type \{ Fold \} from '\.\.\/\.\.\/coordination\/index\.js';/);
    expect(src).not.toMatch(/from '\.\.\/\.\.\/coordination\/(ledger|fold|claims|records|leases|mailbox)\.js'/);
    // no value import from anywhere outside core/ — the module is pure and zero-I/O. `RUN_ID_RE` lives in
    // `checkpoint/run-id.ts`, which reaches `node:fs`, so the tail slice is spelled out locally instead.
    expect(src).not.toMatch(/^import \{/m);
    expect(src).not.toMatch(/node:(fs|path|os|child_process)/);
  });
});
