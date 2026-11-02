# DeepSeek 双语翻译 Chrome 扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Manifest V3 Chrome 扩展，用用户自己配置的 DeepSeek API Key 实现整页双语对照、划词翻译、输入框翻译和站点规则。

**Architecture:** 纯逻辑（域名匹配、语言检测、LRU、分批、DeepSeek 调用、并发队列）放在 `lib/`，写成同时兼容浏览器全局变量和 Node `module.exports` 的 IIFE，用 `node --test` 做单元测试。background service worker 通过 `importScripts` 加载 `lib/`，是唯一持有 API Key 并发起网络请求的地方；content scripts 共享 `window.__DST__` 命名空间，通过 `chrome.runtime.sendMessage` 请求翻译。

**Tech Stack:** Chrome Extension Manifest V3、原生 JavaScript (ES2020+)、CSS、Node 22 内置 `node:test`（仅用于测试，无任何 npm 依赖）。

**Spec:** `docs/specs/2026-11-02-deepseek-translate-design.md`

## Global Constraints

- 项目根目录：`D:/AI/deepseek-translate`，无构建步骤，`chrome://extensions` →「加载已解压的扩展程序」直接加载根目录。
- 零第三方依赖；`package.json` 只有 `test` 脚本。
- API Key 只存 `chrome.storage.local`，只在 background 中发往 `{baseUrl}/chat/completions`（默认 `https://api.deepseek.com`）。
- 默认值：`model=deepseek-chat`，`targetLang=zh-CN`，`inputTargetLang=en`，`maxConcurrency=3`，`temperature=0.3`，超时 60s，失败重试 1 次（间隔 1s，仅网络/超时/429/5xx），LRU 2000 条，单批 ≤2000 字符且 ≤20 段。
- 错误文案：401「API Key 无效」；402「DeepSeek 账户余额不足」；429「请求过于频繁，请稍后再试」；超时「请求超时」；无 Key「请先在设置页配置 DeepSeek API Key」；扩展失效「扩展已更新，请刷新页面」。
- 快捷键 `Alt+A`（command 名 `toggle-page`）；右键菜单 id `dst-translate-selection`，标题「DeepSeek 翻译选中内容」。
- 所有注入页面的 class / 属性用 `dst-` / `data-dst` 前缀；主色 `#4d6bfe`。
- 代码风格：无分号、单引号、2 空格缩进；UI 文案中文。

**相对 spec 的简化：** spec §5 的 `getSiteStatus` 消息不实现——站点规则由 content/popup 直接用 `DST_UTILS.getSiteRule` + `chrome.storage` 本地计算，效果相同、少一次往返。新增 `forwardToTab`（popup → background → tab，自动补注入 content scripts）和 `getPageState` 消息。

## Review Focus

1. **扩展重载后旧标签页**：用户在已打开的页面划词/按快捷键，应提示「扩展已更新，请刷新页面」而不是静默失败或报 JS 错误 → Task 4 Step 7 手工验证。
2. **React/Vue 受控输入框**：三连空格替换后，失焦或提交时框架状态应是译文，不能被回滚成原文 → Task 7 Step 3 手工验证（GitHub issue 评论框 / 任意 React 站点）。
3. **SPA / 无限滚动**：新加载的段落应在滚到视口附近时自动翻译，已翻译段落不重复翻译 → Task 5 Step 4 手工验证（Reddit / Twitter 类页面或 MDN 侧边导航）。
4. **链接内的译文与重试**：段落在 `<a>` 内时，点击「⚠ 重试」不应触发跳转 → Task 5 Step 5 手工验证（断网或错误 Key 制造失败）。
5. **错误提示刷屏**：Key 无效时整页几十个段落同时失败，toast 5 秒内只出现一次 → Task 5 Step 5 手工验证。

---

### Task 1: 项目骨架 + `lib/utils.js`

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `lib/utils.js`
- Test: `tests/utils.test.js`

**Interfaces:**
- Consumes: 无
- Produces（全局 `DST_UTILS` / `require('./utils.js')`）:
  - `LANGS: {code, name, en}[]`，`langName(code): string`（返回英文名，供 prompt 使用）
  - `normalizeHost(input: string): string`
  - `matchSite(host: string, list: string[]): boolean`
  - `getSiteRule(host: string, cfg: {alwaysSites, neverSites}): 'always'|'never'|null`
  - `parseSiteList(text: string): string[]`
  - `setSiteRule(cfg, host, rule: ''|'always'|'never'): {alwaysSites, neverSites}`
  - `isTranslatable(text: string): boolean`
  - `isTargetLang(text: string, lang: string): boolean`
  - `class LruCache(max)`，方法 `get(key)`、`set(key, value)`、属性 `size`
  - `buildBatches(texts: string[], maxChars = 2000, maxItems = 20): number[][]`（返回下标分组）

- [ ] **Step 1: 创建 `package.json` 和 `.gitignore`**

`package.json`:
```json
{
  "name": "deepseek-translate",
  "version": "0.1.0",
  "private": true,
  "description": "DeepSeek 双语翻译 Chrome 扩展",
  "scripts": {
    "test": "node --test tests/",
    "icons": "node scripts/make-icons.js"
  }
}
```

`.gitignore`:
```
node_modules/
*.zip
```

- [ ] **Step 2: 写失败测试 `tests/utils.test.js`**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const u = require('../lib/utils.js')

test('normalizeHost strips scheme, www, port, path and lowercases', () => {
  assert.equal(u.normalizeHost('https://www.Example.com:8080/a/b'), 'example.com')
  assert.equal(u.normalizeHost('  Docs.Example.com '), 'docs.example.com')
  assert.equal(u.normalizeHost(''), '')
})

test('matchSite matches exact host and subdomains only', () => {
  assert.equal(u.matchSite('a.example.com', ['example.com']), true)
  assert.equal(u.matchSite('example.com', ['www.example.com']), true)
  assert.equal(u.matchSite('badexample.com', ['example.com']), false)
  assert.equal(u.matchSite('example.com', []), false)
  assert.equal(u.matchSite('', ['example.com']), false)
})

test('getSiteRule prefers never over always', () => {
  const cfg = { alwaysSites: ['example.com'], neverSites: ['a.example.com'] }
  assert.equal(u.getSiteRule('a.example.com', cfg), 'never')
  assert.equal(u.getSiteRule('b.example.com', cfg), 'always')
  assert.equal(u.getSiteRule('other.com', cfg), null)
})

test('parseSiteList normalizes, dedupes and drops blanks', () => {
  assert.deepEqual(u.parseSiteList('a.com\n\n https://www.b.com/x \na.com'), ['a.com', 'b.com'])
})

test('setSiteRule moves host between lists and removes covering rules', () => {
  const cfg = { alwaysSites: ['example.com', 'x.com'], neverSites: [] }
  assert.deepEqual(u.setSiteRule(cfg, 'docs.example.com', 'never'), {
    alwaysSites: ['x.com'],
    neverSites: ['docs.example.com'],
  })
  assert.deepEqual(u.setSiteRule(cfg, 'x.com', ''), { alwaysSites: ['example.com'], neverSites: [] })
})

test('isTranslatable requires at least 2 chars and a letter', () => {
  assert.equal(u.isTranslatable(''), false)
  assert.equal(u.isTranslatable('a'), false)
  assert.equal(u.isTranslatable('12:30'), false)
  assert.equal(u.isTranslatable('— · —'), false)
  assert.equal(u.isTranslatable('Hi'), true)
  assert.equal(u.isTranslatable('你好'), true)
})

test('isTargetLang detects text already in target language', () => {
  assert.equal(u.isTargetLang('今天天气很好，适合出门。', 'zh-CN'), true)
  assert.equal(u.isTargetLang('Hello world', 'zh-CN'), false)
  assert.equal(u.isTargetLang('こんにちは世界', 'zh-CN'), false)
  assert.equal(u.isTargetLang('こんにちは世界', 'ja'), true)
  assert.equal(u.isTargetLang('Hello world', 'en'), true)
  assert.equal(u.isTargetLang('Hola señor', 'en'), false)
  assert.equal(u.isTargetLang('안녕하세요', 'ko'), true)
  assert.equal(u.isTargetLang('สวัสดีครับ', 'th'), true)
  assert.equal(u.isTargetLang('Bonjour', 'fr'), false)
})

test('LruCache evicts least recently used', () => {
  const c = new u.LruCache(2)
  c.set('a', 1)
  c.set('b', 2)
  assert.equal(c.get('a'), 1) // a 变为最近使用
  c.set('c', 3)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('c'), 3)
  assert.equal(c.size, 2)
})

test('buildBatches splits by chars and item count', () => {
  assert.deepEqual(u.buildBatches(['a'.repeat(1500), 'b'.repeat(600), 'c']), [[0], [1, 2]])
  const many = Array.from({ length: 25 }, () => 'x')
  const b = u.buildBatches(many)
  assert.equal(b.length, 2)
  assert.equal(b[0].length, 20)
  assert.deepEqual(u.buildBatches(['z'.repeat(5000)]), [[0]])
  assert.deepEqual(u.buildBatches([]), [])
})

test('langName returns English name for prompts', () => {
  assert.equal(u.langName('zh-CN'), 'Simplified Chinese')
  assert.equal(u.langName('xx'), 'xx')
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd D:/AI/deepseek-translate && npm test`
Expected: FAIL，`Cannot find module '../lib/utils.js'`

- [ ] **Step 4: 实现 `lib/utils.js`**

```js
;(function (root) {
  const LANGS = [
    { code: 'zh-CN', name: '简体中文', en: 'Simplified Chinese' },
    { code: 'zh-TW', name: '繁體中文', en: 'Traditional Chinese' },
    { code: 'en', name: 'English', en: 'English' },
    { code: 'ja', name: '日本語', en: 'Japanese' },
    { code: 'ko', name: '한국어', en: 'Korean' },
    { code: 'th', name: 'ไทย', en: 'Thai' },
    { code: 'es', name: 'Español', en: 'Spanish' },
    { code: 'pt', name: 'Português', en: 'Portuguese' },
    { code: 'id', name: 'Bahasa Indonesia', en: 'Indonesian' },
    { code: 'fr', name: 'Français', en: 'French' },
    { code: 'de', name: 'Deutsch', en: 'German' },
    { code: 'ru', name: 'Русский', en: 'Russian' },
  ]

  function langName(code) {
    const lang = LANGS.find((l) => l.code === code)
    return lang ? lang.en : code
  }

  function normalizeHost(input) {
    return String(input || '')
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/[/:?#].*$/, '')
      .replace(/^www\./, '')
  }

  function matchSite(host, list) {
    const h = normalizeHost(host)
    if (!h) return false
    return (list || []).some((rule) => {
      const d = normalizeHost(rule)
      return !!d && (h === d || h.endsWith('.' + d))
    })
  }

  function getSiteRule(host, cfg) {
    if (matchSite(host, cfg.neverSites)) return 'never'
    if (matchSite(host, cfg.alwaysSites)) return 'always'
    return null
  }

  function parseSiteList(text) {
    const out = []
    for (const line of String(text || '').split(/[\n,]+/)) {
      const h = normalizeHost(line)
      if (h && !out.includes(h)) out.push(h)
    }
    return out
  }

  // 设置某站点规则：先移除所有覆盖该站点的规则，再按需加入
  function setSiteRule(cfg, host, rule) {
    const h = normalizeHost(host)
    const keep = (list) => (list || []).filter((r) => !matchSite(h, [r]))
    const alwaysSites = keep(cfg.alwaysSites)
    const neverSites = keep(cfg.neverSites)
    if (rule === 'always') alwaysSites.push(h)
    if (rule === 'never') neverSites.push(h)
    return { alwaysSites, neverSites }
  }

  function isTranslatable(text) {
    const t = String(text || '').trim()
    return t.length >= 2 && /\p{L}/u.test(t)
  }

  const RE = {
    han: /[\u4e00-\u9fff]/g,
    kana: /[\u3040-\u30ff]/g,
    hangul: /[\uac00-\ud7af]/g,
    thai: /[\u0e00-\u0e7f]/g,
    cyrillic: /[\u0400-\u04ff]/g,
    latin: /[a-zA-Z\u00c0-\u024f]/g,
    accented: /[\u00c0-\u024f]/g,
  }

  function count(text, re) {
    const m = text.match(re)
    return m ? m.length : 0
  }

  // 粗略判断文本是否已经是目标语言（拉丁语系除英语外无法可靠区分，一律返回 false）
  function isTargetLang(text, lang) {
    const t = String(text || '').replace(/[\s\d\p{P}\p{S}]/gu, '')
    if (!t) return true
    const ratio = (re) => count(t, re) / t.length
    switch (String(lang).slice(0, 2)) {
      case 'zh':
        return ratio(RE.han) > 0.5 && count(t, RE.kana) === 0
      case 'ja':
        return ratio(RE.kana) > 0.1
      case 'ko':
        return ratio(RE.hangul) > 0.5
      case 'th':
        return ratio(RE.thai) > 0.5
      case 'ru':
        return ratio(RE.cyrillic) > 0.5
      case 'en':
        return ratio(RE.latin) > 0.9 && count(t, RE.accented) === 0
      default:
        return false
    }
  }

  class LruCache {
    constructor(max) {
      this.max = max
      this.map = new Map()
    }
    get size() {
      return this.map.size
    }
    get(key) {
      if (!this.map.has(key)) return undefined
      const value = this.map.get(key)
      this.map.delete(key)
      this.map.set(key, value)
      return value
    }
    set(key, value) {
      this.map.delete(key)
      this.map.set(key, value)
      if (this.map.size > this.max) this.map.delete(this.map.keys().next().value)
    }
  }

  function buildBatches(texts, maxChars = 2000, maxItems = 20) {
    const batches = []
    let cur = []
    let size = 0
    texts.forEach((t, i) => {
      if (cur.length && (size + t.length > maxChars || cur.length >= maxItems)) {
        batches.push(cur)
        cur = []
        size = 0
      }
      cur.push(i)
      size += t.length
    })
    if (cur.length) batches.push(cur)
    return batches
  }

  const api = {
    LANGS,
    langName,
    normalizeHost,
    matchSite,
    getSiteRule,
    parseSiteList,
    setSiteRule,
    isTranslatable,
    isTargetLang,
    LruCache,
    buildBatches,
  }
  root.DST_UTILS = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(globalThis)
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd D:/AI/deepseek-translate && npm test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore lib/utils.js tests/utils.test.js
git commit -m "feat: add shared utils (site rules, language detection, LRU, batching)"
```

---

### Task 2: `lib/deepseek.js` — DeepSeek 调用与批量解析

**Files:**
- Create: `lib/deepseek.js`
- Test: `tests/deepseek.test.js`

**Interfaces:**
- Consumes: `DST_UTILS.langName`
- Produces（全局 `DST_DEEPSEEK` / `require('./deepseek.js')`）:
  - `class TranslateError extends Error`，字段 `code: 'nokey'|'auth'|'balance'|'rate'|'server'|'http'|'timeout'|'network'|'bad'`、`retryable: boolean`
  - `buildBatchContent(texts: string[]): string`
  - `parseBatchContent(content: string, count: number): string[] | null`
  - `chat({apiKey, baseUrl, model, system, user, fetchImpl?, timeout?}): Promise<string>`
  - `translateOne(cfg: {apiKey, baseUrl, model}, text, targetLang, fetchImpl?): Promise<string>`
  - `translateBatch(cfg, texts: string[], targetLang, fetchImpl?): Promise<string[]>`

- [ ] **Step 1: 写失败测试 `tests/deepseek.test.js`**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const ds = require('../lib/deepseek.js')

const cfg = { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat' }

function okResponse(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
}

test('buildBatchContent numbers paragraphs', () => {
  assert.equal(ds.buildBatchContent(['A', 'B']), '<<0>>\nA\n<<1>>\nB')
})

test('parseBatchContent handles newline and same-line markers', () => {
  assert.deepEqual(ds.parseBatchContent('<<0>>\n甲\n<<1>>\n乙', 2), ['甲', '乙'])
  assert.deepEqual(ds.parseBatchContent('<<0>> 甲\n<<1>> 乙\n', 2), ['甲', '乙'])
})

test('parseBatchContent returns null when a paragraph is missing', () => {
  assert.equal(ds.parseBatchContent('<<0>>\n甲', 2), null)
  assert.equal(ds.parseBatchContent('甲乙', 2), null)
})

test('chat posts OpenAI-compatible request and trims content', async () => {
  let call
  const fetchImpl = async (url, init) => {
    call = { url, init }
    return okResponse('  你好 \n')
  }
  const out = await ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl })
  assert.equal(out, '你好')
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test')
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.temperature, 0.3)
  assert.equal(body.stream, false)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ])
})

test('chat without key throws nokey and does not call fetch', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
  }
  await assert.rejects(ds.chat({ ...cfg, apiKey: '', system: 'S', user: 'U', fetchImpl }), (e) => {
    assert.equal(e.code, 'nokey')
    assert.equal(e.message, '请先在设置页配置 DeepSeek API Key')
    return true
  })
  assert.equal(called, false)
})

test('chat maps HTTP errors', async () => {
  const cases = [
    [401, 'auth', 'API Key 无效', false],
    [402, 'balance', 'DeepSeek 账户余额不足', false],
    [429, 'rate', '请求过于频繁，请稍后再试', true],
    [503, 'server', 'DeepSeek 服务异常（503）', true],
    [400, 'http', '请求失败（400）', false],
  ]
  for (const [status, code, message, retryable] of cases) {
    const fetchImpl = async () => ({ ok: false, status, json: async () => ({}) })
    await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl }), (e) => {
      assert.equal(e.code, code)
      assert.equal(e.message, message)
      assert.equal(e.retryable, retryable)
      return true
    })
  }
})

test('chat maps network failure and timeout', async () => {
  const failing = async () => {
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl: failing }), { code: 'network' })

  const hanging = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
  await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl: hanging, timeout: 10 }), {
    code: 'timeout',
    message: '请求超时',
  })
})

test('chat rejects malformed response', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })
  await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl }), { code: 'bad' })
})

test('translateOne prompt names the target language', async () => {
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    return okResponse('你好')
  }
  assert.equal(await ds.translateOne(cfg, 'Hello', 'zh-CN', fetchImpl), '你好')
  assert.match(body.messages[0].content, /Simplified Chinese/)
  assert.equal(body.messages[1].content, 'Hello')
})

test('translateBatch parses numbered output in one request', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return okResponse('<<0>>\n甲\n<<1>>\n乙')
  }
  assert.deepEqual(await ds.translateBatch(cfg, ['A', 'B'], 'zh-CN', fetchImpl), ['甲', '乙'])
  assert.equal(calls, 1)
})

test('translateBatch falls back to one-by-one when markers mismatch', async () => {
  const replies = ['甲乙（格式错乱）', '甲', '乙']
  const fetchImpl = async () => okResponse(replies.shift())
  assert.deepEqual(await ds.translateBatch(cfg, ['A', 'B'], 'zh-CN', fetchImpl), ['甲', '乙'])
  assert.equal(replies.length, 0)
})

test('translateBatch with single text uses single prompt', async () => {
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    return okResponse('甲')
  }
  assert.deepEqual(await ds.translateBatch(cfg, ['A'], 'zh-CN', fetchImpl), ['甲'])
  assert.equal(body.messages[1].content, 'A')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/AI/deepseek-translate && npm test`
Expected: FAIL，`Cannot find module '../lib/deepseek.js'`

- [ ] **Step 3: 实现 `lib/deepseek.js`**

```js
;(function (root) {
  const utils = root.DST_UTILS || require('./utils.js')

  class TranslateError extends Error {
    constructor(code, message, retryable) {
      super(message)
      this.name = 'TranslateError'
      this.code = code
      this.retryable = retryable
    }
  }

  function errorFromStatus(status) {
    if (status === 401) return new TranslateError('auth', 'API Key 无效', false)
    if (status === 402) return new TranslateError('balance', 'DeepSeek 账户余额不足', false)
    if (status === 429) return new TranslateError('rate', '请求过于频繁，请稍后再试', true)
    if (status >= 500) return new TranslateError('server', `DeepSeek 服务异常（${status}）`, true)
    return new TranslateError('http', `请求失败（${status}）`, false)
  }

  function singlePrompt(targetLang) {
    const lang = utils.langName(targetLang)
    return (
      `You are a professional translator. Translate the user's text into ${lang}. ` +
      'Output only the translation, without explanations, notes or quotes. ' +
      'Keep line breaks, URLs, code, numbers and proper nouns unchanged. ' +
      `If the text is already in ${lang}, output it unchanged.`
    )
  }

  function batchPrompt(targetLang) {
    const lang = utils.langName(targetLang)
    return (
      'You are a professional translator. The user sends several paragraphs, each preceded by a marker line ' +
      `such as <<0>>, <<1>>. Translate every paragraph into ${lang}. ` +
      'Output every marker in the same order, each followed by its translation on the next line. ' +
      'Output only markers and translations, without explanations. ' +
      'Keep URLs, code, numbers and proper nouns unchanged.'
    )
  }

  function buildBatchContent(texts) {
    return texts.map((t, i) => `<<${i}>>\n${t}`).join('\n')
  }

  function parseBatchContent(content, count) {
    const parts = String(content || '').split(/<<(\d+)>>/)
    const out = new Array(count).fill(null)
    for (let i = 1; i < parts.length; i += 2) {
      const idx = Number(parts[i])
      if (idx >= 0 && idx < count) out[idx] = parts[i + 1].trim()
    }
    return out.every((x) => x) ? out : null
  }

  async function chat({ apiKey, baseUrl, model, system, user, fetchImpl = fetch, timeout = 60000 }) {
    if (!apiKey) throw new TranslateError('nokey', '请先在设置页配置 DeepSeek API Key', false)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeout)
    let data
    try {
      const res = await fetchImpl(String(baseUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      })
      if (!res.ok) throw errorFromStatus(res.status)
      data = await res.json()
    } catch (e) {
      if (e instanceof TranslateError) throw e
      if (e && e.name === 'AbortError') throw new TranslateError('timeout', '请求超时', true)
      throw new TranslateError('network', '网络错误：' + (e && e.message), true)
    } finally {
      clearTimeout(timer)
    }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
    if (typeof content !== 'string') throw new TranslateError('bad', 'DeepSeek 返回格式异常', false)
    return content.trim()
  }

  function translateOne(cfg, text, targetLang, fetchImpl) {
    return chat({ ...cfg, system: singlePrompt(targetLang), user: text, fetchImpl })
  }

  async function translateBatch(cfg, texts, targetLang, fetchImpl) {
    if (texts.length === 1) return [await translateOne(cfg, texts[0], targetLang, fetchImpl)]
    const content = await chat({
      ...cfg,
      system: batchPrompt(targetLang),
      user: buildBatchContent(texts),
      fetchImpl,
    })
    const parsed = parseBatchContent(content, texts.length)
    if (parsed) return parsed
    // 模型没有按编号格式返回时，逐段单独翻译
    const out = []
    for (const t of texts) out.push(await translateOne(cfg, t, targetLang, fetchImpl))
    return out
  }

  const api = { TranslateError, buildBatchContent, parseBatchContent, chat, translateOne, translateBatch }
  root.DST_DEEPSEEK = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(globalThis)
```

Note: `fetchImpl = fetch` 默认参数只在 `fetchImpl` 为 `undefined` 时求值，所以 `translateOne(cfg, text, lang)` 在浏览器里会使用全局 `fetch`。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/AI/deepseek-translate && npm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/deepseek.js tests/deepseek.test.js
git commit -m "feat: add DeepSeek client with batch translation and error mapping"
```

---

### Task 3: `lib/translator.js` — 缓存、并发队列、重试

**Files:**
- Create: `lib/translator.js`
- Test: `tests/translator.test.js`

**Interfaces:**
- Consumes: `DST_UTILS.LruCache`、`DST_UTILS.buildBatches`
- Produces（全局 `DST_TRANSLATOR`）:
  - `createTranslator({ getConfig: () => Promise<cfg>, translateBatch: (cfg, texts, targetLang) => Promise<string[]>, cacheSize = 2000, retryDelay = 1000 }) => { translate(texts: string[], targetLang: string): Promise<string[]> }`
  - 并发上限读取 `cfg.maxConcurrency`（缺省 3）

- [ ] **Step 1: 写失败测试 `tests/translator.test.js`**

```js
const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslator } = require('../lib/translator.js')

const retryable = (msg) => Object.assign(new Error(msg), { retryable: true })
const fatal = (msg) => Object.assign(new Error(msg), { retryable: false })

test('translate caches results per target language', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({ maxConcurrency: 3 }),
    translateBatch: async (cfg, texts, lang) => {
      calls++
      return texts.map((x) => `${lang}:${x}`)
    },
  })
  assert.deepEqual(await t.translate(['a', 'b'], 'zh-CN'), ['zh-CN:a', 'zh-CN:b'])
  assert.deepEqual(await t.translate(['b', 'a'], 'zh-CN'), ['zh-CN:b', 'zh-CN:a'])
  assert.equal(calls, 1)
  assert.deepEqual(await t.translate(['a'], 'ja'), ['ja:a'])
  assert.equal(calls, 2)
})

test('translate only requests cache misses', async () => {
  const seen = []
  const t = createTranslator({
    getConfig: async () => ({}),
    translateBatch: async (cfg, texts) => {
      seen.push(texts)
      return texts.map((x) => x.toUpperCase())
    },
  })
  await t.translate(['a'], 'en')
  assert.deepEqual(await t.translate(['a', 'b'], 'en'), ['A', 'B'])
  assert.deepEqual(seen, [['a'], ['b']])
})

test('retries once on retryable error', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({}),
    retryDelay: 1,
    translateBatch: async (cfg, texts) => {
      if (++calls === 1) throw retryable('busy')
      return texts
    },
  })
  assert.deepEqual(await t.translate(['x'], 'en'), ['x'])
  assert.equal(calls, 2)
})

test('does not retry fatal errors and does not cache failures', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({}),
    retryDelay: 1,
    translateBatch: async () => {
      calls++
      throw fatal('API Key 无效')
    },
  })
  await assert.rejects(t.translate(['x'], 'en'), { message: 'API Key 无效' })
  assert.equal(calls, 1)
  await assert.rejects(t.translate(['x'], 'en'))
  assert.equal(calls, 2)
})

test('gives up after one retry', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({}),
    retryDelay: 1,
    translateBatch: async () => {
      calls++
      throw retryable('timeout')
    },
  })
  await assert.rejects(t.translate(['x'], 'en'), { message: 'timeout' })
  assert.equal(calls, 2)
})

test('respects maxConcurrency across batches and calls', async () => {
  let active = 0
  let peak = 0
  const t = createTranslator({
    getConfig: async () => ({ maxConcurrency: 2 }),
    translateBatch: async (cfg, texts) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return texts
    },
  })
  // 每段 1500 字符 → 每段一个批次
  const big = (c) => c.repeat(1500)
  await Promise.all([t.translate([big('a'), big('b'), big('c')], 'en'), t.translate([big('d'), big('e')], 'en')])
  assert.equal(peak, 2)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd D:/AI/deepseek-translate && npm test`
Expected: FAIL，`Cannot find module '../lib/translator.js'`

- [ ] **Step 3: 实现 `lib/translator.js`**

```js
;(function (root) {
  const utils = root.DST_UTILS || require('./utils.js')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function createTranslator({ getConfig, translateBatch, cacheSize = 2000, retryDelay = 1000 }) {
    const cache = new utils.LruCache(cacheSize)
    let active = 0
    const waiting = []

    async function acquire(limit) {
      if (active < limit) {
        active++
        return
      }
      await new Promise((resolve) => waiting.push(resolve))
    }

    function release() {
      const next = waiting.shift()
      // 直接把名额交给下一个等待者，active 不变
      if (next) next()
      else active--
    }

    async function withRetry(fn) {
      try {
        return await fn()
      } catch (e) {
        if (!e || !e.retryable) throw e
        await sleep(retryDelay)
        return fn()
      }
    }

    async function translate(texts, targetLang) {
      const cfg = await getConfig()
      const keyOf = (t) => targetLang + '\u0000' + t
      const results = texts.map((t) => cache.get(keyOf(t)))
      const missIdx = []
      results.forEach((r, i) => {
        if (r === undefined) missIdx.push(i)
      })
      if (!missIdx.length) return results

      const missTexts = missIdx.map((i) => texts[i])
      await Promise.all(
        utils.buildBatches(missTexts).map(async (batch) => {
          await acquire(cfg.maxConcurrency || 3)
          try {
            const out = await withRetry(() => translateBatch(cfg, batch.map((j) => missTexts[j]), targetLang))
            batch.forEach((j, k) => {
              results[missIdx[j]] = out[k]
              cache.set(keyOf(missTexts[j]), out[k])
            })
          } finally {
            release()
          }
        }),
      )
      return results
    }

    return { translate }
  }

  const api = { createTranslator }
  root.DST_TRANSLATOR = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(globalThis)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd D:/AI/deepseek-translate && npm test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add lib/translator.js tests/translator.test.js
git commit -m "feat: add translator queue with LRU cache, concurrency limit and retry"
```

---

### Task 4: 扩展外壳 — manifest、图标、storage、background、content 公共层、设置页

**Files:**
- Create: `scripts/make-icons.js`、`icons/icon16.png`、`icons/icon32.png`、`icons/icon48.png`、`icons/icon128.png`（脚本生成）
- Create: `manifest.json`
- Create: `lib/storage.js`
- Create: `background.js`
- Create: `content/common.js`、`content/content.css`
- Create: `content/page.js`、`content/selection.js`、`content/input.js`（本任务先放空壳 `;(() => {})()`，让 manifest 可加载）
- Create: `options/options.html`、`options/options.js`、`options/options.css`

**Interfaces:**
- Consumes: `DST_UTILS`、`DST_DEEPSEEK.translateOne/translateBatch`、`DST_TRANSLATOR.createTranslator`
- Produces:
  - 全局 `DST_STORAGE = { DEFAULTS, getConfig(): Promise<cfg>, setConfig(patch): Promise<void> }`
  - background 消息：`{type:'translate', texts, targetLang}` → `{ok:true, results}` | `{ok:false, error, code}`；`{type:'testConnection', apiKey, baseUrl, model}` → `{ok}` | `{ok:false, error}`；`{type:'forwardToTab', tabId, payload}` → `{ok:true, result}`
  - background → tab 消息：`{type:'togglePage'}`、`{type:'translateSelection', text}`
  - `window.__DST__ = { utils, storage, config, host, ready: Promise<cfg>, siteRule(): 'always'|'never'|null, send(msg), translate(texts, targetLang): Promise<string[]>, toast(text) }`

- [ ] **Step 1: 图标生成脚本 `scripts/make-icons.js` 并生成图标**

```js
// 生成纯色圆角方块 + 三条横线的扩展图标，无第三方依赖
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function png(size, pixel) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size)
      const o = y * stride + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function inRoundRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r)
  const cy = Math.min(Math.max(y, r), s - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function pixel(x, y, s) {
  if (!inRoundRect(x, y, s, s * 0.22)) return [0, 0, 0, 0]
  const u = x / s
  const v = y / s
  const bar = (y0, y1, x1) => v >= y0 && v <= y1 && u >= 0.22 && u <= x1
  if (bar(0.26, 0.38, 0.78)) return [255, 255, 255, 255]
  if (bar(0.46, 0.58, 0.62)) return [255, 255, 255, 255]
  if (bar(0.66, 0.76, 0.7)) return [199, 210, 255, 255]
  return [77, 107, 254, 255]
}

const dir = path.join(__dirname, '..', 'icons')
fs.mkdirSync(dir, { recursive: true })
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `icon${s}.png`), png(s, pixel))
console.log('icons written to', dir)
```

Run: `cd D:/AI/deepseek-translate && npm run icons`
Expected: `icons written to ...`，`icons/` 下出现 4 个 png；用 Read 工具打开 `icons/icon128.png` 目测为蓝色圆角方块 + 白色横线。

- [ ] **Step 2: `manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "DeepSeek 双语翻译",
  "version": "0.1.0",
  "description": "使用你自己的 DeepSeek API Key，进行网页双语对照翻译、划词翻译和输入框翻译。",
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": {
    "default_title": "DeepSeek 双语翻译",
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png"
    }
  },
  "options_ui": {
    "page": "options/options.html",
    "open_in_tab": true
  },
  "background": {
    "service_worker": "background.js"
  },
  "permissions": ["storage", "activeTab", "scripting", "contextMenus"],
  "host_permissions": ["<all_urls>"],
  "commands": {
    "toggle-page": {
      "suggested_key": { "default": "Alt+A" },
      "description": "翻译本页 / 显示原文"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": [
        "lib/utils.js",
        "lib/storage.js",
        "content/common.js",
        "content/page.js",
        "content/selection.js",
        "content/input.js"
      ],
      "css": ["content/content.css"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ]
}
```

（popup 文件在 Task 8 创建；在此之前点图标会显示空白弹窗，属预期。）

- [ ] **Step 3: `lib/storage.js`**

```js
;(function (root) {
  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    targetLang: 'zh-CN',
    inputTargetLang: 'en',
    alwaysSites: [],
    neverSites: [],
    enableSelection: true,
    enableInput: true,
    maxConcurrency: 3,
  }

  function getConfig() {
    return chrome.storage.local.get(DEFAULTS)
  }

  function setConfig(patch) {
    return chrome.storage.local.set(patch)
  }

  root.DST_STORAGE = { DEFAULTS, getConfig, setConfig }
})(globalThis)
```

- [ ] **Step 4: `background.js`**

```js
importScripts('lib/utils.js', 'lib/storage.js', 'lib/deepseek.js', 'lib/translator.js')

const MENU_ID = 'dst-translate-selection'
const { js: CONTENT_JS, css: CONTENT_CSS } = chrome.runtime.getManifest().content_scripts[0]

const translator = DST_TRANSLATOR.createTranslator({
  getConfig: DST_STORAGE.getConfig,
  translateBatch: (cfg, texts, targetLang) => DST_DEEPSEEK.translateBatch(cfg, texts, targetLang),
})

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'DeepSeek 翻译选中内容', contexts: ['selection'] })
  })
  if (details.reason === 'install') chrome.runtime.openOptionsPage()
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab && tab.id != null) {
    sendToTab(tab.id, { type: 'translateSelection', text: info.selectionText || '' })
  }
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-page') return
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (target && target.id != null) sendToTab(target.id, { type: 'togglePage' })
})

// 发消息到页面；页面还没有 content script（扩展安装前打开的标签页）时先补注入
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg)
  } catch {
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS })
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS })
      return await chrome.tabs.sendMessage(tabId, msg)
    } catch {
      // chrome:// 、应用商店等受限页面无法注入
      return undefined
    }
  }
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'translate':
      return { ok: true, results: await translator.translate(msg.texts, msg.targetLang) }
    case 'testConnection':
      await DST_DEEPSEEK.translateOne(
        { apiKey: msg.apiKey, baseUrl: msg.baseUrl, model: msg.model },
        'Hello',
        'zh-CN',
      )
      return { ok: true }
    case 'forwardToTab':
      return { ok: true, result: await sendToTab(msg.tabId, msg.payload) }
    default:
      return { ok: false, error: '未知消息类型' }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: (e && e.message) || String(e), code: e && e.code }),
  )
  return true
})
```

- [ ] **Step 5: `content/common.js` + `content/content.css` + 三个空壳**

`content/common.js`:
```js
;(() => {
  const D = (window.__DST__ = {})
  D.utils = window.DST_UTILS
  D.storage = window.DST_STORAGE
  D.config = null
  D.host = location.hostname
  D.ready = D.storage.getConfig().then((cfg) => (D.config = cfg))

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !D.config) return
    for (const key of Object.keys(changes)) D.config[key] = changes[key].newValue
  })

  D.siteRule = () => D.utils.getSiteRule(D.host, D.config)

  const INVALIDATED = '扩展已更新，请刷新页面'

  D.send = async (msg) => {
    if (!chrome.runtime || !chrome.runtime.id) throw new Error(INVALIDATED)
    let res
    try {
      res = await chrome.runtime.sendMessage(msg)
    } catch (e) {
      throw new Error(/context invalidated/i.test(e && e.message) ? INVALIDATED : e.message)
    }
    if (!res || !res.ok) {
      const err = new Error((res && res.error) || '未知错误')
      err.code = res && res.code
      throw err
    }
    return res
  }

  D.translate = async (texts, targetLang) => (await D.send({ type: 'translate', texts, targetLang })).results

  // 同一提示 5 秒内只显示一次，避免整页失败时刷屏
  let last = { text: '', at: 0 }
  D.toast = (text) => {
    const now = Date.now()
    if (text === last.text && now - last.at < 5000) return
    last = { text, at: now }
    const el = document.createElement('div')
    el.className = 'dst-toast'
    el.textContent = text
    document.documentElement.appendChild(el)
    setTimeout(() => el.remove(), 3000)
  }
})()
```

`content/content.css`:
```css
.dst-translation {
  font: inherit;
  color: inherit;
}

.dst-translation .dst-text {
  white-space: pre-line;
  opacity: 0.85;
}

.dst-translation.dst-block .dst-text {
  display: inline-block;
  margin-top: 0.25em;
  padding-left: 0.5em;
  border-left: 2px solid rgba(77, 107, 254, 0.55);
}

.dst-translation.dst-inline {
  margin-left: 0.4em;
}

html.dst-hide .dst-translation {
  display: none !important;
}

.dst-spinner {
  display: inline-block;
  width: 0.8em;
  height: 0.8em;
  margin-left: 0.3em;
  vertical-align: middle;
  border: 2px solid rgba(77, 107, 254, 0.25);
  border-top-color: #4d6bfe;
  border-radius: 50%;
  animation: dst-spin 0.8s linear infinite;
}

@keyframes dst-spin {
  to {
    transform: rotate(360deg);
  }
}

.dst-retry {
  margin-left: 0.3em;
  color: #e5484d;
  font-size: 0.85em;
  cursor: pointer;
}

.dst-toast {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  max-width: 360px;
  padding: 10px 14px;
  color: #fff;
  font: 13px/1.5 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  background: #1f2329;
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
}

.dst-input-loading {
  opacity: 0.6 !important;
  cursor: progress !important;
}
```

`content/page.js`、`content/selection.js`、`content/input.js` 暂时都写成：
```js
;(() => {})()
```

- [ ] **Step 6: 设置页 `options/`**

`options/options.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>DeepSeek 双语翻译 - 设置</title>
    <link rel="stylesheet" href="options.css" />
  </head>
  <body>
    <main>
      <h1>
        <img src="../icons/icon48.png" alt="" />
        DeepSeek 双语翻译
        <span id="saved" class="saved" hidden>已保存</span>
      </h1>

      <section>
        <h2>API 设置</h2>
        <label>
          API Key
          <span class="row">
            <input id="apiKey" type="password" placeholder="sk-..." autocomplete="off" spellcheck="false" />
            <button id="toggleKey" type="button">显示</button>
          </span>
          <small>
            在
            <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com</a>
            创建。Key 仅保存在本机浏览器中，只发送给下方的 Base URL。
          </small>
        </label>
        <label>
          Base URL
          <input id="baseUrl" type="text" placeholder="https://api.deepseek.com" spellcheck="false" />
        </label>
        <label>
          模型
          <input id="model" type="text" list="models" spellcheck="false" />
          <datalist id="models">
            <option value="deepseek-chat"></option>
            <option value="deepseek-reasoner"></option>
          </datalist>
        </label>
        <div class="row">
          <button id="test" type="button" class="primary">测试连接</button>
          <span id="testResult"></span>
        </div>
      </section>

      <section>
        <h2>翻译偏好</h2>
        <label>网页 / 划词目标语言<select id="targetLang"></select></label>
        <label>输入框翻译目标语言<select id="inputTargetLang"></select></label>
        <label class="check"><input id="enableSelection" type="checkbox" />启用划词翻译</label>
        <label class="check">
          <input id="enableInput" type="checkbox" />启用输入框翻译（在输入框中 500ms 内连按三次空格）
        </label>
        <label>最大并发请求数<input id="maxConcurrency" type="number" min="1" max="10" /></label>
      </section>

      <section>
        <h2>站点规则</h2>
        <p class="hint">每行一个域名，同时匹配其子域名，例如 example.com 也匹配 docs.example.com。</p>
        <label>总是翻译<textarea id="alwaysSites" rows="5" spellcheck="false"></textarea></label>
        <label>永不翻译<textarea id="neverSites" rows="5" spellcheck="false"></textarea></label>
      </section>

      <section>
        <h2>快捷键</h2>
        <p>翻译本页 / 显示原文：<kbd id="shortcut">Alt+A</kbd></p>
        <button id="shortcuts" type="button">修改快捷键</button>
      </section>
    </main>
    <script src="../lib/utils.js"></script>
    <script src="../lib/storage.js"></script>
    <script src="options.js"></script>
  </body>
</html>
```

`options/options.js`:
```js
const $ = (id) => document.getElementById(id)
const { DEFAULTS } = DST_STORAGE

const FIELDS = {
  apiKey: 'text',
  baseUrl: 'text',
  model: 'text',
  targetLang: 'text',
  inputTargetLang: 'text',
  enableSelection: 'bool',
  enableInput: 'bool',
  maxConcurrency: 'int',
  alwaysSites: 'sites',
  neverSites: 'sites',
}

function readField(key) {
  const el = $(key)
  const kind = FIELDS[key]
  if (kind === 'bool') return el.checked
  if (kind === 'int') return Math.min(10, Math.max(1, parseInt(el.value, 10) || DEFAULTS[key]))
  if (kind === 'sites') return DST_UTILS.parseSiteList(el.value)
  return el.value.trim() || DEFAULTS[key]
}

function writeField(key, value) {
  const el = $(key)
  const kind = FIELDS[key]
  if (kind === 'bool') el.checked = value
  else if (kind === 'sites') el.value = value.join('\n')
  else el.value = value
}

function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

let savedTimer
async function save(key) {
  await DST_STORAGE.setConfig({ [key]: readField(key) })
  $('saved').hidden = false
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => ($('saved').hidden = true), 1500)
}

async function testConnection() {
  const result = $('testResult')
  result.className = ''
  result.textContent = '测试中…'
  $('test').disabled = true
  const res = await chrome.runtime.sendMessage({
    type: 'testConnection',
    apiKey: readField('apiKey'),
    baseUrl: readField('baseUrl'),
    model: readField('model'),
  })
  $('test').disabled = false
  result.className = res && res.ok ? 'ok' : 'err'
  result.textContent = res && res.ok ? '连接成功' : '连接失败：' + ((res && res.error) || '未知错误')
}

;(async () => {
  for (const id of ['targetLang', 'inputTargetLang']) {
    for (const lang of DST_UTILS.LANGS) $(id).add(new Option(lang.name, lang.code))
  }
  const cfg = await DST_STORAGE.getConfig()
  for (const key of Object.keys(FIELDS)) {
    writeField(key, cfg[key])
    $(key).addEventListener('input', debounce(() => save(key), 400))
    $(key).addEventListener('change', () => save(key))
  }

  $('toggleKey').addEventListener('click', () => {
    const show = $('apiKey').type === 'password'
    $('apiKey').type = show ? 'text' : 'password'
    $('toggleKey').textContent = show ? '隐藏' : '显示'
  })
  $('test').addEventListener('click', testConnection)
  $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))

  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-page')
  $('shortcut').textContent = (cmd && cmd.shortcut) || '未设置'
})()
```

`options/options.css`:
```css
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  color: #1f2329;
  font: 14px/1.6 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  background: #f5f6f8;
}

main {
  max-width: 720px;
  margin: 32px auto;
  padding: 0 16px;
}

h1 {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 22px;
}

h1 img {
  width: 32px;
  height: 32px;
}

h2 {
  margin: 0 0 12px;
  font-size: 16px;
}

section {
  margin-bottom: 16px;
  padding: 20px;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}

label {
  display: block;
  margin-bottom: 14px;
  font-weight: 500;
}

label.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 400;
}

input[type='text'],
input[type='password'],
input[type='number'],
select,
textarea {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 7px 10px;
  font: inherit;
  border: 1px solid #d0d3d9;
  border-radius: 6px;
  outline: none;
}

input:focus,
select:focus,
textarea:focus {
  border-color: #4d6bfe;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row input {
  flex: 1;
}

small,
.hint {
  display: block;
  margin-top: 4px;
  color: #86909c;
  font-size: 12px;
  font-weight: 400;
}

button {
  padding: 6px 14px;
  font: inherit;
  white-space: nowrap;
  background: #fff;
  border: 1px solid #d0d3d9;
  border-radius: 6px;
  cursor: pointer;
}

button.primary {
  color: #fff;
  background: #4d6bfe;
  border-color: #4d6bfe;
}

button:disabled {
  opacity: 0.6;
  cursor: default;
}

.row input,
.row button {
  margin-top: 6px;
}

.saved {
  margin-left: auto;
  color: #00a870;
  font-size: 13px;
  font-weight: 400;
}

.ok {
  color: #00a870;
}

.err {
  color: #e5484d;
}

kbd {
  padding: 1px 6px;
  background: #f0f1f5;
  border: 1px solid #d0d3d9;
  border-radius: 4px;
}
```

- [ ] **Step 7: 在 Chrome 中手工验证**

1. `chrome://extensions` → 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `D:/AI/deepseek-translate`。
   Expected: 无报错；首次安装自动打开设置页。
2. 点「Service Worker」链接打开 background DevTools，Console 无报错。
3. 设置页填错误 Key `sk-wrong` →「测试连接」 Expected:「连接失败：API Key 无效」。
4. 填正确 Key →「测试连接」 Expected:「连接成功」；刷新设置页后 Key 与其他字段保持。
5. 修改任意字段 → 右上角闪现「已保存」。
（Review Focus #1「扩展重载后旧标签页」依赖划词 UI，在 Task 6 Step 2 第 6 条验证。）

- [ ] **Step 8: 运行单测确认未回退并 Commit**

Run: `cd D:/AI/deepseek-translate && npm test` → 全部 PASS

```bash
git add manifest.json scripts icons lib/storage.js background.js content options
git commit -m "feat: add extension shell, background service worker and options page"
```

---

### Task 5: 整页双语对照 `content/page.js`

**Files:**
- Modify: `content/page.js`（替换 Task 4 的空壳）

**Interfaces:**
- Consumes: `window.__DST__`（`utils`、`config`、`ready`、`siteRule`、`translate`、`toast`）
- Produces: 响应 tab 消息 `{type:'togglePage'}` → `{active, hidden}`、`{type:'getPageState'}` → `{active, hidden}`；`<html>` 上的 `dst-hide` class 表示隐藏译文。

- [ ] **Step 1: 实现 `content/page.js`**

```js
;(() => {
  const D = window.__DST__
  const { utils } = D

  const SKIP =
    'script,style,noscript,template,code,pre,kbd,samp,var,textarea,input,select,option,button,svg,canvas,math,' +
    'iframe,video,audio,[contenteditable="true"],[contenteditable=""],[translate="no"],.notranslate,' +
    '.dst-translation,.dst-root'
  const BLOCKISH =
    'address,article,aside,blockquote,dd,details,dialog,div,dl,dt,fieldset,figcaption,figure,footer,form,' +
    'h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,summary,table,tbody,td,tfoot,th,thead,tr,ul'
  const BLOCK_TAGS = /^(P|LI|BLOCKQUOTE|TD|DD|FIGCAPTION)$/

  const textOf = new WeakMap()
  const wrapperOf = new WeakMap()
  const waiting = new Set()
  const queue = new Set()
  const dirty = new Set()
  let observer = null
  let active = false
  let flushTimer = null
  let scanTimer = null

  const isHidden = () => document.documentElement.classList.contains('dst-hide')
  const normalize = (s) =>
    String(s || '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim()

  // 只翻译「叶子块」：内部不再包含块级元素的元素
  function visit(el) {
    if (el.matches(SKIP) || el.hasAttribute('data-dst')) return
    if (el.querySelector(BLOCKISH)) {
      for (const child of el.children) visit(child)
      return
    }
    consider(el)
  }

  function consider(el) {
    if (!el.getClientRects().length) return
    const text = normalize(el.innerText)
    if (!utils.isTranslatable(text) || utils.isTargetLang(text, D.config.targetLang)) return
    el.setAttribute('data-dst', 'wait')
    textOf.set(el, text)
    waiting.add(el)
    observer.observe(el)
  }

  function scan(root) {
    if (!root || !root.isConnected || root.closest('[data-dst],' + SKIP)) return
    visit(root)
  }

  function onMutations(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
        if (el && !el.closest('.dst-translation,.dst-root')) dirty.add(el)
      }
    }
    if (dirty.size && !scanTimer) {
      scanTimer = setTimeout(() => {
        scanTimer = null
        const roots = [...dirty]
        dirty.clear()
        roots.forEach(scan)
      }, 300)
    }
  }

  function onIntersect(entries) {
    if (isHidden()) return
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      waiting.delete(entry.target)
      queue.add(entry.target)
    }
    if (queue.size && !flushTimer) flushTimer = setTimeout(flush, 100)
  }

  function flush() {
    flushTimer = null
    const els = [...queue].filter((el) => el.isConnected)
    queue.clear()
    const texts = els.map((el) => textOf.get(el))
    for (const batch of utils.buildBatches(texts)) translateGroup(batch.map((i) => els[i]))
  }

  function font(cls) {
    const el = document.createElement('font')
    el.className = cls
    return el
  }

  function isInline(el, text) {
    if (getComputedStyle(el).display.startsWith('inline')) return true
    return text.length <= 40 && !text.includes('\n') && !BLOCK_TAGS.test(el.tagName)
  }

  function wrapperFor(el) {
    let w = wrapperOf.get(el)
    if (!w || !w.isConnected) {
      w = font('dst-translation ' + (isInline(el, textOf.get(el)) ? 'dst-inline' : 'dst-block'))
      w.setAttribute('translate', 'no')
      w.setAttribute('lang', D.config.targetLang)
      el.appendChild(w)
      wrapperOf.set(el, w)
    }
    return w
  }

  function setResult(w, text) {
    const nodes = []
    if (w.classList.contains('dst-block')) nodes.push(document.createElement('br'))
    const t = font('dst-text')
    t.textContent = text
    nodes.push(t)
    w.replaceChildren(...nodes)
  }

  function setError(w, el) {
    const retry = font('dst-retry')
    retry.textContent = '⚠ 重试'
    retry.title = '翻译失败，点击重试'
    retry.addEventListener('click', (e) => {
      // 段落可能在 <a> 内，阻止跳转
      e.preventDefault()
      e.stopPropagation()
      translateGroup([el])
    })
    w.replaceChildren(retry)
  }

  async function translateGroup(els) {
    const wrappers = els.map((el) => {
      el.setAttribute('data-dst', 'loading')
      const w = wrapperFor(el)
      w.replaceChildren(font('dst-spinner'))
      return w
    })
    try {
      const results = await D.translate(
        els.map((el) => textOf.get(el)),
        D.config.targetLang,
      )
      els.forEach((el, i) => {
        const r = normalize(results[i])
        if (!r || r === textOf.get(el)) {
          wrappers[i].remove()
          wrapperOf.delete(el)
        } else {
          setResult(wrappers[i], r)
        }
        el.setAttribute('data-dst', 'done')
      })
    } catch (e) {
      els.forEach((el, i) => {
        el.setAttribute('data-dst', 'error')
        setError(wrappers[i], el)
      })
      D.toast(e.message)
    }
  }

  function start() {
    active = true
    observer = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' })
    new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true })
    scan(document.body)
  }

  function setHidden(hidden) {
    document.documentElement.classList.toggle('dst-hide', hidden)
    // 重新显示时，让视口内仍待翻译的段落重新触发 IntersectionObserver
    if (!hidden) {
      for (const el of waiting) {
        observer.unobserve(el)
        observer.observe(el)
      }
    }
  }

  function toggle() {
    if (!D.config.apiKey) {
      D.toast('请先在设置页配置 DeepSeek API Key')
      return
    }
    if (!active) start()
    else setHidden(!isHidden())
  }

  const pageState = () => ({ active, hidden: isHidden() })

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getPageState') {
      sendResponse(pageState())
      return
    }
    if (msg.type === 'togglePage') {
      D.ready.then(() => {
        toggle()
        sendResponse(pageState())
      })
      return true
    }
  })

  D.ready.then(() => {
    if (D.config.apiKey && D.siteRule() === 'always') start()
  })
})()
```

- [ ] **Step 2: 重新加载扩展，基本流程验证**

`chrome://extensions` 点扩展卡片上的刷新按钮，打开 `https://en.wikipedia.org/wiki/Electric_vehicle`，按 `Alt+A`。
Expected: 视口内段落、标题、列表项下方/后方出现中文译文（加载中有旋转圈）；导航中已是中文的文字（如有）不翻译；代码块不翻译。

- [ ] **Step 3: 切换验证**

再按 `Alt+A` → 所有译文隐藏；再按 → 恢复，且隐藏期间滚到的新段落此时开始翻译。

- [ ] **Step 4: Review Focus #3 — 动态内容**

打开 `https://developer.mozilla.org/en-US/docs/Web/JavaScript` 按 `Alt+A` 后持续向下滚动；再打开一个无限滚动页面（如 `https://news.ycombinator.com/` 翻页或 `https://www.reddit.com/r/programming/`）滚动加载新内容。
Expected: 新进入视口的内容被翻译；已翻译段落不出现第二份译文（DevTools 中 `document.querySelectorAll('[data-dst] > .dst-translation').length` 与 `document.querySelectorAll('[data-dst="done"]').length` 大致相当）。

- [ ] **Step 5: Review Focus #4/#5 — 失败、重试、toast 去重**

在设置页把 Key 改成 `sk-wrong`，回到一个未翻译的英文页面按 `Alt+A`。
Expected: 段落显示「⚠ 重试」；右下角只出现一次「API Key 无效」toast（5 秒内不重复）；在链接文字（如 Wikipedia 正文中的导航链接项）上点击「⚠ 重试」不发生跳转。改回正确 Key 后点「⚠ 重试」→ 出现译文。

- [ ] **Step 6: Commit**

```bash
git add content/page.js
git commit -m "feat: add full-page bilingual translation"
```

---

### Task 6: 划词翻译 `content/selection.js`

**Files:**
- Modify: `content/selection.js`（替换空壳）

**Interfaces:**
- Consumes: `window.__DST__`（`config.enableSelection`、`config.targetLang`、`ready`、`siteRule`、`translate`、`utils.isTranslatable`）
- Produces: 响应 tab 消息 `{type:'translateSelection', text}`；页面中的 Shadow DOM 宿主 `div.dst-root`

- [ ] **Step 1: 实现 `content/selection.js`**

```js
;(() => {
  const D = window.__DST__

  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .icon {
      position: fixed; width: 24px; height: 24px; border-radius: 6px;
      background: #4d6bfe; color: #fff; font: 600 13px/24px system-ui, sans-serif;
      text-align: center; cursor: pointer; user-select: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
    }
    .panel {
      position: fixed; width: 360px; max-height: 360px; overflow: auto;
      background: #fff; color: #1f2329; border: 1px solid #e5e6eb; border-radius: 10px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, .18);
      font: 14px/1.6 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
    }
    .head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 12px; border-bottom: 1px solid #f0f1f5;
      color: #4d6bfe; font-size: 12px; font-weight: 600;
    }
    .close { border: 0; background: none; color: #86909c; font-size: 18px; line-height: 1; cursor: pointer; }
    .src { padding: 8px 12px 0; color: #86909c; font-size: 12px; white-space: pre-wrap; word-break: break-word; }
    .dst { padding: 8px 12px; white-space: pre-wrap; word-break: break-word; }
    .dst.loading { color: #86909c; }
    .dst.error { color: #e5484d; }
    .foot { padding: 0 12px 10px; text-align: right; }
    .copy {
      padding: 2px 10px; font-size: 12px; cursor: pointer;
      background: #fff; border: 1px solid #d0d3d9; border-radius: 6px;
    }
  `

  let host = null
  let shadow = null
  let icon = null
  let panel = null
  let lastText = ''
  let lastRect = null
  let seq = 0

  function ensureHost() {
    if (host && host.isConnected) return
    host = document.createElement('div')
    host.className = 'dst-root'
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;'
    shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="icon" title="DeepSeek 翻译" hidden>译</div>
      <div class="panel" hidden>
        <div class="head"><span>DeepSeek 翻译</span><button class="close" title="关闭">×</button></div>
        <div class="src"></div>
        <div class="dst"></div>
        <div class="foot"><button class="copy">复制译文</button></div>
      </div>`
    document.documentElement.appendChild(host)
    icon = shadow.querySelector('.icon')
    panel = shadow.querySelector('.panel')
    // 阻止 mousedown 默认行为，避免点击图标时选区被清除
    icon.addEventListener('mousedown', (e) => e.preventDefault())
    icon.addEventListener('click', () => openPanel(lastText, lastRect))
    shadow.querySelector('.close').addEventListener('click', hideAll)
    const copy = shadow.querySelector('.copy')
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(shadow.querySelector('.dst').textContent)
      copy.textContent = '已复制'
      setTimeout(() => (copy.textContent = '复制译文'), 1200)
    })
  }

  function hideAll() {
    if (!host) return
    icon.hidden = true
    panel.hidden = true
    seq++
  }

  const inHost = (e) => host && e.composedPath().includes(host)

  function isEditable(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
  }

  function showIcon(rect) {
    ensureHost()
    panel.hidden = true
    icon.style.left = Math.min(rect.right + 4, innerWidth - 28) + 'px'
    icon.style.top = Math.min(rect.bottom + 4, innerHeight - 28) + 'px'
    icon.hidden = false
  }

  function placePanel(rect) {
    panel.style.left = Math.max(8, Math.min(rect.left, innerWidth - 368)) + 'px'
    if (innerHeight - rect.bottom > 260) {
      panel.style.top = rect.bottom + 8 + 'px'
      panel.style.bottom = 'auto'
    } else {
      panel.style.top = 'auto'
      panel.style.bottom = Math.max(8, innerHeight - rect.top + 8) + 'px'
    }
  }

  async function openPanel(text, rect) {
    ensureHost()
    icon.hidden = true
    placePanel(rect)
    panel.hidden = false
    shadow.querySelector('.src').textContent = text.length > 200 ? text.slice(0, 200) + '…' : text
    const dst = shadow.querySelector('.dst')
    dst.className = 'dst loading'
    dst.textContent = '翻译中…'
    const token = ++seq
    try {
      const [result] = await D.translate([text], D.config.targetLang)
      if (token !== seq) return
      dst.className = 'dst'
      dst.textContent = result
    } catch (e) {
      if (token !== seq) return
      dst.className = 'dst error'
      dst.textContent = e.message
    }
  }

  function selectionRect(sel) {
    const range = sel.getRangeAt(0)
    const rects = range.getClientRects()
    return rects.length ? rects[rects.length - 1] : range.getBoundingClientRect()
  }

  function onSelect() {
    if (!D.config || !D.config.enableSelection || D.siteRule() === 'never') return
    if (isEditable(document.activeElement)) return
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ''
    if (!text || text.length > 2000 || !D.utils.isTranslatable(text) || !sel.rangeCount) return
    lastText = text
    lastRect = selectionRect(sel)
    showIcon(lastRect)
  }

  document.addEventListener(
    'mouseup',
    (e) => {
      if (e.button !== 0 || inHost(e)) return
      // 选区在 mouseup 之后才更新
      setTimeout(onSelect, 0)
    },
    true,
  )
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!inHost(e)) hideAll()
    },
    true,
  )
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') hideAll()
    },
    true,
  )
  window.addEventListener('scroll', hideAll, { capture: true, passive: true })

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type !== 'translateSelection') return
    const sel = window.getSelection()
    const text = (msg.text || (sel ? sel.toString() : '')).trim()
    if (!text) return
    const rect =
      sel && sel.rangeCount
        ? selectionRect(sel)
        : { left: innerWidth / 2 - 180, right: innerWidth / 2 + 180, top: 80, bottom: 80 }
    D.ready.then(() => openPanel(text, rect))
  })
})()
```

- [ ] **Step 2: 重新加载扩展并验证**

在 Wikipedia 英文页刷新后：
1. 选中一句英文 → 选区右下角出现蓝色「译」图标 → 点击 → 浮窗显示原文摘要与中文译文；「复制译文」后粘贴可得到译文。
2. 点击页面其他位置 / 按 Esc / 滚动 → 浮窗关闭。
3. 选中文字右键 →「DeepSeek 翻译选中内容」→ 浮窗出现。
4. 设置页关闭「启用划词翻译」→ 选中文字不再出现图标；右键菜单仍可用。
5. 在 textarea 中选中文字 → 不出现图标。
6. **Review Focus #1**：打开页面后在 `chrome://extensions` 重新加载扩展，回到该页划词点击图标 → 浮窗显示「扩展已更新，请刷新页面」。

- [ ] **Step 3: Commit**

```bash
git add content/selection.js
git commit -m "feat: add selection translation popup and context menu"
```

---

### Task 7: 输入框翻译 `content/input.js`

**Files:**
- Modify: `content/input.js`（替换空壳）

**Interfaces:**
- Consumes: `window.__DST__`（`config.enableInput`、`config.inputTargetLang`、`siteRule`、`translate`、`toast`）
- Produces: 无（仅监听 keydown）

- [ ] **Step 1: 实现 `content/input.js`**

```js
;(() => {
  const D = window.__DST__
  const busy = new WeakSet()
  let presses = []

  function editableOf(target) {
    if (!(target instanceof Element)) return null
    if (target.tagName === 'TEXTAREA') return target
    if (target.tagName === 'INPUT') return ['text', 'search'].includes(target.type) ? target : null
    if (target.isContentEditable) {
      let el = target
      while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement
      return el
    }
    return null
  }

  // 优先 execCommand（保留撤销栈且框架能感知）；失败时用原生 setter + input 事件兼容 React/Vue 受控组件
  function setValue(el, value) {
    el.focus()
    if (el.isContentEditable) {
      const sel = window.getSelection()
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
      if (!document.execCommand('insertText', false, value)) el.innerText = value
      return
    }
    el.select()
    if (document.execCommand('insertText', false, value) && el.value === value) return
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  async function translateField(el) {
    if (busy.has(el)) return
    const original = el.isContentEditable ? el.innerText : el.value
    // 去掉前两次空格按键输入的空格
    const text = original.replace(/ {1,2}$/, '').trim()
    if (!text) return
    busy.add(el)
    el.classList.add('dst-input-loading')
    try {
      const [result] = await D.translate([text], D.config.inputTargetLang)
      setValue(el, result)
    } catch (e) {
      D.toast(e.message)
    } finally {
      busy.delete(el)
      el.classList.remove('dst-input-loading')
    }
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== ' ' || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
        presses = []
        return
      }
      const el = editableOf(e.target)
      if (!el || !D.config || !D.config.enableInput || D.siteRule() === 'never') return
      const now = Date.now()
      presses = presses.filter((t) => now - t < 500)
      presses.push(now)
      if (presses.length >= 3) {
        presses = []
        e.preventDefault()
        translateField(el)
      }
    },
    true,
  )
})()
```

- [ ] **Step 2: 重新加载扩展，基础验证**

在任意含 textarea 的页面（如 `https://www.google.com` 搜索框、或本地新建 `data:text/html,<textarea></textarea>` 不支持注入则改用 `https://example.com` + DevTools 插入 textarea）：
1. 输入「今天天气很好」后快速连按三次空格 → 框变半透明 → 内容替换为英文；`Ctrl+Z` 可撤销回原文。
2. 输入后间隔 >500ms 按空格 → 只是正常输入空格。
3. 在 `<input type="password">` 中连按三次空格 → 不触发。
4. 设置页关闭「启用输入框翻译」→ 不再触发。

- [ ] **Step 3: Review Focus #2 — React 受控输入框**

在 GitHub 任意 issue 评论框（React）中输入中文并三连空格 → 替换为英文 → 点击评论框外再点回 / 切换「Preview」标签。
Expected: Preview 显示的是英文译文（框架状态已更新），而不是原文。

- [ ] **Step 4: Commit**

```bash
git add content/input.js
git commit -m "feat: add triple-space input box translation"
```

---

### Task 8: popup 与站点规则

**Files:**
- Create: `popup/popup.html`、`popup/popup.js`、`popup/popup.css`

**Interfaces:**
- Consumes: `DST_UTILS.LANGS/normalizeHost/getSiteRule/setSiteRule`、`DST_STORAGE.getConfig/setConfig`、background `forwardToTab`、tab 消息 `getPageState`/`togglePage`
- Produces: 无

- [ ] **Step 1: `popup/popup.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="popup.css" />
  </head>
  <body>
    <header>
      <img src="../icons/icon32.png" alt="" />
      <span class="title">DeepSeek 双语翻译</span>
      <button id="openOptions" class="link" type="button">设置</button>
    </header>

    <section id="noKey" hidden>
      <p>尚未配置 DeepSeek API Key</p>
      <button id="goOptions" class="primary" type="button">去设置</button>
    </section>

    <section id="main" hidden>
      <button id="toggle" class="primary" type="button">翻译本页</button>
      <p id="unsupported" class="hint" hidden>当前页面不支持翻译</p>
      <label>目标语言<select id="targetLang"></select></label>
      <label>
        本站规则 <span id="host" class="host"></span>
        <select id="siteRule">
          <option value="">默认</option>
          <option value="always">总是翻译本站</option>
          <option value="never">永不翻译本站</option>
        </select>
      </label>
      <p class="hint">快捷键：<kbd id="shortcut">Alt+A</kbd></p>
    </section>

    <script src="../lib/utils.js"></script>
    <script src="../lib/storage.js"></script>
    <script src="popup.js"></script>
  </body>
</html>
```

- [ ] **Step 2: `popup/popup.js`**

```js
const $ = (id) => document.getElementById(id)

async function forward(tabId, payload) {
  const res = await chrome.runtime.sendMessage({ type: 'forwardToTab', tabId, payload })
  return res && res.result
}

function renderToggle(state) {
  $('toggle').textContent = !state || !state.active ? '翻译本页' : state.hidden ? '显示译文' : '显示原文'
}

;(async () => {
  const openOptions = () => chrome.runtime.openOptionsPage()
  $('openOptions').addEventListener('click', openOptions)
  $('goOptions').addEventListener('click', openOptions)

  const cfg = await DST_STORAGE.getConfig()
  if (!cfg.apiKey) {
    $('noKey').hidden = false
    return
  }
  $('main').hidden = false

  for (const lang of DST_UTILS.LANGS) $('targetLang').add(new Option(lang.name, lang.code))
  $('targetLang').value = cfg.targetLang
  $('targetLang').addEventListener('change', () => DST_STORAGE.setConfig({ targetLang: $('targetLang').value }))

  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-page')
  $('shortcut').textContent = (cmd && cmd.shortcut) || '未设置'

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = (tab && tab.url) || ''
  if (!/^(https?|file):/.test(url)) {
    $('toggle').disabled = true
    $('siteRule').disabled = true
    $('unsupported').hidden = false
    return
  }

  const host = new URL(url).hostname
  $('host').textContent = DST_UTILS.normalizeHost(host)
  $('siteRule').value = DST_UTILS.getSiteRule(host, cfg) || ''
  $('siteRule').addEventListener('change', async () => {
    const latest = await DST_STORAGE.getConfig()
    await DST_STORAGE.setConfig(DST_UTILS.setSiteRule(latest, host, $('siteRule').value))
  })

  renderToggle(await forward(tab.id, { type: 'getPageState' }))
  $('toggle').addEventListener('click', async () => {
    renderToggle(await forward(tab.id, { type: 'togglePage' }))
  })
})()
```

- [ ] **Step 3: `popup/popup.css`**

```css
* {
  box-sizing: border-box;
}

body {
  width: 300px;
  margin: 0;
  padding: 12px 14px 14px;
  color: #1f2329;
  font: 13px/1.5 system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif;
}

header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

header img {
  width: 20px;
  height: 20px;
}

.title {
  flex: 1;
  font-weight: 600;
}

button {
  font: inherit;
  cursor: pointer;
}

button.link {
  padding: 0;
  color: #4d6bfe;
  background: none;
  border: 0;
}

button.primary {
  width: 100%;
  padding: 8px 0;
  color: #fff;
  font-weight: 600;
  background: #4d6bfe;
  border: 0;
  border-radius: 6px;
}

button.primary:disabled {
  opacity: 0.5;
  cursor: default;
}

label {
  display: block;
  margin-top: 12px;
  color: #4e5969;
}

select {
  display: block;
  width: 100%;
  margin-top: 4px;
  padding: 5px 8px;
  font: inherit;
  border: 1px solid #d0d3d9;
  border-radius: 6px;
}

.host {
  color: #86909c;
}

.hint {
  margin: 10px 0 0;
  color: #86909c;
  font-size: 12px;
}

kbd {
  padding: 0 5px;
  background: #f0f1f5;
  border: 1px solid #d0d3d9;
  border-radius: 4px;
}

#noKey p {
  margin: 0 0 10px;
}
```

- [ ] **Step 4: 重新加载扩展并验证**

1. 清空 Key 后点扩展图标 → 显示「尚未配置 DeepSeek API Key」+「去设置」。
2. 填 Key 后在英文页点图标 →「翻译本页」→ 页面开始翻译，按钮变「显示原文」；再点 →「显示译文」。
3. 在扩展安装前就打开的标签页上点「翻译本页」→ 仍能翻译（background 补注入）。
4. `chrome://extensions` 页点图标 → 按钮禁用并提示「当前页面不支持翻译」。
5. 在 `en.wikipedia.org` 选「总是翻译本站」→ 打开另一个 Wikipedia 条目 → 自动翻译；设置页「总是翻译」中出现 `en.wikipedia.org`。
6. 选「永不翻译本站」→ 刷新 → 不自动翻译、划词无图标、三连空格不触发；popup「翻译本页」仍可手动翻译。
7. 改回「默认」→ 两个列表中都不再有该域名。
8. popup 中切换目标语言为「日本語」→ 在新页面翻译 → 译文为日语。

- [ ] **Step 5: Commit**

```bash
git add popup
git commit -m "feat: add popup with page toggle, target language and site rules"
```

---

### Task 9: 收尾 — README 与整体回归

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 `README.md`**

````markdown
# DeepSeek 双语翻译

使用你自己的 DeepSeek API Key 的 Chrome 翻译扩展：网页双语对照、划词翻译、输入框翻译、站点规则。

## 安装

1. 打开 `chrome://extensions`，开启右上角「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录。
3. 在自动打开的设置页填入 DeepSeek API Key（在 https://platform.deepseek.com/api_keys 创建），点「测试连接」。

## 使用

| 功能 | 操作 |
|---|---|
| 整页双语对照 | 点击扩展图标 →「翻译本页」，或按 `Alt+A`；再次触发切换显示原文 |
| 划词翻译 | 选中文字后点击出现的「译」图标；或右键 →「DeepSeek 翻译选中内容」 |
| 输入框翻译 | 在输入框中 500ms 内连按三次空格，内容替换为设置的目标语言（默认英文） |
| 站点规则 | 扩展弹窗中设置「总是翻译本站 / 永不翻译本站」，或在设置页批量编辑 |

## 隐私

API Key 仅保存在本机 `chrome.storage.local`，翻译请求只由扩展后台直接发往你配置的 Base URL（默认 `https://api.deepseek.com`）。

## 开发

无构建步骤。修改代码后在 `chrome://extensions` 点刷新即可。

```bash
npm test        # 运行 lib/ 单元测试（Node 22+，无依赖）
npm run icons   # 重新生成图标
```
````

- [ ] **Step 2: 整体回归**

Run: `cd D:/AI/deepseek-translate && npm test` → 全部 PASS。
按 spec §11 的 6 条验证步骤在 Chrome 中完整走一遍，全部符合预期。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```
