/**
 * Zero-dependency single-file panel (no build step). Graded approval inbox:
 * decision/constraint/api-catalog require one-by-one approval; other types
 * show a batch button. Human clicking approve = panel channel.
 */
export const PANEL_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>memhub panel</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 14px 20px; border-bottom: 1px solid #262b36; display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 16px; margin: 0; }
  header span { color: #8b93a7; font-size: 12px; }
  main { max-width: 860px; margin: 0 auto; padding: 16px; }
  .card { border: 1px solid #262b36; border-radius: 10px; padding: 14px 16px; margin: 10px 0; background: #161a22; }
  .card h3 { margin: 0 0 6px; font-size: 14px; }
  .meta { color: #8b93a7; font-size: 12px; margin-bottom: 8px; }
  .grade { border-radius: 6px; padding: 1px 8px; font-size: 11px; }
  .grade.individual { background: #3a2a2a; color: #ff9e9e; }
  .grade.batch { background: #233a2c; color: #8ee39b; }
  button { border: 1px solid #2f3542; background: #1d2330; color: #e6e6e6; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #262d3d; }
  button.primary { background: #245639; border-color: #2f7a4d; }
  button.danger { background: #5a2a2a; border-color: #7a3a3a; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  #status { font-size: 12px; color: #8b93a7; }
  pre { white-space: pre-wrap; font-size: 12px; color: #a9b1c2; }
  .empty { color: #8b93a7; padding: 30px 0; text-align: center; }
  #batchbar { display: none; margin: 10px 0; }
</style>
</head>
<body>
<header><h1>memhub panel</h1><span id="status">loading…</span></header>
<main>
  <div id="batchbar"><button class="primary" onclick="approveBatch()">批准所选低风险条目（批量）</button></div>
  <div id="inbox"><div class="empty">加载中…</div></div>
  <details><summary>只读检索</summary>
    <div class="row"><input id="q" placeholder="查询词…" style="flex:1"><button onclick="doSearch()">搜索</button></div>
    <pre id="results"></pre>
  </details>
</main>
<script>
let inbox = [];
async function j(url, opts) { const r = await fetch(url, opts); return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }; }
async function refresh() {
  const s = await j('/api/status'); const i = await j('/api/inbox');
  document.getElementById('status').textContent =
    (s.data.workspace ? s.data.workspace.workspaceId + (s.data.workspace.exact ? '' : ' (synthetic)') : '?') +
    ' · accepted ' + (s.data.acceptedCount ?? 0) + ' · pending ' + (i.data.proposals ?? []).length;
  inbox = i.data.proposals ?? [];
  const el = document.getElementById('inbox');
  if (inbox.length === 0) { el.innerHTML = '<div class="empty">✓ inbox 清空，无待审条目</div>'; }
  else {
    el.innerHTML = inbox.map(p => \`
      <div class="card" id="card-\${p.id}">
        <h3>\${p.title} <span class="grade \${p.grade}">\${p.grade === 'individual' ? '逐条审批' : '可批量'}</span></h3>
        <div class="meta">\${p.id} · \${p.type} · \${(p.tags ?? []).join(', ')}</div>
        <div>\${p.summary}</div>
        <div class="row">
          <button class="primary" onclick="approveOne('\${p.id}')">批准</button>
          <button class="danger" onclick="rejectOne('\${p.id}')">拒绝</button>
        </div>
      </div>\`).join('');
  }
  const batchables = inbox.filter(p => p.grade === 'batch');
  document.getElementById('batchbar').style.display = batchables.length > 1 ? 'block' : 'none';
}
async function approveOne(id) { await j('/api/inbox/' + id + '/approve', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }); refresh(); }
async function rejectOne(id) { await j('/api/inbox/' + id + '/reject', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }); refresh(); }
async function approveBatch() {
  const ids = inbox.filter(p => p.grade === 'batch').map(p => p.id);
  await j('/api/inbox/approve', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ ids }) });
  refresh();
}
async function doSearch() {
  const r = await j('/api/search', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ query: document.getElementById('q').value }) });
  document.getElementById('results').textContent = JSON.stringify(r.data.hits ?? r.data, null, 2);
}
refresh();
</script>
</body>
</html>`
