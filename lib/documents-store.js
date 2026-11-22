'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FORMATS = Object.freeze(['pdf', 'docx', 'md']);
const KINDS = new Set(['paragraph', 'heading', 'bullet', 'number', 'quote', 'header', 'footer', 'table']);
const FRAME = new Set(['header', 'footer']);
const MAX_ROWS=80, MAX_COLS=12, MAX_CELLS=320, MAX_FRAME=1600;
const structured = content => content.blocks.some(b => FRAME.has(b.kind) || b.kind==='table' || b.level!==undefined);
const ID = /^[A-Za-z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const ARTIFACT = /^hubdoc_[a-f0-9-]{36}$/;
const MAX_TEXT = 32_000;
const MAX_BLOCK = 12_000;
const MAX_EXPORT = 6 * 1024 * 1024;
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', md: 'text/markdown; charset=utf-8' };
class DocumentError extends Error {
  constructor(status, message, document) { super(message); this.status = status; this.document = document; }
}
const error = (status, message, document) => { throw new DocumentError(status, message, document); };
const parse = value => value ? JSON.parse(value) : null;
const sha = value => createHash('sha256').update(value).digest('hex');
const signed = value => sha(JSON.stringify(value));
const scopeKey = ({ user, agent, key, sessionId }) => JSON.stringify([user, agent, key, sessionId]);
function plain(value, max, label, { nonempty = false, line = false } = {}) {
  if (typeof value !== 'string' || value.length > max || !value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
      || (line && /[\r\n\t]/u.test(value)) || (nonempty && !value.trim())) error(400, label);
  return value.replace(/\r\n?/gu, '\n');
}
function snapshot(input) {
  const title = plain(input?.title, 160, 'El título debe tener entre 1 y 160 caracteres', { nonempty: true, line: true }).trim();
  if (!Array.isArray(input?.blocks) || input.blocks.length < 1 || input.blocks.length > 160) error(400, 'Usa entre 1 y 160 bloques');
  const known = new Set(), frames = new Set(); let length = 0, cells = 0;
  function id(value){
    if(typeof value!=='string'||!ID.test(value)||known.has(value))error(400,'Identificador de bloque o celda inválido');
    known.add(value);return value;
  }
  function text(value,limit=MAX_BLOCK){
    const result=plain(value,limit,'Un bloque supera el límite de edición o contiene caracteres inválidos');
    length+=result.length;return result;
  }
  const blocks = input.blocks.map(block => {
    if (!block || !KINDS.has(block.kind)) error(400, 'Bloque de documento inválido');
    const base={id:id(block.id),kind:block.kind};
    if(block.kind==='table'){
      if(!Array.isArray(block.rows)||!block.rows.length||block.rows.length>MAX_ROWS)error(400,'La tabla debe tener entre 1 y 80 filas');
      let columns;
      const rows=block.rows.map(row=>{
        if(!row||!Array.isArray(row.cells)||!row.cells.length||row.cells.length>MAX_COLS||
           (row.header!==undefined&&typeof row.header!=='boolean'))error(400,'Fila de tabla inválida');
        let width=0;
        const values=row.cells.map(cell=>{
          if(!cell||++cells>MAX_CELLS)error(400,'El documento admite hasta 320 celdas');
          const span=cell.span===undefined?1:cell.span;
          if(!Number.isSafeInteger(span)||span<1||span>MAX_COLS)error(400,'Combinación de celdas inválida');
          width+=span;return {id:id(cell.id),text:text(cell.text),...(span===1?{}:{span})};
        });
        if(width>MAX_COLS||(columns!==undefined&&width!==columns))error(400,'Todas las filas deben tener el mismo ancho (hasta 12 columnas)');
        columns=width;
        return {cells:values,...(row.header===true?{header:true}:{})};
      });
      return {...base,rows};
    }
    const frame=FRAME.has(block.kind);
    if(frame){
      if(frames.has(block.kind))error(400,'Usa un encabezado y un pie como máximo');
      frames.add(block.kind);
    }
    if(block.pageNumber!==undefined&&(block.kind!=='footer'||typeof block.pageNumber!=='boolean'))error(400,'Numeración de página inválida');
    if(block.level!==undefined&&(block.kind!=='heading'||!Number.isSafeInteger(block.level)||block.level<1||block.level>6))error(400,'Nivel de título inválido');
    return {...base,text:text(block.text,frame?MAX_FRAME:MAX_BLOCK),...(block.level>1?{level:block.level}:{}),...(block.pageNumber?{pageNumber:true}:{})};
  });
  if (length > MAX_TEXT) error(413, 'El documento supera los 32.000 caracteres');
  if(blocks.every(b=>FRAME.has(b.kind)))error(400,'Añade contenido al cuerpo del documento');
  return { title, blocks };
}
function anchorTarget(content,{blockId,cellId}) {
  const block=content.blocks.find(item=>item.id===blockId);
  if(block?.kind==='table'){
    if(!ID.test(typeof cellId==='string'?cellId:''))return {};
    const cell=block.rows.flatMap(r=>r.cells).find(c=>c.id===cellId);
    return {block,field:cell};
  }
  return cellId===undefined?{block,field:block}:{};
}
function anchorFor(content, data) {
  const { blockId, cellId, start, end } = data;
  const {block,field}=anchorTarget(content,data);
  const quote = plain(data.quote,3500,'Selecciona entre 1 y 3.500 caracteres del mismo bloque o celda',{nonempty:true});
  if(!field||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>field.text.length||field.text.slice(start,end)!==quote)
    error(409,'La selección ya no corresponde al documento guardado');
  return {blockId,...(cellId?{cellId}:{}),kind:block.kind,source:field.text,start,end,before:quote};
}
function matches(content, anchor) {
  const {block,field}=anchorTarget(content,anchor);
  return block?.kind===anchor.kind&&field?.text===anchor.source&&field.text.slice(anchor.start,anchor.end)===anchor.before;
}
function insertion(content, anchor, replacement) {
  if(!matches(content,anchor))error(409,'La selección ya no corresponde al documento guardado');
  const copy=structuredClone(content),{field}=anchorTarget(copy,anchor);
  field.text=field.text.slice(0,anchor.start)+replacement+field.text.slice(anchor.end);
  return snapshot(copy);
}
function localName(title, revision, format) {
  const stem = title.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '').slice(0, 96);
  return (stem || 'Documento') + '-v' + revision + '.' + format;
}

class DocumentStore {
  constructor(dataDir) {
    // The Hub is a single writer. The directory is runtime-only and not in public/.
    const home = path.join(dataDir, 'documents');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = path.join(home, 'documents.sqlite3');
    try { fs.closeSync(fs.openSync(file, 'wx', 0o600)); } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    const { DatabaseSync } = require('node:sqlite');
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) throw Error('Unsupported documents schema version');
    this.db.exec(
      'BEGIN IMMEDIATE;'+
      'CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL, n INTEGER NOT NULL, hash TEXT NOT NULL, title TEXT NOT NULL, updated INTEGER NOT NULL, proposal TEXT, job TEXT);'+
      'CREATE INDEX IF NOT EXISTS docs_scope ON docs(scope,updated DESC);'+
      'CREATE INDEX IF NOT EXISTS docs_owner ON docs(owner);'+
      'CREATE TABLE IF NOT EXISTS revisions (doc TEXT NOT NULL REFERENCES docs(id), n INTEGER NOT NULL, hash TEXT NOT NULL, snapshot TEXT NOT NULL, actor TEXT NOT NULL, t INTEGER NOT NULL, review TEXT, approval TEXT, PRIMARY KEY(doc,n), UNIQUE(doc,hash));'+
      'CREATE TABLE IF NOT EXISTS ops (scope TEXT NOT NULL, id TEXT NOT NULL, signature TEXT NOT NULL, doc TEXT NOT NULL REFERENCES docs(id), artifact TEXT, t INTEGER NOT NULL, PRIMARY KEY(scope,id));'+
      'CREATE INDEX IF NOT EXISTS ops_recent ON ops(doc,t DESC);'+
      'CREATE TABLE IF NOT EXISTS outputs (id TEXT PRIMARY KEY, doc TEXT NOT NULL REFERENCES docs(id), rev TEXT NOT NULL, format TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, sha TEXT NOT NULL, data BLOB NOT NULL, route TEXT NOT NULL, t INTEGER NOT NULL, UNIQUE(doc,rev,format));'+
      'CREATE INDEX IF NOT EXISTS outputs_doc ON outputs(doc,t DESC);'+
      'CREATE TABLE IF NOT EXISTS offers (id TEXT PRIMARY KEY, scope TEXT NOT NULL, op TEXT NOT NULL, signature TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, data TEXT, state TEXT NOT NULL, t INTEGER NOT NULL, doc TEXT REFERENCES docs(id), UNIQUE(scope,op));'+
      'CREATE INDEX IF NOT EXISTS offers_scope ON offers(scope,t DESC);'+
      'PRAGMA user_version=2; COMMIT;');
    this.db.exec('PRAGMA max_page_count=262144;');
  }
  close() { this.db.close(); }
  p(sql) { return this.db.prepare(sql); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (cause) { this.db.exec('ROLLBACK'); throw cause; }
  }
  row(scope, id) { return this.p('SELECT * FROM docs WHERE id=? AND scope=?').get(id, scope); }
  require(scope, id) { return this.row(scope, id) || error(404, 'No se encontró el documento en esta conversación'); }
  rev(id, n) { return this.p('SELECT * FROM revisions WHERE doc=? AND n=?').get(id, n); }
  revisionAt(id, hash) { return this.p('SELECT * FROM revisions WHERE doc=? AND hash=?').get(id, hash); }
  content(row) { return parse(this.rev(row.id, row.n).snapshot); }
  list(scope) {
    return this.p('SELECT d.id,d.title,d.n AS revision,d.updated AS updatedAt,(r.approval IS NOT NULL) AS conformable FROM docs d JOIN revisions r ON d.id=r.doc AND d.n=r.n WHERE d.scope=? ORDER BY d.updated DESC,d.id').all(scope)
      .map(item => ({ ...item, conformable: Boolean(item.conformable) }));
  }
  project(row, running) {
    const rev = this.rev(row.id, row.n);
    const active = parse(row.job);
    const job = active?.state === 'running' && !running?.has(active.id) ? { id: active.id, action: active.action, state: 'failed', error: 'La revisión se interrumpió; puedes pedirla otra vez' } : active;
    const p = parse(row.proposal);
    const proposal = p ? Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'source' && key !== 'kind')) : null;
    const history = this.p('SELECT n AS revision,hash,actor,t AS updatedAt FROM revisions WHERE doc=? ORDER BY n DESC LIMIT 120').all(row.id);
    return { id: row.id, ...parse(rev.snapshot), revision: row.n, hash: row.hash, updatedAt: row.updated, history,
      proposal, review: parse(rev.review), approval: parse(rev.approval), job, formats: FORMATS };
  }
  op(scope, id, signature) {
    if (!ID.test(typeof id === 'string' ? id : '')) error(400, 'Falta el identificador de operación');
    const row = this.p('SELECT signature,doc,artifact FROM ops WHERE scope=? AND id=?').get(scope, id);
    if (row && row.signature !== signature) error(409, 'Esa operación ya se utilizó con otros datos');
    return row;
  }
  record(scope, id, signature, doc, artifact = null) {
    this.p('INSERT INTO ops VALUES (?,?,?,?,?,?)').run(scope,id,signature,doc,artifact,Date.now());
    // A bounded durable replay window; keep the create receipt for this document.
    this.p('DELETE FROM ops WHERE doc=? AND rowid NOT IN (SELECT rowid FROM ops WHERE doc=? ORDER BY rowid DESC LIMIT 800) AND rowid!=(SELECT MIN(rowid) FROM ops WHERE doc=?)').run(doc,doc,doc);
  }
  checkBase(row, base, running) {
    if (typeof base !== 'string' || !HASH.test(base)) error(400, 'Falta la revisión de partida');
    if (row.hash !== base) error(409, 'El documento cambió en otra pestaña. Conserva tu texto y revisa la versión guardada.', this.project(row, running));
  }
  append(row, content, actor, bump = false) {
    if (!bump && signed(content) === signed(this.content(row))) return row;
    if (row.n >= 1500) error(409, 'El documento alcanzó el límite de revisiones. Conserva el original y crea una copia.');
    const n = row.n + 1, updated = Date.now(), hash = signed([row.id, n, content]);
    const proposal = parse(row.proposal);
    if (proposal && (bump || !matches(content, proposal))) proposal.status = 'stale';
    this.p('INSERT INTO revisions(doc,n,hash,snapshot,actor,t) VALUES (?,?,?,?,?,?)').run(row.id,n,hash,JSON.stringify(content),actor,updated);
    this.p('UPDATE docs SET n=?,hash=?,title=?,updated=?,proposal=? WHERE id=?').run(n,hash,content.title,updated,proposal ? JSON.stringify(proposal) : null,row.id);
    return { ...row, n, hash, title: content.title, updated, proposal: proposal ? JSON.stringify(proposal) : null };
  }
  create(scope, user, content, opId, signature) {
    return this.atomic(() => {
      const replay = this.op(scope,opId,signature);
      if (replay) return this.require(scope,replay.doc);
      if (this.p('SELECT count(*) AS n FROM docs WHERE scope=?').get(scope).n >= 24 || this.p('SELECT count(*) AS n FROM docs WHERE owner=?').get(user).n >= 200) error(409, 'Se alcanzó el límite de documentos del piloto');
      const id = randomUUID(), n = 1, updated = Date.now(), hash = signed([id,n,content]);
      this.p('INSERT INTO docs(id,scope,owner,n,hash,title,updated) VALUES (?,?,?,?,?,?,?)').run(id,scope,user,n,hash,content.title,updated);
      this.p('INSERT INTO revisions(doc,n,hash,snapshot,actor,t) VALUES (?,?,?,?,?,?)').run(id,n,hash,JSON.stringify(content),'Tú',updated);
      this.record(scope,opId,signature,id);
      return this.require(scope,id);
    });
  }
  update(scope, id, content, data, running) {
    const signature = signed(['update',id,data.base,content]);
    return this.atomic(() => {
      let row = this.require(scope,id);
      if (this.op(scope,data.opId,signature)) return row;
      this.checkBase(row,data.base,running);
      row = this.append(row,content,'Tú');
      this.record(scope,data.opId,signature,id); return row;
    });
  }
  set(row, fields) {
    const proposal = fields.proposal === undefined ? row.proposal : fields.proposal && JSON.stringify(fields.proposal);
    const job = fields.job === undefined ? row.job : fields.job && JSON.stringify(fields.job);
    this.p('UPDATE docs SET proposal=?,job=? WHERE id=?').run(proposal,job,row.id);
  }
  resolve(row, data, running) {
    const p = parse(row.proposal);
    if (!p || data.proposalId !== p.id) error(409, 'La propuesta ya fue resuelta o cambió', this.project(row,running));
    if (data.decision === 'discard') { this.set(row,{ proposal: null }); return; }
    if (data.decision !== 'apply') error(400, 'Decisión de revisión inválida');
    if (p.status !== 'pending' || !matches(this.content(row),p)) error(409, 'El bloque cambió. Pide otra propuesta sobre el texto actual.', this.project(row,running));
    this.append(row,insertion(this.content(row),p,p.after),'Tú · propuesta aplicada',true);
    this.set(this.require(row.scope,row.id),{ proposal: null });
  }
  approve(row) {
    const rev = this.rev(row.id,row.n);
    if (row.proposal || parse(rev.review)?.verdict !== 'approved') error(409, 'La revisión debe tener el visto bueno editorial y no tener propuestas pendientes');
    if (!rev.approval) this.p('UPDATE revisions SET approval=? WHERE doc=? AND n=?').run(JSON.stringify({ hash: row.hash, at: Date.now() }),row.id,row.n);
  }
  retireApproval(row) {
    this.p('UPDATE revisions SET review=NULL, approval=NULL WHERE doc=? AND n=? AND approval IS NULL').run(row.id,row.n);
  }
  storeReview(row, value) {
    this.p('UPDATE revisions SET review=? WHERE doc=? AND n=? AND approval IS NULL').run(JSON.stringify(value),row.id,row.n);
  }
  anchorChanged(row, original, anchor) {
    if (!matches(this.content(row),anchor)) return true;
    return this.p('SELECT n,snapshot,actor FROM revisions WHERE doc=? AND n>? ORDER BY n DESC LIMIT 121').all(row.id,original)
      .some(item => item.n > original + 120 || item.actor.startsWith('Tú · restauración') || !matches(parse(item.snapshot),anchor));
  }
  outputs(scope) {
    return this.p('SELECT o.id,o.name,o.mime,o.format,length(o.data) AS amount FROM outputs o JOIN docs d ON o.doc=d.id WHERE d.scope=? ORDER BY o.t DESC LIMIT 200').all(scope).map(item => this.artifact(item));
  }
  artifact(item) { return { id: item.id, title: item.name, fileName: item.name, mimeType: item.mime, type: 'file', sizeBytes: item.amount, downloadSupported: true, source: 'hub-document' }; }
  output(scope,id) { return this.p('SELECT o.* FROM outputs o JOIN docs d ON o.doc=d.id WHERE d.scope=? AND o.id=?').get(scope,id); }
  existing(doc, hash, format) { return this.p('SELECT id,name,mime,length(data) AS amount FROM outputs WHERE doc=? AND rev=? AND format=?').get(doc,hash,format); }
  commitOutput(scope, id, rev, format, file, route, data, signature) {
    return this.atomic(() => {
      this.require(scope,id);
      const replay = this.op(scope,data.opId,signature);
      if (replay?.artifact) return this.artifactForId(scope,replay.artifact);
      if (!parse(this.revisionAt(id,rev.hash)?.approval)?.hash || parse(this.revisionAt(id,rev.hash)?.approval)?.hash !== rev.hash) error(409, 'La revisión ya no está disponible para exportar');
      let item = this.existing(id,rev.hash,format);
      if (!item) {
        if (!Buffer.isBuffer(file?.bytes) || !file.bytes.length || file.bytes.length > MAX_EXPORT || file.extension !== format || file.mimeType !== MIME[format]) throw Error('Invalid or oversized renderer output');
        const artifact = 'hubdoc_' + randomUUID();
        const name = localName(parse(rev.snapshot).title,rev.n,format);
        this.p('INSERT INTO outputs VALUES (?,?,?,?,?,?,?,?,?,?)').run(artifact,id,rev.hash,format,name,file.mimeType,sha(file.bytes),file.bytes,route,Date.now());
        item = { id: artifact, name, mime: file.mimeType, amount: file.bytes.length };
      }
      this.record(scope,data.opId,signature,id,item.id);
      return this.artifact(item);
    });
  }
  artifactForId(scope, id) {
    const row = this.p('SELECT o.id,o.name,o.mime,length(o.data) AS amount FROM outputs o JOIN docs d ON o.doc=d.id WHERE d.scope=? AND o.id=?').get(scope,id);
    return row ? this.artifact(row) : null;
  }
}
module.exports = { FORMATS, ARTIFACT, MAX_BLOCK, MAX_TEXT, DocumentError, DocumentStore, error, parse, sha, signed, scopeKey, snapshot, structured, anchorFor, matches, insertion, plain };
