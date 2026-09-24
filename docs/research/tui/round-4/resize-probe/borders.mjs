import { readFileSync } from 'node:fs';
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[c78=>]/g;
const strip=(s)=>s.replace(ANSI_RE,'');
const text=readFileSync(process.argv[2]+'/capture.bin','utf8');
const BSU='\x1b[?2026h', RESET='\x1b[0 q';
let t=text; const f=t.indexOf(BSU); const cut=f<0?-1:t.indexOf(RESET,f); if(cut>=0)t=t.slice(0,cut);
const parts=t.split(BSU).slice(1);
let n=0;
parts.forEach((raw,i)=>{
  const lines=strip(raw).replace(/\r\n|\r/g,'\n').split('\n');
  const bad=lines.filter((l)=>/^[╭│├╰]/.test(l) && /…$/.test(l));
  if(bad.length){n++; if(n<=6){console.log(`frame ${i}: ${bad.length} box rows ending in the truncation ellipsis`); bad.slice(0,6).forEach((b)=>console.log(`   |${b}`));}}
});
console.log(`frames with a box row whose right border is an ellipsis: ${n} / ${parts.length}`);
