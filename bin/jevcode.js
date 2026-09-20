#!/usr/bin/env node
// Launcher: enable the V8 compile cache, then load the single bundled ESM file.
// Nothing here touches the network; the first frame renders before config is read.
import { enableCompileCache } from 'node:module';
try { enableCompileCache(); } catch { /* older Node: no compile cache, still works */ }
await import('../dist/jevcode.mjs');
