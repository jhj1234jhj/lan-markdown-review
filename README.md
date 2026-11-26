# 共阅 · 局域网 Markdown 协作评审

把一份 Markdown 交给大家评审：所有人打开同一个链接，**划词批注**、回复讨论，最后把意见导出成 Markdown / JSON 交回给作者或 AI 工具继续修改。

## 快速开始

需要 Node.js ≥ 24（服务端使用内置 `node:sqlite`）。仓库不含构建产物，先装依赖并构建前端，再启动：

```powershell
pnpm install
pnpm build      # 生成 public/dist；首次，以及每次改过 src/ 之后都要跑
pnpm start
# 共阅已启动：http://localhost:6767
# 局域网：http://192.168.x.x:6767
```

浏览器打开 http://localhost:6767 就能用；首次启动会自动创建数据库，并播种一篇《欢迎来到共阅》的示例文档。不想用 pnpm 的话，`node scripts/build.mjs && node server.mjs` 等价。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `6767` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；只想本机访问改成 `127.0.0.1` |
| `REVIEW_DATA_DIR` | `./data` | 数据库目录 |

- 不需要账号：填个姓名就能参与，局域网内直接访问。
- 不转格式：文档始终是 Markdown，批注锚定到具体那句话，不是截图和坐标。
- 不丢版本：每次上传新版本，旧正文和旧批注都保留，可随时回看。

## 适合什么场景

用 AI 生成一份方案 / 需求 / 文档 → 需要几位同事逐段提意见 → 汇总后统一修改。常见做法是转成 Word 或者截图圈画，批注和原文很快失联；共阅让每条意见都带着「它指的是哪句话」。

## 使用流程

1. **导入文档**：拖入 `.md`（可以连同图片文件夹一起拖），或直接粘贴内容；标题默认取第一个 `#` 标题。
2. **分享**：右上角「分享」给出局域网链接，链接固定到当前版本，评审期间正文不会变。
3. **批注**：选中正文文字 → 浮出「添加批注」；不选文字可以点「＋ 整体建议」。
4. **讨论**：在右侧卡片里回复，处理完把批注标为「已解决」，可切换待处理 / 已解决 / 全部。
5. **上传新版本**：改完文档点「上传新版本」，旧版本从版本下拉里仍可打开。
6. **导出意见**：导出 Markdown（便于人读）或 JSON（保留定位信息，便于程序处理）。

## 部署与数据

- 单进程、单文件：文档、批注、图片都在 `data/review.sqlite` 里，**备份就是拷贝 `data/` 整个目录**（连 `-wal`、`-shm` 一起）。
- 删掉 `data/` 就是重置，下次启动会重建并重新播种示例文档。
- 默认监听 `0.0.0.0` 并向局域网开放：**同一网络内能访问端口的人都能读写**，请只放在可信局域网里。

## 目录结构

```
server.mjs            HTTP 路由、SQLite 表结构、SSE 广播
src/app.js            前端状态机：路由、列表、批注渲染与交互（约 270 行）
src/render.js         Markdown → DOM：markdown-it + DOMPurify + highlight.js + mermaid
src/anchoring.js      选区 → 选择器；选择器 → 选区（严格匹配）
public/index.html     单页壳：侧栏、正文、批注栏、对话框
public/style.css      样式
public/dist/          由 scripts/build.mjs 用 esbuild 打包生成（gitignore，需先 build）
tests/                node:test：接口、SSE、导出、版本隔离、锚定
qa/browser-qa.mjs     用独立数据目录在 6768 端口起服务，手动验收用
vendor/hypothesis/    Hypothesis 的锚定组件（BSD-2-Clause，见 PROVENANCE.md）
data/                 运行时数据库（gitignore）
```

## 工作原理

### 批注如何定位到原文

选中一段文字时，同时记录两个选择器：

- `TextQuoteSelector`：原文、前缀、后缀；
- `TextPositionSelector`：字符区间。

回显时先用位置选择器还原区间并**校验文本完全一致**；不一致再用「引用 + 上下文」查找。两者都对不上就明确标记为「未定位」，**不会退化为模糊匹配**——宁可让这条批注显示为失效，也不把它悄悄挂到另一句话上。选中的起始节点带 `data-line`，所以导出时还能给出源文件段落行号。

### 版本

每个版本是独立的一行 `revisions`（正文 + 哈希 + 作者 + 时间），批注挂在 `(doc_id, version)` 上。上传新版本时校验 `baseVersion`，避免并发覆盖；内容哈希相同则拒绝重复上传。**新版本不继承旧批注**：正文已变，沿用旧锚点会错位——这是刻意取舍。

### 实时协作

每个文档一条 SSE（`/api/documents/:id/events`），有人新增批注、回复或上传版本时向所有订阅者广播 `update` 事件，前端静默重取。服务是单进程内存广播，配 SQLite WAL，够一个团队局域网使用。

## HTTP 接口

写操作要求登录 cookie（`review_session`，HttpOnly），并同时满足：`Origin` 与 Host 一致、带 `X-Review-Request: 1` 头、`Content-Type: application/json`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/info` | 端口、局域网地址、当前用户 |
| POST | `/api/session` | `{name}`，创建/改名并下发 cookie |
| GET | `/api/documents` | 文档列表（含待处理批注数） |
| POST | `/api/documents` | 新建文档，body 同导入 |
| GET | `/api/documents/:id?v=` | 文档 + 指定版本正文 + 版本列表 |
| POST | `/api/documents/:id/revisions` | `{baseVersion, markdown, assets?}` 上传新版本 |
| GET | `/api/documents/:id/events` | SSE 更新流 |
| GET | `/api/documents/:id/comments?v=` | 指定版本的批注与回复 |
| POST | `/api/documents/:id/comments` | `{version, body, quote, selectors, sourceLine?}` |
| GET | `/api/documents/:id/source?v=` | 下载该版本 Markdown |
| GET | `/api/documents/:id/export?v=&format=md\|json&status=open` | 导出意见 |
| GET | `/api/documents/:id/assets/:version/:path` | 随文档导入的图片 |
| PATCH | `/api/comments/:id` | `{status}` 解决/重开，或 `{body}` 改自己的批注 |
| POST | `/api/comments/:id/replies` | `{body}` 回复 |

JSON 导出格式见代码：`schema: "lan-review/1"`，每条批注带 `target.selector`（两个选择器原文）与 `sourcePath`。

## 限制

| 项 | 限制 |
| --- | --- |
| Markdown 正文 | ≤ 2 MB（导入与上传都是） |
| 图片 | 仅 PNG/JPEG/WebP/GIF，单版本合计 ≤ 8 MB、≤ 100 张 |
| 批注正文 | ≤ 20000 字符，引用文字 ≤ 8000 字符 |
| 姓名 | ≤ 40 字符，仅作显示，**不是身份认证** |

另外：单实例部署（SQLite + 进程内 SSE，不支持多机共享）；批注不跨版本；没有删除文档 / 批注的接口。

## 测试与验收

```powershell
pnpm test     # node --test：接口、SSE、导出、版本隔离、重启持久化、非法输入、跨站拦截、锚定
pnpm build    # esbuild 打包 src/ → public/dist
pnpm qa       # 6768 端口，独立数据目录，手动浏览器验收
```

锚定测试会在 `qa/.cache/` 里生成一个 `anchoring-qa.mjs` 打包产物（因为 `vendor/` 是 TypeScript，Node 不能直接 import），该目录已 gitignore。

## 第三方

`vendor/hypothesis/` 是 [hypothesis/client](https://github.com/hypothesis/client) 在 `1c9d82c8` 上 `src/annotator/anchoring/` 的六个 TypeScript 文件原样副本，BSD-2-Clause，许可证与第三方声明见 `vendor/hypothesis/LICENSE`，来源记录见 `vendor/hypothesis/PROVENANCE.md`。本项目只使用其锚定组件，不运行 Hypothesis 的侧栏、h 服务或云 API；协作服务与界面为独立实现。

运行时依赖：markdown-it、DOMPurify、highlight.js、mermaid、approx-string-match；构建/测试用 esbuild、jsdom。
