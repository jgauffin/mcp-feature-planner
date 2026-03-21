// ── HTTP helpers ────────────────────────────────────────────────

async function api(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, data: json };
}

export function apiGet(url) { return api(url); }

export function apiPost(url, body) {
  return api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function apiDelete(url) { return api(url, { method: 'DELETE' }); }

export function apiPatch(url, body) {
  return api(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
