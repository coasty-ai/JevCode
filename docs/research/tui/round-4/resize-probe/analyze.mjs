import { readFileSync, existsSync } from 'node:fs';
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[c78=>]/g;
const RULE_RE = /^(?:─{3}|-{3})(?:[ ─-]|$)/;
const CURSOR_HIDE='\x1b[?25l', ERASE_SCREEN='\x1b[2J', ERASE_LINE='\x1b[2K', CURSOR_SHAPE_RESET='\x1b[0 q', BSU='\x1b[?2026h';
export function stripAnsi(s){return s.replace(ANSI_RE,'');}
function vw(s){ // visible width incl wide chars
  let w=0; for (const ch of s){const c=ch.codePointAt(0); if(c===undefined)continue;
    if(c===0x200d||(c>=0x300&&c<=0x36f)||(c>=0xfe00&&c<=0xfe0f)){continue;}
    const wide=(c>=0x1100&&c<=0x115f)||(c>=0x2e80&&c<=0xa4cf)||(c>=0xac00&&c<=0xd7a3)||(c>=0xf900&&c<=0xfaff)||(c>=0xfe30&&c<=0xfe6f)||(c>=0xff00&&c<=0xff60)||(c>=0xffe0&&c<=0xffe6)||(c>=0x1f300&&c<=0x1f64f)||(c>=0x1f900&&c<=0x1f9ff)||(c>=0x20000&&c<=0x3fffd);
    w+= wide?2:1;}
  return w;}
export function units(text,untilRestore=true){
  let t=text;
  if(untilRestore){const f=t.indexOf(CURSOR_HIDE);const cut=f<0?-1:t.indexOf(CURSOR_SHAPE_RESET,f); if(cut>=0)t=t.slice(0,cut);}
  const parts=t.split(/(?=\x1b\[\?25l|\x1b\[2J)/);
  return parts.map((raw,index)=>{
    const stripped=stripAnsi(raw).replace(/\r\n|\r/g,'\n');
    const lines=stripped.split('\n');
    while(lines.length>0&&lines.at(-1)==='')lines.pop();
    let ruleIndex=-1;
    for(let i=lines.length-1;i>=0;i--){if(RULE_RE.test(lines[i]??'')){ruleIndex=i;break;}}
    const rule=ruleIndex>=0?lines[ruleIndex]??'':null;
    const head=/^(?:\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x1f\x7f])*/.exec(raw)?.[0]??'';
    return {index,raw,lines,clears:raw.split(ERASE_SCREEN).length-1,erased:head.split(ERASE_LINE).length-1,ruleIndex,
      rows:ruleIndex>=0?lines.length-ruleIndex:null, ruleWidth:rule===null?null:vw(rule),
      staticRows:ruleIndex>=0?lines.slice(0,ruleIndex):index===0?lines:[]};
  });
}
export function syncFrames(text){
  let t=text; const f=t.indexOf(BSU); const cut=f<0?-1:t.indexOf(CURSOR_SHAPE_RESET,f); if(cut>=0)t=t.slice(0,cut);
  const parts=t.split(BSU).slice(1);
  return parts.map((raw,index)=>{
    const lines=stripAnsi(raw).replace(/\r\n|\r/g,'\n').split('\n');
    while(lines.length>0&&lines.at(-1)==='')lines.pop();
    let ruleIndex=-1;
    for(let i=lines.length-1;i>=0;i--){if(RULE_RE.test(lines[i]??'')){ruleIndex=i;break;}}
    return {index,raw,lines,ruleIndex,dynamic:ruleIndex>=0?lines.slice(ruleIndex):[],clears:raw.split(ERASE_SCREEN).length-1};
  });
}
const dir=process.argv[2];
const mode=process.argv[3]??'summary';
const cap=`${dir}/capture.bin`;
if(!existsSync(cap)){console.log('NO CAPTURE');process.exit(0);}
const text=readFileSync(cap,'utf8');
const us=units(text);
const fr=us.filter(u=>u.rows!==null);
const sf=syncFrames(text);
const timing=existsSync(`${dir}/timing.jsonl`)?readFileSync(`${dir}/timing.jsonl`,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
const forbidden=(text.match(/\x1b\[\?1049[hl]|\x1bc/g)??[]).length;
if(mode==='summary'){
  console.log(`bytes=${text.length} units=${us.length} frames=${fr.length} syncFrames=${sf.length} totalClears=${us.reduce((a,u)=>a+u.clears,0)} forbidden(altscreen/RIS)=${forbidden}`);
  // group frames by ruleWidth in order -> segments
  const segs=[];
  const sfr=sf.filter(f=>f.ruleIndex>=0).map(f=>({index:f.index,clears:f.clears,rows:f.lines.length-f.ruleIndex,ruleWidth:(f.lines[f.ruleIndex]??'').length}));
  for(const f of sfr){const last=segs.at(-1); if(last&&last.w===f.ruleWidth)  {last.n++;last.clears+=f.clears;last.maxRows=Math.max(last.maxRows,f.rows);last.idx.push(f.index);} else segs.push({w:f.ruleWidth,n:1,clears:f.clears,maxRows:f.rows,idx:[f.index]});}
  console.log('segments (ruleWidth x frames, clears, maxDynRows):');
  for(const s of segs)console.log(`  w=${s.w} frames=${s.n} clears=${s.clears} maxDynRows=${s.maxRows} firstUnit=${s.idx[0]} lastUnit=${s.idx.at(-1)}`);
  console.log('timing ops:', timing.map(r=>`${r.op}${r.arg?'('+r.arg.slice(0,24)+')':''}@${r.t}`).join(' '));
}else if(mode==='frames'){
  const from=Number(process.argv[4]??0), to=Number(process.argv[5]??fr.length);
  for(const f of fr.slice(from,to)){
    console.log(`--- unit ${f.index} clears=${f.clears} erased=${f.erased} dynRows=${f.rows} ruleW=${f.ruleWidth} staticRows=${f.staticRows.length}`);
    for(const l of f.lines.slice(Math.max(0,f.ruleIndex)))console.log(`   |${l}`);
  }
}else if(mode==='sync'){
  const from=Number(process.argv[4]??0), to=Number(process.argv[5]??sf.length);
  for(const f of sf.slice(from,to)){
    console.log(`=== syncframe ${f.index} clears=${f.clears} lines=${f.lines.length} dyn=${f.dynamic.length}`);
    for(const l of f.lines)console.log(`   |${l}`);
  }
}else if(mode==='last'){
  const n=Number(process.argv[4]??1);
  for(const f of sf.slice(-n)){console.log(`=== syncframe ${f.index} clears=${f.clears}`);for(const l of f.lines)console.log(`   |${l}`);}
}else if(mode==='raw'){
  process.stdout.write(stripAnsi(text));
}
