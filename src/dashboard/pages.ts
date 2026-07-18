import { escapeHtml } from '../domain/demo/sanitize.js';
import { type LeadReviewDetail, type LeadReviewSummary } from '../domain/review/review-service.js';

/**
 * Server-rendered HTML for the local review dashboard. No JS framework, no client scripts.
 * EVERY dynamic value is HTML-escaped. Mutations are POST forms carrying a per-session CSRF
 * token. Demo and email decisions are always shown SEPARATELY and are never conflated.
 */

const STYLE = `
  *{box-sizing:border-box} body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#12303a;background:#f6fafa;line-height:1.5}
  .wrap{max-width:960px;margin:0 auto;padding:22px}
  a{color:#0b5f67} h1{font-size:22px;margin:0 0 14px} h2{font-size:17px;margin:22px 0 10px}
  table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e3ebed;border-radius:8px;overflow:hidden}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eef3f4;font-size:14px;vertical-align:top}
  th{background:#eef6f6;font-weight:700;width:180px}
  .card{background:#fff;border:1px solid #e3ebed;border-radius:10px;padding:16px;margin:10px 0}
  .row{display:flex;gap:16px;flex-wrap:wrap} .col{flex:1;min-width:300px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;background:#eef6f6;color:#0b5f67}
  .badge.ok{background:#e6f6ec;color:#0f8a45} .badge.no{background:#fdeaea;color:#c0392b} .badge.wait{background:#fef6e6;color:#b7791f}
  pre{white-space:pre-wrap;word-break:break-word;background:#f6fafa;border:1px solid #e3ebed;border-radius:8px;padding:12px;font-size:13.5px}
  iframe{width:100%;height:520px;border:1px solid #e3ebed;border-radius:8px;background:#fff}
  form.act{display:inline-block;margin:8px 8px 0 0} textarea{width:100%;min-height:52px;font:inherit;padding:8px;border:1px solid #cdd9db;border-radius:6px}
  button{font:inherit;font-weight:700;padding:9px 16px;border-radius:8px;border:0;cursor:pointer}
  button.approve{background:#12a150;color:#fff} button.reject{background:#c0392b;color:#fff}
  .muted{color:#3a5560;font-size:13px} .note{background:#fef6e6;border:1px solid #f0e0c0;border-radius:8px;padding:10px;font-size:13px;margin:8px 0}
`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function decisionBadge(value: string | null, kind: 'demo' | 'email'): string {
  if (!value) return '<span class="badge">pending</span>';
  if (value === 'APPROVED') return '<span class="badge ok">approved</span>';
  if (value === 'REJECTED') return '<span class="badge no">rejected</span>';
  if (value === 'GENERATED_PENDING_REVIEW') return '<span class="badge">pending</span>';
  void kind;
  return `<span class="badge">${escapeHtml(value.toLowerCase())}</span>`;
}

export function renderIndex(rows: LeadReviewSummary[]): string {
  const list = rows.length === 0
    ? '<p class="muted">No leads awaiting review.</p>'
    : `<table><tr><th>Business</th><th>Lead status</th><th>Demo</th><th>Email</th><th></th></tr>${rows.map((r) => `<tr>
        <td>${escapeHtml(r.businessName ?? '(unnamed)')}</td>
        <td><span class="badge${r.leadStatus === 'WAITING_FOR_DEMO_URL' ? ' wait' : ''}">${escapeHtml(r.leadStatus)}</span></td>
        <td>${decisionBadge(r.demoStatus, 'demo')}</td>
        <td>${r.hasEmail ? decisionBadge(r.emailHumanDecision, 'email') : '<span class="muted">no email</span>'}</td>
        <td><a href="/lead/${encodeURIComponent(r.leadId)}">review →</a></td>
      </tr>`).join('')}</table>`;
  return layout('Review queue', `<h1>Review queue</h1>${list}<p class="muted">Local review only — no sending, no deployment.</p>`);
}

function factsTable(facts: { factType: string; value: string }[]): string {
  if (facts.length === 0) return '<p class="muted">No verified facts.</p>';
  return `<table>${facts.map((f) => `<tr><th>${escapeHtml(f.factType)}</th><td>${escapeHtml(f.value)}</td></tr>`).join('')}</table>`;
}

function findingsList(findings: LeadReviewDetail['findings']): string {
  if (findings.length === 0) return '<p class="muted">No accepted findings.</p>';
  return findings.map((f) => `<div class="card"><strong>${escapeHtml(f.findingRef)}</strong> · ${escapeHtml(f.category)} · ${escapeHtml(f.severity)}
    <div class="muted">${escapeHtml(f.observation)}</div><div>${escapeHtml(f.recommendation)}</div></div>`).join('');
}

function actionForms(action: string, leadId: string, csrf: string, disabled: boolean): string {
  const t = escapeHtml(csrf);
  const id = encodeURIComponent(leadId);
  if (disabled) return '';
  return `<div>
    <form class="act" method="POST" action="/lead/${id}/${action}/approve"><input type="hidden" name="csrf" value="${t}"><textarea name="notes" placeholder="Review notes (optional)"></textarea><button class="approve" type="submit">Approve ${action}</button></form>
    <form class="act" method="POST" action="/lead/${id}/${action}/reject"><input type="hidden" name="csrf" value="${t}"><textarea name="notes" placeholder="Reason (optional)"></textarea><button class="reject" type="submit">Reject ${action}</button></form>
  </div>`;
}

export function renderLeadDetail(d: LeadReviewDetail, csrf: string): string {
  const demoBlock = d.demo
    ? `<div class="card"><h2>Demo &nbsp; ${decisionBadge(d.demo.status, 'demo')}</h2>
        ${d.demo.approvalNotes ? `<div class="muted">Notes: ${escapeHtml(d.demo.approvalNotes)}</div>` : ''}
        <iframe src="/demo/${encodeURIComponent(d.leadId)}" title="demo preview" sandbox="allow-same-origin"></iframe>
        ${actionForms('demo', d.leadId, csrf, false)}
      </div>`
    : '<div class="card"><h2>Demo</h2><p class="muted">No demo for this lead.</p></div>';

  const waiting = d.leadStatus === 'WAITING_FOR_DEMO_URL';
  const emailBlock = d.email
    ? `<div class="card"><h2>Email &nbsp; ${decisionBadge(d.email.humanDecision, 'email')}</h2>
        <div class="muted">Automated reviewer: ${escapeHtml(d.email.reviewerDecision ?? 'n/a')} · CTA: ${escapeHtml(d.email.ctaKind)}</div>
        ${d.email.humanNotes ? `<div class="muted">Notes: ${escapeHtml(d.email.humanNotes)}</div>` : ''}
        ${waiting ? '<div class="note">This email contains a demo link placeholder. Approving records the <strong>wording only</strong> — the lead stays <strong>WAITING_FOR_DEMO_URL</strong> and is not send-ready until Phase 11 inserts and validates the deployed URL.</div>' : ''}
        <p><strong>Subject:</strong> ${escapeHtml(d.email.subject)}</p>
        <pre>${escapeHtml(d.email.body)}</pre>
        ${actionForms('email', d.leadId, csrf, false)}
      </div>`
    : '<div class="card"><h2>Email</h2><p class="muted">No email draft for this lead.</p></div>';

  return layout(`Review — ${d.businessName ?? d.leadId}`, `
    <p><a href="/">← queue</a></p>
    <h1>${escapeHtml(d.businessName ?? '(unnamed)')} <span class="badge${waiting ? ' wait' : ''}">${escapeHtml(d.leadStatus)}</span></h1>
    <p class="muted">Demo and email decisions are independent.</p>
    <h2>Verified facts</h2>${factsTable(d.facts)}
    <h2>Accepted findings</h2>${findingsList(d.findings)}
    <div class="row"><div class="col">${demoBlock}</div><div class="col">${emailBlock}</div></div>
  `);
}
