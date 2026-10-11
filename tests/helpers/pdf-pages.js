/* Node-side helper: load a PDF with the pdf.js legacy build and extract pages. */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages } from '../../src/pdf-pages.js';

export async function loadPdfPages(data) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, isEvalSupported: false }).promise;
  return extractPages(pdfjs, doc);
}
