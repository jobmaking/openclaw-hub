'use strict';

/**
 * HUB Documentos — exportador de documentos normalizados.
 * =======================================================
 *
 * API pública (CommonJS):
 *
 *   const { renderDocument, suggestFileName, ExportError } = require('./document-export');
 *   const { bytes, mimeType, extension } = await renderDocument(snapshot, 'pdf', options);
 *
 * `snapshot` es la representación normalizada y NO ejecutable que entrega el HUB:
 *
 *   {
 *     title: 'Informe de situación',
 *     blocks: [
 *       { id: 'b1', kind: 'heading',   text: 'Resumen' },
 *       { id: 'b2', kind: 'paragraph', text: 'Texto…' },
 *       { id: 'b3', kind: 'bullet',    text: 'Punto' },
 *       { id: 'b4', kind: 'number',    text: 'Paso' },
 *       { id: 'b5', kind: 'quote',     text: 'Cita' },
 *       { id: 'b6', kind: 'header',    text: 'Cabecera', pageNumber: true },
 *       { id: 'b7', kind: 'footer',    text: 'Pie', pageNumber: true },
 *       {
 *         id: 'b8',
 *         kind: 'table',
 *         rows: [
 *           { header: true, cells: [{ id: 'c1', text: 'Concepto' }, { id: 'c2', text: 'Importe' }] },
 *           { cells: [{ id: 'c3', text: 'Total', span: 2 }] }
 *         ]
 *       }
 *     ]
 *   }
 *
 * Uniones admitidas:
 *   - Bloques heredados: paragraph, heading (con `level` opcional 2..6; 1 por
 *     defecto, que también se acepta explícito), bullet, number y quote.
 *   - Como máximo una cabecera y un pie. Su posición en `blocks` es indiferente:
 *     se dibujan en la parte superior/inferior de cada página (DOCX y PDF) o se
 *     etiquetan al principio/final (Markdown). `pageNumber: true` añade el campo
 *     PAGE en DOCX y el número de página en PDF; Markdown no tiene páginas.
 *   - Tablas: filas con celdas de texto y `span` horizontal (1 por defecto). La
 *     suma de spans de cada fila debe coincidir con el número de columnas (1..12),
 *     con un máximo de 80 filas por tabla y 320 celdas por documento. No hay
 *     tablas anidadas ni combinación vertical.
 *
 * Formatos: 'md', 'docx', 'pdf'. Todo se genera aquí, en proceso, sin subprocesos,
 * sin sistema de ficheros, sin red y sin dependencias npm (solo `node:zlib`).
 *
 * Opciones (todas opcionales):
 *   - maxBlocks   límite de bloques (por defecto 5000; máximo 20000)
 *   - maxChars    límite de caracteres totales (por defecto 400000; máximo 2000000)
 *   - now         Date | number | ISO string para metadatos (por defecto, ahora)
 *   - author      autor de metadatos (por defecto 'HUB Documentos'; máx. 120)
 *   - pageNumbers booleano, solo PDF (por defecto true)
 *
 * Garantías:
 *   - DOCX es OOXML real (ZIP + XML) con A4 fijo, estilos y numeración nativos:
 *     el texto es editable en Word/LibreOffice.
 *   - PDF 1.7 real, A4 fijo, texto nativo Helvetica con WinAnsiEncoding y ToUnicode.
 *   - Markdown UTF-8 generado carácter a carácter desde el texto normalizado.
 *   - Los caracteres de control C0 se eliminan; el texto nunca se interpreta como
 *     HTML, shell ni ruta de fichero.
 *   - Los caracteres fuera de WinAnsi se sustituyen por '?' SOLO en PDF (limitación
 *     de las fuentes base-14). DOCX y Markdown conservan todo Unicode.
 */

const zlib = require('node:zlib');
const crypto = require('node:crypto');

const FORMATS = Object.freeze({
  md: Object.freeze({ mimeType: 'text/markdown; charset=utf-8', extension: 'md' }),
  docx: Object.freeze({
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extension: 'docx',
  }),
  pdf: Object.freeze({ mimeType: 'application/pdf', extension: 'pdf' }),
});

const KINDS = Object.freeze([
  'paragraph', 'heading', 'bullet', 'number', 'quote', 'header', 'footer', 'table',
]);
const KIND_SET = new Set(KINDS);

const LIMITS = Object.freeze({
  blocks: 5000,
  chars: 400000,
  title: 300,
  author: 120,
  id: 200,
  tableRows: 80,
  tableColumns: 12,
  tableCells: 320,
  cellSpan: 12,
});

class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------------- *
 * Entrada
 * ------------------------------------------------------------------------- */

function cleanText(value, field) {
  if (typeof value !== 'string') {
    throw new ExportError('E_INPUT', `${field} debe ser una cadena de texto.`);
  }
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\uFEFF/g, '');
  // XML 1.0 no admite estos controles y un PDF tampoco los necesita.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // Surrogates sueltos: se descartan en lugar de producir UTF-8 inválido.
  text = text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1');
  return text;
}

function integerOption(value, fallback, min, max, field) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < min) {
    throw new ExportError('E_OPTION', `${field} debe ser un entero >= ${min}.`);
  }
  return Math.min(value, max);
}

function readOptions(options) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new ExportError('E_OPTION', 'options debe ser un objeto.');
  }

  let now = new Date();
  if (options.now !== undefined && options.now !== null) {
    now = options.now instanceof Date ? new Date(options.now.getTime()) : new Date(options.now);
    if (Number.isNaN(now.getTime())) {
      throw new ExportError('E_OPTION', 'options.now no es una fecha válida.');
    }
  }

  let author = 'HUB Documentos';
  if (options.author !== undefined && options.author !== null) {
    author = cleanText(options.author, 'options.author').trim();
    if (!author || author.length > LIMITS.author) {
      throw new ExportError('E_OPTION', `options.author debe tener entre 1 y ${LIMITS.author} caracteres.`);
    }
  }

  if (options.pageNumbers !== undefined && typeof options.pageNumbers !== 'boolean') {
    throw new ExportError('E_OPTION', 'options.pageNumbers debe ser booleano.');
  }

  return {
    maxBlocks: integerOption(options.maxBlocks, LIMITS.blocks, 1, 20000, 'options.maxBlocks'),
    maxChars: integerOption(options.maxChars, LIMITS.chars, 1, 2000000, 'options.maxChars'),
    now,
    author,
    pageNumbers: options.pageNumbers !== false,
  };
}

function normalizeSnapshot(snapshot, options) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new ExportError('E_INPUT', 'snapshot debe ser un objeto.');
  }

  // Un título es una línea: se colapsan saltos y espacios para que no rompa
  // encabezados Markdown ni metadatos.
  const title = cleanText(snapshot.title, 'snapshot.title').replace(/\s+/g, ' ').trim();
  if (!title) throw new ExportError('E_INPUT', 'snapshot.title es obligatorio.');
  if (title.length > LIMITS.title) {
    throw new ExportError('E_INPUT', `snapshot.title supera ${LIMITS.title} caracteres.`);
  }

  const rawBlocks = snapshot.blocks;
  if (!Array.isArray(rawBlocks)) {
    throw new ExportError('E_INPUT', 'snapshot.blocks debe ser un array.');
  }
  if (rawBlocks.length > options.maxBlocks) {
    throw new ExportError('E_LIMIT', `El documento supera ${options.maxBlocks} bloques.`);
  }

  const blocks = [];
  let chars = title.length;
  let header = null;
  let footer = null;
  let totalCells = 0;

  for (let i = 0; i < rawBlocks.length; i++) {
    const raw = rawBlocks[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ExportError('E_INPUT', `blocks[${i}] debe ser un objeto.`);
    }
    const kind = raw.kind;
    if (typeof kind !== 'string' || !KIND_SET.has(kind)) {
      throw new ExportError('E_KIND', `blocks[${i}].kind no es válido.`);
    }
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || raw.id.length > LIMITS.id) {
        throw new ExportError('E_INPUT', `blocks[${i}].id no es válido.`);
      }
    }

    if (kind === 'header' || kind === 'footer') {
      if ((kind === 'header' && header) || (kind === 'footer' && footer)) {
        throw new ExportError('E_INPUT', `Solo se admite un bloque ${kind}.`);
      }
      const text = cleanText(raw.text, `blocks[${i}].text`);
      chars += text.length;
      if (chars > options.maxChars) {
        throw new ExportError('E_LIMIT', `El documento supera ${options.maxChars} caracteres.`);
      }
      let pageNumber = false;
      if (raw.pageNumber !== undefined && raw.pageNumber !== null) {
        if (raw.pageNumber !== true) {
          throw new ExportError('E_INPUT', `blocks[${i}].pageNumber solo puede ser true.`);
        }
        pageNumber = true;
      }
      const entry = { text, pageNumber };
      if (kind === 'header') header = entry;
      else footer = entry;
      continue;
    }

    if (kind === 'table') {
      const table = normalizeTable(raw, i, options, chars);
      totalCells += table.cellCount;
      if (totalCells > LIMITS.tableCells) {
        throw new ExportError('E_LIMIT', `El documento supera ${LIMITS.tableCells} celdas de tabla.`);
      }
      chars += table.chars;
      if (chars > options.maxChars) {
        throw new ExportError('E_LIMIT', `El documento supera ${options.maxChars} caracteres.`);
      }
      blocks.push(table);
      continue;
    }

    let level = 1;
    if (kind === 'heading' && raw.level !== undefined && raw.level !== null) {
      if (!Number.isSafeInteger(raw.level) || raw.level < 1 || raw.level > 6) {
        throw new ExportError('E_INPUT', `blocks[${i}].level debe ser un entero entre 1 y 6.`);
      }
      level = raw.level;
    }
    const text = cleanText(raw.text, `blocks[${i}].text`);
    chars += text.length;
    if (chars > options.maxChars) {
      throw new ExportError('E_LIMIT', `El documento supera ${options.maxChars} caracteres.`);
    }
    if (kind === 'heading') blocks.push({ kind, text, level });
    else blocks.push({ kind, text });
  }

  return { title, blocks, header, footer };
}

/**
 * Valida y normaliza una tabla. El número de columnas lo fija la primera fila
 * y todas las demás deben sumar exactamente lo mismo con sus spans.
 */
function normalizeTable(raw, index, options, charsSoFar) {
  const rawRows = raw.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw new ExportError('E_TABLE', `blocks[${index}].rows debe ser un array no vacío.`);
  }
  if (rawRows.length > LIMITS.tableRows) {
    throw new ExportError('E_LIMIT', `Una tabla supera ${LIMITS.tableRows} filas.`);
  }

  let columns = null;
  let cellCount = 0;
  let chars = 0;
  const rows = [];

  for (let r = 0; r < rawRows.length; r++) {
    const rawRow = rawRows[r];
    if (rawRow === null || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
      throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}] debe ser un objeto.`);
    }
    if (rawRow.header !== undefined && typeof rawRow.header !== 'boolean') {
      throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}].header debe ser booleano.`);
    }
    const rawCells = rawRow.cells;
    if (!Array.isArray(rawCells) || rawCells.length === 0) {
      throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}].cells debe ser un array no vacío.`);
    }

    let spanSum = 0;
    const cells = [];
    for (let c = 0; c < rawCells.length; c++) {
      const rawCell = rawCells[c];
      if (rawCell === null || typeof rawCell !== 'object' || Array.isArray(rawCell)) {
        throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}].cells[${c}] debe ser un objeto.`);
      }
      if (rawCell.rowSpan !== undefined || rawCell.vMerge !== undefined) {
        throw new ExportError('E_TABLE', 'No se admite combinación vertical de celdas.');
      }
      if (rawCell.cells !== undefined || rawCell.rows !== undefined) {
        throw new ExportError('E_TABLE', 'No se admiten tablas anidadas.');
      }
      if (rawCell.id !== undefined && rawCell.id !== null) {
        if (typeof rawCell.id !== 'string' || rawCell.id.length > LIMITS.id) {
          throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}].cells[${c}].id no es válido.`);
        }
      }
      let span = 1;
      if (rawCell.span !== undefined && rawCell.span !== null) {
        if (!Number.isSafeInteger(rawCell.span) || rawCell.span < 1) {
          throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}].cells[${c}].span debe ser un entero >= 1.`);
        }
        if (rawCell.span > LIMITS.cellSpan) {
          throw new ExportError('E_LIMIT', `Un span de celda supera ${LIMITS.cellSpan} columnas.`);
        }
        span = rawCell.span;
      }
      const text = cleanText(rawCell.text, `blocks[${index}].rows[${r}].cells[${c}].text`);
      spanSum += span;
      if (spanSum > LIMITS.tableColumns) {
        throw new ExportError('E_LIMIT', `Una tabla supera ${LIMITS.tableColumns} columnas.`);
      }
      chars += text.length;
      if (charsSoFar + chars > options.maxChars) {
        throw new ExportError('E_LIMIT', `El documento supera ${options.maxChars} caracteres.`);
      }
      cells.push({ text, span });
    }

    if (columns === null) columns = spanSum;
    else if (spanSum !== columns) {
      throw new ExportError('E_TABLE', `blocks[${index}].rows[${r}] no suma el mismo número de columnas (${columns}).`);
    }
    if (columns < 1 || columns > LIMITS.tableColumns) {
      throw new ExportError('E_LIMIT', `Las tablas deben tener entre 1 y ${LIMITS.tableColumns} columnas.`);
    }
    cellCount += cells.length;
    rows.push({ header: rawRow.header === true, cells });
  }

  return { kind: 'table', columns, rows, cellCount, chars };
}

/* ------------------------------------------------------------------------- *
 * Markdown
 * ------------------------------------------------------------------------- */

function markdownDocument(doc) {
  const out = [];
  if (doc.header) out.push(labelLine('Cabecera', doc.header.text), '');
  out.push(`# ${doc.title}`, '');
  let number = 0;
  for (const block of doc.blocks) {
    switch (block.kind) {
      case 'heading':
        out.push(`${'#'.repeat(Math.min(block.level + 1, 6))} ${block.text.replace(/\s*\n\s*/g, ' ')}`, '');
        break;
      case 'bullet':
        out.push(...prefixLines(block.text, '- ', '  '), '');
        break;
      case 'number':
        number += 1;
        out.push(...prefixLines(block.text, `${number}. `, '   '), '');
        break;
      case 'quote':
        out.push(...prefixLines(block.text, '> ', '> '), '');
        break;
      case 'table':
        out.push(...markdownTable(block), '');
        break;
      default:
        out.push(block.text, '');
        break;
    }
  }
  if (doc.footer) out.push(labelLine('Pie de página', doc.footer.text), '');
  // Un único salto final: no se inventan bloques vacíos al final.
  return out.join('\n').replace(/\n+$/, '\n');
}

function labelLine(label, text) {
  return text ? `**${label}:** ${text}` : `**${label}:**`;
}

/**
 * Markdown no admite colspan. La única aplanación admitida es horizontal y se
 * hace de forma explícita: el texto de la celda se repite en cada columna que
 * cubre. Nunca se inventan combinaciones verticales.
 */
function markdownTable(block) {
  const first = block.rows[0];
  const hasHeader = first.header === true;
  const headerCells = hasHeader
    ? markdownRow(first, block.columns)
    : new Array(block.columns).fill('');
  const lines = [
    `| ${headerCells.join(' | ')} |`,
    `| ${new Array(block.columns).fill('---').join(' | ')} |`,
  ];
  for (let index = hasHeader ? 1 : 0; index < block.rows.length; index++) {
    lines.push(`| ${markdownRow(block.rows[index], block.columns).join(' | ')} |`);
  }
  return lines;
}

function markdownRow(row, columns) {
  const cells = [];
  for (const cell of row.cells) {
    const value = markdownCell(cell.text);
    for (let index = 0; index < cell.span; index++) cells.push(value);
  }
  // La validación garantiza la suma, pero nunca se genera una fila corta.
  while (cells.length < columns) cells.push('');
  return cells.slice(0, columns);
}

function markdownCell(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
    .replace(/\t/g, '    ');
}

function prefixLines(text, first, rest) {
  if (!text) return [first.trimEnd()];
  return text.split('\n').map((line, index) => (index === 0 ? first : rest) + line);
}

/* ------------------------------------------------------------------------- *
 * DOCX (OOXML mínimo, real y editable)
 * ------------------------------------------------------------------------- */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function docxInline(text, runProperties = '') {
  if (!text) return '';
  const runs = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    if (li > 0) runs.push(`<w:r>${runProperties}<w:br/></w:r>`);
    const line = lines[li];
    if (!line) continue;
    const segments = line.split('\t');
    for (let si = 0; si < segments.length; si++) {
      if (si > 0) runs.push(`<w:r>${runProperties}<w:tab/></w:r>`);
      const segment = segments[si];
      if (segment) {
        runs.push(`<w:r>${runProperties}<w:t xml:space="preserve">${escapeXml(segment)}</w:t></w:r>`);
      }
    }
  }
  return runs.join('');
}

function docxBlock(block) {
  if (block.kind === 'table') return docxTable(block);
  let properties = '';
  if (block.kind === 'heading') {
    properties = `<w:pStyle w:val="Heading${block.level || 1}"/>`;
  } else if (block.kind === 'quote') {
    properties = '<w:pStyle w:val="Quote"/>';
  } else if (block.kind === 'bullet') {
    properties = '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  } else if (block.kind === 'number') {
    properties = '<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>';
  }
  const pPr = properties ? `<w:pPr>${properties}</w:pPr>` : '';
  return `<w:p>${pPr}${docxInline(block.text)}</w:p>`;
}

/* --- Tablas DOCX nativas (w:tbl, sin imágenes ni texto simulado) --- */

// Ancho útil de la caja de texto A4: 11906 - 2 * 1134 twips.
const DOCX_CONTENT_WIDTH = 9638;

function docxColumnWidths(columns) {
  const base = Math.floor(DOCX_CONTENT_WIDTH / columns);
  const widths = new Array(columns).fill(base);
  widths[columns - 1] += DOCX_CONTENT_WIDTH - base * columns;
  return widths;
}

function docxTable(block) {
  const widths = docxColumnWidths(block.columns);
  const grid = `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>`;
  const borders = '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="AEB3BB"/>`)
    .join('') + '</w:tblBorders>';
  const properties = '<w:tblPr>' +
    `<w:tblW w:w="${DOCX_CONTENT_WIDTH}" w:type="dxa"/>` +
    borders + '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="85" w:type="dxa"/>' +
    '<w:bottom w:w="57" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr>';

  const rows = block.rows.map((row) => {
    let column = 0;
    const cells = row.cells.map((cell) => {
      const width = widths.slice(column, column + cell.span).reduce((total, value) => total + value, 0);
      column += cell.span;
      const span = cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : '';
      const shading = row.header ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : '';
      const runProperties = row.header ? '<w:rPr><w:b/></w:rPr>' : '';
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span}${shading}</w:tcPr>` +
        `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>` +
        `${docxInline(cell.text, runProperties)}</w:p></w:tc>`;
    }).join('');
    const rowProperties = row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    return `<w:tr>${rowProperties}${cells}</w:tr>`;
  }).join('');

  return `<w:tbl>${properties}${grid}${rows}</w:tbl>`;
}

function docxStyles(levels = []) {
  const styles = `${XML_DECL}<w:styles xmlns:w="${W_NS}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
    '<w:sz w:val="22"/><w:szCs w:val="22"/>' +
    '<w:lang w:val="es-ES" w:eastAsia="es-ES" w:bidi="ar-SA"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:spacing w:before="0" w:after="240"/><w:jc w:val="left"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/><w:color w:val="111827"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/><w:color w:val="1F2937"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D1D5DB"/></w:pBdr><w:spacing w:before="120" w:after="240"/><w:ind w:left="567" w:right="567"/></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="4B5563"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/><w:contextualSpacing/></w:pPr></w:style>' +
    '</w:styles>';
  if (!levels.length) return styles;

  const sizes = { 2: 28, 3: 26, 4: 24, 5: 22, 6: 22 };
  const extra = levels.map((level) =>
    `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sizes[level]}"/><w:szCs w:val="${sizes[level]}"/><w:color w:val="1F2937"/></w:rPr></w:style>`
  ).join('');
  return styles.replace('</w:styles>', `${extra}</w:styles>`);
}

function docxNumbering() {
  return `${XML_DECL}<w:numbering xmlns:w="${W_NS}">` +
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>' +
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>' +
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    '</w:numbering>';
}

function docxCore(doc, meta) {
  const stamp = meta.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${XML_DECL}<cp:coreProperties` +
    ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    ' xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXml(doc.title)}</dc:title>` +
    `<dc:creator>${escapeXml(meta.author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXml(meta.author)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>';
}

function docxApp() {
  return `${XML_DECL}<Properties` +
    ' xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>HUB Documentos</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>' +
    '<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>';
}

/**
 * Cabecera/pie reales del paquete DOCX. El campo PAGE es una instrucción fija
 * (` PAGE `) con un marcador de posición: nunca se interpola texto del documento
 * dentro de `w:instr`.
 */
function docxHeaderFooter(kind, entry) {
  const tag = kind === 'header' ? 'hdr' : 'ftr';
  let content = docxInline(entry.text);
  if (entry.pageNumber) {
    content += '<w:r><w:t xml:space="preserve"> · </w:t></w:r>' +
      '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>';
  }
  const border = kind === 'header'
    ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D1D5DB"/></w:pBdr>'
    : '<w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D1D5DB"/></w:pBdr>';
  return `${XML_DECL}<w:${tag} xmlns:w="${W_NS}" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:p><w:pPr>${border}<w:spacing w:before="0" w:after="0"/></w:pPr>${content}</w:p>` +
    `</w:${tag}>`;
}

function docxDocumentXml(doc, links) {
  const body = [`<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr>${docxInline(doc.title)}</w:p>`];
  for (const block of doc.blocks) body.push(docxBlock(block));
  const references = [];
  if (doc.header) references.push(`<w:headerReference w:type="default" r:id="${links.headerRid}"/>`);
  if (doc.footer) references.push(`<w:footerReference w:type="default" r:id="${links.footerRid}"/>`);
  // A4 (11906 x 16838 twips) y márgenes de 2 cm (1134 twips), fijos.
  const sectPr = `<w:sectPr>${references.join('')}<w:pgSz w:w="11906" w:h="16838"/>` +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>' +
    '<w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  return `${XML_DECL}<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${body.join('')}${sectPr}</w:body></w:document>`;
}

/* --- ZIP determinista (método deflate, CRC32 real) --- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function zipArchive(files) {
  const DOS_DATE = 0x0021; // 1980-01-01, fijo para salida reproducible
  const DOS_TIME = 0;
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + packed.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end]);
}

function docxBytes(doc, meta) {
  let nextRelationship = 3;
  const links = {
    headerRid: doc.header ? `rId${nextRelationship++}` : null,
    footerRid: doc.footer ? `rId${nextRelationship++}` : null,
  };

  const contentTypes = `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    (doc.header ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '') +
    (doc.footer ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') +
    '</Types>';

  const rootRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  const documentRels = `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    (doc.header ? `<Relationship Id="${links.headerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>` : '') +
    (doc.footer ? `<Relationship Id="${links.footerRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>` : '') +
    '</Relationships>';

  const headingLevels = [...new Set(doc.blocks
    .filter((block) => block.kind === 'heading' && block.level > 1)
    .map((block) => block.level))].sort((a, b) => a - b);

  const files = [
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'docProps/core.xml', data: docxCore(doc, meta) },
    { name: 'docProps/app.xml', data: docxApp() },
    { name: 'word/document.xml', data: docxDocumentXml(doc, links) },
    { name: 'word/styles.xml', data: docxStyles(headingLevels) },
    { name: 'word/numbering.xml', data: docxNumbering() },
    { name: 'word/_rels/document.xml.rels', data: documentRels },
  ];
  if (doc.header) files.push({ name: 'word/header1.xml', data: docxHeaderFooter('header', doc.header) });
  if (doc.footer) files.push({ name: 'word/footer1.xml', data: docxHeaderFooter('footer', doc.footer) });
  return zipArchive(files);
}

/* ------------------------------------------------------------------------- *
 * PDF 1.7 (texto nativo, A4, WinAnsi + ToUnicode)
 * ------------------------------------------------------------------------- */

// Anchuras Helvetica (1/1000 em) para los bytes WinAnsi 32..255.
// Obtenidas de las métricas compatibles NimbusSans (URW base35), embebidas aquí
// para no depender de ficheros del sistema en tiempo de ejecución.
const PDF_WIDTHS = {
  F1: Int16Array.from('278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500'.split(','), Number),
  F2: Int16Array.from('278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556'.split(','), Number),
  F3: Int16Array.from('278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500'.split(','), Number),
};

const A4 = Object.freeze({ width: 595.276, height: 841.89 });
const MARGIN = 56.693; // 2 cm
const CONTENT_WIDTH = A4.width - MARGIN * 2;

const INK = '0.067 0.094 0.153';       // #111827
const HEADING_INK = '0.122 0.161 0.216'; // #1F2937
const MUTED_INK = '0.294 0.333 0.388';  // #4B5563
const FOOTER_INK = '0.420 0.447 0.502'; // #6B7280
const RULE = '0.898 0.906 0.922';       // #E5E7EB
const TABLE_RULE = '0.682 0.718 0.769'; // #AEB7C4
const TABLE_HEADER_FILL = '0.953 0.957 0.965'; // #F3F4F6

const HEADING_SPECS = Object.freeze({
  1: Object.freeze({ size: 14, leading: 18.5 }),
  2: Object.freeze({ size: 13, leading: 17.5 }),
  3: Object.freeze({ size: 12, leading: 16.5 }),
  4: Object.freeze({ size: 11.5, leading: 16 }),
  5: Object.freeze({ size: 11, leading: 15.4 }),
  6: Object.freeze({ size: 11, leading: 15.4 }),
});

const TABLE_FONT_SIZE = 9;
const TABLE_LEADING = 11.5;
const TABLE_PAD_X = 4;
const TABLE_PAD_Y = 4;

// WinAnsi (CP1252) byte para cada punto de código soportado.
const WINANSI_TO_BYTE = new Map();
for (let byte = 32; byte <= 126; byte++) WINANSI_TO_BYTE.set(byte, byte);
for (let byte = 160; byte <= 255; byte++) WINANSI_TO_BYTE.set(byte, byte);
WINANSI_TO_BYTE.set(0x20ac, 0x80);
WINANSI_TO_BYTE.set(0x201a, 0x82);
WINANSI_TO_BYTE.set(0x0192, 0x83);
WINANSI_TO_BYTE.set(0x201e, 0x84);
WINANSI_TO_BYTE.set(0x2026, 0x85);
WINANSI_TO_BYTE.set(0x2020, 0x86);
WINANSI_TO_BYTE.set(0x2021, 0x87);
WINANSI_TO_BYTE.set(0x02c6, 0x88);
WINANSI_TO_BYTE.set(0x2030, 0x89);
WINANSI_TO_BYTE.set(0x0160, 0x8a);
WINANSI_TO_BYTE.set(0x2039, 0x8b);
WINANSI_TO_BYTE.set(0x0152, 0x8c);
WINANSI_TO_BYTE.set(0x017d, 0x8e);
WINANSI_TO_BYTE.set(0x2018, 0x91);
WINANSI_TO_BYTE.set(0x2019, 0x92);
WINANSI_TO_BYTE.set(0x201c, 0x93);
WINANSI_TO_BYTE.set(0x201d, 0x94);
WINANSI_TO_BYTE.set(0x2022, 0x95);
WINANSI_TO_BYTE.set(0x2013, 0x96);
WINANSI_TO_BYTE.set(0x2014, 0x97);
WINANSI_TO_BYTE.set(0x02dc, 0x98);
WINANSI_TO_BYTE.set(0x2122, 0x99);
WINANSI_TO_BYTE.set(0x0161, 0x9a);
WINANSI_TO_BYTE.set(0x203a, 0x9b);
WINANSI_TO_BYTE.set(0x0153, 0x9c);
WINANSI_TO_BYTE.set(0x017e, 0x9e);
WINANSI_TO_BYTE.set(0x0178, 0x9f);
WINANSI_TO_BYTE.set(0x00a0, 0xa0);

function winAnsiByte(codePoint) {
  return WINANSI_TO_BYTE.get(codePoint) ?? 0x3f;
}

function pdfTextWidth(text, fontKey, size) {
  const widths = PDF_WIDTHS[fontKey];
  let total = 0;
  for (const character of text) {
    total += widths[winAnsiByte(character.codePointAt(0)) - 32];
  }
  return (total * size) / 1000;
}

function pdfHexText(text) {
  const bytes = Buffer.allocUnsafe(Buffer.byteLength(text, 'utf8'));
  let index = 0;
  for (const character of text) {
    bytes[index++] = winAnsiByte(character.codePointAt(0));
  }
  return bytes.subarray(0, index).toString('hex').toUpperCase();
}

function number(value) {
  return String(Number(value.toFixed(3)));
}

function wrapPdfText(text, fontKey, size, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    const words = paragraph.replace(/\t/g, '    ').split(/ +/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (pdfTextWidth(candidate, fontKey, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        lines.push(line);
        line = '';
      }
      if (pdfTextWidth(word, fontKey, size) <= maxWidth) {
        line = word;
        continue;
      }
      let rest = word;
      while (rest && pdfTextWidth(rest, fontKey, size) > maxWidth) {
        let cut = rest.length;
        while (cut > 1 && pdfTextWidth(rest.slice(0, cut), fontKey, size) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines : [''];
}

function pdfLayout(doc, options) {
  const pages = [];
  let ops = [];
  let cursor = A4.height - MARGIN;

  const textOp = (x, baseline, text, fontKey, size, color) => {
    ops.push(`${color} rg BT /${fontKey} ${number(size)} Tf 1 0 0 1 ${number(x)} ${number(baseline)} Tm <${pdfHexText(text)}> Tj ET`);
  };

  const rule = (x1, y1, x2, y2, width, color) => {
    ops.push(`${color} RG ${number(width)} w ${number(x1)} ${number(y1)} m ${number(x2)} ${number(y2)} l S`);
  };

  const bar = (x, top, height, width, color) => {
    ops.push(`${color} rg ${number(x)} ${number(top)} ${number(width)} ${number(height)} re f`);
  };

  const truncateToWidth = (line, fontKey, size, maxWidth) => {
    let value = line;
    while (value && pdfTextWidth(`${value}…`, fontKey, size) > maxWidth) value = value.slice(0, -1);
    return value ? `${value.replace(/\s+$/, '')}…` : '';
  };

  // Cabecera de página dentro del margen superior; el cuerpo no pierde espacio.
  const drawHeader = () => {
    if (!doc.header) return;
    const headerWidth = CONTENT_WIDTH - (doc.header.pageNumber ? 42 : 0);
    const allLines = wrapPdfText(doc.header.text, 'F1', 8, headerWidth).filter((line) => line !== '');
    if (!allLines.length) return;
    const lines = allLines.slice(0, 4);
    if (allLines.length > 4) {
      lines[3] = truncateToWidth(lines[3], 'F1', 8, headerWidth);
      if (!lines[3]) lines.length = 3;
    }
    const firstBaseline = A4.height - 22;
    lines.forEach((line, index) => {
      textOp(MARGIN, firstBaseline - index * 8.5, line, 'F1', 8, FOOTER_INK);
    });
    if (lines.length) {
      const borderY = firstBaseline - (lines.length - 1) * 8.5 - 6;
      rule(MARGIN, borderY, A4.width - MARGIN, borderY, 0.5, RULE);
    }
  };

  const newPage = () => {
    ops = [];
    pages.push(ops);
    cursor = A4.height - MARGIN;
    drawHeader();
  };

  const ensure = (height) => {
    if (cursor - height < MARGIN) newPage();
  };

  /* --- Tablas PDF: rejilla real, multilínea y continuación de filas --- */

  const layoutTableRow = (row, widths) => {
    let column = 0;
    const cells = row.cells.map((cell) => {
      const width = widths.slice(column, column + cell.span).reduce((total, value) => total + value, 0);
      const lines = wrapPdfText(
        cell.text || '',
        row.header ? 'F2' : 'F1',
        TABLE_FONT_SIZE,
        Math.max(1, width - TABLE_PAD_X * 2),
      );
      const entry = { column, span: cell.span, width, lines };
      column += cell.span;
      return entry;
    });
    const lineCount = Math.max(1, ...cells.map((cell) => cell.lines.length));
    return { row, cells, lineCount };
  };

  const drawRowChunk = (layout, startLine, endLine, top, columnX) => {
    const height = (endLine - startLine) * TABLE_LEADING + TABLE_PAD_Y * 2;
    const bottom = top - height;
    if (layout.row.header) bar(MARGIN, bottom, height, CONTENT_WIDTH, TABLE_HEADER_FILL);

    rule(MARGIN, top, MARGIN + CONTENT_WIDTH, top, 0.5, TABLE_RULE);
    rule(MARGIN, bottom, MARGIN + CONTENT_WIDTH, bottom, 0.5, TABLE_RULE);

    const skipped = new Set();
    for (const cell of layout.cells) {
      for (let boundary = cell.column + 1; boundary < cell.column + cell.span; boundary++) {
        skipped.add(boundary);
      }
    }
    for (let boundary = 1; boundary < columnX.length - 1; boundary++) {
      if (skipped.has(boundary)) continue;
      rule(columnX[boundary], top, columnX[boundary], bottom, 0.5, TABLE_RULE);
    }
    rule(columnX[0], top, columnX[0], bottom, 0.5, TABLE_RULE);
    rule(columnX[columnX.length - 1], top, columnX[columnX.length - 1], bottom, 0.5, TABLE_RULE);

    const fontKey = layout.row.header ? 'F2' : 'F1';
    for (const cell of layout.cells) {
      for (let lineIndex = startLine; lineIndex < endLine; lineIndex++) {
        const line = cell.lines[lineIndex];
        if (!line) continue;
        const baseline = top - TABLE_PAD_Y - TABLE_FONT_SIZE * 0.78 - (lineIndex - startLine) * TABLE_LEADING;
        textOp(columnX[cell.column] + TABLE_PAD_X, baseline, line, fontKey, TABLE_FONT_SIZE, INK);
      }
    }
  };

  const drawTable = (block) => {
    const widths = new Array(block.columns).fill(CONTENT_WIDTH / block.columns);
    const columnX = [MARGIN];
    for (const width of widths) columnX.push(columnX[columnX.length - 1] + width);
    const layouts = block.rows.map((row) => layoutTableRow(row, widths));

    const headerLayouts = [];
    let headerCount = 0;
    while (headerCount < layouts.length && block.rows[headerCount].header) {
      headerLayouts.push(layouts[headerCount]);
      headerCount += 1;
    }
    const headerHeight = headerLayouts.reduce(
      (total, layout) => total + layout.lineCount * TABLE_LEADING + TABLE_PAD_Y * 2,
      0,
    );
    const contentHeight = A4.height - MARGIN * 2;
    const minChunk = TABLE_LEADING + TABLE_PAD_Y * 2;
    const firstNeeded = Math.min(
      headerHeight + (headerCount < layouts.length ? minChunk : 0),
      contentHeight,
    );
    if (cursor - firstNeeded < MARGIN) newPage();

    const breakPage = (isHeaderRow) => {
      newPage();
      if (!isHeaderRow && headerLayouts.length) {
        const repeatHeight = headerHeight;
        if (repeatHeight + minChunk <= contentHeight) {
          for (const layout of headerLayouts) {
            drawRowChunk(layout, 0, layout.lineCount, cursor, columnX);
            cursor -= layout.lineCount * TABLE_LEADING + TABLE_PAD_Y * 2;
          }
        }
      }
    };

    for (let index = 0; index < layouts.length; index++) {
      const layout = layouts[index];
      const isHeaderRow = index < headerCount;
      let startLine = 0;
      while (startLine < layout.lineCount) {
        if (cursor - MARGIN < minChunk) breakPage(isHeaderRow);
        const available = cursor - MARGIN;
        const maxLines = Math.max(1, Math.floor((available - TABLE_PAD_Y * 2) / TABLE_LEADING));
        const endLine = Math.min(layout.lineCount, startLine + maxLines);
        drawRowChunk(layout, startLine, endLine, cursor, columnX);
        cursor -= (endLine - startLine) * TABLE_LEADING + TABLE_PAD_Y * 2;
        startLine = endLine;
        if (startLine < layout.lineCount) breakPage(isHeaderRow);
      }
    }
    cursor -= 8;
  };

  const drawLine = (text, { x = MARGIN, fontKey = 'F1', size = 11, color = INK, leading = 15.4 } = {}) => {
    ensure(leading);
    cursor -= leading;
    const baseline = cursor + size * 0.78;
    if (text) textOp(x, baseline, text, fontKey, size, color);
    return baseline;
  };

  newPage();

  // Título
  for (const line of wrapPdfText(doc.title, 'F2', 20, CONTENT_WIDTH)) {
    drawLine(line, { fontKey: 'F2', size: 20, leading: 25, color: INK });
  }
  cursor -= 6;
  ensure(10);
  const ruleY = cursor - 2;
  rule(MARGIN, ruleY, A4.width - MARGIN, ruleY, 0.8, RULE);
  cursor = ruleY - 14;

  let numberIndex = 0;

  for (const block of doc.blocks) {
    if (block.kind === 'heading') {
      const spec = HEADING_SPECS[block.level] || HEADING_SPECS[1];
      if (cursor < A4.height - MARGIN - 1) {
        ensure(16);
        cursor -= 16;
      }
      const lines = wrapPdfText(block.text, 'F2', spec.size, CONTENT_WIDTH);
      ensure(lines.length * spec.leading + 12);
      for (const line of lines) {
        drawLine(line, { fontKey: 'F2', size: spec.size, leading: spec.leading, color: HEADING_INK });
      }
      cursor -= 6;
      continue;
    }

    if (block.kind === 'table') {
      drawTable(block);
      continue;
    }

    const isQuote = block.kind === 'quote';
    const isBullet = block.kind === 'bullet';
    const isNumber = block.kind === 'number';

    if (isNumber) numberIndex += 1;
    if (isNumber || isBullet) {
      ensure(16);
      cursor -= 2;
    }
    if (isQuote) {
      ensure(14);
      cursor -= 4;
    }

    const indent = isBullet ? 22 : isNumber ? 34 : isQuote ? 18 : 0;
    const rightIndent = isQuote ? 14 : 0;
    const size = isQuote ? 10.5 : 11;
    const fontKey = isQuote ? 'F3' : 'F1';
    const leading = isQuote ? 14.5 : 15.4;
    const color = isQuote ? MUTED_INK : INK;
    const x = MARGIN + indent;
    const lines = wrapPdfText(block.text, fontKey, size, CONTENT_WIDTH - indent - rightIndent);

    lines.forEach((line, index) => {
      const baseline = drawLine(line, { x, fontKey, size, leading, color });
      if (index === 0 && isBullet) textOp(MARGIN + 6, baseline, '\u2022', 'F1', 11, INK);
      if (index === 0 && isNumber) {
        const label = `${numberIndex}.`;
        textOp(MARGIN + 30 - pdfTextWidth(label, 'F1', 11), baseline, label, 'F1', 11, INK);
      }
      if (isQuote) bar(MARGIN + 1.5, baseline - 9.5, 12.5, 2.6, '0.72 0.75 0.79');
    });

    if (isQuote) cursor -= 6;
    else if (isNumber || isBullet) cursor -= 3;
    else cursor -= 5;
  }

  // Pie de página: una pasada posterior conoce el total de páginas.
  const total = pages.length;
  if (!doc.footer) {
    // Camino heredado, sin cambios de bytes cuando no hay pie explícito.
    if (options.pageNumbers) {
      pages.forEach((pageOps, index) => {
        const label = `${index + 1} / ${total}`;
        const labelWidth = pdfTextWidth(label, 'F1', 8.5);
        pageOps.push(`${FOOTER_INK} rg BT /F1 8.5 Tf 1 0 0 1 ${number(A4.width - MARGIN - labelWidth)} 28 Tm <${pdfHexText(label)}> Tj ET`);
        const maxTitle = CONTENT_WIDTH - labelWidth - 24;
        const footerTitle = doc.title.replace(/[\n\t]+/g, ' ');
        const characters = Array.from(footerTitle);
        while (characters.length && pdfTextWidth(characters.join(''), 'F1', 8.5) > maxTitle) characters.pop();
        let title = characters.join('');
        if (title !== footerTitle && title) title = `${title.replace(/\s+$/, '')}…`;
        if (title) {
          pageOps.push(`${FOOTER_INK} rg BT /F1 8.5 Tf 1 0 0 1 ${number(MARGIN)} 28 Tm <${pdfHexText(title)}> Tj ET`);
        }
      });
    }
  } else {
    const showNumbers = options.pageNumbers || doc.footer.pageNumber === true;
    pages.forEach((pageOps, index) => {
      const label = showNumbers ? `${index + 1} / ${total}` : '';
      const labelWidth = label ? pdfTextWidth(label, 'F1', 8.5) : 0;
      const maxWidth = CONTENT_WIDTH - labelWidth - (label ? 24 : 0);
      const allLines = wrapPdfText(doc.footer.text, 'F1', 8.5, maxWidth).filter((line) => line !== '');
      const lines = allLines.slice(0, 2);
      if (allLines.length > 2) {
        lines[1] = truncateToWidth(lines[1], 'F1', 8.5, maxWidth);
        if (!lines[1]) lines.length = 1;
      }
      lines.forEach((line, lineIndex) => {
        const baseline = 28 + (lines.length - 1 - lineIndex) * 10;
        pageOps.push(`${FOOTER_INK} rg BT /F1 8.5 Tf 1 0 0 1 ${number(MARGIN)} ${number(baseline)} Tm <${pdfHexText(line)}> Tj ET`);
      });
      if (label) {
        pageOps.push(`${FOOTER_INK} rg BT /F1 8.5 Tf 1 0 0 1 ${number(A4.width - MARGIN - labelWidth)} 28 Tm <${pdfHexText(label)}> Tj ET`);
      }
    });
  }

  // Campo de página en cabecera (si se pidió): se dibuja arriba a la derecha.
  if (doc.header?.pageNumber) {
    pages.forEach((pageOps, index) => {
      const label = `${index + 1} / ${total}`;
      const labelWidth = pdfTextWidth(label, 'F1', 8);
      pageOps.push(`${FOOTER_INK} rg BT /F1 8 Tf 1 0 0 1 ${number(A4.width - MARGIN - labelWidth)} ${number(A4.height - 22)} Tm <${pdfHexText(label)}> Tj ET`);
    });
  }

  return pages;
}

function pdfUnicodeString(value) {
  return `<FEFF${Buffer.from(value, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

function pdfDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function pdfToUnicodeCMap() {
  const entries = [];
  for (let byte = 32; byte <= 255; byte++) {
    let codePoint;
    if (byte <= 126) codePoint = byte;
    else if (byte >= 160) codePoint = byte;
    else continue; // 127..159 no definidos salvo los especiales de abajo
    entries.push([byte, codePoint]);
  }
  const specials = [
    [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
    [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
    [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
    [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
    [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
    [0x9e, 0x017e], [0x9f, 0x0178],
  ];
  entries.push(...specials);

  const blocks = [];
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    blocks.push(`${slice.length} beginbfchar\n` +
      slice.map(([byte, codePoint]) =>
        `<${byte.toString(16).toUpperCase().padStart(2, '0')}> <${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`
      ).join('\n') + '\nendbfchar');
  }

  return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /WinAnsi-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<00> <FF>\nendcodespacerange\n' +
    `${blocks.join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

function pdfBytes(doc, meta, options) {
  const pages = pdfLayout(doc, options);
  const total = pages.length;
  const objects = new Array(8 + total * 2).fill(null); // índice 1..(7+N*2)

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${8 + i * 2} 0 R`).join(' ')}] /Count ${total} >>`;

  const font = (objectNumber, baseFont, tableKey) => {
    objects[objectNumber] = `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding ` +
      `/FirstChar 32 /LastChar 255 /Widths [${Array.from(PDF_WIDTHS[tableKey]).join(' ')}] /ToUnicode 6 0 R >>`;
  };
  font(3, 'Helvetica', 'F1');
  font(4, 'Helvetica-Bold', 'F2');
  font(5, 'Helvetica-Oblique', 'F3');

  const cmap = Buffer.from(pdfToUnicodeCMap(), 'latin1');
  objects[6] = `<< /Length ${cmap.length} >>\nstream\n${cmap.toString('latin1')}\nendstream`;

  objects[7] = `<< /Title ${pdfUnicodeString(doc.title)} /Author ${pdfUnicodeString(meta.author)} ` +
    '/Creator (HUB Documentos) /Producer (HUB Documentos) ' +
    `/CreationDate (${pdfDate(meta.now)}) /ModDate (${pdfDate(meta.now)}) >>`;

  pages.forEach((pageOps, index) => {
    const content = Buffer.from(pageOps.join('\n'), 'latin1');
    objects[8 + index * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
      '/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> /ProcSet [/PDF /Text] >> ' +
      `/Contents ${9 + index * 2} 0 R >>`;
    objects[9 + index * 2] = `<< /Length ${content.length} >>\nstream\n${content.toString('latin1')}\nendstream`;
  });

  const serialized = objects.map((object, index) => (index === 0 ? null : object));
  // El camino heredado conserva exactamente la misma cadena de huella.
  const fingerprint = doc.blocks.map((block) => {
    if (block.kind === 'table') {
      const rows = block.rows.map((row) => `${row.header ? 'h' : 'b'}:${row.cells.map((cell) => `${cell.span}:${cell.text}`).join(',')}`);
      return `table:${rows.join('|')}`;
    }
    if (block.kind === 'heading' && block.level > 1) return `heading:${block.text}:${block.level}`;
    return `${block.kind}:${block.text}`;
  });
  if (doc.header) fingerprint.push(`header:${doc.header.pageNumber ? 1 : 0}:${doc.header.text}`);
  if (doc.footer) fingerprint.push(`footer:${doc.footer.pageNumber ? 1 : 0}:${doc.footer.text}`);
  const id = crypto.createHash('sha256')
    .update(`${doc.title}\n${fingerprint.join('\n')}`)
    .digest('hex')
    .slice(0, 32)
    .toUpperCase();

  const chunks = ['%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n'];
  const offsets = [];
  let position = Buffer.byteLength(chunks[0], 'latin1');

  for (let index = 1; index < serialized.length; index++) {
    const body = `${index} 0 obj\n${serialized[index]}\nendobj\n`;
    offsets[index] = position;
    chunks.push(body);
    position += Buffer.byteLength(body, 'latin1');
  }

  const xrefPosition = position;
  let xref = `xref\n0 ${serialized.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < serialized.length; index++) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${serialized.length} /Root 1 0 R /Info 7 0 R /ID [<${id}> <${id}>] >>\n` +
    `startxref\n${xrefPosition}\n%%EOF\n`);

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'latin1')));
}

/* ------------------------------------------------------------------------- *
 * API
 * ------------------------------------------------------------------------- */

function normalizeFormat(format) {
  if (typeof format !== 'string') {
    throw new ExportError('E_FORMAT', 'El formato debe ser md, docx o pdf.');
  }
  const value = format.trim().toLowerCase().replace(/^\./, '');
  if (!Object.hasOwn(FORMATS, value)) {
    throw new ExportError('E_FORMAT', `Formato no soportado: ${format}.`);
  }
  return value;
}

/**
 * Genera el documento. Nunca lanza errores del sistema: solo ExportError con
 * código estable (E_INPUT, E_KIND, E_TABLE, E_FORMAT, E_OPTION, E_LIMIT).
 */
async function renderDocument(snapshot, format, options) {
  const resolvedFormat = normalizeFormat(format);
  const resolvedOptions = readOptions(options);
  const doc = normalizeSnapshot(snapshot, resolvedOptions);
  const meta = { now: resolvedOptions.now, author: resolvedOptions.author };

  let bytes;
  if (resolvedFormat === 'md') {
    bytes = Buffer.from(markdownDocument(doc), 'utf8');
  } else if (resolvedFormat === 'docx') {
    bytes = docxBytes(doc, meta);
  } else {
    bytes = pdfBytes(doc, meta, resolvedOptions);
  }

  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ExportError('E_INTERNAL', 'La generación produjo un documento vacío.');
  }

  return {
    bytes,
    mimeType: FORMATS[resolvedFormat].mimeType,
    extension: FORMATS[resolvedFormat].extension,
  };
}

/**
 * Nombre de fichero limpio y seguro: ASCII, sin rutas, sin caracteres de control.
 * No se usa para escribir en disco: solo para Content-Disposition / descarga.
 */
function suggestFileName(title, extension = 'pdf') {
  const format = normalizeFormat(extension);
  const ascii = String(title ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øØæÆœŒß]/g, (character) => ({ ø: 'o', Ø: 'O', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ß: 'ss' })[character])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return `${ascii || 'documento'}.${FORMATS[format].extension}`;
}

module.exports = {
  renderDocument,
  suggestFileName,
  ExportError,
  FORMATS,
  LIMITS,
};
