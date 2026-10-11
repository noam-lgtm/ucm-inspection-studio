/*
 * Shared pdf.js glue: turn a loaded document into pages of positioned text
 * items plus image placements (page points, y measured from the top).
 * Works in the browser and in Node; the caller supplies the pdf.js module.
 */
export async function extractPages(pdfjs, doc) {
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = tc.items.filter(it => it.str !== undefined)
      .map(it => ({ str: it.str, x: it.transform[4], y: vp.height - it.transform[5], w: it.width, h: it.height }));
    const images = await pageImages(pdfjs, page, vp);
    pages.push({ items, width: vp.width, height: vp.height, images });
  }
  return pages;
}

/** Image placements by walking the operator list with the current transformation matrix. */
export async function pageImages(pdfjs, page, vp) {
  const ops = await page.getOperatorList();
  const out = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === pdfjs.OPS.save) stack.push(ctm);
    else if (fn === pdfjs.OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, args);
    else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) {
      const w = Math.abs(ctm[0]) + Math.abs(ctm[2]), h = Math.abs(ctm[1]) + Math.abs(ctm[3]);
      const x = ctm[4] + Math.min(0, ctm[0], ctm[2]), yBottom = ctm[5] + Math.min(0, ctm[1], ctm[3]);
      out.push({ x, y: vp.height - (yBottom + h), w, h });
    }
  }
  return out;
}
