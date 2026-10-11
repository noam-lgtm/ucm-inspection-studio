/*
 * The printable Final Inspection Report (English, A4). Pure function of
 * (report, pages) -> HTML string. Used for on-screen preview and printing.
 *
 * Pagination is explicit: `pages` is an array of row-index arrays, one per
 * page, computed by the caller after measuring the rendered rows (see
 * paginateReport in app.js). Page 1 carries the masthead and the header
 * blocks, every page repeats the running header and the table header, and the
 * summary / remarks / signature block closes the last page.
 */
import {
  evaluateFeature, printedRequired, printedTolerances, limitsText, summarize,
  reportSampling, formatDateForReport, COMPANY,
} from './core.js';
import { DEFAULT_LOGO } from './logo-default.js';

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const esc = escapeHtml;
const dash = '—';
const show = v => (String(v ?? '').trim() ? esc(String(v).trim()) : dash);

export const RESULT_LABELS = {
  ok: 'PASS', 'manual-pass': 'PASS', fail: 'FAIL', review: 'REVIEW', empty: 'NOT MEASURED',
};

function resultCell(state) {
  const cls = state === 'ok' || state === 'manual-pass' ? 'r-pass' : state === 'fail' ? 'r-fail' : state === 'review' ? 'r-review' : 'r-empty';
  return `<span class="${cls}">${RESULT_LABELS[state] || 'REVIEW'}</span>`;
}

/** Suggested file name for the saved PDF. */
export function reportFileName(report) {
  const no = String(report.header.reportNo || '').trim();
  const parts = [no || 'Final-Inspection-Report', report.header.partNo].map(p => String(p || '').trim()).filter(Boolean);
  const name = parts.join('_').replace(/[^\w.\-֐-׿]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return name || 'Final-Inspection-Report';
}

function rowHtml(report, i) {
  const f = report.features[i];
  const r = report.results[f.id] || {};
  const ev = evaluateFeature(f, r);
  const isNumeric = f.kind === 'numeric';
  const tol = printedTolerances(f);
  let min, max;
  if (isNumeric) { min = show(r.min); max = show(r.max); }
  else { min = r.outcome === 'pass' ? 'GO' : r.outcome === 'fail' ? 'NO-GO' : dash; max = ''; }
  const noteLine = String(r.note || '').trim() ? `<div class="rs-rownote">${esc(r.note)}</div>` : '';
  return `<tr>
    <td class="c">${i + 1}</td>
    <td class="req">${esc(printedRequired(f) || dash)}${noteLine}</td>
    <td>${show(f.method)}</td>
    ${isNumeric ? `<td class="c">${show(tol.minus)}</td><td class="c">${show(tol.plus)}</td>` : '<td class="c" colspan="2">GO / NO-GO</td>'}
    ${isNumeric ? `<td class="c num">${min}</td><td class="c num">${max}</td>` : `<td class="c num" colspan="2">${min}</td>`}
    <td class="c">${resultCell(ev.state)}</td>
  </tr>`;
}

function firstPageHeader(report) {
  const h = report.header;
  const { plan } = reportSampling(report);
  const cells = [['AQL', show(h.aql)], ['INSPECTION LEVEL', show(h.inspectionLevel)], ['LOT SIZE', show(h.quantity)]];
  if (plan && plan.lotOfOne) cells.push(['CODE LETTER', dash], ['SAMPLE SIZE', '1'], ['Ac / Re', dash]);
  else if (plan) cells.push(['CODE LETTER', esc(plan.tableLetter)], ['SAMPLE SIZE', esc(String(plan.sampleSize))], ['Ac / Re', plan.plan ? `${plan.plan.ac} / ${plan.plan.re}` : dash]);
  else cells.push(['CODE LETTER', dash], ['SAMPLE SIZE', dash], ['Ac / Re', dash]);
  cells.push(['TOTAL INSPECTED', show(h.totalInspected)], ['ACCEPTED QTY', show(h.accepted)], ['REJECTED QTY', show(h.rejected)]);
  const facts = [
    ['CUSTOMER', h.customer], ['PURCHASE ORDER', h.purchaseOrder], ['PRODUCTION ORDER', h.productionOrder], ['LOT QUANTITY', h.quantity],
    ['CATALOG No.', h.catalogNo], ['PART No.', h.partNo], ['PART NAME', h.partName], ['REVISION', h.revision],
    ['GENERAL TOLERANCE', h.generalTolerance], ['INSPECTOR', h.inspector], ['DATE', formatDateForReport(h.inspectionDate)], ['TOTAL INSPECTED', h.totalInspected],
  ];
  return `<div class="rs-first">
    <div class="rs-mast">
      <div class="rs-brand"><img class="rs-logo" src="${DEFAULT_LOGO}" alt=""><div class="rs-company"><strong>${esc(COMPANY.name)}</strong><span>${esc(COMPANY.tagline)}</span></div></div>
      <div class="rs-title"><h1>FINAL INSPECTION REPORT</h1><div class="rs-no" dir="auto">${show(h.reportNo)}</div><div class="rs-date">${esc(formatDateForReport(h.inspectionDate) || dash)}</div></div>
    </div>
    <div class="rs-facts">${facts.map(([k, v]) => `<div class="rs-fact"><small>${k}</small><b dir="auto">${show(v)}</b></div>`).join('')}</div>
    <div class="rs-band">Sampling plan</div>
    <div class="rs-sampling">${cells.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    <div class="rs-band">Dimensional and attribute inspection results</div>
  </div>`;
}

function tailHtml(report) {
  const h = report.header;
  const counts = summarize(report.features, report.results);
  const { plan } = reportSampling(report);
  const notes = [];
  if (plan && plan.lotOfOne) notes.push('Lot of one unit: the unit is inspected in full (Table I starts at lot size 2).');
  if (plan && plan.plan && plan.plan.arrow) notes.push(`Table II-A arrow for code letter ${plan.tableLetter} at AQL ${plan.aql}: first plan ${plan.plan.arrow === 'down' ? 'below' : 'above'} the arrow is used (code ${plan.plan.letter}, n=${plan.plan.sampleSize}).`);
  if (plan && plan.fullInspection && !plan.lotOfOne) notes.push('Sample size equals or exceeds the lot size: 100% inspection.');
  if (plan && !plan.plan && !plan.lotOfOne) notes.push(`AQL ${h.aql || dash} is outside the plans built into this tool; sample size is shown from Table I only and Ac/Re must be taken from the standard.`);
  notes.push('Sampling: MIL-STD-105D Tables I and II-A, single sampling, normal inspection. Ac/Re are the acceptance and rejection numbers of that plan.');
  const status = counts.status === 'pass' ? '<span class="rs-status rs-status-pass">PASS – all characteristics within limits</span>'
    : counts.status === 'fail' ? '<span class="rs-status rs-status-fail">FAIL – nonconformance recorded</span>'
      : '<span class="rs-status rs-status-open">INCOMPLETE – not all characteristics verified</span>';
  return `<div class="rs-tail">
    <div class="rs-summary"><div>${status}</div><div class="rs-counts">Characteristics: ${counts.total} &middot; Pass ${counts.ok} &middot; Fail ${counts.fail} &middot; Review ${counts.review} &middot; Not measured ${counts.empty}</div></div>
    <div class="rs-band">Remarks</div>
    <div class="rs-remarks" dir="auto">${esc(report.remarks || '')}</div>
    <div class="rs-sign">
      <div><small>NAME</small><b dir="auto">${show(h.inspector)}</b></div>
      <div><small>DATE</small><b>${esc(formatDateForReport(h.inspectionDate) || dash)}</b></div>
      <div><small>SIGNATURE</small><b>&nbsp;</b><span class="line"></span></div>
    </div>
    <div class="rs-notes">${notes.map(n => `<div>${esc(n)}</div>`).join('')}</div>
  </div>`;
}

function pageHtml(report, rows, index, total, withTail) {
  const h = report.header;
  const running = `<div class="rs-running"><span>${esc(COMPANY.name)}</span><span>FINAL INSPECTION REPORT ${esc(h.reportNo || '')}</span><span>${esc(h.partNo ? 'Part ' + h.partNo : '')}</span></div>`;
  return `<div class="paper${index === total - 1 ? ' paper-last' : ''}"><section class="rs-page" data-page="${index + 1}">
    ${running}
    ${index === 0 ? firstPageHeader(report) : ''}
    <table class="rs-table">
      <colgroup><col class="w-no"><col class="w-req"><col class="w-method"><col class="w-tol"><col class="w-tol"><col class="w-min"><col class="w-max"><col class="w-res"></colgroup>
      <thead><tr><th>No.</th><th>Required</th><th>Test equip. / method</th><th>TOL&minus;</th><th>TOL+</th><th>Actual min</th><th>Actual max</th><th>Result</th></tr></thead>
      <tbody>${rows.map(i => rowHtml(report, i)).join('')}</tbody>
    </table>
    ${withTail ? tailHtml(report) : ''}
    <div class="rs-footer"><span>${esc(COMPANY.name)} | ${esc(COMPANY.footerLine)}</span><span>Page ${index + 1} of ${total}</span></div>
  </section></div>`;
}

/**
 * @param {object} report
 * @param {{pages?: number[][], measure?: boolean}} options  pages: row indices per page (default: all rows on one page).
 *   In measure mode every page carries the tail block so its height can be read.
 */
export function renderReportSheet(report, { pages = null, measure = false } = {}) {
  const all = report.features.map((_, i) => i);
  const layout = pages && pages.length ? pages : [all];
  return `<div class="report-sheet${measure ? ' rs-measure' : ''}" lang="en" dir="ltr">${layout.map((rows, i) => pageHtml(report, rows, i, layout.length, measure || i === layout.length - 1)).join('')}</div>`;
}
