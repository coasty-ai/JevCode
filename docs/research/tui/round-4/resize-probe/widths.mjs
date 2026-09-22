import { readFileSync } from 'node:fs';
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[c78=>]/g;
const strip=(s)=>s.replace(ANSI_RE,'');
const seg=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const WIDE=[[0x1100,0x115f],[0x2e80,0x303e],[0x3041,0x33ff],[0x3400,0x4dbf],[0x4e00,0x9fff],[0xa000,0xa4cf],[0xa960,0xa97f],[0xac00,0xd7a3],[0xf900,0xfaff],[0xfe10,0xfe19],[0xfe30,0xfe6f],[0xff00,0xff60],[0xffe0,0xffe6],[0x1f300,0x1f64f],[0x1f680,0x1f6ff],[0x1f900,0x1f9ff],[0x20000,0x3fffd]];
function cw(g){
  // width of a grapheme cluster, string-width-ish
  const cps=[...g].map(c=>c.codePointAt(0));
  if(cps.length>1 && g.includes('‍')) return 2;
  const first=cps.find(c=>!(c===0x200d||(c>=0x300&&c<=0x36f)||(c>=0xfe00&&c<=0xfe0f)||c<0x20));
  if(first===undefined) return 0;
  if(first<0x300) return first<0x20||(first>=0x7f&&first<=0x9f)||first===0xad?0:1;
  for(const [a,b] of WIDE) if(first>=a&&first<=b) return 2;
  return 1;
}
const vw=(s)=>{let w=0;for(const {segment} of seg.segment(s))w+=cw(segment);return w;};
const text=readFileSync(process.argv[2]+'/capture.bin','utf8');
const BSU='\x1b[?2026h', RESET='\x1b[0 q';
let t=text; const f=t.indexOf(BSU); const cut=f<0?-1:t.indexOf(RESET,f); if(cut>=0)t=t.slice(0,cut);
const parts=t.split(BSU).slice(1);
const RULE=/^(?:─{3}|-{3})(?:[ ─-]|$)/;
let flagged=0;
parts.forEach((raw,i)=>{
  const lines=strip(raw).replace(/\r\n|\r/g,'\n').split('\n');
  while(lines.length&&lines.at(-1)==='')lines.pop();
  let ri=-1; for(let k=lines.length-1;k>=0;k--) if(RULE.test(lines[k]??'')){ri=k;break;}
  if(ri<0) return;
  const W=vw(lines[ri]);
  const dyn=lines.slice(ri);
  const bad=dyn.map((l,k)=>({k,l,w:vw(l)})).filter(x=>/^[╭│├╰+|]/.test(x.l) && x.w!==W);
  if(bad.length){flagged++; if(flagged<=8){console.log(`frame ${i}: ruleW=${W}`); for(const b of bad) console.log(`   row${b.k} w=${b.w} |${b.l}`);}}
});
console.log(`frames with console rows whose width != ruleWidth: ${flagged} / ${parts.length}`);
