// 20k-item transcript: cost of the viewport model (option A) — the wrapped-row index and its rebuild on resize.
import { mkItems } from './lib.mjs';
const N = Number(process.argv[2] ?? '20000');
const base = process.memoryUsage().heapUsed;
const items = mkItems(N);
global.gc?.();
const afterItems = process.memoryUsage().heapUsed;
function wrap(text, width) {
  const out = []; let line = '';
  for (const w of text.split(' ')) {
    if (line === '') line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  out.push(line); return out;
}
function index(items, width) {
  const rows = [];
  for (const it of items) for (const r of wrap(it, width)) rows.push(r);
  return rows;
}
let t = performance.now();
let rows80 = index(items, 71);
const t80 = performance.now() - t;
global.gc?.();
const afterIdx = process.memoryUsage().heapUsed;
t = performance.now();
let rows200 = index(items, 191);
const t200 = performance.now() - t;
global.gc?.();
const after2 = process.memoryUsage().heapUsed;
// slice cost per frame (viewport of 40 rows out of the index)
t = performance.now();
let acc = 0;
for (let i = 0; i < 1000; i++) acc += rows80.slice(rows80.length - 40 - (i % 100), rows80.length - (i % 100)).length;
const tslice = (performance.now() - t) / 1000;
console.log(JSON.stringify({
  items: N,
  rows80: rows80.length, rows200: rows200.length,
  heapItemsMb: +((afterItems - base) / 1048576).toFixed(1),
  heapIndex80Mb: +((afterIdx - afterItems) / 1048576).toFixed(1),
  heapIndex200Mb: +((after2 - afterIdx) / 1048576).toFixed(1),
  rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
  rebuild80Ms: +t80.toFixed(1), rebuild200Ms: +t200.toFixed(1),
  slicePerFrameMs: +tslice.toFixed(4), acc,
}));
