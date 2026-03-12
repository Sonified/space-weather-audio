// ── study-builder/utils.js ───────────────────────────────────────
// Small helper functions used across the study builder modules.
// ─────────────────────────────────────────────────────────────────

export function escapeAttr(s) { return (s||'').replace(/"/g, '&quot;'); }

export function escapeHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

const BODY_P_STYLE = 'line-height:1.6;margin:0;';
export function styleBodyHtml(html, pStyle) {
  const style = pStyle || BODY_P_STYLE;
  return (html || '')
    .replace(/<p>/g, `<p style="${style}">`)
    .replace(/<a /g, '<a target="_blank" rel="noopener" ');
}

// Convert ISO string or date-only string to datetime-local value (YYYY-MM-DDTHH:MM:SS)
export function toLocalDatetime(val) {
  if (!val) return '';
  // Already in datetime-local format
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) return val.replace('Z','').slice(0,19);
  // Date-only: append T00:00:00
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val + 'T00:00:00';
  return val;
}

// Convert datetime-local value to ISO string with Z suffix
export function toISOTime(val) {
  if (!val) return '';
  return val.includes('Z') ? val : val + 'Z';
}
