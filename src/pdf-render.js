/*
 * Browser-side PDF/image loading for the import wizard: text items + image
 * placements (for the parser), page renders (for AI and crops).
 */
import { extractPages } from './pdf-pages.js';

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.js').then(mod => {
      mod.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return mod;
    });
  }
  return pdfjsPromise;
}

/** Load a PDF file into a document handle plus parsed pages. */
export async function loadPdf(arrayBuffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(arrayBuffer), isEvalSupported: false }).promise;
  const pages = await extractPages(lib, doc);
  return { kind: 'pdf', doc, pages, numPages: doc.numPages };
}

/** Load a photo / scan: one "page" with no text layer. */
export async function loadImage(file) {
  const bitmap = await createImageBitmap(file);
  const width = 595, height = Math.round(595 * bitmap.height / bitmap.width);
  return { kind: 'image', bitmap, pages: [{ items: [], width, height, images: [] }], numPages: 1 };
}

/** Render page `index` (0-based) to a canvas at `scale` (1 = 72 dpi). */
export async function renderPage(source, index, scale = 2) {
  const canvas = document.createElement('canvas');
  if (source.kind === 'image') {
    const page = source.pages[0];
    canvas.width = Math.round(page.width * scale); canvas.height = Math.round(page.height * scale);
    canvas.getContext('2d').drawImage(source.bitmap, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  const page = await source.doc.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** Crop a rectangle (page points) out of a rendered page canvas. Returns a data URL. */
export function cropDataUrl(pageCanvas, rect, scale, pad = 3) {
  const x = Math.max(0, Math.floor((rect.x - pad) * scale)), y = Math.max(0, Math.floor((rect.y - pad) * scale));
  const w = Math.min(pageCanvas.width - x, Math.ceil((rect.w + pad * 2) * scale)), h = Math.min(pageCanvas.height - y, Math.ceil((rect.h + pad * 2) * scale));
  if (w <= 0 || h <= 0) return '';
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(pageCanvas, x, y, w, h, 0, 0, w, h);
  return c.toDataURL('image/png');
}

/** JPEG data (base64, no prefix) of a page for the AI extractor. */
export async function pageJpegBase64(source, index, maxWidth = 1500) {
  const scale = Math.min(3, maxWidth / source.pages[index].width);
  const canvas = await renderPage(source, index, scale);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}
