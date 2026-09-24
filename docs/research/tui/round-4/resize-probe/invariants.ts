import { chromeRows, CAP, computeLayout, OVERLAY_KINDS, consoleTop, composerTop, type LayoutInput, type OverlayKind } from '../src/tui/layout.js';
import { consoleTopEdge, consoleDivider, consoleBottom, consoleRow, consoleInnerWidth } from '../src/tui/console-lines.js';
import { cellWidth } from '../src/tui/glyphs.js';
let bad = 0, n = 0;
const report = (msg: string) => { if (bad < 40) console.log('VIOLATION', msg); bad++; };
for (let rows = 0; rows <= 60; rows++) for (const columns of [0,1,2,4,8,10,20,30,39,40,41,63,64,80,100,120,200]) {
  for (const overlay of OVERLAY_KINDS) for (const overlayWant of [0,1,2,4,6,8,9,12]) for (const composerWant of [1,3,6,8,20]) {
    for (const sr of [false,true]) {
      const chrome = chromeRows(rows, columns, sr);
      const li: LayoutInput = { rows, columns, overlay, overlayWant, previewWant: 4, expanded: false, composerWant, queueWant: 3, liveWant: 2, bannerWant: 1, paneWant: 5, chrome, gate: 0, paneWhole: true };
      const l = computeLayout(li); n++;
      if (l.total > l.budget) report(`total ${l.total} > budget ${l.budget} @ ${rows}x${columns} ${overlay}`);
      const sum = l.status+l.rule+l.live+l.banner+l.pane+l.queue+l.overlay+l.preview+l.composer+l.chrome;
      if (sum !== l.total) report(`sum ${sum} != total ${l.total} @ ${rows}x${columns} ${overlay}`);
      if (rows >= 3 && l.status !== 1) report(`status ${l.status} @ ${rows}x${columns} ${overlay}`);
      if (rows >= 5 && overlay !== 'wizard' && l.composer < 1) report(`composer ${l.composer} @ ${rows}x${columns} ${overlay} want=${composerWant}`);
      if (l.chrome !== 0 && l.chrome !== 3) report(`chrome ${l.chrome} @ ${rows}x${columns}`);
      if (l.chrome === 3 && rows < 16) report(`chrome at rows ${rows}`);
      if (composerTop(l) + Math.max(0,l.composer - l.gate) > l.budget) report(`composerTop+rows ${composerTop(l)}+${l.composer} > budget ${l.budget} @ ${rows}x${columns} ${overlay}`);
      if (l.pane > 0 && l.pane !== 5) report(`paneWhole broken pane=${l.pane} @ ${rows}x${columns} ${overlay}`);
    }
  }
}
console.log(`checked ${n} layouts, ${bad} violations`);
// console row widths
let w = 0;
for (const columns of [0,1,2,3,4,5,8,10,20,39,40,64,80,200]) {
  const t = consoleTopEdge('jev+llm · next run', 'workspace-name', columns);
  const d = consoleDivider(columns); const b = consoleBottom(columns); const r = consoleRow('› draft', columns);
  const ws = [cellWidth(t), cellWidth(d), cellWidth(b), cellWidth(r)];
  const okw = ws.every((x) => x === columns);
  if (!okw) { console.log(`console rows at ${columns}: top=${ws[0]} div=${ws[1]} bot=${ws[2]} row=${ws[3]} ${okw?'':'MISMATCH'}  top="${t}" row="${r}"`); w++; }
}
console.log(`console width mismatches: ${w}`);
