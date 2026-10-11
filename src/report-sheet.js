/*
 * The printable Final Inspection Report (English, A4). Pure function of
 * (template, report) -> HTML string. Used for on-screen preview and printing.
 */
import {
  evaluateFeature, requirementText, limitsText, featureLimits, formatNumber, summarize,
  reportSampling, formatDateForReport, unitLabel, parseMeasurement,
} from './core.js';
import { DEFAULT_LOGO } from './logo-default.js';

export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const esc = escapeHtml;
const dash = '—';
const show = v => (String(v ?? '').trim() ? esc(v) : dash);

export const RESULT_LABELS = {
  ok: 'PASS', 'manual-pass': 'PASS', fail: 'FAIL', review: 'REVIEW', empty: 'NOT MEASURED',
};

function resultCell(state) {
  const cls = state === 'ok' || state === 'manual-pass' ? 'r-pass' : state === 'fail' ? 'r-fail' : state === 'review' ? 'r-review' : 'r-empty';
  return `<span class="${cls}">${RESULT_LABELS[state] || 'REVIEW'}</span>`;
}

function measuredCell(feature, value, lim) {
  const text = String(value ?? '').trim();
  if (!text) return dash;
  const num = parseMeasurement(text);
  if (Number.isFinite(num) && lim && lim.ok) return esc(formatNumber(num, Math.max(lim.decimals, 2)));
  return esc(text);
}

/** Company logo: the uploaded one, or the UCM logo shipped with the app (as in the original prototype). */
function logoImg(company) {
  const custom = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(company.logo || '');
  return `<img class="rs-logo" src="${custom ? esc(company.logo) : DEFAULT_LOGO}" alt="">`;
}

/** Suggested file name for the saved PDF. */
export function reportFileName(report) {
  const no = String(report.header.reportNo || '').trim();
  const parts = [no || 'Final-Inspection-Report', report.header.partNo].map(p => String(p || '').trim()).filter(Boolean);
  const name = parts.join('_').replace(/[^\w.\-֐-׿]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return name || 'Final-Inspection-Report';
}

export function renderReportSheet(template, report) {
  const company = template.company || {};
  const h = report.header;
  const counts = summarize(report.features, report.results);
  const { plan } = reportSampling(report);
  const status = counts.status;

  const rows = report.features.map((f, i) => {
    const r = report.results[f.id] || {};
    const ev = evaluateFeature(f, r);
    const lim = f.kind === 'numeric' ? featureLimits(f) : null;
    const unit = f.kind === 'numeric' ? unitLabel(f.unit) : '';
    const isNumeric = f.kind === 'numeric';
    const required = requirementText(f) || dash;
    const tolMinus = isNumeric && lim && lim.ok ? formatNumber(Math.abs(lim.lower), lim.decimals) + (lim.lower > 0 ? ' (+)' : '') : dash;
    const tolPlus = isNumeric && lim && lim.ok ? formatNumber(Math.abs(lim.upper), lim.decimals) + (lim.upper < 0 ? ' (\u2212)' : '') : dash;
    const limits = isNumeric ? (limitsText(f) || dash) : (f.kind === 'gauge' ? 'GO / NO-GO' : 'OK / NOT OK');
    let min, max;
    if (isNumeric) { min = measuredCell(f, r.min, lim); max = measuredCell(f, r.max, lim); }
    else {
      const o = r.outcome === 'pass' ? (f.kind === 'gauge' ? 'GO' : 'OK') : r.outcome === 'fail' ? (f.kind === 'gauge' ? 'NO-GO' : 'NOT OK') : dash;
      min = o; max = '';
    }
    const noteLine = String(r.note || '').trim() ? `<div class="rs-rownote">${esc(r.note)}</div>` : '';
    return `<tr>
      <td class="c">${i + 1}</td>
      <td class="req">${esc(required)}${unit ? ` <span class="unit">${esc(unit)}</span>` : ''}${noteLine}</td>
      <td>${show(f.method)}</td>
      ${isNumeric ? `<td class="c">${esc(tolMinus)}</td><td class="c">${esc(tolPlus)}</td>` : `<td class="c" colspan="2">${esc(limits)}</td>`}
      ${isNumeric ? `<td class="c num">${min}</td><td class="c num">${max}</td>` : `<td class="c num" colspan="2">${min}</td>`}
      <td class="c">${resultCell(ev.state)}</td>
    </tr>`;
  }).join('');

  const samplingCells = [];
  samplingCells.push(['AQL', show(h.aql)]);
  samplingCells.push(['INSPECTION LEVEL', show(h.inspectionLevel)]);
  samplingCells.push(['LOT SIZE', show(h.quantity)]);
  if (plan && plan.lotOfOne) {
    samplingCells.push(['CODE LETTER', dash], ['SAMPLE SIZE', '1'], ['Ac / Re', dash]);
  } else if (plan) {
    samplingCells.push(['CODE LETTER', esc(plan.tableLetter)]);
    samplingCells.push(['SAMPLE SIZE', esc(String(plan.sampleSize))]);
    samplingCells.push(['Ac / Re', plan.plan ? `${plan.plan.ac} / ${plan.plan.re}` : dash]);
  } else {
    samplingCells.push(['CODE LETTER', dash], ['SAMPLE SIZE', dash], ['Ac / Re', dash]);
  }
  samplingCells.push(['TOTAL INSPECTED', show(h.totalInspected)]);
  samplingCells.push(['ACCEPTED QTY', show(h.accepted)]);
  samplingCells.push(['REJECTED QTY', show(h.rejected)]);

  const planNotes = [];
  const standardName = company.standardName || 'MIL-STD-105D';
  if (plan && plan.lotOfOne) planNotes.push('Lot of one unit: the unit is inspected in full (Table I starts at lot size 2).');
  if (plan && plan.plan && plan.plan.arrow) {
    planNotes.push(`Table II-A arrow for code letter ${plan.tableLetter} at AQL ${plan.aql}: first plan ${plan.plan.arrow === 'down' ? 'below' : 'above'} the arrow is used (code ${plan.plan.letter}, n=${plan.plan.sampleSize}).`);
  }
  if (plan && plan.fullInspection && !plan.lotOfOne) planNotes.push('Sample size equals or exceeds the lot size: 100% inspection.');
  if (plan && !plan.plan && !plan.lotOfOne) planNotes.push(`AQL ${h.aql || dash} is outside the plans built into this tool; sample size is shown from Table I only and Ac/Re must be taken from the standard.`);
  planNotes.push(`Sampling: ${standardName} Tables I and II-A, single sampling, normal inspection. Ac/Re are the acceptance and rejection numbers of that plan.`);

  const statusBanner = status === 'pass' ? '<span class="rs-status rs-status-pass">PASS – all characteristics within limits</span>'
    : status === 'fail' ? '<span class="rs-status rs-status-fail">FAIL – nonconformance recorded</span>'
      : '<span class="rs-status rs-status-open">INCOMPLETE – not all characteristics verified</span>';

  const headerFacts = [
    ['CUSTOMER', h.customer], ['PURCHASE ORDER', h.purchaseOrder], ['PRODUCTION ORDER', h.productionOrder], ['LOT QUANTITY', h.quantity],
    ['CATALOG No.', h.catalogNo], ['PART No.', h.partNo], ['PART NAME', h.partName], ['REVISION', h.revision],
    ['GENERAL TOLERANCE', h.generalTolerance], ['INSPECTOR', h.inspector], ['DATE', formatDateForReport(h.inspectionDate)], ['TOTAL INSPECTED', h.totalInspected],
  ];

  const runningHeader = `<div class="rs-running"><span>${esc(company.name || '')}</span><span>FINAL INSPECTION REPORT ${esc(h.reportNo || '')}</span><span>${esc(h.partNo ? 'Part ' + h.partNo : '')}</span></div>`;

  return `<div class="report-sheet" lang="en" dir="ltr">
  <table class="rs-doc"><thead><tr><td>${runningHeader}</td></tr></thead><tbody><tr><td>
    <div class="rs-mast">
      <div class="rs-brand">${logoImg(company)}<div class="rs-company"><strong>${esc(company.name || '')}</strong><span>${esc(company.tagline || '')}</span></div></div>
      <div class="rs-title"><h1>FINAL INSPECTION REPORT</h1><div class="rs-no">${show(h.reportNo)}</div><div class="rs-date">${esc(formatDateForReport(h.inspectionDate) || dash)}</div></div>
    </div>
    <div class="rs-facts">${headerFacts.map(([k, v]) => `<div class="rs-fact"><small>${k}</small><b>${show(v)}</b></div>`).join('')}</div>
    <div class="rs-band">Sampling plan</div>
    <div class="rs-sampling">${samplingCells.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>
    <div class="rs-band">Dimensional and attribute inspection results</div>
    <table class="rs-table">
      <colgroup><col class="w-no"><col class="w-req"><col class="w-method"><col class="w-tol"><col class="w-tol"><col class="w-min"><col class="w-max"><col class="w-res"></colgroup>
      <thead><tr><th>No.</th><th>Required</th><th>Test equip. / method</th><th>TOL&minus;</th><th>TOL+</th><th>Actual min</th><th>Actual max</th><th>Result</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="rs-summary"><div>${statusBanner}</div><div class="rs-counts">Characteristics: ${counts.total} &middot; Pass ${counts.ok} &middot; Fail ${counts.fail} &middot; Review ${counts.review} &middot; Not measured ${counts.empty}</div></div>
    <div class="rs-band">Remarks</div>
    <div class="rs-remarks" dir="auto">${esc(report.remarks || '')}</div>
    <div class="rs-sign">
      <div><small>NAME</small><b>${show(h.inspector)}</b></div>
      <div><small>DATE</small><b>${esc(formatDateForReport(h.inspectionDate) || dash)}</b></div>
      <div><small>SIGNATURE</small><b>&nbsp;</b><span class="line"></span></div>
    </div>
    <div class="rs-notes">${planNotes.map(n => `<div>${esc(n)}</div>`).join('')}</div>
    <div class="rs-footer">${esc(company.name || '')}${company.footer ? ' | ' + esc(company.footer) : ''}</div>
  </td></tr></tbody></table>
</div>`;
}
