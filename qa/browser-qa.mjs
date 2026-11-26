// 浏览器手动验收：用独立数据库起一份服务，避免污染 data/ 里的正式文档。
// 用法：node qa/browser-qa.mjs   （或 pnpm qa），然后打开打印出的地址。
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const dataDir = fileURLToPath(new URL('./browser-qa-data/', import.meta.url));
const port = Number(process.env.QA_PORT || 6768);
const app = createApp({ dataDir });

app.server.listen(port, '127.0.0.1', () => {
  console.log(`共阅 QA 服务：http://127.0.0.1:${port}`);
  console.log(`数据目录：qa/browser-qa-data（可随时删除重建）`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => app.close().then(() => process.exit(0)));
}
