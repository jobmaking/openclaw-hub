import { openArtifactZip } from './artifact-zip.mjs?v=1';

const sheetNS = new Set(['http://schemas.openxmlformats.org/spreadsheetml/2006/main','http://purl.oclc.org/ooxml/spreadsheetml/main']);
const relBases = ['http://schemas.openxmlformats.org/officeDocument/2006/relationships','http://purl.oclc.org/ooxml/officeDocument/relationships'];
const pkgNS='http://schemas.openxmlformats.org/package/2006/relationships';
const ROW_CAP=5000, COL_CAP=128, CELL_CAP=50000, TEXT_CAP=1500000, XML_CAP=5*1024*1024;
const bad=()=>new Error('El libro no tiene una estructura Excel compatible.');
function xml(source, name, namespaces) {
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(source)) throw bad();
  const root=new DOMParser().parseFromString(source,'application/xml').documentElement;
  if(root?.localName!==name||!namespaces.has(root.namespaceURI))throw bad();
  return root;
}
function child(parent,name){
  if(parent)for(const n of parent.children) if(n.namespaceURI===parent.namespaceURI&&n.localName===name)return n;
  return null;
}
function *children(parent,name){
  if(parent)for(const n of parent.children) if(n.namespaceURI===parent.namespaceURI&&n.localName===name)yield n;
}
function partFor(base,reference) {
  if(typeof reference!=='string'||reference.length>420)return null;
  const ref=decodeURIComponent(reference);
  if(/[\\:#?\x00-\x1f]/u.test(ref))return null;
  const parts=ref.startsWith('/')?[]:base.split('/').slice(0,-1);
  for(const piece of ref.split('/')){
    if(!piece||piece==='.')continue;
    if(piece==='..'){if(!parts.length)return null;parts.pop();}else parts.push(piece);
  }
  const name=parts.join('/');
  return name.endsWith('.xml')?name:null;
}
async function relationships(zip,part,relPath){
  if(!zip.has(relPath))return new Map();
  const root=xml(await zip.text(relPath,256*1024),'Relationships',new Set([pkgNS]));
  const out=new Map();
  for(const node of children(root,'Relationship')){
    const id=node.getAttribute('Id'),type=node.getAttribute('Type');
    if(!id||!type||out.has(id))continue;
    if(node.hasAttribute('TargetMode')&&node.getAttribute('TargetMode')!=='Internal')continue;
    if(!relBases.some(base=>type.startsWith(base+'/')))continue;
    let name;
    try{name=partFor(part,node.getAttribute('Target'));}catch{continue;}
    if(name&&zip.has(name))out.set(id,{type:type.slice(type.lastIndexOf('/')+1),name});
  }
  return out;
}
function excelText(value){return value.replace(/_x([\da-f]{4})_/giu,(_,hex)=>String.fromCharCode(parseInt(hex,16))).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu,'�');}
function richText(node) {
  let text='';
  if(node)for(const part of node.children){
    if(part.namespaceURI!==node.namespaceURI)continue;
    if(part.localName==='t')text+=part.textContent;
    else if(part.localName==='r')text+=child(part,'t')?.textContent||'';
  }
  return excelText(text);
}
const builtIn=new Map([[9,'0%'],[10,'0.00%'],[14,'d/m/yyyy'],[15,'d/m/yyyy'],[16,'d/m'],[17,'m/yyyy'],[18,'h:mm'],[19,'h:mm:ss'],[20,'h:mm'],[21,'h:mm:ss'],[22,'d/m/yyyy h:mm'],[45,'mm:ss'],[46,'[h]:mm:ss'],[47,'mm:ss']]);
const regionalDate=id=>(id>=27&&id<=36)||(id>=50&&id<=58);
function numberPresentation(code) {
  if(!code)return null;
  const part=code.trim().split(';',1)[0].toLowerCase();
  const tokens=part.replace(/(?:"[^"]*"|\\.|_.|\*.)/gu,'').replace(/\[(?![hms]+\])[^\]]*\]/gu,'');
  if(tokens.includes('%'))return {kind:'percent',places:Math.min(8,/\.([0#?]+)/u.exec(tokens)?.[1].length||0)};
  const date=/[dy]|m{3,}/u.test(tokens),time=/[hs]/u.test(tokens);
  if(date||time)return {kind:'date',date,time,seconds:tokens.includes('s'),elapsed:/\[h+\]/u.test(tokens)};
  return null;
}
async function styleFormats(zip, styles) {
  if(!styles)return [];
  const root=xml(await zip.text(styles,512*1024),'styleSheet',sheetNS);
  const custom=new Map();
  for(const item of children(child(root,'numFmts'),'numFmt'))custom.set(Number(item.getAttribute('numFmtId')),item.getAttribute('formatCode'));
  return Array.from(children(child(root,'cellXfs'),'xf'),el=>{
    const id=Number(el.getAttribute('numFmtId'));
    return numberPresentation(custom.get(id)||builtIn.get(id)||(regionalDate(id)?'d/m/yyyy':''));
  });
}
const datePrinter=new Intl.DateTimeFormat('es-ES',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric'});
function displayNumber(raw, style, base1904) {
  if(!style||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?$/iu.test(raw))return raw;
  const n=Number(raw);
  if(!Number.isFinite(n))return raw;
  if(style.kind==='percent')return (n*100).toLocaleString('es-ES',{minimumFractionDigits:style.places,maximumFractionDigits:style.places})+' %';
  if(n<0||n>=2958466)return raw;
  const whole=Math.floor(n), seconds=Math.floor((n-whole)*86400+.00001);
  const pad=value=>String(value).padStart(2,'0');
  const clock=pad((style.elapsed?whole*24:0)+Math.floor(seconds/3600))+':'+pad(Math.floor(seconds/60)%60)+(style.seconds?':'+pad(seconds%60):'');
  if(!style.date)return clock;
  const time=Date.UTC(base1904?1904:1899,base1904?0:11,base1904?1:31)+(whole-(!base1904&&whole>59?1:0))*86400000;
  const written=!base1904&&whole===60?'29/02/1900':datePrinter.format(time);
  return written+(style.time?' '+clock:'');
}
function index(ref,fallbackRow,fallbackColumn){
  if(ref===null)return [fallbackRow,fallbackColumn];
  const hit=/^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(ref);
  if(!hit)return null;
  let col=0; for(const letter of hit[1])col=col*26+letter.charCodeAt(0)-64;
  return [Number(hit[2]),col];
}
function sheetValues(root, strings, styles, base1904) {
  const rows=new Map(), hidden=new Uint8Array(COL_CAP+1);
  for(const def of children(child(root,'cols'),'col')){
    if(!['1','true'].includes(def.getAttribute('hidden')))continue;
    const min=Number(def.getAttribute('min')),max=Number(def.getAttribute('max'));
    if(Number.isInteger(min)&&Number.isInteger(max)&&min>=1&&min<=max&&min<=COL_CAP)hidden.fill(1,min,Math.min(COL_CAP,max)+1);
  }
  let lastRow=0,lastColumn=0, limited=false, previousRow=0, count=0, total=0;
  outer:for(const row of children(child(root,'sheetData'),'row')){
    const r=Number(row.getAttribute('r'))||previousRow+1; previousRow=r;
    if(['1','true'].includes(row.getAttribute('hidden')))continue;
    let previousColumn=0;
    for(const cell of children(row,'c')){
      const where=index(cell.getAttribute('r'),r,previousColumn+1);
      if(!where)continue;
      const [ri,ci]=where;previousColumn=ci;
      const formula=child(cell,'f'), raw=child(cell,'v')?.textContent??'', t=cell.getAttribute('t');
      if(!raw&&!formula&&t!=='inlineStr')continue;
      if(ri<1||ci<1||hidden[ci])continue;
      if(ri>ROW_CAP||ci>COL_CAP){limited=true;continue;}
      let value;
      if(t==='s')value=strings[Number(raw)]??'';
      else if(t==='inlineStr')value=richText(child(cell,'is'));
      else if(t==='b')value=raw==='1'?'VERDADERO':raw==='0'?'FALSO':raw;
      else if(t==='str')value=excelText(raw);
      else if(t==='d'||t==='e')value=raw;
      else value=displayNumber(raw,styles[Number(cell.getAttribute('s'))],base1904);
      if(!value&&formula)value='Sin valor guardado';
      if(!value)continue;
      if(++count>CELL_CAP||total+value.length>TEXT_CAP){limited=true;break outer;}
      total+=value.length;
      let line=rows.get(ri);if(!line){line=new Map();rows.set(ri,line);}
      line.set(ci,value);
      lastRow=Math.max(lastRow,ri);lastColumn=Math.max(lastColumn,ci);
    }
  }
  return {rows,lastRow,lastColumn,limited};
}

export async function openWorkbook(data) {
  const zip=openArtifactZip(data);
  const rootLinks=await relationships(zip,'','_rels/.rels');
  const workbook=[...rootLinks.values()].find(r=>r.type==='officeDocument')?.name||(rootLinks.size===0&&zip.has('xl/workbook.xml')?'xl/workbook.xml':null);
  if(!workbook)throw bad();
  const root=xml(await zip.text(workbook,512*1024),'workbook',sheetNS);
  const slash=workbook.lastIndexOf('/')+1;
  const links=await relationships(zip,workbook,workbook.slice(0,slash)+'_rels/'+workbook.slice(slash)+'.rels');
  const getPart=type=>[...links.values()].find(r=>r.type===type)?.name;
  const base1904=['1','true'].includes(child(root,'workbookPr')?.getAttribute('date1904'));
  const definitions=[];
  for(const el of children(child(root,'sheets'),'sheet')){
    if(definitions.length>=128)throw bad();
    const id=relBases.map(ns=>el.getAttributeNS(ns,'id')).find(Boolean), part=links.get(id);
    if(!part||part.type!=='worksheet')continue;
    definitions.push({name:excelText((el.getAttribute('name')||'Hoja').slice(0,96)),visible:!['hidden','veryHidden'].includes(el.getAttribute('state')),path:part.name});
  }
  if(!definitions.length)throw bad();
  const strings=[], shared=getPart('sharedStrings');
  if(shared){
    for(const item of children(xml(await zip.text(shared,XML_CAP),'sst',sheetNS),'si')){
      if(strings.length>=120000)throw bad();
      strings.push(richText(item));
    }
  }
  const styles=await styleFormats(zip,getPart('styles'));
  let reading=Promise.resolve();
  return {
    sheets:definitions.map(({name,visible})=>({name,visible})),
    readSheet(i,signal){
      const next=reading.then(async()=>{
        signal?.throwIfAborted();
        if(!Number.isSafeInteger(i)||!definitions[i]?.visible)throw bad();
        const text=await zip.text(definitions[i].path,XML_CAP);
        signal?.throwIfAborted();
        return sheetValues(xml(text,'worksheet',sheetNS),strings,styles,base1904);
      });
      reading=next.then(()=>{},()=>{});
      return next;
    },
  };
}
