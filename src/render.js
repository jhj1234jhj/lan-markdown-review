import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github.css';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, highlight: (str, lang) => lang && hljs.getLanguage(lang) ? hljs.highlight(str, { language: lang, ignoreIllegals: true }).value : escapeHTML(str) });
const baseFence = md.renderer.rules.fence.bind(md.renderer);
md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
  const token = tokens[index], line = (token.map?.[0] ?? 0) + 1;
  if (token.info.trim() === 'mermaid') return `<div class="mermaid-block" data-line="${line}" data-mermaid="${encodeURIComponent(token.content)}"><pre>${escapeHTML(token.content)}</pre></div>`;
  return `<div data-line="${line}">${baseFence(tokens, index, options, env, renderer)}</div>`;
};
const baseImage = md.renderer.rules.image;
md.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const t = tokens[index], src = t.attrGet('src') || '';
  if (!/^(https?:|data:|\/\/)/i.test(src)) {
    const file = new URL(src, `http://document.invalid/${env.sourcePath || 'document.md'}`);
    const path = file.pathname.slice(1).split('/').map(s => encodeURIComponent(decodeURIComponent(s))).join('/');
    t.attrSet('src', `/api/documents/${env.docId}/assets/${env.version}/${path}`);
  }
  t.attrSet('loading', 'lazy');
  return baseImage(tokens, index, options, env, renderer);
};
const baseRenderToken = md.renderer.renderToken.bind(md.renderer);
md.renderer.renderToken = (tokens, index, options) => {
  const t = tokens[index];
  if (t.map && t.nesting === 1) t.attrSet('data-line', String(t.map[0] + 1));
  if (t.type === 'link_open') { t.attrSet('target', '_blank'); t.attrSet('rel', 'noopener noreferrer'); }
  return baseRenderToken(tokens, index, options);
};
md.core.ruler.after('inline', 'task-lists', state => {
  for (let i = 0; i < state.tokens.length; i++) {
    const t = state.tokens[i];
    if (t.type === 'inline' && state.tokens[i - 2]?.type === 'list_item_open' && /^\[[ xX]\] /.test(t.content) && t.children?.[0]?.type === 'text') {
      const checked = t.content[1].toLowerCase() === 'x';
      t.children[0].content = t.children[0].content.slice(4);
      const checkbox = new state.Token('html_inline', '', 0);
      checkbox.content = `<input type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? '已完成' : '未完成'}">`;
      t.children.unshift(checkbox);
    }
  }
});
let mermaid;
export async function renderDocument(element, markdown, env) {
  element.innerHTML = DOMPurify.sanitize(md.render(markdown, env), { ADD_ATTR: ['target', 'data-line', 'data-mermaid'], FORBID_TAGS: ['style','script','iframe','object'] });
  const headings = [...element.querySelectorAll('h1,h2,h3')];
  headings.forEach((h, i) => { h.id = `heading-${i}`; });
  const diagrams = [...element.querySelectorAll('[data-mermaid]')];
  if (diagrams.length) {
    try {
      mermaid ||= (await import('mermaid')).default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', suppressErrorRendering: true });
      for (const [i, diagram] of diagrams.entries()) {
        if (!element.contains(diagram)) break;
        try { const result = await mermaid.render(`diagram-${Date.now()}-${i}`, decodeURIComponent(diagram.dataset.mermaid)); diagram.innerHTML = DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: ['foreignObject'], ADD_ATTR: ['dominant-baseline'] }); }
        catch { const warning = document.createElement('div'); warning.className = 'diagram-error'; warning.textContent = '图示语法暂不支持，已保留源代码。'; diagram.prepend(warning); }
      }
    } catch { /* Fenced source remains visible if diagram loading fails. */ }
  }
  return headings;
}
