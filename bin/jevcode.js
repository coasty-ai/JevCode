#!/usr/bin/env node
// Launcher: guard the Node version, honour NO_COLOR, enable the V8 compile cache, then load
// the single bundled ESM file. Nothing here touches the network; the first frame renders
// before config is read.
//
// NO_COLOR (https://no-color.org): chalk 5 never reads it, only FORCE_COLOR, so the mapping
// has to happen here, before the bundle (and chalk inside it) is evaluated.
// With JEVCODE_ASSERT_NO_NETWORK=1 (perf harness) any http(s) fetch before the first frame
// throws. data: URLs stay allowed: yoga-layout (Ink's layout engine) loads its inlined WASM
// through fetch('data:...'), which is local decoding, not network.
const [major = 0, minor = 0] = process.versions.node.split('.').map((s) => Number(s));
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`jevcode: Node 22.12 or newer is required (found ${process.versions.node}); see .nvmrc\n`);
  process.exit(2);
}
if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '' && process.env.FORCE_COLOR === undefined) {
  process.env.FORCE_COLOR = '0';
}
import { enableCompileCache } from 'node:module';
try { enableCompileCache(); } catch { /* older Node: no compile cache, still works */ }
if (process.env.JEVCODE_ASSERT_NO_NETWORK === '1') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';
    if (/^https?:/i.test(url)) throw new Error(`network before first frame: ${url.slice(0, 60)}`);
    return realFetch(input, init);
  };
}
await import('../dist/jevcode.mjs');
