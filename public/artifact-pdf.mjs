import { AnnotationMode, getDocument, PDFWorker } from './vendor/pdfjs-6.5.438/pdf.min.mjs';

const base = new URL('./vendor/pdfjs-6.5.438/', import.meta.url);
const sourceFolders = Object.freeze({ cMapUrl:'cmaps/', standardFontDataUrl:'standard_fonts/', wasmUrl:'wasm/', iccUrl:'iccs/' });
// PDF.js can request built-in fonts and decoders, not URLs from the attachment.
class LocalPdfResources {
  async fetch({ kind, filename }) {
    if (!Object.hasOwn(sourceFolders, kind) || typeof filename !== 'string' ||
        !/^[a-z0-9_-][a-z0-9_.-]{0,127}\.(?:bcmap|ttf|pfb|wasm|icc)$/i.test(filename) || filename.includes('..')) throw new Error('Unsupported PDF resource');
    const res = await fetch(new URL(sourceFolders[kind] + filename, base), { credentials:'omit', redirect:'error' });
    if (!res.ok) throw new Error('PDF resource unavailable');
    return new Uint8Array(await res.arrayBuffer());
  }
}

export async function openPdf(data, signal) {
  const signature = new TextDecoder().decode(data.subarray(0, 1024));
  if (!/%PDF-[12]\.\d/.test(signature)) throw new Error('El archivo no es un PDF válido.');
  signal.throwIfAborted();
  // A worker is required, with no fallback to interpreting the file on the UI thread.
  const port = new Worker(new URL('pdf.worker.min.mjs', base), { type:'module', name:'hub-pdf-renderer' });
  const worker = PDFWorker.create({ port, verbosity:0 });
  const task = getDocument({ data, worker, ...Object.fromEntries(Object.entries(sourceFolders).map(([k, v]) => [k, new URL(v, base).href])),
    cMapPacked:true, useWorkerFetch:false, BinaryDataFactory:LocalPdfResources, enableXfa:false,
    isEvalSupported:false, isImageDecoderSupported:false, maxImageSize:45000000, canvasMaxAreaInBytes:24000000, verbosity:0 });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', dispose);
    void task.destroy().catch(() => {});
    worker.destroy(); port.terminate();
  };
  signal.addEventListener('abort', dispose, { once:true });
  const failed = new Promise((_, reject) => port.addEventListener('error', () => reject(new Error('El lector PDF no se pudo iniciar.')), {once:true}));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  const stopped = new Promise((_, reject) => {
    if (deadline.aborted) reject(deadline.reason);
    else deadline.addEventListener('abort', () => reject(deadline.reason), {once:true});
  });
  try {
    const pdf = await Promise.race([task.promise, failed, stopped]);
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 2000) throw new Error('Este PDF tiene demasiadas páginas para la vista previa.');
    return {
      numPages: pdf.numPages,
      dispose,
      async render(number, width, zoom, renderSignal) {
        const page = await pdf.getPage(number);
        renderSignal.throwIfAborted();
        const intrinsic = page.getViewport({scale:1});
        if (![intrinsic.width,intrinsic.height].every(x=>Number.isFinite(x)&&x>0)) throw new Error('Página PDF no válida.');
        const view = page.getViewport({scale:Math.min(width,900)/intrinsic.width*zoom});
        const ratio = Math.min(window.devicePixelRatio || 1, 2.5, Math.sqrt(5500000/(view.width*view.height)), 4096/Math.max(view.width,view.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1,Math.floor(view.width*ratio)); canvas.height = Math.max(1,Math.floor(view.height*ratio));
        canvas.style.width = Math.round(view.width)+'px'; canvas.style.height = Math.round(view.height)+'px';
        canvas.setAttribute('role','img'); canvas.setAttribute('aria-label','Página '+number+' de '+pdf.numPages);
        const render = page.render({canvas, viewport:view, transform:[ratio,0,0,ratio,0,0], background:'#ffffff', annotationMode:AnnotationMode.ENABLE});
        const cancel = () => render.cancel();
        renderSignal.addEventListener('abort', cancel, { once:true });
        try { await render.promise; renderSignal.throwIfAborted(); return canvas; }
        catch(error) { canvas.width=canvas.height=0; throw error; }
        finally { renderSignal.removeEventListener('abort',cancel); page.cleanup(); }
      },
    };
  } catch (error) { dispose(); throw error; }
}
