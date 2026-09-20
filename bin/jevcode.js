#!/usr/bin/env node
// Launcher: enable the V8 compile cache, then load the single bundled ESM file.
// Nothing here touches the network; the first frame renders before config is read.
// With JEVCODE_ASSERT_NO_NETWORK=1 (perf harness) any fetch before the first frame throws.
import { enableCompileCache } from 'node:module';
try { enableCompileCache(); } catch { /* older Node: no compile cache, still works */ }
if (process.env.JEVCODE_ASSERT_NO_NETWORK === '1') {
  globalThis.fetch = () => { throw new Error('network before first frame'); };
}
await import('../dist/jevcode.mjs');
