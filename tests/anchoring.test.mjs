import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints:[fileURLToPath(new URL('../src/anchoring.js',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false });
// 把浏览器端的锚定模块打包成可在 Node 里 import 的单文件，缓存到 qa/.cache（已 gitignore）。
const cache = new URL('../qa/.cache/', import.meta.url);
mkdirSync(cache, { recursive: true });
const modulePath = new URL('anchoring-qa.mjs', cache);
writeFileSync(modulePath,bundle.outputFiles[0].text);
const {describeSelection,anchorComment} = await import(modulePath.href);
function setup(html) { const dom=new JSDOM(`<article>${html}</article>`); for(const k of ['window','document','Node','NodeFilter','Range','Element','XPathResult'])globalThis[k]=dom.window[k];return dom.window.document.querySelector('article'); }
test('Chinese text across inline nodes and line breaks survives serialization and reload',()=>{
  const root=setup('<p data-line="3">开头 <strong>多人协作</strong><br>批注与讨论。</p>'); const range=new Range(); range.setStart(root.querySelector('strong').firstChild,0);range.setEnd(root.querySelector('p').lastChild,5);
  const d=describeSelection(root,range); assert.equal(d.quote,'多人协作 批注与讨论'); assert.equal(d.sourceLine,3);
  const serialized=JSON.parse(JSON.stringify({quote:d.quote,selectors:d.selectors}));
  const reloaded=setup('<p data-line="3">开头 <strong>多人协作</strong><br>批注与讨论。</p>'); assert.ok(anchorComment(reloaded,serialized));
});
test('repeated text anchors to the chosen occurrence; missing quote is not silently fuzzy-matched',()=>{
  const root=setup('<p>甲：需要修改。</p><p>乙：需要修改。</p>'); const node=root.lastChild.firstChild;const range=new Range();range.setStart(node,2);range.setEnd(node,6);const d=describeSelection(root,range);
  assert.equal(anchorComment(root,d).startContainer,node);
  const changed=setup('<p>这里没有相同的句子。</p>'); assert.equal(anchorComment(changed,d),null);
});
