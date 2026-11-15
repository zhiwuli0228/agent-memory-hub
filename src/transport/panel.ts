/**
 * Zero-dependency single-file console (no build step). ADR-0010: the
 * standalone web console is the first-class human management surface for
 * every host. Tabs: approval inbox (graded), knowledge browser (search /
 * detail / deprecate / hard-delete), audit (ledger + journal). Human
 * clicking approve = panel channel.
 */
export const PANEL_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>memhub console</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-sans-serif, system-ui; margin: 0; background: #0f1115; color: #e6e6e6; }
  header { padding: 14px 20px; border-bottom: 1px solid #262b36; display: flex; gap: 16px; align-items: baseline; }
  header h1 { font-size: 16px; margin: 0; }
  header span { color: #8b93a7; font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 0 20px; border-bottom: 1px solid #262b36; }
  nav button { border: none; background: none; color: #8b93a7; padding: 10px 16px; font-size: 14px; cursor: pointer; border-bottom: 2px solid transparent; }
  nav button.active { color: #e6e6e6; border-bottom-color: #4d7cff; }
  main { max-width: 900px; margin: 0 auto; padding: 16px; }
  .card { border: 1px solid #262b36; border-radius: 10px; padding: 14px 16px; margin: 10px 0; background: #161a22; }
  .card h3 { margin: 0 0 6px; font-size: 14px; }
  .meta { color: #8b93a7; font-size: 12px; margin-bottom: 8px; }
  .grade { border-radius: 6px; padding: 1px 8px; font-size: 11px; }
  .grade.individual { background: #3a2a2a; color: #ff9e9e; }
  .grade.batch { background: #233a2c; color: #8ee39b; }
  .status-tag { border-radius: 6px; padding: 1px 8px; font-size: 11px; background: #262b36; color: #a9b1c2; }
  .status-tag.deprecated { background: #3a2f1e; color: #e3b98e; }
  button { border: 1px solid #2f3542; background: #1d2330; color: #e6e6e6; border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  button:hover { background: #262d3d; }
  button.primary { background: #245639; border-color: #2f7a4d; }
  button.danger { background: #5a2a2a; border-color: #7a3a3a; }
  .row { display: flex; gap: 8px; margin-top: 8px; }
  #statusbar { font-size: 12px; color: #8b93a7; }
  pre { white-space: pre-wrap; font-size: 12px; color: #a9b1c2; }
  .empty { color: #8b93a7; padding: 30px 0; text-align: center; }
  #batchbar { display: none; margin: 10px 0; }
  .tabpane { display: none; }
  .tabpane.active { display: block; }
  .entryline { border-bottom: 1px solid #20242e; padding: 9px 4px; cursor: pointer; display: flex; gap: 10px; align-items: baseline; }
  .entryline:hover { background: #1a1f29; }
  .entryline .id { color: #6f9bff; font-size: 12px; min-width: 90px; }
  .entryline .title { flex: 1; font-size: 13px; }
  .entryline .type { color: #8b93a7; font-size: 11px; }
  .detail pre { background: #12151c; border-radius: 8px; padding: 12px; max-height: 320px; overflow: auto; }
</style>
</head>
<body>
<header><h1>memhub console</h1><span id="statusbar">loading…</span></header>
<nav>
  <button id="tab-inbox" class="active" onclick="showTab('inbox')">收件箱</button>
  <button id="tab-entries" onclick="showTab('entries')">记忆库</button>
  <button id="tab-audit" onclick="showTab('audit')">审计</button>
</nav>
<main>
  <div id="pane-inbox" class="tabpane active">
    <div id="batchbar"><button class="primary" onclick="approveBatch()">批准所选低风险条目（批量）</button></div>
    <div id="inbox"><div class="empty">加载中…</div></div>
  </div>
  <div id="pane-entries" class="tabpane">
    <div class="row"><input id="q" placeholder="BM25 检索…" style="flex:1" onkeydown="if(event.key==='Enter')doSearch()"><button onclick="doSearch()">搜索</button><button onclick="loadEntries()">全部</button></div>
    <div id="entrylist"><div class="empty">点击「全部」浏览或输入检索词</div></div>
    <div id="entrydetail" class="detail"></div>
  </div>
  <div id="pane-audit" class="tabpane">
    <div class="row"><button onclick="loadLedger()">刷新账本</button><button onclick="loadJournal()">刷新情景日志</button></div>
    <div id="auditview"><div class="empty">点击刷新加载</div></div>
  </div>
</main>
<script>
let inbox = [];
async function j(url, opts) { const r = await fetch(url, opts); return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) }; }
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showTab(name) {
  document.querySelectorAll('.tabpane').forEach(p => p.classList.remove('active'));
  document.getElementById('pane-' + name).classList.add('active');
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'inbox') refreshInbox();
  if (name === 'entries' && document.getElementById('entrylist').dataset.loaded !== '1') loadEntries();
}
async function refreshStatus() {
  const s = await j('/api/status');
  document.getElementById('statusbar').textContent =
    (s.data.workspace ? s.data.workspace.workspaceId + (s.data.workspace.exact ? '' : ' (synthetic)') : '?') +
    ' · accepted ' + (s.data.acceptedCount ?? 0) + ' · hub ' + (s.data.hubRoot ?? '?');
}
async function refreshInbox() {
  refreshStatus();
  const i = await j('/api/inbox');
  inbox = i.data.proposals ?? [];
  const el = document.getElementById('inbox');
  if (inbox.length === 0) { el.innerHTML = '<div class="empty">✓ inbox 清空，无待审条目</div>'; }
  else {
    el.innerHTML = inbox.map(p => \`
      <div class="card" id="card-\${p.id}">
        <h3>\${esc(p.title)} <span class="grade \${p.grade}">\${p.grade === 'individual' ? '逐条审批' : '可批量'}</span></h3>
        <div class="meta">\${esc(p.id)} · \${esc(p.type)} · \${esc((p.tags ?? []).join(', '))}</div>
        <div>\${esc(p.summary)}</div>
        <div class="row">
          <button class="primary" onclick="approveOne('\${p.id}')">批准</button>
          <button class="danger" onclick="rejectOne('\${p.id}')">拒绝</button>
        </div>
      </div>\`).join('');
  }
  const batchables = inbox.filter(p => p.grade === 'batch');
  document.getElementById('batchbar').style.display = batchables.length > 1 ? 'block' : 'none';
}
async function approveOne(id) { await j('/api/inbox/' + id + '/approve', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }); refreshInbox(); }
async function rejectOne(id) { await j('/api/inbox/' + id + '/reject', { method: 'POST', headers: {'content-type':'application/json'}, body: '{}' }); refreshInbox(); }
async function approveBatch() {
  const ids = inbox.filter(p => p.grade === 'batch').map(p => p.id);
  await j('/api/inbox/approve', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ ids }) });
  refreshInbox();
}
async function loadEntries() {
  const r = await j('/api/entries');
  renderEntries(r.data.entries ?? []);
  document.getElementById('entrylist').dataset.loaded = '1';
}
async function doSearch() {
  const q = document.getElementById('q').value;
  if (q === '') return loadEntries();
  const r = await j('/api/search', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ query: q, limit: 25 }) });
  renderEntries((r.data.hits ?? []).map(h => ({ id: h.id, type: h.type, status: 'accepted', title: h.title, summary: h.abstract, score: h.score })));
}
function renderEntries(entries) {
  const el = document.getElementById('entrylist');
  if (entries.length === 0) { el.innerHTML = '<div class="empty">无条目</div>'; return; }
  el.innerHTML = entries.map(e => \`
    <div class="entryline" onclick="openEntry('\${esc(e.id)}')">
      <span class="id">\${esc(e.id)}@v\${e.version ?? '?'}</span>
      <span class="title">\${esc(e.title)} <span class="status-tag \${e.status === 'deprecated' ? 'deprecated' : ''}">\${esc(e.status ?? '')}</span>\${e.score !== undefined ? ' · ' + Number(e.score).toFixed(2) : ''}</span>
      <span class="type">\${esc(e.type)}</span>
    </div>\`).join('');
}
async function openEntry(id) {
  const r = await j('/api/entries/' + id);
  if (!r.ok) { document.getElementById('entrydetail').innerHTML = '<div class="card">加载失败: ' + esc(r.data.error ?? r.status) + '</div>'; return; }
  const fm = r.data.frontmatter ?? {};
  document.getElementById('entrydetail').innerHTML = \`
    <div class="card">
      <h3>\${esc(fm.title)} <span class="status-tag">\${esc(fm.status)}</span></h3>
      <div class="meta">\${esc(fm.id)}@v\${fm.version} · \${esc(fm.type)} · \${esc(JSON.stringify(fm.scope))} · \${esc((fm.tags ?? []).join(', '))}</div>
      <div class="meta">path: \${esc(r.data.path)}</div>
      <pre id="entry-body">\${esc(r.data.body)}</pre>
      <div class="row">
        <button class="primary" onclick="editEntry('\${esc(id)}')">编辑（重新萃取）</button>
        <button class="danger" onclick="deprecateEntry('\${esc(id)}')">废弃（软删除）</button>
        <button class="danger" onclick="hardDeleteEntry('\${esc(id)}')">永久删除（不可恢复）</button>
      </div>
    </div>\`;
}
async function editEntry(id) {
  const r = await j('/api/entries/' + id);
  if (!r.ok) { alert('加载失败: ' + (r.data.error ?? r.status)); return; }
  const fm = r.data.frontmatter ?? {};
  document.getElementById('entrydetail').innerHTML = \`
    <div class="card">
      <h3>编辑 \${esc(fm.id)}（保存 = v\${(fm.version ?? 1) + 1}，旧版本进 history/）</h3>
      <div class="meta">标题与类型不可改；摘要与正文通用化改写后保存即重新萃取。</div>
      <div style="margin:8px 0"><label>摘要</label><br><textarea id="edit-summary" rows="3" style="width:98%">\${esc(fm.summary)}</textarea></div>
      <div style="margin:8px 0"><label>正文</label><br><textarea id="edit-body" rows="14" style="width:98%;font-family:monospace">\${esc(r.data.body)}</textarea></div>
      <div class="row">
        <button class="primary" onclick="saveEntry('\${esc(id)}')">保存为新版本</button>
        <button onclick="openEntry('\${esc(id)}')">取消</button>
      </div>
    </div>\`;
}
async function saveEntry(id) {
  const payload = { summary: document.getElementById('edit-summary').value, body: document.getElementById('edit-body').value };
  const r = await j('/api/entries/' + id + '/update', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
  if (r.ok) { document.getElementById('entrydetail').innerHTML = '<div class="card">✓ 已保存 ' + esc(r.data.updated) + '@v' + esc(r.data.version) + '（旧版本进 history/，账本已记录）</div>'; loadEntries(); }
  else alert('失败: ' + (r.data.error ?? r.status));
}
async function deprecateEntry(id) {
  if (!confirm('确认废弃 ' + id + '？（status=deprecated，可追溯）')) return;
  const reason = prompt('废弃原因：', 'via console') ?? '';
  const r = await j('/api/entries/' + id + '/deprecate', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ reason }) });
  if (r.ok) { document.getElementById('entrydetail').innerHTML = '<div class="card">✓ 已废弃 ' + esc(id) + '</div>'; loadEntries(); }
  else alert('失败: ' + (r.data.error ?? r.status));
}
async function hardDeleteEntry(id) {
  if (!confirm('永久删除 ' + id + '？文件将被物理删除，不可恢复（账本留痕）。')) return;
  if (!confirm('再次确认：真的要永久删除 ' + id + ' 吗？')) return;
  const reason = prompt('删除原因：', 'via console') ?? '';
  const r = await j('/api/entries/' + id + '/delete', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ reason }) });
  if (r.ok) { document.getElementById('entrydetail').innerHTML = '<div class="card">✓ 已永久删除 ' + esc(id) + '（账本留痕）</div>'; loadEntries(); }
  else alert('失败: ' + (r.data.error ?? r.status));
}
async function loadLedger() {
  const r = await j('/api/ledger');
  const records = r.data.records ?? [];
  document.getElementById('auditview').innerHTML = '<div class="card"><h3>账本事件（最近 ' + records.length + ' / 共 ' + (r.data.total ?? 0) + '）</h3><pre>' + esc(JSON.stringify(records, null, 2)) + '</pre></div>';
}
async function loadJournal() {
  const r = await j('/api/journal');
  const entries = r.data.entries ?? [];
  document.getElementById('auditview').innerHTML = '<div class="card"><h3>情景日志（最近 ' + entries.length + '）</h3><pre>' + esc(JSON.stringify(entries, null, 2)) + '</pre></div>';
}
refreshInbox();
</script>
</body>
</html>`
