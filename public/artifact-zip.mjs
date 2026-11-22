// Read only named OPC parts. No mounting, writing, or fetching paths from the archive.
const invalid = () => new Error('No se pudo leer el paquete de Excel.');
const decode = new TextDecoder('utf-8', { fatal: true });

export async function readBounded(stream, limit, length = null) {
  if (!stream || length !== null && (!Number.isSafeInteger(length) || length < 1 || length > limit)) {
    await stream?.cancel().catch(() => {});
    throw invalid();
  }
  const chunks = [], reader = stream.getReader();
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit || length !== null && total > length) throw invalid();
      chunks.push(value);
    }
    if (!total || length !== null && total !== length) throw invalid();
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, c) => {
  for (let i = 0; i < 8; i++) c = c >>> 1 ^ ((c & 1) ? 0xedb88320 : 0);
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = c >>> 8 ^ crcTable[(c ^ b) & 255];
  return (c ^ 0xffffffff) >>> 0;
}

export function openArtifactZip(data) {
  if (!(data instanceof Uint8Array) || data.length < 22 || data.length > 8 * 1024 * 1024) throw invalid();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const w = offset => view.getUint16(offset, true), d = offset => view.getUint32(offset, true);
  const first = Math.max(0, data.length - 65557);
  let end = data.length - 22;
  for (; end >= first; end--) if (d(end) === 0x06054b50 && end + 22 + w(end + 20) === data.length) break;
  if (end < first) throw invalid();
  const count = w(end + 10), central = d(end + 16);
  if (w(end + 4) || w(end + 6) || w(end + 8) !== count || !count || count > 1500 || central + d(end + 12) !== end) throw invalid();
  const entries = new Map();
  let at = central;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || d(at) !== 0x02014b50 || w(at + 34)) throw invalid();
    const flags = w(at + 8), method = w(at + 10), crc = d(at + 16), packed = d(at + 20), plain = d(at + 24);
    const size = w(at + 28), offset = d(at + 42), next = at + 46 + size + w(at + 30) + w(at + 32);
    if (!size || size > 2048 || next > end) throw invalid();
    const name = decode.decode(data.subarray(at + 46, at + 46 + size));
    if (entries.has(name)) throw invalid();
    entries.set(name, { flags, method, crc, packed, plain, offset });
    at = next;
  }
  if (at !== end) throw invalid();
  return Object.freeze({
    has: name => entries.has(name),
    async text(name, limit) {
      const item = entries.get(name);
      if (!item || item.flags & (1 | 64 | 8192) || ![0, 8].includes(item.method) || !item.plain || item.plain > limit) throw invalid();
      const p = item.offset;
      if (p + 30 > central || d(p) !== 0x04034b50 || w(p + 6) !== item.flags || w(p + 8) !== item.method) throw invalid();
      const size = w(p + 26), start = p + 30 + size + w(p + 28);
      if (start + item.packed > central || decode.decode(data.subarray(p + 30, p + 30 + size)) !== name) throw invalid();
      let bytes = data.subarray(start, start + item.packed);
      if (item.method === 8) bytes = await readBounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')), limit, item.plain);
      if (bytes.length !== item.plain || crc32(bytes) !== item.crc) throw invalid();
      return decode.decode(bytes);
    },
  });
}
