# rpa-download-session-recovery

JavaScript RPA 下载会话恢复库：处理登录会话失效、断点续抓、过期签名 URL、
并发下载、重复任务与错误页隔离。所有外部操作都通过注入的 `transport` 完成，
库本身不直接发起网络请求或写磁盘。

## 快速开始

```js
import { RpaDownloader, FileCheckpointStore } from './src/index.js';

const downloader = new RpaDownloader({
  transport,                                        // 必填，见下方契约
  checkpointStore: new FileCheckpointStore('./state/checkpoint.json'),
  concurrency: 3,                                   // 并发下载数
  retries: 3,                                       // 临时错误重试次数（指数退避）
  sessionMaxAgeMs: 30 * 60 * 1000,                  // 会话主动过期阈值
});

const summary = await downloader.run([
  { key: 'daily-report', startCursor: null },
]);
// summary: { done, quarantined, failed, sessionRefreshes }
```

进程重启后用同一个 `checkpointStore` 再次 `run()` 即可从最近检查点恢复。

## Transport 契约

```js
const transport = {
  // 拉取一页列表。cursor 为 null 表示第一页。
  // 返回 { status, items: [{ id, name, url, size?, digest? }], nextCursor }
  async fetchPage({ key, cursor }, { cookies }) {},

  // 下载文件内容。返回 { status, headers, body: Buffer }
  async download(url, { cookies }) {},

  // 重新登录，返回新的 cookie 状态（任意可序列化值）
  async refreshSession(oldCookies) {},

  // 校验通过后的落盘
  async writeFile(name, body) {},

  // 可选：错误页隔离。不提供时仅记录在检查点中
  async quarantine(name, body, { reason, item }) {},
};
```

错误约定：transport 可以返回 HTTP 状态码（库按 `401→会话失效`、
`403/410→签名 URL 过期`、`5xx→临时错误` 分类），也可以直接抛出
`TransportError`（指定 `code`）或普通 `Error`（视为临时网络错误）。

## 完成与隔离判定

- **完成**：只有当响应体大小等于列表给出的 `size`（如提供）**且**
  SHA-256 等于 `digest`（如提供）时，才调用 `writeFile` 并标记 `done`。
  两者都未提供时退化为仅校验下载成功，并记录实际摘要。
- **错误页隔离**：`Content-Type: text/html`，或正文明显小于期望大小且
  内容形如 HTML，或（无期望大小时）小于 `minFileBytes` 且形如 HTML ——
  进入隔离（`quarantined`），不计入完成，也不会写盘。
- **校验失败**：大小/摘要不匹配但不像错误页的，按临时错误重试；
  重试耗尽后标记 `failed`，留待下次运行重试。

## 恢复边界

检查点持久化内容：每个分页任务的游标与完成标记、每个文件的状态
（`done` / `quarantined` / `failed`，`failed` 含原始 item 信息）、
已完成文件的摘要集合、最近一次登录的 cookies。

**能恢复的**：

- 进程重启 / RPA 崩溃后，从检查点继续：已 `done` 的文件不再下载，
  `failed` 的文件自动重试，未完成的分页任务从上次游标继续。
- 会话失效（30 分钟过期）：收到 401 后单飞刷新会话并重放请求；
  超过 `sessionMaxAgeMs` 也会主动刷新。cookies 存入检查点，重启后先复用。
- 分页变化：游标失效（`CURSOR_INVALID`）时该任务从头重翻，
  依靠文件级 `done` 记录去重，不会重复下载。
- 过期签名 URL：下载返回 403/410 时，按 item id 重新定位列表项
  （先原页、再从头扫描）换取新 URL 后重试。
- 重复任务/重复文件：同一 `id` 在一次运行中只入队一次；
  同一 `digest` 的文件全局只下载一次，其余标记为 `duplicateOf`。
- 临时网络错误：抛出的普通异常与 5xx 按指数退避重试 `retries` 次。

**不能恢复的**（需要外部处理）：

- `quarantined` 的文件不会自动重试——错误页被视为服务端确定状态，
  需人工或上游修复后清除检查点中对应记录再重跑。
- 列表中彻底消失的 item（重新定位失败）按 `FATAL` 标记 `failed`，
  不会无限等待其重新出现。
- 非 401/403 的 4xx（如 404）视为 `FATAL`，不重试。
- 检查点本身损坏时不做修复：请备份 `checkpoint.json`，
  损坏后删除即等价于全量重抓（已落盘文件不会自动跳过，
  因为完成判定只认检查点记录）。
- 会话刷新本身失败（账号被锁等）会直接抛错，不重试登录。

## 测试

```sh
node --test
```

覆盖：中途会话失效、断点恢复（内存与文件检查点）、重复文件、
错误页隔离、过期签名 URL、分页游标失效、临时网络错误重试、
并发上限、摘要不匹配不算完成。
