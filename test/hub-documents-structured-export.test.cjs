'use strict';

// Pruebas aisladas del exportador estructurado de HUB Documentos.
// No toca red, gateway, credenciales ni documentos reales: todo se genera en
// memoria con fixtures benignos. Solo usa node:builtins.
//
//   node test/hub-documents-structured-export.test.cjs

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { renderDocument, ExportError } = require('../lib/document-export');

let passed = 0;
let skipped = 0;
const ok = (name, condition, detail) => {
  assert(condition, `${name}${detail ? ` :: ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS ${name}`);
};
const skip = (name, reason) => {
  skipped += 1;
  console.log(`SKIP ${name} (${reason})`);
};
const throwsCode = async (name, code, fn) => {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  ok(name, caught instanceof ExportError && caught.code === code, caught ? `${caught.name}:${caught.code}` : 'no lanzó');
};

const FIXED_NOW = new Date('2026-11-20T18:00:00Z');
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/* ------------------------------------------------------------------ ZIP -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
};

function readZip(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= 0; index--) {
    if (buffer.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  assert(eocd >= 0, 'DOCX sin EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  assert.equal(directoryOffset + directorySize, eocd, 'directorio central del DOCX');

  const entries = new Map();
  let position = directoryOffset;
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(position), 0x02014b50, 'entrada central');
    const method = buffer.readUInt16LE(position + 10);
    const crc = buffer.readUInt32LE(position + 16);
    const packedSize = buffer.readUInt32LE(position + 20);
    const plainSize = buffer.readUInt32LE(position + 24);
    const nameSize = buffer.readUInt16LE(position + 28);
    const extraSize = buffer.readUInt16LE(position + 30);
    const commentSize = buffer.readUInt16LE(position + 32);
    const name = buffer.subarray(position + 46, position + 46 + nameSize).toString('utf8');
    const localOffset = buffer.readUInt32LE(position + 42);
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `cabecera local de ${name}`);
    const localNameSize = buffer.readUInt16LE(localOffset + 26);
    const localExtraSize = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameSize + localExtraSize;
    const packed = buffer.subarray(dataStart, dataStart + packedSize);
    const data = method === 8 ? zlib.inflateRawSync(packed) : packed;
    assert.equal(data.length, plainSize, `tamaño de ${name}`);
    assert.equal(crc32(data), crc, `CRC de ${name}`);
    entries.set(name, data);
    position += 46 + nameSize + extraSize + commentSize;
  }
  return entries;
}

const decodeXml = (value) => value
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const docxText = (xml) => [...xml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
  .map((match) => decodeXml(match[1]))
  .join('');

/* ------------------------------------------------------------------ PDF -- */

function validatePdf(buffer) {
  const text = buffer.toString('latin1');
  assert(text.startsWith('%PDF-1.7\n'), 'cabecera PDF');
  assert(text.endsWith('%%EOF\n'), 'cierre PDF');
  const startxref = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  assert(startxref, 'startxref');
  const xrefOffset = Number(startxref[1]);
  assert.equal(text.slice(xrefOffset, xrefOffset + 4), 'xref', 'posición de xref');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(xrefOffset));
  assert(head, 'cabecera xref');
  const size = Number(head[1]);
  const entryBase = xrefOffset + head[0].length;
  assert.match(text.slice(entryBase, entryBase + 20), /^0000000000 65535 f \n$/);
  for (let object = 1; object < size; object++) {
    const entry = text.slice(entryBase + object * 20, entryBase + (object + 1) * 20);
    assert.match(entry, /^\d{10} 00000 n \n$/, `entrada xref ${object}`);
    const offset = Number(entry.slice(0, 10));
    assert.equal(text.slice(offset, offset + `${object} 0 obj`.length), `${object} 0 obj`, `objeto ${object}`);
  }
  const streamPattern = /<< \/Length (\d+) >>\nstream\n/g;
  let streams = 0;
  let match;
  while ((match = streamPattern.exec(text)) !== null) {
    const start = match.index + match[0].length;
    assert.equal(text.slice(start + Number(match[1]), start + Number(match[1]) + 10), '\nendstream');
    streams += 1;
  }
  assert(streams >= 2, 'streams PDF');
  return {
    pages: (text.match(/\/Type \/Page\b/g) || []).length,
    declaredPages: Number((/\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(text) || [])[1]),
    text,
  };
}

function pdfText(buffer) {
  const run = spawnSync('pdftotext', ['-enc', 'UTF-8', '-', '-'], { input: buffer, encoding: 'utf8' });
  return run.error || run.status !== 0 ? null : run.stdout;
}

/* --------------------------------------------------------------- fixtures -- */

const STRUCTURED = {
  title: 'Informe estructurado — Ñandú & Cía.',
  blocks: [
    { id: 'h1', kind: 'heading', text: 'Resumen', level: 2 },
    { id: 'h2', kind: 'heading', text: 'Detalle', level: 6 },
    { id: 'p1', kind: 'paragraph', text: 'Texto áéíóú antes de la tabla.' },
    {
      id: 't1',
      kind: 'table',
      rows: [
        {
          header: true,
          cells: [
            { id: 'c1', text: 'Concepto' },
            { id: 'c2', text: 'Importe | nota & <dato>' },
            { id: 'c3', text: 'Comentario' },
          ],
        },
        {
          cells: [
            { id: 'c4', text: 'Fila 1' },
            { id: 'c5', text: '10 €' },
            { id: 'c6', text: 'Línea uno\nlínea dos' },
          ],
        },
        {
          cells: [
            { id: 'c7', text: 'Total', span: 2 },
            { id: 'c8', text: 'Fin' },
          ],
        },
      ],
    },
    { id: 'p2', kind: 'paragraph', text: 'Después de la tabla.' },
    // El orden no importa: primero el pie y después la cabecera.
    { id: 'f1', kind: 'footer', text: 'Pie confidencial', pageNumber: true },
    { id: 'hd', kind: 'header', text: 'Cabecera del informe' },
  ],
};

const LEGACY = {
  title: 'Acta de prueba — Ñandú & Cía.',
  blocks: [
    { id: 'h1', kind: 'heading', text: 'Resumen' },
    { id: 'p1', kind: 'paragraph', text: 'Texto con áéíóú, ñ, € y “comillas”.' },
    { id: 'b1', kind: 'bullet', text: 'Punto uno' },
    { id: 'n1', kind: 'number', text: 'Paso uno' },
    { id: 'q1', kind: 'quote', text: 'Cita' },
    { id: 'p2', kind: 'paragraph', text: '' },
  ],
};

const LEGACY_SHA256 = {
  md: '589aa01c6cb10e667f7fba86f331dceb7934f37dac37d1ff0272c5cdde89aaac',
  docx: 'bc137b8e0e0a18fa8c83fa138ed54a798bef5145bd0392e437aa421f08afa01d',
  pdf: '5d9a8907211b42c98679dc53dacc2618aebf82f87cb08f44c5c791e229c12a37',
};

function longTable(rows = 60) {
  const tableRows = [{ header: true, cells: [{ text: 'N' }, { text: 'Descripción' }, { text: 'Importe' }] }];
  for (let index = 1; index <= rows; index++) {
    tableRows.push({
      cells: [
        { text: `R${String(index).padStart(2, '0')}` },
        { text: `Descripción larga número ${index} con texto que debe envolver en varias líneas dentro de la celda. `.repeat(2) },
        { text: `${index * 10} €` },
      ],
    });
  }
  return {
    title: 'Tabla larga de prueba',
    blocks: [
      { id: 'h', kind: 'heading', text: 'Tabla larga' },
      { id: 't', kind: 'table', rows: tableRows },
      { id: 'end', kind: 'paragraph', text: 'MARCADOR-FINAL-TABLA' },
      { id: 'f', kind: 'footer', text: 'Pie de tabla', pageNumber: true },
    ],
  };
}

(async () => {
  /* ---------------------------------------------------------- Markdown -- */

  const md = await renderDocument(STRUCTURED, 'md', { now: FIXED_NOW });
  const mdText = md.bytes.toString('utf8');
  ok('md: cabecera etiquetada al inicio', mdText.startsWith('**Cabecera:** Cabecera del informe\n\n# Informe estructurado'));
  ok('md: pie etiquetado al final', mdText.endsWith('**Pie de página:** Pie confidencial\n'));
  ok('md: nivel 2 usa tres almohadillas', mdText.includes('\n### Resumen\n'));
  ok('md: nivel 6 se conserva como encabezado', mdText.includes('\n###### Detalle\n'));
  ok('md: tabla con cabecera GFM', mdText.includes('| Concepto | Importe \\| nota & <dato> | Comentario |\n| --- | --- | --- |'));
  ok('md: salto de línea de celda', mdText.includes('| Línea uno<br>línea dos |'));
  ok('md: span horizontal aplanado de forma explícita', mdText.includes('| Total | Total | Fin |'));
  ok('md: texto posterior intacto', mdText.includes('\nDespués de la tabla.\n\n**Pie de página:**'));
  ok('md: un único salto final', mdText.endsWith('\n') && !mdText.endsWith('\n\n'));

  const mdTableNoHeader = await renderDocument({
    title: 'Sin cabecera de tabla',
    blocks: [{ id: 't', kind: 'table', rows: [{ cells: [{ text: 'a' }, { text: 'b' }] }] }],
  }, 'md', { now: FIXED_NOW });
  const mdNoHeaderText = mdTableNoHeader.bytes.toString('utf8');
  ok('md: primera fila sin header conserva todos los datos',
    mdNoHeaderText.includes('|  |  |\n| --- | --- |\n| a | b |'));

  const mdEscape = await renderDocument({
    title: 'Escapado',
    blocks: [{ id: 't', kind: 'table', rows: [{ cells: [{ text: 'a\\b | c\td' }] }] }],
  }, 'md', { now: FIXED_NOW });
  ok('md: escapa barra invertida, tubería y tabulador',
    mdEscape.bytes.toString('utf8').includes('| a\\\\b \\| c    d |'));

  /* -------------------------------------------------------------- DOCX -- */

  const docx = await renderDocument(STRUCTURED, 'docx', { now: FIXED_NOW });
  ok('docx: firma ZIP', docx.bytes.subarray(0, 2).toString('latin1') === 'PK');
  const entries = readZip(docx.bytes);
  const required = [
    '[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml',
    'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels',
    'word/header1.xml', 'word/footer1.xml',
  ];
  ok('docx: diez partes con cabecera y pie', required.every((name) => entries.has(name)), [...entries.keys()].join(','));
  ok('docx: sin partes inesperadas', entries.size === required.length);

  const documentXml = entries.get('word/document.xml').toString('utf8');
  const stylesXml = entries.get('word/styles.xml').toString('utf8');
  const contentTypes = entries.get('[Content_Types].xml').toString('utf8');
  const relsXml = entries.get('word/_rels/document.xml.rels').toString('utf8');
  const headerXml = entries.get('word/header1.xml').toString('utf8');
  const footerXml = entries.get('word/footer1.xml').toString('utf8');

  ok('docx: tabla nativa w:tbl', documentXml.includes('<w:tbl>') && documentXml.includes('</w:tbl>'));
  ok('docx: tres columnas en la rejilla', (documentXml.match(/<w:gridCol /g) || []).length === 3);
  const widths = [...documentXml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
  ok('docx: anchos de columna suman el ancho útil', widths.reduce((total, value) => total + value, 0) === 9638, widths.join(','));
  ok('docx: span horizontal real', documentXml.includes('<w:gridSpan w:val="2"/>'));
  ok('docx: fila de cabecera repetible', documentXml.includes('<w:trPr><w:tblHeader/></w:trPr>'));
  ok('docx: tres filas', (documentXml.match(/<w:tr>/g) || []).length === 3);
  ok('docx: estilos Heading2 y Heading6',
    documentXml.includes('<w:pStyle w:val="Heading2"/>') &&
    documentXml.includes('<w:pStyle w:val="Heading6"/>') &&
    stylesXml.includes('w:styleId="Heading2"') &&
    stylesXml.includes('w:styleId="Heading6"'));
  ok('docx: texto de celdas sin pérdida',
    ['Concepto', 'Importe | nota & <dato>', 'Comentario', 'Fila 1', '10 €', 'Línea uno', 'línea dos', 'Total', 'Fin']
      .every((value) => docxText(documentXml).includes(value)));
  ok('docx: escapa XML dentro de celdas',
    documentXml.includes('Importe | nota &amp; &lt;dato&gt;') && !documentXml.includes('<dato>'));
  ok('docx: cabecera y pie son partes reales',
    headerXml.startsWith('<?xml') && headerXml.includes('<w:hdr') && headerXml.includes('Cabecera del informe') &&
    footerXml.includes('<w:ftr') && footerXml.includes('Pie confidencial'));
  ok('docx: campo PAGE seguro en el pie', footerXml.includes('<w:fldSimple w:instr=" PAGE ">') && !footerXml.includes('Pie confidencial · PAGE'));
  ok('docx: relaciones de cabecera y pie',
    /<Relationship Id="rId3" Type="[^"]+\/header" Target="header1.xml"\/>/.test(relsXml) &&
    /<Relationship Id="rId4" Type="[^"]+\/footer" Target="footer1.xml"\/>/.test(relsXml));
  ok('docx: sectPr referencia cabecera y pie',
    documentXml.includes('<w:headerReference w:type="default" r:id="rId3"/>') &&
    documentXml.includes('<w:footerReference w:type="default" r:id="rId4"/>'));
  ok('docx: content types declara cabecera y pie',
    contentTypes.includes('PartName="/word/header1.xml"') && contentTypes.includes('PartName="/word/footer1.xml"'));

  const docxLong = await renderDocument(longTable(), 'docx', { now: FIXED_NOW });
  const longXml = readZip(docxLong.bytes).get('word/document.xml').toString('utf8');
  ok('docx largo: 60 filas más cabecera', (longXml.match(/<w:tr>/g) || []).length === 61);
  ok('docx largo: contenido final presente', docxText(longXml).includes('MARCADOR-FINAL-TABLA') && docxText(longXml).includes('R60'));

  const docxHeaderOnly = await renderDocument({
    title: 'Solo cabecera',
    blocks: [{ id: 'h', kind: 'header', text: 'Arriba' }, { id: 'p', kind: 'paragraph', text: 'Cuerpo' }],
  }, 'docx', { now: FIXED_NOW });
  const headerOnlyEntries = readZip(docxHeaderOnly.bytes);
  ok('docx: solo cabecera sin pie', headerOnlyEntries.has('word/header1.xml') && !headerOnlyEntries.has('word/footer1.xml'));
  ok('docx: solo cabecera usa rId3',
    headerOnlyEntries.get('word/_rels/document.xml.rels').toString('utf8').includes('Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header"'));

  const docxFooterOnly = await renderDocument({
    title: 'Solo pie',
    blocks: [{ id: 'f', kind: 'footer', text: 'Abajo' }, { id: 'p', kind: 'paragraph', text: 'Cuerpo' }],
  }, 'docx', { now: FIXED_NOW });
  const footerOnlyEntries = readZip(docxFooterOnly.bytes);
  ok('docx: solo pie sin cabecera', footerOnlyEntries.has('word/footer1.xml') && !footerOnlyEntries.has('word/header1.xml'));

  /* --------------------------------------------------------------- PDF -- */

  const pdf = await renderDocument(STRUCTURED, 'pdf', { now: FIXED_NOW });
  ok('pdf: firma', pdf.bytes.subarray(0, 8).toString('latin1') === '%PDF-1.7');
  ok('pdf: EOF', pdf.bytes.subarray(-6).toString('latin1') === '%%EOF\n');
  const info = validatePdf(pdf.bytes);
  ok('pdf: A4 y una página', info.pages === 1 && info.declaredPages === 1 && info.text.includes('/MediaBox [0 0 595.276 841.89]'));
  ok('pdf: rejilla con relleno de cabecera',
    (info.text.match(/0\.682 0\.718 0\.769 RG 0\.5 w/g) || []).length >= 8 &&
    info.text.includes('0.953 0.957 0.965 rg'));
  ok('pdf: cabecera dibujada en el flujo',
    info.text.includes(Buffer.from('Cabecera del informe', 'latin1').toString('hex').toUpperCase()));

  const extracted = pdfText(pdf.bytes);
  if (extracted !== null) {
    ok('pdf: cabecera extraída', extracted.includes('Cabecera del informe'));
    ok('pdf: pie y número extraídos', extracted.includes('Pie confidencial') && /\b1\s*\/\s*1\b/.test(extracted));
    ok('pdf: celdas extraídas', extracted.includes('Concepto') && extracted.includes('Importe | nota & <dato>') &&
      extracted.includes('Línea uno') && extracted.includes('línea dos') && extracted.includes('Total') && extracted.includes('Fin'));
    ok('pdf: texto posterior a la tabla', extracted.includes('Después de la tabla.'));
  } else {
    skip('pdf: extracción de texto', 'pdftotext no disponible');
  }

  const longPdf = await renderDocument(longTable(), 'pdf', { now: FIXED_NOW });
  const longInfo = validatePdf(longPdf.bytes);
  ok('pdf largo: paginación real', longInfo.pages >= 4 && longInfo.pages === longInfo.declaredPages, `${longInfo.pages}`);
  const longText = pdfText(longPdf.bytes);
  if (longText !== null) {
    ok('pdf largo: todas las filas sin pérdida',
      ['R01', 'R15', 'R30', 'R45', 'R60'].every((marker) => longText.includes(marker)));
    ok('pdf largo: contenido posterior a la tabla', longText.includes('MARCADOR-FINAL-TABLA'));
    ok('pdf largo: cabecera repetida en cada página',
      (longText.match(/^Descripción$/gm) || []).length === longInfo.pages, `${(longText.match(/^Descripción$/gm) || []).length}/${longInfo.pages}`);
    const numbers = [...longText.matchAll(/(\d+)\s*\/\s*(\d+)/g)].map((match) => Number(match[1]));
    ok('pdf largo: numeración consecutiva', numbers.length === longInfo.pages && numbers.every((value, index) => value === index + 1), numbers.join(','));
    ok('pdf largo: pie en todas las páginas', (longText.match(/Pie de tabla/g) || []).length === longInfo.pages);
  } else {
    skip('pdf largo: extracción de texto', 'pdftotext no disponible');
  }

  const noNumbers = await renderDocument({
    title: 'Pie sin números',
    blocks: [
      { id: 'f', kind: 'footer', text: 'Solo pie' },
      { id: 'p', kind: 'paragraph', text: 'Cuerpo' },
    ],
  }, 'pdf', { now: FIXED_NOW, pageNumbers: false });
  const noNumbersText = pdfText(noNumbers.bytes);
  if (noNumbersText !== null) {
    ok('pdf: pie sin números cuando no se piden', noNumbersText.includes('Solo pie') && !/\b1\s*\/\s*1\b/.test(noNumbersText));
  } else {
    skip('pdf: pie sin números', 'pdftotext no disponible');
  }

  /* ------------------------------------------------------- validaciones -- */

  const table = (rows) => ({ title: 'Tabla', blocks: [{ id: 't', kind: 'table', rows }] });
  const singleCells = (count) => Array.from({ length: count }, (_, index) => ({ text: `c${index}` }));

  await throwsCode('fallo: 13 columnas', 'E_LIMIT', () =>
    renderDocument(table([{ cells: singleCells(13) }]), 'md'));
  await throwsCode('fallo: 81 filas', 'E_LIMIT', () =>
    renderDocument(table(Array.from({ length: 81 }, () => ({ cells: [{ text: 'x' }] }))), 'md'));
  await throwsCode('fallo: 321 celdas en el documento', 'E_LIMIT', () =>
    renderDocument(table(Array.from({ length: 41 }, () => ({ cells: singleCells(8) }))), 'md'));
  await throwsCode('fallo: suma de spans distinta', 'E_TABLE', () =>
    renderDocument(table([{ cells: [{ text: 'a', span: 2 }] }, { cells: [{ text: 'b' }] }]), 'md'));
  await throwsCode('fallo: dos cabeceras', 'E_INPUT', () =>
    renderDocument({ title: 'T', blocks: [{ kind: 'header', text: 'a' }, { kind: 'header', text: 'b' }] }, 'md'));
  await throwsCode('fallo: dos pies', 'E_INPUT', () =>
    renderDocument({ title: 'T', blocks: [{ kind: 'footer', text: 'a' }, { kind: 'footer', text: 'b' }] }, 'md'));
  await throwsCode('fallo: combinación vertical', 'E_TABLE', () =>
    renderDocument(table([{ cells: [{ text: 'a', rowSpan: 2 }] }]), 'md'));
  await throwsCode('fallo: tabla anidada', 'E_TABLE', () =>
    renderDocument(table([{ cells: [{ text: 'a', cells: [{ text: 'b' }] }] }]), 'md'));
  await throwsCode('fallo: nivel 7', 'E_INPUT', () =>
    renderDocument({ title: 'T', blocks: [{ kind: 'heading', text: 'a', level: 7 }] }, 'md'));
  await throwsCode('fallo: nivel 0', 'E_INPUT', () =>
    renderDocument({ title: 'T', blocks: [{ kind: 'heading', text: 'a', level: 0 }] }, 'md'));
  await throwsCode('fallo: pageNumber no booleano', 'E_INPUT', () =>
    renderDocument({ title: 'T', blocks: [{ kind: 'footer', text: 'a', pageNumber: false }] }, 'md'));
  await throwsCode('fallo: maxChars incluye celdas', 'E_LIMIT', () =>
    renderDocument(table([{ cells: [{ text: 'x'.repeat(50) }] }]), 'md', { maxChars: 20 }));
  await throwsCode('fallo: maxChars incluye cabecera', 'E_LIMIT', () =>
    renderDocument({ title: 'T', blocks: [{ kind: 'header', text: 'x'.repeat(50) }] }, 'md', { maxChars: 20 }));

  /* -------------------------------------------------------- determinismo -- */

  for (const format of ['md', 'docx', 'pdf']) {
    const first = await renderDocument(STRUCTURED, format, { now: FIXED_NOW });
    const second = await renderDocument(STRUCTURED, format, { now: FIXED_NOW });
    ok(`determinismo ${format}`, hash(first.bytes) === hash(second.bytes));
  }

  /* ------------------------------------------------ compatibilidad exacta -- */

  for (const format of ['md', 'docx', 'pdf']) {
    const legacy = await renderDocument(LEGACY, format, { now: FIXED_NOW });
    ok(`legado ${format}: bytes idénticos`, hash(legacy.bytes) === LEGACY_SHA256[format], hash(legacy.bytes));
  }

  console.log(`RESULT ${passed}/${passed} passed` + (skipped ? ` (${skipped} skipped)` : ''));
})().catch((error) => {
  console.error('FAIL', error?.stack || error);
  process.exitCode = 1;
});
