import { wordmarkWanted, wordmarkFrame, WORDMARK_MIN_ROWS } from '../src/tui/wordmark.js';
import { chromeRows, CAP, computeLayout, type LayoutInput } from '../src/tui/layout.js';
import { consoleInnerWidth, consoleTopEdge, consoleDivider, consoleBottom } from '../src/tui/console-lines.js';
const LABEL_GUTTER = 10;
const bodyWidth = (columns: number, label: string): number => Math.max(1, Math.floor(columns) - Math.max(LABEL_GUTTER - 1, label.length) - 1);

const GEOS: [number, number][] = [[0,0],[1,10],[2,10],[3,20],[5,30],[8,40],[10,60],[12,60],[16,64],[20,80],[21,64],[24,80],[30,100],[40,120],[50,160],[60,200]];
console.log('rows x cols | chrome | wanted | pane | layout(total<=budget) | degraded | innerW | bodyW([sandbox])');
for (const [rows, cols] of GEOS) {
  const chrome = chromeRows(rows, cols, false);
  const boxed = chrome === CAP.chrome;
  const wanted = wordmarkWanted({ boxed, rows, postRun: false, columns: cols, screenReader: false, run: 'none', panel: 'collapsed', pickerOpen: false, overlay: 'none', expanded: false, setting: 'sweep' });
  let markRows = 0;
  try { markRows = wanted ? wordmarkFrame({ columns: cols, version: '0.3.0' }).rows.length : 0; } catch (e) { markRows = -1; }
  const li: LayoutInput = { rows, columns: cols, overlay: 'none', overlayWant: 0, previewWant: 0, expanded: false, composerWant: 1, queueWant: 0, liveWant: 0, bannerWant: 0, paneWant: markRows > 0 ? CAP.splash : 0, chrome, gate: 0, paneWhole: markRows > 0 };
  const l = computeLayout(li);
  console.log(`${String(rows).padStart(2)}x${String(cols).padStart(3)} | ${chrome} | ${wanted?'Y':'.'} | ${l.pane} | t=${l.total}<=b=${l.budget} st=${l.status} rule=${l.rule} comp=${l.composer} chr=${l.chrome} ov=${l.overlay} | ${l.degraded} | ${consoleInnerWidth(cols)} | ${bodyWidth(cols,'[sandbox]')}`);
}
