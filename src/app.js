import { renderDocument, escapeHTML as esc } from './render.js';
import { describeSelection, anchorComment } from './anchoring.js';

const $ = id => document.getElementById(id);
const state = { user: null, documents: [], doc: null, version: null, comments: [], filter: 'open', selected: null, ranges: new Map(), addresses: [], stream: null, pending: null, importMode: 'new', files: [], sourceFile: null, loading: 0, replies: new Set() };
let toastTimer, onIdentity, exportEditing = null;
const date = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false });
const shortDate = value => new Date(value).toLocaleDateString('zh-CN', { month:'long',day:'numeric' });
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3200); }
const run = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message || '操作未完成，请重试', true); } };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type':'application/json', 'X-Review-Request':'1', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error || '请求失败'); return body;
}
function setUser(user) { state.user = user; $('user-name').textContent = user?.name || '填写姓名'; $('user-avatar').textContent = user?.name?.slice(0, 1) || '访'; }
function showIdentity(next) { onIdentity = next; $('identity-name').value = state.user?.name || ''; $('identity-dialog').showModal(); setTimeout(() => $('identity-name').focus(), 20); }
function withUser(fn) { if (state.user) return run(fn)(); showIdentity(fn); }
function requireDocument() { if (!state.doc) throw new Error('请先导入或打开一份文档'); }
function connection(connected) { $('connection-dot').className = `connection-dot ${connected ? 'connected' : 'disconnected'}`; $('connection-text').textContent = connected ? '局域网协作 · 已连接' : '连接中断 · 正在重连'; }
const docIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8l-5-5Z"/><path d="M14 3v5h5M8 12h8M8 16h6"/></svg>';
const ownerLabel = d => d.owner_account ? `@${d.owner_account}` : (d.owner_name || '未署名');
const ownerKey = d => d.owner_account || d.owner_name || '';
async function loadLibrary() { state.documents = await api('/api/documents'); renderLibrary(); }
function renderOwnerOptions() {
  const select = $('owner-filter'), current = select.value, owners = new Map();
  for (const doc of state.documents) if (ownerKey(doc)) owners.set(ownerKey(doc), ownerLabel(doc));
  const entries = [...owners].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  select.innerHTML = '<option value="">全部账号</option>' + entries.map(([key, label]) => `<option value="${esc(key)}">${esc(label)}</option>`).join('');
  select.value = owners.has(current) ? current : '';
}
function visibleDocuments() {
  const query = $('document-search').value.trim().toLocaleLowerCase();
  const owner = $('owner-filter').value, days = Number($('time-filter').value) || 0;
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  return state.documents.filter(d => {
    if (query && !`${d.title} ${d.filename} ${ownerLabel(d)}`.toLocaleLowerCase().includes(query)) return false;
    if (owner && ownerKey(d) !== owner) return false;
    if (cutoff && new Date(d.updated).getTime() < cutoff) return false;
    return true;
  });
}
function renderLibrary() {
  renderOwnerOptions();
  const visible = visibleDocuments();
  $('document-count').textContent = visible.length === state.documents.length ? state.documents.length : `${visible.length}/${state.documents.length}`;
  $('document-list').innerHTML = visible.map(d => `<a class="document-link${d.id === state.doc?.id ? ' active' : ''}" href="/d/${d.short_id || d.id}" data-doc="${d.short_id || d.id}">${docIcon}<span class="doc-name">${esc(d.title)}</span>${d.open_count ? `<span class="count-badge">${d.open_count}</span>` : ''}<span class="doc-meta">${esc(ownerLabel(d))} · ${date(d.updated)}</span></a>`).join('') || '<p class="helper">没有匹配的文档</p>';
}
async function openDocument(id, version, { replace = false } = {}) {
  const token = ++state.loading;
  const doc = await api(`/api/documents/${id}${version ? `?v=${version}` : ''}`);
  if (token !== state.loading) return;
  state.stream?.close(); state.doc = doc; state.version = doc.revision.version; state.comments = []; state.ranges.clear(); state.selected = null; state.replies.clear();
  clearSelection();
  for (const name of ['review-open','review-resolved','review-active']) CSS.highlights?.delete(name);
  const path = `/d/${doc.short_id || doc.id}?v=${state.version}`;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  document.title = `${doc.title} · 共阅`;
  $('toolbar-title').textContent = doc.title; $('document-title').textContent = doc.title;
  $('document-filename').textContent = doc.filename; $('document-date').textContent = `${shortDate(doc.revision.created)} · ${doc.revision.author}`;
  $('download-source').href = `/api/documents/${id}/source?v=${state.version}`;
  $('version-select').innerHTML = doc.versions.map(v => `<option value="${v.version}"${v.version === state.version ? ' selected' : ''}>v${v.version}${v.version === doc.latest ? ' · 最新版本' : ''}${v.open_count ? ` · ${v.open_count} 条待处理` : ''}</option>`).join('');
  $('version-notice').hidden = state.version === doc.latest;
  $('version-notice').textContent = `你正在查看 v${state.version}。最新为 v${doc.latest}，可通过版本菜单切换；本页批注属于 v${state.version}。`;
  $('reading-pane').scrollTop = 0; renderLibrary(); renderComments();
  const headings = await renderDocument($('document-content'), doc.revision.markdown, { docId: id, version: state.version, sourcePath: doc.revision.source_path });
  if (token !== state.loading) return;
  $('outline').innerHTML = headings.filter(h => h.tagName !== 'H1').map(h => `<a href="#${h.id}" class="level-${h.tagName.slice(1)}">${esc(h.textContent)}</a>`).join('');
  await loadComments();
  if (token !== state.loading) return;
  const stream = new EventSource(`/api/documents/${id}/events`); state.stream = stream;
  stream.addEventListener('ready', () => { connection(true); run(loadComments)(); });
  stream.addEventListener('update', run(async e => {
    const event = JSON.parse(e.data);
    await loadLibrary();
    if (event.docId === state.doc?.id) {
      if (event.type === 'documents') {
        const fresh = await api(`/api/documents/${id}?v=${state.version}`);
        state.doc.latest = fresh.latest; state.doc.versions = fresh.versions;
        $('version-select').innerHTML = fresh.versions.map(v => `<option value="${v.version}"${v.version === state.version ? ' selected' : ''}>v${v.version}${v.version === fresh.latest ? ' · 最新版本' : ''}</option>`).join('');
        $('version-notice').hidden = state.version === fresh.latest;
        $('version-notice').textContent = `已有新版本 v${fresh.latest}。本轮评审仍固定在 v${state.version}，可通过版本菜单切换。`;
      }
      await loadComments();
    }
  }));
  stream.onerror = () => connection(false);
  const commentId = sessionStorage.getItem('review-focus-comment');
  if (commentId) { sessionStorage.removeItem('review-focus-comment'); focusComment(commentId); }
}
async function loadComments() {
  if (!state.doc) return;
  const id = state.doc.id, v = state.version;
  const comments = await api(`/api/documents/${id}/comments?v=${v}`);
  if (state.doc?.id !== id || state.version !== v) return;
  state.comments = comments; updateHighlights(); renderComments();
}
function updateHighlights() {
  state.ranges.clear(); const open = [], resolved = [];
  for (const c of state.comments) { const range = anchorComment($('document-content'), c); if (range) { state.ranges.set(c.id, range); (c.status === 'resolved' ? resolved : open).push(range); } }
  if (CSS.highlights) { CSS.highlights.set('review-open', new Highlight(...open)); CSS.highlights.set('review-resolved', new Highlight(...resolved)); CSS.highlights.set('review-active', new Highlight(...(state.ranges.has(state.selected) ? [state.ranges.get(state.selected)] : []))); }
}
const avatar = name => `<span class="avatar">${esc(name?.slice(0, 1) || '?')}</span>`;
function renderComments() {
  const drafts = new Map([...$('comments').querySelectorAll('.reply-form')].map(f => [f.dataset.id, f.querySelector('textarea').value]));
  const active = document.activeElement?.closest('.reply-form');
  const focus = active ? { id: active.dataset.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const scroll = $('comments').scrollTop;
  const open = state.comments.filter(c => c.status === 'open').length;
  $('open-count').textContent = open; $('resolved-count').textContent = state.comments.length - open; $('comment-total').textContent = state.comments.length;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
  const comments = state.comments.filter(c => state.filter === 'all' || c.status === state.filter);
  $('comments').innerHTML = comments.length ? comments.map(c => `<section class="comment-card ${c.status === 'resolved' ? 'resolved' : ''} ${c.id === state.selected ? 'active' : ''}" data-id="${c.id}" id="comment-${c.id}">
    <div class="comment-author">${avatar(c.author)}<strong>${esc(c.author)}</strong><time title="${esc(c.created)}">${date(c.created)}</time></div>
    ${c.quote ? `<button class="quote-button" data-action="locate">${esc(c.quote)}</button>${!state.ranges.has(c.id) ? '<div class="orphan-label">原文暂无法定位，已保留引用</div>' : ''}` : '<span class="page-note-label">整体建议</span>'}
    <div class="comment-body">${esc(c.body)}</div>
    <div class="comment-actions"><button data-action="reply">回复${c.replies.length ? ` (${c.replies.length})` : ''}</button>${c.author_id === state.user?.id ? '<button data-action="edit">编辑</button>' : ''}<button data-action="resolve" class="resolve-button">${c.status === 'resolved' ? '✓ 已解决 · 重新打开' : '✓ 标为已解决'}</button></div>
    ${c.replies.length ? `<div class="reply-list">${c.replies.map(r => `<div class="reply"><div class="comment-author">${avatar(r.author)}<strong>${esc(r.author)}</strong><time>${date(r.created)}</time></div><div class="comment-body">${esc(r.body)}</div></div>`).join('')}</div>` : ''}
    ${state.replies.has(c.id) ? `<form class="reply-form" data-id="${c.id}"><textarea aria-label="回复 ${esc(c.author)}" placeholder="回复 ${esc(c.author)}……" maxlength="20000" rows="2" required>${esc(drafts.get(c.id) || '')}</textarea><button class="button primary" type="submit">发送回复</button></form>` : ''}
  </section>`).join('') : `<div class="empty-comments"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M9 8h30v24H23L9 41V8Z"/><path d="M17 17h14M17 24h9"/></svg><strong>${state.filter === 'resolved' ? '还没有已解决的批注' : state.comments.length ? '当前没有待处理的意见' : '让讨论从一句话开始'}</strong><span>${state.filter === 'resolved' ? '处理完意见后，可将批注标记为已解决。' : '选中正文中的文字，添加你的第一条批注。<br>也可以提出一条整体建议。'}</span></div>`;
  if (focus) { const field = $('comments').querySelector(`.reply-form[data-id="${focus.id}"] textarea`); field?.focus({ preventScroll:true }); field?.setSelectionRange(focus.start, focus.end); }
  $('comments').scrollTop = scroll;
}
function focusComment(id, scrollText = true) {
  const c = state.comments.find(c => c.id === id); if (!c) return;
  state.selected = id;
  if (state.filter !== 'all' && state.filter !== c.status) state.filter = c.status;
  renderComments(); updateHighlights();
  $(`comment-${id}`)?.scrollIntoView({ behavior:'smooth', block:'nearest' });
  if (scrollText && state.ranges.has(id)) {
    const node = state.ranges.get(id).startContainer;
    (node.nodeType === 1 ? node : node.parentElement).scrollIntoView({ behavior:'smooth', block:'center' });
  }
}
function clearSelection() { $('selection-button').hidden = true; window.getSelection()?.removeAllRanges(); CSS.highlights?.delete('review-selection'); }
function inspectSelection() {
  if (document.querySelector('dialog[open]') || !state.doc) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) { $('selection-button').hidden = true; return; }
  const range = selection.getRangeAt(0);
  if (!$('document-content').contains(range.startContainer) || !$('document-content').contains(range.endContainer)) { $('selection-button').hidden = true; return; }
  try {
    const description = describeSelection($('document-content'), range);
    state.pending = { ...description, docId:state.doc.id, version:state.version };
    const rects = range.getClientRects(), rect = rects[rects.length - 1] || range.getBoundingClientRect();
    $('selection-button').style.left = `${Math.max(10, Math.min(window.innerWidth - 140, rect.right - 100))}px`;
    $('selection-button').style.top = `${Math.min(window.innerHeight - 48, rect.bottom + 8)}px`;
    $('selection-button').hidden = false;
  } catch { $('selection-button').hidden = true; }
}
function openComment(pending, editing = null) {
  state.pending = pending; exportEditing = editing;
  $('comment-heading').textContent = editing ? '编辑批注' : pending.quote ? '添加批注' : '提出整体建议';
  $('comment-quote').textContent = pending.quote || ''; $('comment-quote').hidden = !pending.quote;
  $('comment-body').value = editing?.body || '';
  $('comment-form').querySelector('[type=submit]').textContent = editing ? '保存修改' : '发布批注';
  if (pending.range && CSS.highlights) CSS.highlights.set('review-selection', new Highlight(pending.range));
  $('selection-button').hidden = true; window.getSelection()?.removeAllRanges();
  $('comment-dialog').showModal(); setTimeout(() => $('comment-body').focus(), 30);
}
function busyForm(form, fn) {
  if (form.dataset.busy) return;
  form.dataset.busy = '1'; const button = form.querySelector('[type=submit]'); if (button) button.disabled = true;
  return Promise.resolve().then(fn).finally(() => { delete form.dataset.busy; if (button) button.disabled = false; });
}

function openImport(mode) {
  if (mode === 'revision') requireDocument();
  state.importMode = mode; state.importTarget = mode === 'revision' ? { id:state.doc.id, baseVersion:state.doc.latest } : null;
  state.files = []; state.sourceFile = null; $('import-form').reset(); $('file-input').value = ''; $('folder-input').value = '';
  $('file-picker-row').hidden = true; $('source-file').innerHTML = '';
  $('import-heading').textContent = mode === 'revision' ? '上传文档新版本' : '导入 Markdown 文档';
  $('import-description').textContent = mode === 'revision' ? '新版本将单独保存。旧版本的正文和批注会完整保留。' : '选择文件，或直接粘贴 Markdown 内容。';
  $('import-submit').textContent = mode === 'revision' ? '保存为新版本' : '导入并开始评审';
  $('import-title').value = mode === 'revision' ? state.doc.title : '';
  $('import-title').disabled = mode === 'revision';
  $('import-file-info').textContent = '支持 .md / .markdown，最大 2 MB；图片总计最大 8 MB。';
  $('import-dialog').showModal();
}
async function selectSource(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error('Markdown 文件不能超过 2 MB');
  state.sourceFile = file; const content = await file.text(); $('import-markdown').value = content;
  if (state.importMode === 'new') $('import-title').value = content.match(/^#\s+(.+)$/m)?.[1] || file.name.replace(/\.(md|markdown)$/i,'');
  const count = state.files.filter(f => /^image\/(png|jpeg|webp|gif)$/.test(f.type)).length;
  $('import-file-info').textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB${count ? ` · 同时导入 ${count} 张图片` : ''}`;
}
async function receiveFiles(files) {
  state.files = [...files]; const markdownFiles = state.files.filter(f => /\.(md|markdown)$/i.test(f.name));
  if (!markdownFiles.length) throw new Error('请选择至少一个 .md 或 .markdown 文件');
  $('source-file').innerHTML = markdownFiles.map((f,i) => `<option value="${i}">${esc(f.webkitRelativePath || f.name)}</option>`).join('');
  $('file-picker-row').hidden = markdownFiles.length === 1;
  $('source-file').onchange = run(() => selectSource(markdownFiles[Number($('source-file').value)]));
  await selectSource(markdownFiles[0]);
}
function readAsBase64(file) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); }); }
async function importBody() {
  const images = state.files.filter(f => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
  if (images.reduce((sum,f) => sum + f.size,0) > 8 * 1024 * 1024) throw new Error('图片总大小不能超过 8 MB');
  const assets = await Promise.all(images.map(async f => ({ path:f.webkitRelativePath || f.name, mime:f.type, data:await readAsBase64(f) })));
  return { title:$('import-title').value.trim(), markdown:$('import-markdown').value, filename:state.sourceFile?.name || `${$('import-title').value.trim() || 'document'}.md`, sourcePath:state.sourceFile?.webkitRelativePath || state.sourceFile?.name || 'document.md', assets };
}
function updateExportLinks() {
  requireDocument();
  const base = `/api/documents/${state.doc.id}/export?v=${state.version}&status=${$('export-scope').value}`;
  $('export-markdown').href = `${base}&format=md`; $('export-json').href = `${base}&format=json`;
}

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));
$('comment-dialog').addEventListener('close', () => { CSS.highlights?.delete('review-selection'); exportEditing = null; });
$('identity-button').addEventListener('click', () => showIdentity());
$('identity-form').addEventListener('submit', run(async e => {
  e.preventDefault(); await busyForm(e.currentTarget, async () => {
    setUser(await api('/api/session', { method:'POST', body:{ name:$('identity-name').value } }));
    $('identity-dialog').close(); renderComments(); const next = onIdentity; onIdentity = null; if (next) await next();
  });
}));
$('import-document').addEventListener('click', () => withUser(() => openImport('new')));
$('upload-version').addEventListener('click', () => withUser(() => openImport('revision')));
$('file-input').addEventListener('change', run(e => receiveFiles(e.target.files)));
$('folder-input').addEventListener('change', run(e => receiveFiles(e.target.files)));
for (const event of ['dragenter','dragover']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const event of ['dragleave','drop']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop', run(e => receiveFiles(e.dataTransfer.files)));
$('import-form').addEventListener('submit', run(async e => {
  e.preventDefault(); await busyForm(e.currentTarget, async () => {
    const body = await importBody(), target = state.importTarget;
    const result = await api(target ? `/api/documents/${target.id}/revisions` : '/api/documents', { method:'POST', body: target ? { ...body, baseVersion:target.baseVersion } : body });
    $('import-dialog').close(); await loadLibrary(); await openDocument(result.id, result.version); toast(target ? '新版本已保存，旧版批注完整保留' : '文档已导入，可以开始评审了');
  });
}));
$('document-search').addEventListener('input', renderLibrary);
$('owner-filter').addEventListener('change', renderLibrary);
$('time-filter').addEventListener('change', renderLibrary);
$('document-list').addEventListener('click', run(async e => { const link = e.target.closest('[data-doc]'); if (link && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('library').classList.remove('open'); await openDocument(link.dataset.doc); } }));
$('outline').addEventListener('click', e => { const link = e.target.closest('a'); if (link) { e.preventDefault(); $(link.hash.slice(1))?.scrollIntoView({ behavior:'smooth', block:'start' }); $('library').classList.remove('open'); } });
$('version-select').addEventListener('change', run(() => openDocument(state.doc.id, Number($('version-select').value))));
document.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => { state.filter = b.dataset.filter; renderComments(); }));
$('toggle-library').addEventListener('click', () => $('library').classList.toggle('open'));
$('about-button').addEventListener('click', () => $('about-dialog').showModal());
$('page-comment').addEventListener('click', () => withUser(() => { requireDocument(); openComment({ quote:'', selectors:[], docId:state.doc.id, version:state.version }); }));
$('document-content').addEventListener('mouseup', () => setTimeout(inspectSelection, 0));
$('document-content').addEventListener('keyup', inspectSelection);
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) $('selection-button').hidden = true; });
$('reading-pane').addEventListener('scroll', () => { $('selection-button').hidden = true; });
$('selection-button').addEventListener('mousedown', e => e.preventDefault());
$('selection-button').addEventListener('click', () => { const pending = state.pending; if (pending) withUser(() => openComment(pending)); });
$('document-content').addEventListener('click', e => {
  if (!window.getSelection()?.isCollapsed) return;
  for (const [id, range] of state.ranges) if ([...range.getClientRects()].some(r => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) { focusComment(id, false); return; }
});
$('comment-form').addEventListener('submit', run(async e => {
  e.preventDefault(); await busyForm(e.currentTarget, async () => {
    const pending = state.pending, editing = exportEditing;
    const result = editing ? await api(`/api/comments/${editing.id}`, { method:'PATCH', body:{ body:$('comment-body').value } }) : await api(`/api/documents/${pending.docId}/comments`, { method:'POST', body:{ body:$('comment-body').value, quote:pending.quote, selectors:pending.selectors, version:pending.version, sourceLine:pending.sourceLine } });
    $('comment-dialog').close(); state.filter = editing?.status || 'open'; await loadComments(); await loadLibrary(); focusComment(editing?.id || result.id, false); toast(editing ? '批注已更新' : '批注已发布，同事可以实时看到');
  });
}));
$('comments').addEventListener('click', run(async e => {
  const button = e.target.closest('[data-action]'), card = e.target.closest('.comment-card'); if (!card) return;
  const c = state.comments.find(c => c.id === card.dataset.id); if (!c) return;
  if (!button) { if (!e.target.closest('form')) { state.selected = c.id; updateHighlights(); document.querySelectorAll('.comment-card').forEach(el => el.classList.toggle('active', el.dataset.id === c.id)); } return; }
  if (button.dataset.action === 'locate') return focusComment(c.id);
  withUser(async () => {
    if (button.dataset.action === 'reply') { state.replies.add(c.id); renderComments(); $(`comment-${c.id}`).querySelector('textarea').focus(); }
    if (button.dataset.action === 'edit') openComment({ ...c, docId:c.doc_id, range:state.ranges.get(c.id) }, c);
    if (button.dataset.action === 'resolve') { button.disabled = true; try { await api(`/api/comments/${c.id}`, { method:'PATCH', body:{ status:c.status === 'open' ? 'resolved' : 'open' } }); await loadComments(); await loadLibrary(); toast(c.status === 'open' ? '已标为解决' : '批注已重新打开'); } finally { button.disabled = false; } }
  });
}));
$('comments').addEventListener('submit', run(async e => {
  const form = e.target.closest('.reply-form'); if (!form) return; e.preventDefault();
  await busyForm(form, async () => { await api(`/api/comments/${form.dataset.id}/replies`, { method:'POST', body:{ body:form.querySelector('textarea').value } }); state.replies.delete(form.dataset.id); await loadComments(); toast('回复已发送'); });
}));
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target.matches('textarea')) { const form = e.target.closest('form'); if (form) { e.preventDefault(); form.requestSubmit(); } } });
$('share-button').addEventListener('click', run(() => {
  requireDocument(); const origin = ['localhost','127.0.0.1','[::1]'].includes(location.hostname) ? state.addresses[0] || location.origin : location.origin;
  $('share-url').value = `${origin}/d/${state.doc.short_id || state.doc.id}?v=${state.version}`;
  $('share-version').textContent = `${state.doc.title} · v${state.version}`; $('share-dialog').showModal();
}));
$('copy-share').addEventListener('click', run(async () => {
  const field = $('share-url');
  try { if (!navigator.clipboard || !window.isSecureContext) throw new Error(); await navigator.clipboard.writeText(field.value); }
  catch { field.focus(); field.select(); if (!document.execCommand('copy')) { toast('链接已选中，请按 Ctrl+C 复制'); return; } }
  toast('链接已复制');
}));
$('export-button').addEventListener('click', run(() => { updateExportLinks(); $('export-dialog').showModal(); }));
$('export-scope').addEventListener('change', updateExportLinks);
window.addEventListener('popstate', run(() => { const match = location.pathname.match(/^\/d\/([0-9a-z-]{8,64})$/i); if (match) return openDocument(match[1], Number(new URLSearchParams(location.search).get('v')) || undefined, { replace:true }); }));
window.addEventListener('online', () => state.doc && run(loadComments)());
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.doc) run(async () => { await loadLibrary(); await loadComments(); })(); });

run(async () => {
  const info = await api('/api/info'); setUser(info.user); state.addresses = info.addresses; connection(true);
  await loadLibrary();
  const match = location.pathname.match(/^\/d\/([0-9a-z-]{8,64})$/i), params = new URLSearchParams(location.search);
  if (params.get('comment')) sessionStorage.setItem('review-focus-comment', params.get('comment'));
  const id = match?.[1] || state.documents[0]?.short_id || state.documents[0]?.id;
  if (id) await openDocument(id, Number(params.get('v')) || undefined, { replace:true });
  if (!state.user) showIdentity();
})();
