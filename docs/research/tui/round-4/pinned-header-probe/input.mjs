import { appendFileSync, writeFileSync } from 'node:fs';
import React from 'react';
import { Box, Text, render, useInput } from 'ink';
const LOG = process.env.PROTO_LOG ?? '/tmp/jevcode-r4-header/proto/input.log';
writeFileSync(LOG, '');
const e = React.createElement;
let n = 0;
function A() {
  useInput((input, key) => {
    n += 1;
    appendFileSync(LOG, JSON.stringify({ n, input, key: Object.fromEntries(Object.entries(key).filter(([, v]) => v === true)) }) + '\n');
    if (n >= 40) setTimeout(() => process.exit(0), 200);
  });
  return e(Box, null, e(Text, null, `keys ${n}`));
}
// turn on SGR mouse reporting like a full-screen TUI would
process.stdout.write('\u001b[?1000h\u001b[?1002h\u001b[?1006h');
render(e(A, null), { exitOnCtrlC: false, patchConsole: false });
setTimeout(() => process.exit(0), 12000);
