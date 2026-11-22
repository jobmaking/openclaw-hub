#!/usr/bin/env python3
"""Synthetic PDF and Excel attachments. Nothing is written outside the fixture directory."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
from xml.sax.saxutils import escape
import sys
import json
import shutil
import subprocess

out = Path(sys.argv[1])
out.mkdir(mode=0o700, exist_ok=True)
media = '--media' in sys.argv[1:]
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
P = 'http://schemas.openxmlformats.org/package/2006/relationships'
C = 'http://schemas.openxmlformats.org/package/2006/content-types'

def rel(ident, kind, path):
    return f'<Relationship Id="{ident}" Type="{R}/{kind}" Target="{path}"/>'

def relfile(parts):
    return f'<Relationships xmlns="{P}">'+''.join(parts)+'</Relationships>'

def sheet(data):
    return f'<worksheet xmlns="{S}"><sheetData>{data}</sheetData></worksheet>'

def inline(ref, text):
    return f'<c r="{ref}" t="inlineStr"><is><t>{escape(text)}</t></is></c>'

with ZipFile(out/'Balance de ejemplo.xlsx','w',ZIP_DEFLATED) as x:
    override = lambda p, t: f'<Override PartName="/xl/{p}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.{t}+xml"/>'
    parts = ''.join(override('worksheets/sheet'+str(n),'worksheet') for n in range(1,5)) + override('workbook','sheet.main') + override('styles','styles') + override('sharedStrings','sharedStrings')
    x.writestr('[Content_Types].xml',f'<Types xmlns="{C}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>{parts}</Types>')
    x.writestr('_rels/.rels',relfile([rel('rId1','officeDocument','xl/workbook.xml')]))
    x.writestr('xl/workbook.xml',f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets><sheet name="Resumen" sheetId="1" r:id="rId1"/><sheet name="Detalles" sheetId="2" r:id="rId2"/><sheet name="Vacía" sheetId="3" r:id="rId3"/><sheet name="Auxiliar" sheetId="4" state="hidden" r:id="rId4"/></sheets></workbook>')
    x.writestr('xl/_rels/workbook.xml.rels',relfile([rel('rId'+str(n),'worksheet','worksheets/sheet'+str(n)+'.xml') for n in range(1,5)]+[rel('rId5','sharedStrings','sharedStrings.xml'),rel('rId6','styles','styles.xml')]))
    x.writestr('xl/sharedStrings.xml',f'<sst xmlns="{S}" count="2" uniqueCount="2"><si><t>Concepto</t></si><si><r><t>Tot</t></r><r><t>al</t></r></si></sst>')
    x.writestr('xl/styles.xml',f'<styleSheet xmlns="{S}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>')
    x.writestr('xl/worksheets/sheet1.xml',sheet('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2">'+inline('A2','Cuota <prevista> & revisión')+'<c r="B2"><f>200+34.5</f><v>234.5</v></c><c r="C2" s="1"><v>0.253</v></c><c r="D2" s="2"><v>46347</v></c></row>'))
    x.writestr('xl/worksheets/sheet2.xml',sheet('<row r="1">'+inline('A1','Hoja 2: financiación')+inline('AH1','Columna 34')+'</row><row r="61">'+inline('A61','Fila 61')+'</row><row r="5001">'+inline('A5001','Fuera de la vista')+'</row>'))
    x.writestr('xl/worksheets/sheet3.xml',sheet(''))
    x.writestr('xl/worksheets/sheet4.xml',sheet('<row r="1">'+inline('A1','Hoja auxiliar')+'</row>'))

pdf = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
page = lambda ref: f'<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 500 680] /Contents {ref} 0 R >>'.encode()

def drawing(color, text):
    content = f'{color} rg 25 485 440 120 re f 0 0 0 rg BT /F1 26 Tf 38 635 Td ({text}) Tj ET'.encode('latin1')
    return f'<< /Length {len(content)} >>\nstream\n'.encode()+content+b'\nendstream'

objects = [b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Count 2 /Kids [4 0 R 5 0 R] >>',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',page(6),page(7),
    drawing('0.90 0.18 0.25','Informe de prueba - página 1'),drawing('0.13 0.63 0.39','Informe de prueba - página 2')]
offsets = [0]
for i, entry in enumerate(objects,1):
    offsets.append(len(pdf));pdf.extend(f'{i} 0 obj\n'.encode()+entry+b'\nendobj\n')
start=len(pdf)
pdf.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
for o in offsets[1:]:pdf.extend(f'{o:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{start}\n%%EOF\n'.encode())
(out/'Informe de ejemplo.pdf').write_bytes(pdf)
(out/'PDF no disponible.pdf').write_bytes(b'El archivo no contiene un PDF.')

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
def para(t): return '<w:p><w:r><w:t xml:space="preserve">'+escape(t)+'</w:t></w:r></w:p>'
def word_table(data, header=False):
    return '<w:tbl>'+''.join('<w:tr>'+('<w:trPr><w:tblHeader/></w:trPr>' if header and i==0 else '')+''.join('<w:tc>'+c+'</w:tc>' for c in cells)+'</w:tr>' for i,cells in enumerate(data))+'</w:tbl>'

def make_word(name, complex_table=False):
    cols=[para('Concepto'),para('Estado'),para('Responsable')]
    body=para('Texto original completo antes de la tabla.')+word_table([cols,[para('Pago de ejemplo'),para('Confirmado'),para('Equipo ficticio')],
          [para('Segunda fila'),para('Pendiente')+(word_table([[para('Detalle de tabla anidada')]]) if complex_table else ''),para('Misma cifra')]],True)+para('Texto original completo después de la tabla.')
    frame='<w:sectPr><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr>'
    with ZipFile(out/name,'w',ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml',f'<Types xmlns="{C}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+''.join('<Override PartName="/word/'+part+'.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.'+typ+'+xml"/>' for part,typ in [('document','document.main'),('header1','header'),('footer1','footer')])+'</Types>')
        z.writestr('_rels/.rels',relfile([rel('rId1','officeDocument','word/document.xml')]))
        z.writestr('word/document.xml',f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}{frame}</w:body></w:document>')
        z.writestr('word/_rels/document.xml.rels',relfile([rel('rId1','header','header1.xml'),rel('rId2','footer','footer1.xml')]))
        z.writestr('word/header1.xml',f'<w:hdr xmlns:w="{W}">'+para('Cabecera de prueba')+'</w:hdr>')
        z.writestr('word/footer1.xml',f'<w:ftr xmlns:w="{W}"><w:p><w:r><w:t>Pie de prueba</w:t><w:tab/></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>')

make_word('Acuerdo estructurado.docx')
make_word('Acuerdo complejo.docx',True)

# Long titles, near-identical versions and one unsupported type for the
# "Mi trabajo" reader. Existing fixtures above stay byte-identical.
def make_long_pdf(name, label, rgb):
    data = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    content = f'{rgb} rg 20 400 460 210 re f 0 0 0 rg BT /F1 22 Tf 34 620 Td ({label}) Tj ET'.encode('latin1')
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Count 1 /Kids [4 0 R] >>',
        b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
        b'<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 500 680] /Contents 5 0 R >>',
        f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'\nendstream']
    offsets = [0]
    for i, entry in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(f'{i} 0 obj\n'.encode() + entry + b'\nendobj\n')
    start = len(data)
    data.extend(f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode())
    for o in offsets[1:]: data.extend(f'{o:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{start}\n%%EOF\n'.encode())
    (out/name).write_bytes(data)

reader = []
def declare(ident, name, mime):
    reader.append({'id': ident, 'title': name, 'mimeType': mime})

prefix = 'Acta de la comisión de seguimiento del proyecto de modernización del servicio municipal de aguas'
for ident, suffix, label, rgb in [
    ('fixture-reader-acta-3', ' — versión 3', 'ACTA version 3', '0.85 0.18 0.22'),
    ('fixture-reader-acta-3-final', ' — versión 3 (revisión final)', 'ACTA version 3 revision final', '0.16 0.32 0.78'),
    ('fixture-reader-acta-30', ' — versión 30', 'ACTA version 30', '0.10 0.62 0.36'),
]:
    name = prefix + suffix + '.pdf'
    make_long_pdf(name, label, rgb)
    declare(ident, name, 'application/pdf')

budget = 'Presupuesto consolidado del plan de eficiencia energética de edificios municipales — versión 12.xlsx'
(out/budget).write_bytes((out/'Balance de ejemplo.xlsx').read_bytes())
declare('fixture-reader-budget-12', budget, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')

contract = 'Contrato de suministro y mantenimiento del sistema de control de accesos — versión 2 (revisión legal).docx'
(out/contract).write_bytes((out/'Acuerdo estructurado.docx').read_bytes())
declare('fixture-reader-contract-2', contract, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')

notes = 'Notas internas de la reunión del comité de dirección — versión 2.txt'
(out/notes).write_text('Notas ficticias de la prueba del lector.\n', encoding='utf-8')
declare('fixture-reader-notes-2', notes, 'text/plain')

(out/'fixtures.json').write_text(json.dumps({'reader': reader}, ensure_ascii=False, indent=1), encoding='utf-8')

# Synthetic stills and short clips for the isolated multimedia viewer suite.
# They are generated locally, never downloaded, and stay inside the fixture
# directory. The old PDF/Word/Excel fixtures above remain byte-identical.
media_items = []

def ffmpeg(*args):
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y',*args],
                   check=True, timeout=90, stdin=subprocess.DEVNULL)

def declare_media(ident, name, mime, kind, session='main', width=None, height=None, duration_ms=None):
    media_items.append({'id': ident, 'title': name, 'mimeType': mime, 'kind': kind,
                        'session': session, 'file': name, 'width': width, 'height': height,
                        'durationMs': duration_ms})

if media:
    if not shutil.which('ffmpeg'):
        raise SystemExit('ffmpeg is required for the multimedia fixtures')
    ffmpeg('-f','lavfi','-i','testsrc2=size=360x240:rate=1','-frames:v','1',str(out/'Imagen sintética.png'))
    declare_media('fixture-media-image','Imagen sintética.png','image/png','image',width=360,height=240)
    ffmpeg('-f','lavfi','-i','testsrc2=size=320x200:rate=1','-frames:v','1','-q:v','3',str(out/'Fotografía sintética.jpg'))
    declare_media('fixture-media-jpeg','Fotografía sintética.jpg','image/jpeg','image',width=320,height=200)
    ffmpeg('-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1.6',
           '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1.6',
           '-t','1.6','-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-profile:v','baseline',
           '-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',str(out/'Vídeo de prueba.mp4'))
    declare_media('fixture-media-video','Vídeo de prueba.mp4','video/mp4','video',width=320,height=180,duration_ms=1600)
    ffmpeg('-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=1.0',
           '-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=1.0',
           '-t','1.0','-c:v','libvpx-vp9','-b:v','300k','-c:a','libopus','-b:a','64k','-shortest',
           str(out/'Vídeo alternativo.webm'))
    declare_media('fixture-media-webm','Vídeo alternativo.webm','video/webm','video',width=320,height=180,duration_ms=1000)
    # The Work inbox gets its own media deliveries so a session can only see
    # the files it was actually granted, never the chat session's files.
    (out/'Imagen de trabajo.png').write_bytes((out/'Imagen sintética.png').read_bytes())
    declare_media('fixture-work-image','Imagen de trabajo.png','image/png','image',session='work',width=360,height=240)
    (out/'Vídeo de trabajo.mp4').write_bytes((out/'Vídeo de prueba.mp4').read_bytes())
    declare_media('fixture-work-video','Vídeo de trabajo.mp4','video/mp4','video',session='work',width=320,height=180,duration_ms=1600)

(out/'fixtures.json').write_text(json.dumps({'reader': reader, 'media': media_items}, ensure_ascii=False, indent=1), encoding='utf-8')
