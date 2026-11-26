import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const tempDir = () => mkdtempSync(join(tmpdir(), 'lan-review-'));
const launch = async dataDir => { const app = createApp({ dataDir, seed:false }); await new Promise(r=>app.server.listen(0,'127.0.0.1',r)); app.url = `http://127.0.0.1:${app.server.address().port}`; return app; };
const request = async (app, path, method = 'GET', body, cookie) => {
  const r = await fetch(app.url + path, {method,headers:{'Content-Type':'application/json','X-Review-Request':'1',...(cookie?{Cookie:cookie}:{})},body:body === undefined ? undefined : JSON.stringify(body)});
  const json = r.headers.get('content-type')?.includes('application/json'); return { status:r.status, body:json ? await r.json() : await r.text(), headers:r.headers };
};
test('two reviewers, live notifications, replies, exports, revision isolation and restart persistence', async () => {
  const dir = tempDir();
  let app = await launch(dir);
  let sse, reader;
  try {
    const alice = await request(app,'/api/session','POST',{name:'审阅者甲'}), bob = await request(app,'/api/session','POST',{name:'审阅者乙'});
    const a = alice.headers.get('set-cookie').split(';')[0], b = bob.headers.get('set-cookie').split(';')[0];
    assert.notEqual(a,b);
    const created = await request(app,'/api/documents','POST',{filename:'方案.md',markdown:'# 方案\n\n这一段需要讨论。\n'},a); assert.equal(created.status,201);
    const id = created.body.id;
    sse = new AbortController();
    const stream = await fetch(app.url+`/api/documents/${id}/events`,{signal:sse.signal}); reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    const result = await request(app,`/api/documents/${id}/comments`,'POST',{version:1,body:'建议补充验收标准。',quote:'这一段需要讨论。',selectors:[{type:'TextQuoteSelector',exact:'这一段需要讨论。',prefix:'',suffix:''}],sourceLine:3},a);
    assert.equal(result.status,201); const cid = result.body.id;
    const next = await Promise.race([reader.read(), new Promise((_,reject)=>setTimeout(()=>reject(new Error('SSE notification timed out')),2000))]);
    assert.match(new TextDecoder().decode(next.value), /event: update/);
    const received = await request(app,`/api/documents/${id}/comments?v=1`,'GET',undefined,b); assert.equal(received.body[0].body,'建议补充验收标准。');
    assert.equal((await request(app,`/api/comments/${cid}/replies`,'POST',{body:'同意，我来补充。'},b)).status,201);
    assert.equal((await request(app,`/api/comments/${cid}`,'PATCH',{body:'冒充作者'},b)).status,403);
    assert.equal((await request(app,`/api/comments/${cid}`,'PATCH',{status:'resolved'},b)).status,200);
    assert.equal((await request(app,`/api/documents/${id}/export?v=1&format=json&status=open`)).body.comments.length,0);
    const exported = await request(app,`/api/documents/${id}/export?v=1&format=md`); assert.match(exported.body,/同意，我来补充/); assert.match(exported.body,/已解决/);
    const v2 = await request(app,`/api/documents/${id}/revisions`,'POST',{baseVersion:1,filename:'方案.md',markdown:'# 方案\n\n已补充验收标准。'},a); assert.equal(v2.status,201);
    assert.equal((await request(app,`/api/documents/${id}/comments?v=2`)).body.length,0);
    assert.equal((await request(app,`/api/documents/${id}/comments?v=1`)).body.length,1);
    assert.equal((await request(app,`/api/documents/${id}/revisions`,'POST',{baseVersion:1,markdown:'错误并发覆盖'},b)).status,409);
    sse.abort(); await reader.cancel().catch(()=>{}); reader=null;
    await app.close(); app = await launch(dir);
    const persisted = await request(app,`/api/documents/${id}/comments?v=1`); assert.equal(persisted.body[0].replies[0].author,'审阅者乙');
    assert.equal((await request(app,`/api/documents/${id}?v=2`)).body.revision.markdown,'# 方案\n\n已补充验收标准。');
    assert.equal((await request(app,'/api/info','GET',undefined,a)).body.user.name,'审阅者甲');
  } finally { sse?.abort(); if (reader) await reader.cancel().catch(()=>{}); await app.close(); }
});

test('invalid input is rejected atomically; cross-origin writes and anonymous writes are blocked', async () => {
  const app = await launch(tempDir());
  try {
    assert.equal((await request(app,'/api/documents','POST',{markdown:'hello'})).status,401);
    const login = await request(app,'/api/session','POST',{name:'测试'}); const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await request(app,'/api/documents','POST',{filename:'a.md',markdown:''},cookie)).status,400);
    assert.equal((await request(app,'/api/documents','POST',{filename:'a.md',markdown:'ok',assets:[{path:'../secret',mime:'image/png',data:'AA=='}]},cookie)).status,400);
    assert.equal((await request(app,'/api/documents')).body.length,0);
    const cross = await fetch(app.url+'/api/session',{method:'POST',headers:{'Content-Type':'application/json','X-Review-Request':'1',Origin:'https://outside.example'},body:'{"name":"test"}'});
    assert.equal(cross.status,403);
    const noHeader = await fetch(app.url+'/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"name":"test"}'}); assert.equal(noHeader.status,403);
    const created = await request(app,'/api/documents','POST',{filename:'图片.md',markdown:'![图](img/x.png)',assets:[{path:'img/x.png',mime:'image/png',data:'aGVsbG8='}]},cookie);
    assert.equal(created.status,201);
    const image = await request(app,`/api/documents/${created.body.id}/assets/1/img/x.png`); assert.equal(image.body,'hello'); assert.equal(image.headers.get('content-type'),'image/png');
    assert.equal((await request(app,`/api/documents/${created.body.id}?v=999`)).status,404);
    assert.equal((await request(app,`/api/documents/${created.body.id}/comments`,'POST',{version:1,body:'x',quote:'q',selectors:[]},cookie)).status,400);
  } finally { await app.close(); }
});
