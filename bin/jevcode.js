#!/usr/bin/env node
// Launcher: enable the V8 compile cache, then load the single bundled ESM file.
// Nothing here touches the network; the first frame renders before config is read.
// With JEVCODE_ASSERT_NO_NETWORK=1 (perf harness) any http(s) fetch before the first frame
// throws. data: URLs stay allowed: yoga-layout (Ink's layout engine) loads its inlined WASM
// through fetch('data:...'), which is local decoding, not network.
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
