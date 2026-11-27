import { renderDocument, escapeHTML as esc } from './render.js';
import { describeSelection, anchorComment } from './anchoring.js';

const $ = id => document.getElementById(id);
const state = { user: null, documents: [], doc: null, version: null, comments: [], filter: 'pending', selected: null, ranges: new Map(), addresses: [], stream: null, pending: null, importMode: 'new', files: [], sourceFile: null, loading: 0, replies: new Set(), displayMode: 'all', diffBase: null, diff: null };
let toastTimer, onIdentity, exportEditing = null;
const date = value => new Date(value).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false });
const shortDate = value => new Date(value).toLocaleDateString('zh-CN', { month:'long',day:'numeric' });
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 7000 : 3200); }
const run = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message || '操作未完成，请重试', true); } };
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type':'application/json', 'X-Review-Request':'1', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const body = await response.json(); if (!response.ok) throw new Error(body.error || '请求失败'); return body;
}
function setUser(user, admin = false) {
  state.user = user;
  state.admin = Boolean(admin) || /^admin$/i.test(user?.name || '');
  $('user-name').textContent = user?.name ? `${user.name}${state.admin ? ' · 管理员' : ''}` : '填写姓名';
  $('user-avatar').textContent = user?.name?.slice(0, 1) || '访';
}
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
const canDeleteDocument = d => Boolean(state.user) && (state.admin || (d.owner_id ? d.owner_id === state.user.id : d.owner_name === state.user.name));
function renderLibrary() {
  renderOwnerOptions();
  const visible = visibleDocuments();
  $('document-count').textContent = visible.length === state.documents.length ? state.documents.length : `${visible.length}/${state.documents.length}`;
  $('document-list').innerHTML = visible.map(d => {
    const ref = d.short_id || d.id, active = d.id === state.doc?.id;
    return `<div class="document-row${active ? ' active' : ''}">
      <a class="document-link${active ? ' active' : ''}" href="/d/${ref}" data-doc="${ref}">${docIcon}<span class="doc-name">${esc(d.title)}</span>${d.open_count ? `<span class="count-badge">${d.open_count}</span>` : ''}<span class="doc-meta">${esc(ownerLabel(d))} · ${date(d.updated)}</span></a>
      ${canDeleteDocument(d) ? `<button type="button" class="doc-delete" data-delete="${ref}" data-title="${esc(d.title)}" title="删除文档" aria-label="删除文档"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg></button>` : ''}
    </div>`;
  }).join('') || '<p class="helper">没有匹配的文档</p>';
}
async function openDocument(id, version, { replace = false } = {}) {
  const token = ++state.loading;
  const doc = await api(`/api/documents/${id}${version ? `?v=${version}` : ''}`);
  if (token !== state.loading) return;
  state.stream?.close(); state.doc = doc; state.version = doc.revision.version; state.comments = []; state.ranges.clear(); state.selected = null; state.replies.clear();
  clearSelection();
  for (const name of ['review-pending','review-agreed','review-rejected','review-open','review-resolved','review-active']) CSS.highlights?.delete(name);
  const path = `/d/${doc.short_id || doc.id}?v=${state.version}`;
  history[replace ? 'replaceState' : 'pushState']({}, '', path);
  document.title = `${doc.title} · 共阅`;
  $('toolbar-title').textContent = doc.title; $('document-title').textContent = doc.title;
  $('doc-id').textContent = doc.short_id; $('doc-id').hidden = !doc.short_id; $('doc-id').dataset.id = doc.short_id;
  $('document-filename').textContent = doc.filename; $('document-date').textContent = `${shortDate(doc.revision.created)} · ${doc.revision.author}`;
  $('download-source').href = `/api/documents/${id}/source?v=${state.version}`;
  $('version-label').textContent = `v${doc.latest}`;
  updateVersionButtons();
  $('version-notice').hidden = true;
  $('reading-pane').scrollTop = 0; renderLibrary(); renderComments();
  renderDiffControls();
  await renderBody();
  if (token !== state.loading) return;
  renderOutline();
  await loadComments();
  if (token !== state.loading) return;
  const stream = new EventSource(`/api/documents/${id}/events`); state.stream = stream;
  stream.addEventListener('ready', () => { connection(true); run(loadComments)(); });
  stream.addEventListener('update', run(async e => {
    const event = JSON.parse(e.data);
    await loadLibrary();
    if (event.docId === state.doc?.id) {
      if (event.type === 'documents') {
        const fresh = await api(`/api/documents/${id}`);
        state.doc.latest = fresh.latest; state.doc.versions = fresh.versions;
        $('version-label').textContent = `v${fresh.latest}`;
        updateVersionButtons();
      }
      await loadComments();
    }
  }));
  stream.onerror = () => connection(false);
  const commentId = sessionStorage.getItem('review-focus-comment');
  if (commentId) { sessionStorage.removeItem('review-focus-comment'); focusComment(commentId); }
}
/* ---------- 正文显示模式（全部 / 精简）与修改记录（版本对比） ---------- */
function clearHighlights() {
  if (!CSS.highlights) return;
  for (const info of Object.values(STATUS)) CSS.highlights.delete(info.highlight);
  CSS.highlights.delete('review-active');
}
function buildMarginMarkers() {
  const host = $('margin-markers'), body = document.querySelector('.document-body'), article = $('document-content');
  if (!host || !body || !article) return;
  host.replaceChildren();
  if (state.displayMode !== 'compact' || state.diff || !state.doc) return;
  const base = body.getBoundingClientRect(), articleRect = article.getBoundingClientRect();
  const left = Math.round(articleRect.left - base.left - 18), lanes = new Map();
  for (const comment of state.comments) {
    const range = state.ranges.get(comment.id);
    if (!range) continue;
    const rect = range.getClientRects()[0] || range.getBoundingClientRect();
    const top = Math.round(rect.top - base.top);
    const lane = lanes.get(Math.round(top / 16)) || 0;
    lanes.set(Math.round(top / 16), lane + 1);
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = `margin-marker ${statusOf(comment.status).className}`;
    marker.style.left = `${left}px`;
    marker.style.top = `${top + lane * 16}px`;
    marker.title = `${statusOf(comment.status).label} · ${(comment.quote || '整体建议').slice(0, 40)}`;
    marker.addEventListener('click', () => focusComment(comment.id));
    host.append(marker);
  }
}
function applyDisplayMode() {
  const content = $('document-content');
  const compact = state.displayMode === 'compact';
  content.classList.toggle('compact', compact && !state.diff);
  content.classList.toggle('diff-compact', compact && Boolean(state.diff));
  document.querySelector('.review-pane')?.classList.toggle('diff-mode', Boolean(state.diff));
  updateHighlights();
  requestAnimationFrame(buildMarginMarkers);
}
function updateDiffSummary(diff) {
  const node = $('diff-summary');
  node.hidden = false;
  node.innerHTML = `v${diff.from.version} → v${diff.to.version} · <b>+${diff.stats.added}</b> 行 / <i>−${diff.stats.removed}</i> 行`;
}
function hideDiffSummary() { const node = $('diff-summary'); if (node) node.hidden = true; }
function renderDiffControls() {
  const toggle = $('diff-toggle');
  toggle.disabled = !(state.doc && state.doc.latest > 1);
  if (!state.diffBase) { toggle.checked = false; return; }
  // 修改记录固定对比最初版本，不再提供版本选择。
  state.diffBase = 1;
  toggle.checked = true;
}
function renderOutline() {
  const headings = [...$('document-content').querySelectorAll('h1,h2,h3')];
  $('outline').innerHTML = headings.filter(h => h.tagName !== 'H1').map(h => `<a href="#${h.id}" class="level-${h.tagName.slice(1)}">${esc(h.textContent)}</a>`).join('');
}
// 词级 diff：中文按字、英文按词、空白/标点单独成 token，只标真正改动的部分。
const TOKEN_PATTERN = /[\u4e00-\u9fff]|[A-Za-z0-9_]+|\s+|[^\s]/g;
function tokenizeText(text) {
  const tokens = [];
  TOKEN_PATTERN.lastIndex = 0;
  for (let match = TOKEN_PATTERN.exec(text); match; match = TOKEN_PATTERN.exec(text)) tokens.push(match[0]);
  return tokens;
}
function diffTokens(a, b) {
  const n = a.length, m = b.length, width = m + 1;
  if (n * m > 400000) return null;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  const segments = [];
  const push = (type, text) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type) last.text += text;
    else segments.push({ type, text });
  };
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { push('equal', a[i]); i += 1; j += 1; }
    else if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) { push('insert', b[j]); j += 1; }
    else { push('delete', a[i]); i += 1; }
  }
  // 同一处替换里让删除排在新增前面，读起来更接近 Word 的顺序。
  const ordered = [];
  for (let index = 0; index < segments.length;) {
    if (segments[index].type === 'equal') { ordered.push(segments[index]); index += 1; continue; }
    const run = [];
    while (index < segments.length && segments[index].type !== 'equal') { run.push(segments[index]); index += 1; }
    ordered.push(...run.filter(segment => segment.type === 'delete'), ...run.filter(segment => segment.type === 'insert'));
  }
  return ordered;
}
function textMap(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [], starts = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push(node); starts.push(text.length); text += node.nodeValue; }
  return { nodes, starts, text };
}
function locateOffset(map, offset) {
  for (let i = map.nodes.length - 1; i >= 0; i -= 1) {
    if (map.starts[i] <= offset) return { node: map.nodes[i], offset: offset - map.starts[i] };
  }
  return null;
}
function wrapRange(root, start, end, tag, className) {
  if (end <= start) return;
  const map = textMap(root);
  for (let i = map.nodes.length - 1; i >= 0; i -= 1) {
    const node = map.nodes[i], base = map.starts[i], length = node.nodeValue.length;
    const from = Math.max(start, base) - base, to = Math.min(end, base + length) - base;
    if (to <= from) continue;
    if (to < length) node.splitText(to);
    let target = node;
    if (from > 0) target = node.splitText(from);
    const wrapper = document.createElement(tag);
    wrapper.className = className;
    target.parentNode.insertBefore(wrapper, target);
    wrapper.appendChild(target);
  }
}
function insertDeletion(root, offset, text) {
  if (!text.trim()) return;
  const deletion = document.createElement('del');
  deletion.className = 'diff-del';
  deletion.textContent = text;
  const map = textMap(root);
  const hit = locateOffset(map, offset);
  if (!hit) { root.appendChild(deletion); return; }
  const { node } = hit;
  const local = hit.offset;
  // 别把删除线塞进绿色的 <ins> 里：在它前面或后面断开。
  const inside = node.parentElement?.closest('.diff-ins');
  if (inside) {
    if (local === 0) { inside.parentNode.insertBefore(deletion, inside); return; }
    if (local >= node.nodeValue.length) { inside.parentNode.insertBefore(deletion, inside.nextSibling); return; }
  }
  let anchor = node;
  if (local > 0) anchor = node.splitText(local);
  anchor.parentNode.insertBefore(deletion, anchor);
}
// 把「整段替换」细化成词级标记：新增的词标绿，删掉的词原位划掉，其余保持原样。
const INLINE_DIFF_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE']);
function buildInlineDiff(oldBlock, newBlock) {
  if (oldBlock.tagName !== newBlock.tagName || !INLINE_DIFF_TAGS.has(oldBlock.tagName)) return null;
  const segments = diffTokens(tokenizeText(oldBlock.textContent), tokenizeText(newBlock.textContent));
  if (!segments) return null;
  const changed = segments.reduce((sum, seg) => sum + (seg.type === 'equal' ? 0 : seg.text.length), 0);
  const total = oldBlock.textContent.length + newBlock.textContent.length || 1;
  if (!changed || changed / total > 0.85) return null;
  const clone = newBlock.cloneNode(true);
  let position = 0;
  const inserts = [], deletes = [];
  for (const segment of segments) {
    if (segment.type === 'equal') position += segment.text.length;
    else if (segment.type === 'insert') { inserts.push([position, position + segment.text.length]); position += segment.text.length; }
    else deletes.push([position, segment.text]);
  }
  for (const [start, end] of inserts.sort((a, b) => b[0] - a[0])) wrapRange(clone, start, end, 'ins', 'diff-ins');
  for (const [offset, text] of deletes.sort((a, b) => b[0] - a[0])) insertDeletion(clone, offset, text);
  return clone;
}
// 把两个版本的渲染结果按行区间拼回去：新增块标绿、删除块标红，能配对的块做词级对比。
function composeDiff(oldRoot, newRoot, ops) {
  const collect = root => {
    let last = 1;
    return [...root.children].map(el => {
      const value = Number(el.dataset.line);
      const line = Number.isFinite(value) && value > 0 ? value : last;
      last = line;
      return { el, line };
    });
  };
  const groups = ops.map(() => []);
  const place = (items, side) => {
    for (const item of items) {
      const index = ops.findIndex(op => {
        if (side === 'old') return op.type === 'delete' && item.line >= op.oldStart && item.line < op.oldStart + op.lines.length;
        if (op.type === 'equal') return item.line >= op.newStart && item.line < op.newStart + op.count;
        if (op.type === 'insert') return item.line >= op.newStart && item.line < op.newStart + op.lines.length;
        return false;
      });
      if (index >= 0) groups[index].push(item);
    }
  };
  place(collect(newRoot), 'new');
  place(collect(oldRoot), 'old');
  const fragment = document.createDocumentFragment();
  const appendBlock = (item, className) => {
    const clone = item.el.cloneNode(true);
    clone.removeAttribute('id');
    if (className) clone.classList.add(className);
    fragment.append(clone);
  };
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].type === 'equal') { groups[i].forEach(item => appendBlock(item)); continue; }
    const run = [];
    while (i < ops.length && ops[i].type !== 'equal') { run.push(i); i += 1; }
    i -= 1;
    const removed = [], added = [];
    for (const index of run) (ops[index].type === 'delete' ? removed : added).push(...groups[index]);
    // 同一位置的块先试词级对比；配不上（类型不同或改动过大）就退回整块红/绿。
    while (removed.length && added.length) {
      const inline = buildInlineDiff(removed[0].el, added[0].el);
      if (!inline) break;
      inline.removeAttribute('id');
      inline.classList.add('diff-inline');
      fragment.append(inline);
      removed.shift(); added.shift();
    }
    removed.forEach(item => appendBlock(item, 'diff-deleted'));
    added.forEach(item => appendBlock(item, 'diff-inserted'));
  }
  return fragment;
}
async function renderBody() {
  const content = $('document-content'), doc = state.doc;
  state.diff = null;
  if (state.diffBase) {
    const [older, diff] = await Promise.all([
      api(`/api/documents/${doc.id}?v=${state.diffBase}`),
      api(`/api/documents/${doc.id}/diff?from=${state.diffBase}&to=${state.version}`),
    ]);
    state.diff = diff;
    const oldRoot = document.createElement('div'), newRoot = document.createElement('div');
    await renderDocument(oldRoot, older.revision.markdown, { docId: doc.id, version: state.diffBase, sourcePath: older.revision.source_path });
    await renderDocument(newRoot, doc.revision.markdown, { docId: doc.id, version: state.version, sourcePath: doc.revision.source_path });
    content.replaceChildren(composeDiff(oldRoot, newRoot, diff.ops));
    content.classList.add('diff-mode');
    updateDiffSummary(diff);
  } else {
    content.classList.remove('diff-mode');
    await renderDocument(content, doc.revision.markdown, { docId: doc.id, version: state.version, sourcePath: doc.revision.source_path });
    hideDiffSummary();
  }
  [...content.querySelectorAll('h1,h2,h3')].forEach((heading, index) => { heading.id = `heading-${index}`; });
  applyDisplayMode();
}
async function loadComments() {
  if (!state.doc) return;
  const id = state.doc.id, v = state.version;
  const comments = await api(`/api/documents/${id}/comments?v=${v}`);
  if (state.doc?.id !== id || state.version !== v) return;
  state.comments = comments; updateHighlights(); renderComments();
}
const STATUS = {
  pending: { label: '未批注', className: 'status-pending', highlight: 'review-pending' },
  agreed: { label: '同意', className: 'status-agreed', highlight: 'review-agreed' },
  rejected: { label: '拒绝', className: 'status-rejected', highlight: 'review-rejected' },
};
const statusOf = status => STATUS[status] || STATUS.pending;
function updateHighlights() {
  state.ranges.clear();
  const buckets = { pending: [], agreed: [], rejected: [] };
  for (const c of state.comments) {
    const range = anchorComment($('document-content'), c);
    if (!range) continue;
    state.ranges.set(c.id, range);
    buckets[buckets[c.status] ? c.status : 'pending'].push(range);
  }
  const suppressed = state.displayMode === 'compact' || Boolean(state.diff);
  if (CSS.highlights) {
    if (suppressed) clearHighlights();
    else {
      for (const [key, ranges] of Object.entries(buckets)) CSS.highlights.set(STATUS[key].highlight, new Highlight(...ranges));
      CSS.highlights.set('review-active', new Highlight(...(state.ranges.has(state.selected) ? [state.ranges.get(state.selected)] : [])));
    }
  }
  buildMarginMarkers();
}
const avatar = name => `<span class="avatar">${esc(name?.slice(0, 1) || '?')}</span>`;
function renderComments() {
  const drafts = new Map([...$('comments').querySelectorAll('.reply-form')].map(f => [f.dataset.id, f.querySelector('textarea').value]));
  const active = document.activeElement?.closest('.reply-form');
  const focus = active ? { id: active.dataset.id, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const scroll = $('comments').scrollTop;
  const counts = { pending: 0, agreed: 0, rejected: 0 };
  for (const c of state.comments) if (counts[c.status] !== undefined) counts[c.status] += 1;
  $('pending-count').textContent = counts.pending;
  $('agreed-count').textContent = counts.agreed;
  $('rejected-count').textContent = counts.rejected;
  $('comment-total').textContent = state.comments.length;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
  const comments = state.comments.filter(c => state.filter === 'all' || c.status === state.filter);
  $('comments').innerHTML = comments.length ? comments.map(c => {
    const info = statusOf(c.status);
    return `<section class="comment-card ${info.className} ${c.id === state.selected ? 'active' : ''}" data-id="${c.id}" id="comment-${c.id}">
    <div class="comment-author">${avatar(c.author)}<strong>${esc(c.author)}</strong><span class="status-pill ${info.className}">${info.label}</span><time title="${esc(c.created)}">${date(c.created)}</time></div>
    ${c.quote ? `<button class="quote-button" data-action="locate">${esc(c.quote)}</button>${!state.ranges.has(c.id) ? '<div class="orphan-label">原文暂无法定位，已保留引用</div>' : ''}` : '<span class="page-note-label">整体建议</span>'}
    <div class="comment-body">${esc(c.body)}</div>
    <div class="comment-actions"><button data-action="reply">回复${c.replies.length ? ` (${c.replies.length})` : ''}</button>${c.author_id === state.user?.id ? '<button data-action="edit">编辑</button>' : ''}<span class="status-actions" role="group" aria-label="批注状态"><button data-action="status" data-status="agreed" class="status-button approve${c.status === 'agreed' ? ' on' : ''}" aria-pressed="${c.status === 'agreed'}">同意</button><button data-action="status" data-status="rejected" class="status-button reject${c.status === 'rejected' ? ' on' : ''}" aria-pressed="${c.status === 'rejected'}">拒绝</button><button data-action="status" data-status="pending" class="status-button pending${c.status === 'pending' ? ' on' : ''}" aria-pressed="${c.status === 'pending'}">未批注</button></span></div>
    ${c.replies.length ? `<div class="reply-list">${c.replies.map(r => `<div class="reply"><div class="comment-author">${avatar(r.author)}<strong>${esc(r.author)}</strong><time>${date(r.created)}</time></div><div class="comment-body">${esc(r.body)}</div></div>`).join('')}</div>` : ''}
    ${state.replies.has(c.id) ? `<form class="reply-form" data-id="${c.id}"><textarea aria-label="回复 ${esc(c.author)}" placeholder="回复 ${esc(c.author)}……" maxlength="20000" rows="2" required>${esc(drafts.get(c.id) || '')}</textarea><button class="button primary" type="submit">发送回复</button></form>` : ''}
  </section>`;
  }).join('') : `<div class="empty-comments"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M9 8h30v24H23L9 41V8Z"/><path d="M17 17h14M17 24h9"/></svg><strong>${state.comments.length ? `没有「${state.filter === 'all' ? '全部' : statusOf(state.filter).label}」的批注` : '让讨论从一句话开始'}</strong><span>${state.comments.length ? '换个筛选条件，或在批注卡片上点「同意 / 拒绝 / 未批注」。' : '选中正文中的文字，添加你的第一条批注。<br>也可以提出一条整体建议。'}</span></div>`;
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

const redoStoreKey = () => (state.doc ? `review:redo:${state.doc.id}` : null);
function redoStack() {
  const key = redoStoreKey();
  if (!key) return [];
  try { const value = JSON.parse(sessionStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function setRedoStack(stack) {
  const key = redoStoreKey();
  if (!key) return;
  if (stack.length) sessionStorage.setItem(key, JSON.stringify(stack)); else sessionStorage.removeItem(key);
}
function updateVersionButtons() {
  if (!state.doc) return;
  $('undo-version').disabled = state.doc.latest <= 1;
  $('redo-version').disabled = redoStack().length === 0;
}
function firstChangeLine(diff, side) {
  let oldLine = 1, newLine = 1;
  for (const op of diff.ops) {
    if (op.type === 'equal') { oldLine += op.count; newLine += op.count; continue; }
    if (op.type === 'delete') return side === 'old' ? op.oldStart : newLine;
    return side === 'old' ? oldLine : op.newStart;
  }
  return null;
}
function flashLine(line) {
  if (!line) return;
  const blocks = [...$('document-content').querySelectorAll('[data-line]')].filter(el => Number(el.dataset.line) > 0);
  if (!blocks.length) return;
  const target = blocks.find(el => Number(el.dataset.line) >= line) || blocks[blocks.length - 1];
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('change-flash');
  setTimeout(() => target.classList.remove('change-flash'), 2400);
}
// 回退＝删掉最新一版（像 Word 撤销），恢复＝把它加回来；版本号始终连续。
async function undoVersion() {
  requireDocument();
  const latest = state.doc.latest;
  if (latest <= 1) throw new Error('已经是第一个版本');
  const [source, diff] = await Promise.all([
    api(`/api/documents/${state.doc.id}?v=${latest}`),
    api(`/api/documents/${state.doc.id}/diff?from=${latest - 1}&to=${latest}`),
  ]);
  const line = firstChangeLine(diff, 'old');
  const stack = redoStack();
  stack.push({ markdown: source.revision.markdown });
  setRedoStack(stack);
  let undone;
  try {
    undone = await api(`/api/documents/${state.doc.id}/revisions?version=${latest}`, { method: 'DELETE' });
  } catch (error) {
    stack.pop(); setRedoStack(stack);
    throw error;
  }
  state.diffBase = null;
  await loadLibrary();
  await openDocument(state.doc.id);
  setTimeout(() => flashLine(line), 180);
  const kept = undone?.keptComments || 0, removed = undone?.removedComments || 0;
  const note = kept || removed ? `（保留 ${kept} 条批注${removed ? `，删除 ${removed} 条与改动相关的` : ''}）` : '';
  toast(`已回退，删除 v${latest}；现在最新是 v${latest - 1}${note}`);
}
async function redoVersion() {
  requireDocument();
  const stack = redoStack();
  const last = stack[stack.length - 1];
  if (!last) throw new Error('没有可恢复的修改');
  const before = state.doc.latest;
  await api(`/api/documents/${state.doc.id}/revisions`, {
    method: 'POST',
    body: { baseVersion: before, markdown: last.markdown, filename: state.doc.filename, sourcePath: state.doc.revision.source_path, restoreUndone: true },
  });
  stack.pop(); setRedoStack(stack);
  state.diffBase = null;
  await loadLibrary();
  const diff = await api(`/api/documents/${state.doc.id}/diff?from=${before}&to=${before + 1}`);
  await openDocument(state.doc.id);
  setTimeout(() => flashLine(firstChangeLine(diff, 'new')), 180);
  toast('已恢复刚才的修改');
}
function openHistory() {
  requireDocument();
  $('version-list').innerHTML = state.doc.versions.map(v => `<li class="${v.version === state.doc.latest ? 'current' : ''}">
    <div class="version-main"><strong>v${v.version}</strong><span class="version-meta">${date(v.created)} · ${esc(v.author)}</span>${v.version === state.doc.latest ? '<span class="version-tag">当前</span>' : ''}${v.open_count ? `<span class="count-badge">${v.open_count}</span>` : ''}</div>
  </li>`).join('');
  $('history-dialog').showModal();
}
function openEditor() {
  requireDocument();
  if (state.version !== state.doc.latest) throw new Error(`请先切回当前版本 v${state.doc.latest} 再编辑`);
  const area = $('editor-markdown');
  area.value = state.doc.revision.markdown;
  $('editor-hint').textContent = `当前 v${state.version}，保存后成为 v${state.doc.latest + 1}，并自动打开「修改记录」对比。`;
  $('editor-count').textContent = `${area.value.length} 字符`;
  $('editor-dialog').showModal();
  setTimeout(() => { area.focus(); area.setSelectionRange(0, 0); }, 30);
}
async function deleteDocument(ref, title) {
  if (!window.confirm(`删除「${title}」？文档的所有版本和批注都会一起删除，无法恢复。`)) return;
  const removing = Boolean(state.doc && (state.doc.short_id === ref || state.doc.id === ref));
  await api(`/api/documents/${ref}`, { method: 'DELETE' });
  if (removing) {
    state.stream?.close(); state.stream = null;
    state.doc = null; state.comments = []; state.ranges.clear();
    $('document-content').innerHTML = '';
    $('document-title').textContent = '文档已删除';
    $('toolbar-title').textContent = '团队空间';
    $('doc-id').hidden = true;
    $('comments').innerHTML = '';
    $('outline').innerHTML = '';
    history.replaceState({}, '', '/');
  }
  await loadLibrary();
  toast('文档已删除');
  if (!state.doc) {
    const next = state.documents[0];
    if (next) await openDocument(next.short_id || next.id, undefined, { replace: true });
    else $('document-content').innerHTML = '<p class="helper">还没有文档，点左上角「导入文档」开始。</p>';
  }
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
    $('identity-dialog').close(); renderLibrary(); renderComments(); const next = onIdentity; onIdentity = null; if (next) await next();
  });
}));
$('import-document').addEventListener('click', () => withUser(() => openImport('new')));
$('upload-version').addEventListener('click', () => withUser(() => openImport('revision')));
$('edit-document').addEventListener('click', () => withUser(openEditor));
$('undo-version').addEventListener('click', run(undoVersion));
$('redo-version').addEventListener('click', run(redoVersion));
$('history-button').addEventListener('click', run(openHistory));
$('doc-id').addEventListener('click', run(async () => {
  const id = $('doc-id').dataset.id;
  if (!id) return;
  try {
    if (!navigator.clipboard || !window.isSecureContext) throw new Error('no clipboard');
    await navigator.clipboard.writeText(id);
    toast(`已复制文档编号 ${id}`);
  } catch {
    toast(`文档编号：${id}`);
  }
}));
$('editor-markdown').addEventListener('input', e => { $('editor-count').textContent = `${e.target.value.length} 字符`; });
$('editor-form').addEventListener('submit', run(async e => {
  e.preventDefault();
  await busyForm(e.currentTarget, async () => {
    const markdown = $('editor-markdown').value;
    if (!markdown.trim()) throw new Error('正文不能为空');
    if (state.version !== state.doc.latest) throw new Error(`请先切回当前版本 v${state.doc.latest} 再编辑`);
    const previous = state.version;
    const result = await api(`/api/documents/${state.doc.id}/revisions`, {
      method: 'POST',
      body: { baseVersion: previous, markdown, filename: state.doc.filename, sourcePath: state.doc.revision.source_path },
    });
    $('editor-dialog').close();
    setRedoStack([]);
    state.diffBase = 1;
    await loadLibrary();
    await openDocument(state.doc.id, result.version);
    toast(`已保存为 v${result.version}，正在显示修改记录`);
  });
}));
$('file-input').addEventListener('change', run(e => receiveFiles(e.target.files)));
$('folder-input').addEventListener('change', run(e => receiveFiles(e.target.files)));
for (const event of ['dragenter','dragover']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.add('dragging'); });
for (const event of ['dragleave','drop']) $('dropzone').addEventListener(event, e => { e.preventDefault(); $('dropzone').classList.remove('dragging'); });
$('dropzone').addEventListener('drop', run(e => receiveFiles(e.dataTransfer.files)));
$('import-form').addEventListener('submit', run(async e => {
  e.preventDefault(); await busyForm(e.currentTarget, async () => {
    const body = await importBody(), target = state.importTarget;
    const result = await api(target ? `/api/documents/${target.id}/revisions` : '/api/documents', { method:'POST', body: target ? { ...body, baseVersion:target.baseVersion } : body });
    $('import-dialog').close(); setRedoStack([]); await loadLibrary(); await openDocument(result.id, result.version); toast(target ? '新版本已保存，旧版批注完整保留' : '文档已导入，可以开始评审了');
  });
}));
$('document-search').addEventListener('input', renderLibrary);
$('owner-filter').addEventListener('change', renderLibrary);
$('time-filter').addEventListener('change', renderLibrary);
$('document-list').addEventListener('click', run(async e => {
  const remove = e.target.closest('[data-delete]');
  if (remove) { e.preventDefault(); e.stopPropagation(); await deleteDocument(remove.dataset.delete, remove.dataset.title); return; }
  const link = e.target.closest('[data-doc]'); if (link && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('library').classList.remove('open'); await openDocument(link.dataset.doc); }
}));
$('outline').addEventListener('click', e => { const link = e.target.closest('a'); if (link) { e.preventDefault(); $(link.hash.slice(1))?.scrollIntoView({ behavior:'smooth', block:'start' }); $('library').classList.remove('open'); } });
$('version-label').addEventListener('click', () => run(openHistory)());
document.querySelectorAll('[data-display]').forEach(button => button.addEventListener('click', () => {
  state.displayMode = button.dataset.display;
  document.querySelectorAll('[data-display]').forEach(b => b.classList.toggle('on', b === button));
  applyDisplayMode();
}));
$('diff-toggle').addEventListener('change', run(async () => {
  state.diffBase = $('diff-toggle').checked ? 1 : null;
  await renderBody();
  renderOutline();
  renderComments();
}));
if (typeof ResizeObserver === 'function') new ResizeObserver(() => buildMarginMarkers()).observe($('document-content'));
window.addEventListener('resize', () => buildMarginMarkers());
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
    $('comment-dialog').close(); state.filter = editing?.status || 'pending'; await loadComments(); await loadLibrary(); focusComment(editing?.id || result.id, false); toast(editing ? '批注已更新' : '批注已发布，同事可以实时看到');
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
    if (button.dataset.action === 'status') {
      const next = button.dataset.status === c.status ? 'pending' : button.dataset.status;
      button.disabled = true;
      try {
        await api(`/api/comments/${c.id}`, { method:'PATCH', body:{ status: next } });
        await loadComments(); await loadLibrary();
        toast(next === 'agreed' ? '已标记为同意' : next === 'rejected' ? '已标记为拒绝' : '已改回未批注');
      } finally { button.disabled = false; }
    }
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
  const info = await api('/api/info'); state.admin = Boolean(info.admin); setUser(info.user, info.admin); state.addresses = info.addresses; connection(true);
  await loadLibrary();
  const match = location.pathname.match(/^\/d\/([0-9a-z-]{8,64})$/i), params = new URLSearchParams(location.search);
  if (params.get('comment')) sessionStorage.setItem('review-focus-comment', params.get('comment'));
  const id = match?.[1] || state.documents[0]?.short_id || state.documents[0]?.id;
  if (id) await openDocument(id, Number(params.get('v')) || undefined, { replace:true });
  if (!state.user) showIdentity();
})();
