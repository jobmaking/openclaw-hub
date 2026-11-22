import { openArtifactZip } from './artifact-zip.mjs?v=1';

const W='http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG='http://schemas.openxmlformats.org/package/2006/relationships';
const unavailable=()=>new Error('No se pudo abrir este Word. El original sigue disponible en «Descargar».');
const w=(node,tag)=>node?.namespaceURI===W && node.localName===tag;
const child=(node,tag)=>node&&Array.from(node.children).find(n=>w(n,tag));
const attr=(node,key)=>node?.getAttributeNS(W,key);
const enabled=(node,tag)=>{const n=child(node,tag);return Boolean(n&&!['0','false','off'].includes(attr(n,'val')));};

function rootOf(xml,kind,namespace=W){
  if(/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml))throw unavailable();
  const doc=new DOMParser().parseFromString(xml,'application/xml');
  const root=doc.documentElement;
  if(root?.namespaceURI!==namespace||root.localName!==kind)throw unavailable();
  return root;
}
async function stylesFor(zip){
  if(!zip.has('word/styles.xml'))return ()=>({});
  const styleRoot=rootOf(await zip.text('word/styles.xml',512*1024),'styles');
  const styles=new Map();
  for(const s of styleRoot.children){
    if(!w(s,'style'))continue;
    const rp=child(s,'rPr'), pp=child(s,'pPr');
    styles.set(attr(s,'styleId'),{parent:attr(child(s,'basedOn'),'val'),
      hidden:enabled(rp,'vanish')||enabled(rp,'webHidden'),numbered:!!child(pp,'numPr')});
  }
  return id=>{
    let hidden=false,numbered=false;
    for(let n=0;id&&n<20;n++){
      const style=styles.get(id);if(!style)break;
      hidden=hidden||style.hidden;numbered=numbered||style.numbered;id=style.parent;
    }
    return {hidden,numbered};
  };
}

const ignored=new Set(['pPr','rPr','proofErr','bookmarkStart','bookmarkEnd','lastRenderedPageBreak']);
const wrappers=new Set(['r','hyperlink','smartTag','sdt','sdtContent','customXml','fldSimple','ins','moveTo']);
const marked=new Set(['fldSimple','ins','del','moveTo','moveFrom','fldChar','instrText','commentRangeStart','commentRangeEnd','commentReference']);

export async function readWord(data){
  if(!(data instanceof Uint8Array)||data.length>2*1024*1024)throw unavailable();
  const zip=openArtifactZip(data);
  const root=rootOf(await zip.text('word/document.xml',512*1024),'document');
  const body=child(root,'body');if(!body)throw unavailable();
  const style=await stylesFor(zip);
  let elements=0, chars=0, canEdit=true, partial=false;
  const refs=[];
  const omit=()=>{partial=true;canEdit=false;};
  const bounded=()=>{if(++elements>8500)throw unavailable();};
  function paragraph(p,inside,area){
    const prop=child(p,'pPr'), id=attr(child(prop,'pStyle'),'val')||'';
    const defaults=style(id);
    if(inside&&child(prop,'sectPr'))section(child(prop,'sectPr'));
    if(defaults.hidden){omit();return null;}
    if(defaults.numbered||child(prop,'numPr'))omit(); // Do not invent numbering.
    const tokens=[];let pageNumber=false;
    function add(text){
      if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text))throw unavailable();
      if(pageNumber&&text.trim())omit();
      chars+=text.length;if(chars>96000)throw unavailable();tokens.push(text);
    }
    function visit(n,depth){
      bounded();if(depth>14||n.namespaceURI!==W){omit();return;}
      const tag=n.localName;
      if(ignored.has(tag)||tag==='sdtPr')return;
      if(tag==='fldSimple'&&area==='footer'&&!pageNumber&&/^\s*PAGE(?:\s+\\\*\s+MERGEFORMAT)?\s*$/iu.test(attr(n,'instr')||'')){
        pageNumber=true;return;
      }
      if(tag==='t'){if(n.childElementCount)throw unavailable();add(n.textContent);return;}
      if(tag==='tab'){add('\t');return;}
      if(tag==='br'||tag==='cr'){add('\n');return;}
      if(tag==='noBreakHyphen'){add('\u2011');return;}
      if(tag==='softHyphen'){add('\u00ad');return;}
      if(tag==='r'){
        const rp=child(n,'rPr');
        if(enabled(rp,'vanish')||enabled(rp,'webHidden')||style(attr(child(rp,'rStyle'),'val')).hidden){omit();return;}
      }
      if(marked.has(tag)){
        canEdit=false;
        // Keep only a normal field's saved display text, never its instruction or deleted revision.
        if(!['fldSimple','fldChar','instrText'].includes(tag))partial=true;
      }
      if(!wrappers.has(tag)){omit();return;}
      for(const sub of n.children)visit(sub,depth+1);
    }
    for(const n of p.children)visit(n,0);
    const heading=/^(?:heading|t[ií]tulo)\s*([1-6])$/iu.exec(id);
    const level=/^(?:title|t[ií]tulo)$/iu.test(id)?1:heading?Number(heading[1]):0;
    return {kind:'paragraph',text:tokens.join(''),level,...(pageNumber?{pageNumber:true}:{})};
  }
  function section(properties){
    for(const n of properties.children)if(w(n,'headerReference')||w(n,'footerReference')){
      if(refs.length>=24){omit();break;}
      refs.push({id:n.getAttributeNS(R,'id'),type:attr(n,'type')||'default',part:w(n,'headerReference')?'header':'footer'});
    }
  }
  function flow(parent,inside,depth=0,area=null){
    if(depth>3){omit();return [];}
    const result=[];
    for(const node of parent.children){
      bounded();
      if(w(node,'p')){const p=paragraph(node,inside,area);if(p)result.push(p);}
      else if(w(node,'sectPr')&&inside)section(node);
      else if(w(node,'tbl')){
        if(!inside||depth)canEdit=false;
        const rows=[];
        for(const row of node.children){
          bounded();if(w(row,'tblGrid')||w(row,'tblPr'))continue;
          if(!w(row,'tr')){omit();continue;}
          const cells=[];
          for(const cell of row.children){
            bounded();if(w(cell,'trPr')||w(cell,'tblPrEx'))continue;
            if(!w(cell,'tc')){omit();continue;}
            const properties=child(cell,'tcPr');
            const span=Number(attr(child(properties,'gridSpan'),'val')||1);
            if(!Number.isSafeInteger(span)||span<1||span>32||child(properties,'vMerge')||child(properties,'hMerge'))omit();
            cells.push({items:flow(cell,inside,depth+1),span:Number.isSafeInteger(span)&&span>=1&&span<=32?span:1});
            if(cells.length>64)throw unavailable();
          }
          rows.push({header:enabled(child(row,'trPr'),'tblHeader'),cells});
        }
        result.push({kind:'table',rows});
      } else if(w(node,'tcPr'))continue;
      else if(w(node,'sdt')){
        if(inside)canEdit=false;
        const contents=child(node,'sdtContent');if(contents)result.push(...flow(contents,inside,depth+1));else omit();
      } else omit();
    }
    return result;
  }
  const content=flow(body,true);
  const bodyChars=chars;
  const notes=[];
  if(refs.length){
    const relations=new Map();
    if(zip.has('word/_rels/document.xml.rels')){
      const rel=rootOf(await zip.text('word/_rels/document.xml.rels',128*1024),'Relationships',PKG);
      for(const n of rel.children){
        if(n.namespaceURI!==PKG||n.localName!=='Relationship')continue;
        const id=n.getAttribute('Id');if(relations.has(id))throw unavailable();relations.set(id,n);
      }
    }
    const shown=new Set();
    for(const {id,part,type} of refs){
      if(type!=='default')canEdit=false;
      const r=relations.get(id), target=r?.getAttribute('Target')||'';
      const match=/^(?:\/word\/)?((?:header|footer)[a-z0-9_-]{0,50}\.xml)$/iu.exec(target);
      if(r?.getAttribute('Type')!==R+'/'+part||!match||!match[1].startsWith(part)||
         (r.getAttribute('TargetMode')||'Internal')!=='Internal'||!zip.has('word/'+match[1])){omit();continue;}
      if(shown.has(match[1]))continue;
      if(shown.size===8){omit();break;}
      shown.add(match[1]);
      const note=rootOf(await zip.text('word/'+match[1],96*1024),part==='header'?'hdr':'ftr');
      notes.push({part,items:flow(note,false,0,part)});
    }
  }
  if(!chars&&!notes.some(n=>n.items.some(p=>p.pageNumber)))throw unavailable();
  const normalizePart=(part,items)=>{
    if(items.some(p=>p.kind!=='paragraph'))return null;
    const page=items.findIndex(p=>p.pageNumber);
    if(page>=0&&(part!=='footer'||page!==items.length-1))return null;
    const text=items.map(p=>p.text).join('\n');
    return text.length<=1600?{kind:part,text,...(page>=0?{pageNumber:true}:{})}:null;
  };
  const frame={};let framesLength=0, cellCount=0;
  for(const note of notes){
    if(frame[note.part]){canEdit=false;continue;}
    frame[note.part]=normalizePart(note.part,note.items);
    if(!frame[note.part])canEdit=false;else framesLength+=frame[note.part].text.length;
  }
  function asBlock(item){
    if(item.kind==='paragraph'){
      if(item.text.length>12000)return null;
      return {kind:item.level?'heading':'paragraph',text:item.text,...(item.level>1?{level:item.level}:{})};
    }
    if(item.rows.length<1||item.rows.length>80)return null;
    let columns;
    const rows=[];
    for(const row of item.rows){
      const width=row.cells.reduce((n,c)=>n+c.span,0);
      if(width<1||width>12||(columns!==undefined&&width!==columns))return null;
      columns=width;const cells=[];
      for(const cell of row.cells){
        if(++cellCount>320||cell.items.some(p=>p.kind!=='paragraph'))return null;
        const text=cell.items.map(p=>p.text).join('\n');if(text.length>12000)return null;
        cells.push({text,...(cell.span>1?{span:cell.span}:{})});
      }
      rows.push({cells,...(row.header?{header:true}:{})});
    }
    return {kind:'table',rows};
  }
  const bodyBlocks=canEdit?content.map(asBlock):[];
  const blocks=[frame.header,...bodyBlocks,frame.footer].filter(Boolean);
  const editable=canEdit&&bodyChars+framesLength<=32000&&blocks.length<=160&&bodyBlocks.length&&bodyBlocks.every(Boolean)&&content.length>0;
  return {content,notes,partial,blocks:editable?blocks:null,framed:refs.length>0};
}
