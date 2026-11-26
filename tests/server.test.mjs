import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
const tempDir = () => mkdtempSync(join(tmpdir(), 'lan-review-'));
const launch = async dataDir => { const app = createApp({ dataDir, seed:false }); await new Promise(r=>app.server.listen(0,'127.0.0.1',r)); app.url = `http://127.0.0.1:${app.server.address().port}`; return app; };
const request = async (app, path, method = 'GET', body, cookie, headers = {}) => {
  const r = await fetch(app.url + path, {method,headers:{'Content-Type':'application/json','X-Review-Request':'1',...(cookie?{Cookie:cookie}:{}),...headers},body:body === undefined ? undefined : JSON.stringify(body)});
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

test('service API: token auth, short ids, submit/fetch, filters and revision ownership', async () => {
  const app = await launch(tempDir());
  const bearer = token => ({ Authorization: `Bearer ${token}` });
  try {
    const alice = await request(app, '/api/accounts', 'POST', { account: 'alice', name: '爱丽丝' });
    assert.equal(alice.status, 201);
    assert.match(alice.body.token, /^[a-f0-9]{64}$/);
    assert.equal((await request(app, '/api/accounts', 'POST', { account: 'alice', name: '冒名' })).status, 409);
    assert.equal((await request(app, '/api/service/documents', 'POST', { markdown: '# 无 token' })).status, 401);

    const created = await request(app, '/api/service/documents', 'POST', { filename: 'a.md', markdown: '# 标题 A\n\n正文。' }, undefined, bearer(alice.body.token));
    assert.equal(created.status, 201);
    assert.match(created.body.shortId, /^[a-z0-9]{8}$/);
    assert.equal(created.body.url, `/d/${created.body.shortId}`);

    const fetched = await request(app, `/api/service/documents/${created.body.shortId}?include=content,comments`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.content, '# 标题 A\n\n正文。');
    assert.deepEqual(fetched.body.comments, []);
    assert.equal(fetched.body.content !== undefined && fetched.body.owner.account, 'alice');
    assert.equal(fetched.body.version, 1);

    const byShort = await request(app, `/api/documents/${created.body.shortId}`);
    assert.equal(byShort.body.id, created.body.id);

    const comment = await request(app, `/api/documents/${created.body.shortId}/comments`, 'POST',
      { version: 1, body: '建议补充验收标准。', quote: '正文。', selectors: [{ type: 'TextQuoteSelector', exact: '正文。' }] },
      undefined, bearer(alice.body.token));
    assert.equal(comment.status, 201);

    const withComments = await request(app, `/api/service/documents/${created.body.shortId}?include=comments`);
    assert.equal(withComments.body.comments.length, 1);
    assert.equal(withComments.body.comments[0].body, '建议补充验收标准。');
    assert.equal(withComments.body.content, undefined);

    const v2 = await request(app, `/api/service/documents/${created.body.shortId}/revisions`, 'POST',
      { markdown: '# 标题 A\n\n正文已补充验收标准。' }, undefined, bearer(alice.body.token));
    assert.equal(v2.status, 201);
    assert.equal(v2.body.version, 2);

    const bob = await request(app, '/api/accounts', 'POST', { account: 'bob', name: '鲍勃' });
    assert.equal((await request(app, `/api/service/documents/${created.body.shortId}/revisions`, 'POST',
      { markdown: '# 抢改' }, undefined, bearer(bob.body.token))).status, 403);

    const all = await request(app, '/api/service/documents');
    assert.equal(all.body.length, 1);
    assert.equal(all.body[0].owner.account, 'alice');
    assert.equal((await request(app, '/api/service/documents?account=alice')).body.length, 1);
    assert.equal((await request(app, '/api/service/documents?account=bob')).body.length, 0);
    assert.equal((await request(app, '/api/service/documents?since=2999-01-01T00:00:00Z')).body.length, 0);
    assert.equal((await request(app, '/api/documents?owner=alice')).body.length, 1);
    assert.equal((await request(app, '/api/documents?owner=%E4%B8%8D%E5%AD%98%E5%9C%A8')).body.length, 0);

    const rotated = await request(app, '/api/accounts', 'POST', { account: 'alice', name: '爱丽丝' }, undefined, bearer(alice.body.token));
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.token, alice.body.token);
    assert.equal((await request(app, '/api/accounts/me')).status, 401);
    assert.equal((await request(app, '/api/accounts/me', 'GET', undefined, undefined, bearer(rotated.body.token))).body.account, 'alice');
    assert.equal((await request(app, '/api/service/documents', 'POST', { markdown: '# 旧 token' }, undefined, bearer(alice.body.token))).status, 401);
  } finally { await app.close(); }
});
