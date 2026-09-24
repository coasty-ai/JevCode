// Shared bits for the round-4 pinned-header prototypes. Not part of the product.
import React from 'react';

export const WORDMARK = [
  '                ██ ███████ ██    ██',
  '                ██ ██      ██    ██',
  '                ██ █████   ██    ██',
  '            ██  ██ ██       ██  ██ ',
  '             ████  ███████   ████  ',
];

export function mkItems(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const label = i % 5 === 0 ? '[jevcode]' : i % 5 === 1 ? '     [you]' : `[step ${(i % 90) + 10}]`;
    out.push(`${label} line ${i} — lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod`);
  }
  return out;
}

// byte / latency instrumentation on the real tty write path
export function instrument() {
  const st = { bytes: 0, writes: 0, keyAt: null, keyBytes: 0, samples: [], byteSamples: [], frames: 0, window: 0, windowOpen: false, firstWriteAt: null };
  const real = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, enc, cb) => {
    const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    st.bytes += len;
    st.writes += 1;
    if (st.firstWriteAt === null) st.firstWriteAt = performance.now();
    if (st.keyAt !== null) {
      st.samples.push(performance.now() - st.keyAt);
      st.keyAt = null;
    }
    if (st.windowOpen === true) st.window += len;
    return real(chunk, enc, cb);
  };
  return st;
}

// call at the top of the key handler: closes the previous key's byte window and opens a new one
export function onKey(st) {
  if (st.windowOpen === true) st.byteSamples.push(st.window);
  st.window = 0;
  st.windowOpen = true;
  st.keyAt = performance.now();
}

export function q(a, p) {
  if (a.length === 0) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

export function report(tag, st, extra) {
  const out = {
    tag,
    samples: st.samples.length,
    p50: q(st.samples, 50),
    p95: q(st.samples, 95),
    max: st.samples.length ? Math.max(...st.samples) : null,
    bytesPerKeyP50: q(st.byteSamples, 50),
    bytesPerKeyP95: q(st.byteSamples, 95),
    bytesPerKeyMax: st.byteSamples.length ? Math.max(...st.byteSamples) : null,
    totalBytes: st.bytes,
    firstWriteMs: st.firstWriteAt === null ? null : Math.round(st.firstWriteAt * 10) / 10,
    writes: st.writes,
    rssMb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
    heapMb: Math.round((process.memoryUsage().heapUsed / 1048576) * 10) / 10,
    ...extra,
  };
  return out;
}

export const e = React.createElement;
