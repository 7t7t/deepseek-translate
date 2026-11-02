# DeepSeek 双语翻译 Chrome 扩展 — 设计文档

日期：2026-11-02
参考：沉浸式翻译（Chrome 扩展 ID `bpoadfkcbjbfhfodiogcnhhhpibjhbnh`）

## 1. 目标

做一个 Chrome 扩展，提供类似「沉浸式翻译」的网页双语对照体验，翻译引擎使用 DeepSeek，API Key 由用户在设置页自行配置。

成功标准：

- 在设置页填入 DeepSeek Key 并「测试连接」成功后，四项功能（整页、划词、输入框、站点规则）在真实网页上均可用。
- API Key 仅存在本地 `chrome.storage.local`，只发往用户配置的 Base URL（默认 `https://api.deepseek.com`），不经任何第三方。
- 翻译失败时不破坏页面原文，并给出可理解的提示。

非目标（YAGNI）：PDF/EPUB/视频字幕翻译、多翻译引擎、云同步、账号体系、Firefox 支持。

## 2. 技术选型

- Manifest V3，原生 JavaScript（ES2020+）+ CSS，**无构建步骤**，`chrome://extensions` →「加载已解压的扩展程序」直接使用。
- 无第三方依赖。
- 无自动化测试框架；以手工在真实网页验证为准。

## 3. 目录结构

```
deepseek-translate/
├─ manifest.json
├─ background.js          # service worker：消息路由、翻译队列、缓存、快捷键、右键菜单、站点规则判断
├─ lib/
│   ├─ storage.js         # 配置默认值 + 读写 chrome.storage.local
│   └─ deepseek.js        # DeepSeek API 调用、prompt 构造、批量结果解析
├─ content/
│   ├─ common.js          # content 侧共享：发消息到 background、toast、语言检测
│   ├─ page.js            # 整页双语对照
│   ├─ selection.js       # 划词翻译浮窗
│   ├─ input.js           # 输入框三连空格翻译
│   └─ content.css        # 译文、浮窗、toast 样式（统一 dst- 前缀）
├─ popup/  popup.html / popup.js / popup.css
├─ options/ options.html / options.js / options.css
├─ icons/  16/32/48/128 png
└─ docs/specs/
```

`background.js` 以 `importScripts` 加载 `lib/*.js`（classic service worker）；content scripts 按 `common.js → page.js → selection.js → input.js` 顺序注入，共享全局命名空间 `window.__DST__`。

## 4. 配置项（lib/storage.js）

| key | 默认值 | 说明 |
|---|---|---|
| `apiKey` | `''` | DeepSeek API Key |
| `baseUrl` | `https://api.deepseek.com` | 兼容 OpenAI 的接口地址 |
| `model` | `deepseek-chat` | 模型名 |
| `targetLang` | `zh-CN` | 网页/划词目标语言 |
| `inputTargetLang` | `en` | 输入框翻译目标语言 |
| `alwaysSites` | `[]` | 总是翻译的域名 |
| `neverSites` | `[]` | 永不翻译的域名 |
| `enableSelection` | `true` | 划词翻译开关 |
| `enableInput` | `true` | 输入框翻译开关 |
| `maxConcurrency` | `3` | 并发请求数 |

可选语言：简体中文、繁体中文、English、日本語、한국어、ไทย、Español、Português、Bahasa Indonesia、Français、Deutsch、Русский。

域名匹配：去掉 `www.` 后完全相等，或者是规则域名的子域名（规则 `example.com` 能匹配 `a.example.com`）。

## 5. 消息协议（content/popup → background）

| type | 参数 | 返回 |
|---|---|---|
| `translate` | `{ texts: string[], targetLang }` | `{ ok: true, results: string[] }` 或 `{ ok: false, error }` |
| `testConnection` | `{ apiKey, baseUrl, model }` | `{ ok, error? }` |
| `getSiteStatus` | `{ host }` | `{ rule: 'always'|'never'|null }` |

background → content（`chrome.tabs.sendMessage`）：`togglePage`（切换整页翻译）、`translateSelection`（右键菜单翻译选中内容）。

## 6. DeepSeek 调用（lib/deepseek.js + background）

- `POST {baseUrl}/chat/completions`，`Authorization: Bearer {apiKey}`，`temperature: 0.3`，`stream: false`，超时 60s（AbortController）。
- **单条**（划词 / 输入框）：system prompt 要求「只输出译文，不解释」。
- **批量**（整页）：将段落编号后合并发送：
  ```
  <<0>>
  段落文本
  <<1>>
  段落文本
  ```
  system prompt 要求保持相同编号格式逐段输出译文。按 `<<n>>` 拆回；若解析出的段数不符，则退化为逐段单独请求。
- 批大小：单批累计 ≤ 2000 字符且 ≤ 20 段。
- 队列：全局并发上限 `maxConcurrency`；失败（网络/5xx/429）重试 1 次，间隔 1s；401/402 不重试。
- 缓存：key = `targetLang + '\u0000' + 原文`，内存 Map 实现 LRU，上限 2000 条（service worker 重启后丢失，可接受）。
- 错误映射：401 →「API Key 无效」；402 →「DeepSeek 账户余额不足」；429 →「请求过于频繁」；超时 →「请求超时」；未配置 Key →「请先在设置页配置 DeepSeek API Key」。

## 7. 功能设计

### 7.1 整页双语对照（content/page.js）

- 触发：popup 按钮、快捷键 `Alt+A`（`commands`）、或站点命中 `alwaysSites` 时在页面加载后自动开始。
- 段落收集：从 `document.body` 遍历，候选块元素为 `p, li, h1–h6, td, th, dd, dt, blockquote, figcaption, summary, label`，以及「直接含有非空文本节点、且没有块级子元素」的 `div/span/a`（防止漏掉 div 排版的网站）。
- 跳过：`script, style, noscript, code, pre, kbd, samp, textarea, input, select, svg, canvas, [contenteditable]`、本扩展自己的元素（`.dst-*`）、`translate="no"`、隐藏元素；文本去空白后 < 2 个字符、纯数字/符号；以及文本已是目标语言的（中文目标时 CJK 占比 > 50% 视为已是中文，其他目标语言用简单字符集判断）。
- 按需翻译：每个候选段落交给 IntersectionObserver（rootMargin `600px`），进入视口后放进待翻译队列，攒 100ms 一起打批发出。
- 动态内容：MutationObserver 监听新增节点，对新节点重复收集（节流 300ms）。
- 插入：原元素末尾追加 `<font class="dst-translation" lang="..."><br>译文</font>`；对行内/短标题以 inline 形式（不加 `<br>`、前置空格）。原元素标记 `data-dst-done`，避免重复翻译。
- 切换：再次触发时在 `<html>` 上切换 `dst-hide` class（CSS 隐藏所有 `.dst-translation`），不重新请求。
- 加载态：段落翻译中显示小号旋转圈；失败时显示可点击的「⚠ 重试」。

### 7.2 划词翻译（content/selection.js）

- `mouseup` 后若选中文本非空且 ≤ 2000 字、不在输入框内，在选区右下角显示 20px 小图标；点击图标弹出浮窗（Shadow DOM 隔离样式）显示原文摘要 + 译文 + 复制按钮。
- 点击浮窗外、按 Esc 或滚动时关闭。
- 右键菜单「DeepSeek 翻译选中内容」直接弹出浮窗。
- `enableSelection=false` 或站点命中 `neverSites` 时不启用（右键菜单仍可手动使用）。

### 7.3 输入框翻译（content/input.js）

- 监听 `input/textarea/[contenteditable]` 的 keydown：500ms 内连续三次空格键 → 去掉末尾刚输入的空格 → 将全文翻译为 `inputTargetLang` → 替换内容并派发 `input` 事件（兼容 React/Vue 受控组件：通过原生 value setter 赋值）。
- 翻译中给元素加 `dst-input-loading` 样式；失败时恢复原文并弹出 toast。
- 跳过 `type=password` 等非文本输入。

### 7.4 站点规则

- 设置页：两个文本域，每行一个域名。
- popup：显示当前域名，下拉选择「默认 / 总是翻译本站 / 永不翻译本站」，保存后立即生效。
- `neverSites`：content script 启动时检查，命中则不挂载划词、输入框功能，也不自动翻译；popup 中「翻译本页」按钮仍可手动强制执行。

## 8. UI

- **popup**（约 300px 宽）：未配置 Key 时显示提示和「去设置」入口；否则显示「翻译本页 / 显示原文」主按钮、目标语言下拉、本站规则下拉、设置入口。
- **options**：分为「API 设置」（Key 用密码框，可切换显示；Base URL；模型；测试连接按钮）、「翻译偏好」（目标语言、输入框目标语言、划词/输入框开关、并发数）、「站点规则」和「快捷键」（说明文字 + 跳转 `chrome://extensions/shortcuts` 的按钮）。修改后自动保存，并显示「已保存」提示。
- 译文样式：继承原文字体，颜色稍浅（`opacity: .85`），左侧加细边线以便区分。

## 9. 权限

`storage`、`activeTab`、`scripting`、`contextMenus`；`host_permissions`: `<all_urls>`（content script 注入 + 访问 API）。content script `matches: ["<all_urls>"]`，`all_frames: false`，`run_at: document_idle`。

## 10. 错误处理

- 所有 API 错误统一映射为中文提示（见 §6），通过 toast 显示在页面右下角，3s 后自动消失；同一错误 5s 内只提示一次。
- 段落级失败只影响该段，显示重试入口。
- 扩展重载后旧页面中 `chrome.runtime` 失效：捕获 "Extension context invalidated"，提示「扩展已更新，请刷新页面」。

## 11. 验证计划（手工）

1. 加载扩展，打开设置页，填入 Key，点击「测试连接」→ 成功；填错误 Key → 提示「API Key 无效」。
2. 英文新闻/文档页（如 Wikipedia、MDN）按 `Alt+A` → 段落下方出现中文译文；滚动后新段落继续翻译；再按一次 → 隐藏译文。
3. 划词 → 出现图标 → 点击后浮窗显示译文；右键菜单可用。
4. 在任意 textarea 中输入中文，连按三次空格 → 替换为英文。
5. popup 设置本站「总是翻译」→ 刷新后自动翻译；设置「永不翻译」→ 划词图标不再出现。
6. 未配置 Key 时触发翻译 → 提示去设置。
