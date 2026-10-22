# BUGFIX.md

## 标题

`data:image/...` 壁纸链接被渲染层追加缓存戳 `?t=<毫秒>` 而损坏：base64 载荷解码失败、SVG 载荷根元素后多出垃圾，壁纸画不出来（`lib/client.js` 的 `stampedWallpaperUrl()`）。

## 证据链（失败 → 通过）

上游基线：HEAD `65f98f94b656553dd4a8be3bafe6df7272896159`，版本 10.22.0。全量测试逐文件跑：34 个测试文件全绿（569 通过 / 0 失败，另有环境跳过），`npm run typecheck` 退出码 0，`npm run skin:check` 退出码 0——本 bug 不在既有测试覆盖内（既有用例只断言 data URL 被「存下来」，不断言它被「画出来」）。开放 issue 里没有与本 bug 对应的条目（`gh api .../issues?state=open`：#117 非 bug、#112 功能请求、#110 为 macOS GPU 占用报告，本机无法复现），故按静态实锤 + 最小复现取证。

最小复现脚本（从 `lib/client.js` 原样抽出 `stripWallpaperBust` + `stampedWallpaperUrl` 两个纯函数后调用）：

- 修复前（`git stash` 回基线跑同一脚本，退出码 1）：
  - `FAIL svg data URL unstamped — got: data:image/svg+xml,%3Csvg ...%3E%3C/svg%3E?t=1792703789275`
  - `FAIL svg payload well-formed tail — decoded: <svg xmlns="http://www.w3.org/2000/svg"></svg>?t=1792703789275`
  - `FAIL base64 data URL unstamped + decodable — got: data:image/png;base64,iVBORwECAwQ=?t=1792703789275`；且 Node `atob()` 对该载荷抛 `Invalid character`（data URL 用的就是 WHATWG forgiving-base64 解码，`?` 不在字母表内）。
  - `PASS http URL still stamped before fragment`（http 行为基线正常）
- 集成复现（借用 `tests/client.smoke.test.cjs` 的沙箱 harness 追加一条用例，经设置动作 `setUrl(svgDataUrl)` 后读壁纸层实际写入的 `backgroundImage`）：
  - 修复前渲染值：`url("data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"%3E%3C/svg%3E?t=1792703789275")`
  - 修复后渲染值：`url("data:image/svg+xml,%3Csvg xmlns=\"http://www.w3.org/2000/svg\"%3E%3C/svg%3E")`，用例通过。
- 修复后同一最小脚本：4/4 PASS，退出码 0。

## 根因

- `isSafeWallpaperUrl()` 明确允许 `data:image/` 作为「图片链接」壁纸（`lib/client.js`，且有既有用例钉住：SVG data URL 可被接受并持久化）。
- 但三条路径都会无条件给 URL 加缓存戳：手动「应用链接」`setUrl()` 先把刷新配置的 `lastFiredAt` 写成当前时刻再渲染；`wallpaperBackgroundCss()` 只要 `lastFiredAt > 0` 就调用 `stampedWallpaperUrl(url, lastFiredAt)`；定时刷新与预加载探针同样调用它。
- 缓存戳是给 http(s) 网络请求用的：它以 `?t=` / `&t=` 形式拼进 URL 的 query。而 `data:` URL 没有 query 的位置——拼进去的字符串直接成为数据载荷的一部分：base64 载荷多出 `?`、`=`（位置非法）与字母表外字符，解码失败；百分号编码的 SVG 解码后在根元素 `</svg>` 之后多出 `?t=...`，不再是合法 XML 文档。两种形态的 data 壁纸都会因此加载失败，用户看到的是空白背景（预加载探针还会误报「链接加载失败」）。

## 改动

只改一个文件：`lib/client.js`，函数 `stampedWallpaperUrl()` 开头加一条守卫（+9 行，含注释）：

```js
if (!/^https?:\/\//i.test(clean)) return clean;
```

即：只有 http(s) 链接才追加缓存戳，其余（此处即合法的 `data:image/...`）原样返回。本函数是全部加戳路径的唯一入口（渲染、定时刷新探针、手动应用探针、轮换探针共用），一处修复覆盖全部调用点；轮换列表本身只收 http(s)，不受影响。

另按落点仓管线改 `package.json`：`version` 10.22.0 → 10.22.1，`repository.url` 改为 `https://github.com/lhg-dsh-plugins/lhg-dsh-dream-skin`；README 顶部追加中文 fork 说明头，原文一字未删；`LICENSE` 原样保留；新增本文件与 `UPSTREAM.md`。

## 复验

- 最小复现脚本：修复前 3 FAIL / 1 PASS（退出码 1），修复后 4/4 PASS（退出码 0）；`git stash` 基线对照已做。
- 集成复现：修复后渲染值不带任何 `?t=` / `&t=` 戳且以 `%3C/svg%3E` 收尾，用例通过。
- 回归：逐文件跑全部 34 个测试文件，569 通过 / 0 失败，与基线逐文件计数完全一致（其中 `client.smoke` 157/157，含既有的 http 加戳用例 T1 与 #61「apply link」用例——http 链接的缓存戳行为不变）；`npm run typecheck` 退出码 0；`npm run skin:check` 退出码 0。

## 边界

- 只修 `data:` 被加戳这一条缺陷；不改定时刷新/轮换的调度、相位与 `lastFiredAt` 语义（data 链接被手动应用时仍会写 `lastFiredAt`，但渲染与探针都不再用它改写 data URL）。
- http(s) 链接行为逐字不变：戳仍在 `#fragment` 之前、仍是 13 位毫秒值。
- 未做真浏览器目视验证：结论基于函数级复现 + 沙箱集成复现 + WHATWG `atob` 解码实测，未在真实 DSH 页面里目视 data 壁纸的最终像素。
- 按本 fork 的待集成管线，`package.json` 之外的上游发版同步项（`PLUGIN_BUILD` 常量、`package-lock.json` 版本字段、CHANGELOG/README 版本块）未在本目录内同步，留待集成时按落点仓的发版口径处理。
