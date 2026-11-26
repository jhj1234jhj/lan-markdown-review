import { TextQuoteAnchor, TextPositionAnchor } from '../vendor/hypothesis/anchoring/types.ts';
import { TextRange } from '../vendor/hypothesis/anchoring/text-range.ts';
import { renderedTextFromRange } from '../vendor/hypothesis/anchoring/rendered-text.ts';

export function describeSelection(root, range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) throw new Error('请在正文内选择文字');
  if ([...root.querySelectorAll('.mermaid-block')].some(el => range.intersectsNode(el))) throw new Error('图示请使用“整体建议”进行批注');
  const trimmed = TextRange.trimmedRange(range);
  const quote = TextQuoteAnchor.fromRange(root, trimmed).toSelector();
  if (!quote.exact.trim()) throw new Error('请选择文字');
  if (quote.exact.length > 8000) throw new Error('选中文字过长，请缩小范围');
  const start = trimmed.startContainer.nodeType === 1 ? trimmed.startContainer : trimmed.startContainer.parentElement;
  return { quote: quote.exact, selectors: [quote, TextPositionAnchor.fromRange(root, trimmed).toSelector()], sourceLine: Number(start.closest('[data-line]')?.dataset.line) || null, range: trimmed };
}
export function anchorComment(root, comment) {
  const quote = comment.selectors.find(s => s.type === 'TextQuoteSelector');
  const position = comment.selectors.find(s => s.type === 'TextPositionSelector');
  if (!quote) return null;
  if (position) {
    try { const range = TextPositionAnchor.fromSelector(root, position).toRange(); if (renderedTextFromRange(range) === quote.exact) return range; } catch { /* Try the quote and surrounding context. */ }
  }
  try {
    const range = TextQuoteAnchor.fromSelector(root, quote).toRange({ hint: position?.start });
    // Revisions are immutable. Never silently attach an approximate match.
    return renderedTextFromRange(range) === quote.exact ? range : null;
  } catch { return null; }
}
