'use strict';
(() => {
  // Import only visible body text. The attached original remains downloadable, unchanged.
  const MAX_BYTES = 2 * 1024 * 1024;
  const MAX_TEXT = 32000, MAX_BLOCK = 12000, MAX_BLOCKS = 160;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reject = () => new Error('Este Word no se puede copiar completo al editor. Conserva el archivo original con «Descargar».');
  async function readBounded(stream, maximum, expected) {
    if (!stream) throw reject();
    const reader = stream.getReader(), chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maximum) throw reject();
        chunks.push(value);
      }
      if (expected !== null && total !== expected) throw reject();
      const output = new Uint8Array(total); let at = 0;
      for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; }
      return output;
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
  async function unpack(data, filename) {
    if (!(data instanceof Uint8Array) || data.length > MAX_BYTES || !data.length || typeof filename !== 'string') throw reject();
    const title = filename.replace(/\.[^.]+$/u,'').replace(/---[a-f0-9-]{36}$/iu,'').replace(/[\x00-\x1f\x7f]/gu,' ').trim().slice(0,160).replace(/[\ud800-\udbff]$/u,'') || 'Documento';
    if (/\.docx$/iu.test(filename)) {
      const {readWord}=await import('./artifact-word.mjs?v=1');
      const word=await readWord(data);
      return {title,blocks:word.blocks,word:word.blocks?null:word};
    }
    let blocks;
    if (/\.(?:md|markdown|txt)$/iu.test(filename)) {
      const text = decoder.decode(data).replace(/\r\n?/gu, '\n');
      blocks = [];
      for (let i=0; i<text.length;) {
        let stop = Math.min(text.length, i+MAX_BLOCK);
        if (stop < text.length && /[\udc00-\udfff]/u.test(text[stop])) stop--;
        blocks.push({kind:'paragraph',text:text.slice(i,stop)});i=stop;
      }
    } else throw reject();
    if (!blocks.length || blocks.length > MAX_BLOCKS || blocks.every(b => !b.text.trim()) || blocks.reduce((sum, b) => sum+b.text.length, 0)>MAX_TEXT ||
        blocks.some(b => b.text.length>MAX_BLOCK || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(b.text))) throw reject();
    return { title, blocks };
  }
  async function fetchFile(artifact, scope, signal) {
    const url = '/api/artifact-download?' + new URLSearchParams({ agent: scope.agent, key: scope.key, sessionId: scope.sessionId, id: artifact.id });
    const res = await fetch(url, { credentials:'same-origin',cache:'no-store',redirect:'error',signal });
    if (res.status !== 200) throw new Error('No se pudo abrir este entregable en la conversación actual.');
    const raw = res.headers.get('content-length'), expected = raw === null || res.headers.get('content-encoding') ? null : Number(raw);
    if (expected !== null && (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_BYTES)) { await res.body?.cancel(); throw reject(); }
    return unpack(await readBounded(res.body, MAX_BYTES, expected), artifact.fileName || artifact.title);
  }
  window.HubDocumentImport = Object.freeze({ unpack, fetchFile });
})();
