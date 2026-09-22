/**
 * Round-4 topic A1 probe: option A (full-screen, header pinned at the physical top) vs
 * option B (today's hybrid: <Static> scrollback + a bounded dynamic region).
 *
 * env: PROTO_MODE=full|hybrid   PROTO_ALT=1|0   PROTO_INC=1|0   PROTO_ITEMS=<n>
 *      PROTO_KEYS=<n> (exit after n keys)   PROTO_OUT=<json file>
 */
import { writeFileSync } from 'node:fs';
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Static, render, useInput, useStdout, useWindowSize } from 'ink';
import { WORDMARK, mkItems, instrument, report, onKey, e } from './lib.mjs';

const MODE = process.env.PROTO_MODE ?? 'full';
const ALT = process.env.PROTO_ALT === '1';
const INC = process.env.PROTO_INC === '1';
const NITEMS = Number(process.env.PROTO_ITEMS ?? '200');
const NKEYS = Number(process.env.PROTO_KEYS ?? '60');
const OUT = process.env.PROTO_OUT ?? '/tmp/proto-out.json';
const OVER = Number(process.env.PROTO_OVER ?? '0');

const ALL = mkItems(NITEMS);
const st = instrument();
let keyCount = 0;

function Header({ columns }) {
  const pad = Math.max(0, Math.floor((columns - 56) / 2));
  return e(
    Box,
    { flexDirection: 'column', height: 5, flexShrink: 0 },
    WORDMARK.map((r, i) => e(Text, { key: `w${i}`, wrap: 'truncate', color: '#ff5fa2' }, ' '.repeat(pad) + r)),
  );
}

function Console({ columns, draft, extra }) {
  const w = Math.max(4, columns);
  const inner = w - 4;
  const top = '╭─ jev+llm ' + '─'.repeat(Math.max(0, w - 21)) + ' JevCode ─╮';
  const div = '├' + '─'.repeat(w - 2) + '┤';
  const bot = '╰' + '─'.repeat(w - 2) + '╯';
  const row = (s) => '│ ' + (s + ' '.repeat(inner)).slice(0, inner) + ' │';
  return e(
    Box,
    { flexDirection: 'column', height: 5, flexShrink: 0 },
    e(Text, { wrap: 'truncate', color: '#ff5fa2' }, top),
    e(Text, { wrap: 'truncate' }, row('› ' + draft)),
    e(Text, { wrap: 'truncate' }, div),
    e(Text, { wrap: 'truncate', dimColor: true }, row('idle' + extra)),
    e(Text, { wrap: 'truncate', color: '#ff5fa2' }, bot),
  );
}

function AppFull() {
  const { rows, columns } = useWindowSize();
  const [draft, setDraft] = useState('');
  const [top, setTop] = useState(Math.max(0, ALL.length - 1));
  useInput((input, key) => {
    onKey(st);
    keyCount += 1;
    if (key.pageUp) setTop((t) => Math.max(0, t - 5));
    else if (key.pageDown) setTop((t) => Math.min(ALL.length - 1, t + 5));
    else setDraft((d) => (d + input).slice(-60));
    if (keyCount >= NKEYS) setTimeout(finish, 120);
  });
  const viewRows = Math.max(0, rows + OVER - 5 - 5 - 1);
  const end = Math.min(ALL.length, top + 1);
  const start = Math.max(0, end - viewRows);
  const shown = ALL.slice(start, end);
  const pct = ALL.length <= viewRows ? 100 : Math.round((end / ALL.length) * 100);
  return e(
    Box,
    { flexDirection: 'column', height: rows + OVER, width: columns },
    e(Header, { columns }),
    e(
      Box,
      { flexDirection: 'column', height: viewRows, flexGrow: 1, overflow: 'hidden' },
      shown.map((l, i) => e(Text, { key: `v${start + i}`, wrap: 'truncate' }, l)),
    ),
    e(Text, { wrap: 'truncate', dimColor: true }, `── ${end}/${ALL.length} ${pct}% ${'─'.repeat(Math.max(0, columns - 20))}`),
    e(Console, { columns, draft, extra: `  ${pct}%` }),
  );
}

function AppHybrid() {
  const { rows, columns } = useWindowSize();
  const [draft, setDraft] = useState('');
  const [items] = useState(ALL);
  useInput((input) => {
    onKey(st);
    keyCount += 1;
    setDraft((d) => (d + input).slice(-60));
    if (keyCount >= NKEYS) setTimeout(finish, 120);
  });
  return e(
    Box,
    { flexDirection: 'column' },
    e(Static, { items, style: {} }, (item, i) => e(Box, { key: `s${i}` }, e(Text, { wrap: 'truncate' }, item))),
    e(Text, { wrap: 'truncate', dimColor: true }, '─'.repeat(columns)),
    e(Header, { columns }),
    e(Console, { columns, draft, extra: '' }),
  );
}

let inst = null;
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  try {
  const { rows, columns } = { rows: process.stdout.rows, columns: process.stdout.columns };
  if (st.windowOpen === true) { st.byteSamples.push(st.window); st.windowOpen = false; }
    const r = report(`${MODE}${ALT ? '+alt' : ''}${INC ? '+inc' : ''}`, st, { mode: MODE, alt: ALT, inc: INC, rows, columns, items: NITEMS, keys: keyCount });
    writeFileSync(OUT, JSON.stringify(r) + '\n');
  } catch (err) {
    try { writeFileSync(OUT + '.err', String(err && err.stack ? err.stack : err)); } catch {}
  }
  try { inst?.unmount(); } catch {}
  setTimeout(() => process.exit(0), 80).unref();
  setTimeout(() => process.exit(0), 600);
}
setTimeout(() => { finish(); }, 45000).unref();

inst = render(e(MODE === 'full' ? AppFull : AppHybrid, null), {
  exitOnCtrlC: false,
  patchConsole: false,
  maxFps: 30,
  incrementalRendering: INC,
  alternateScreen: ALT,
});
