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
    const message = data && data.choices && data.choices[0] && data.choices[0].message
    const content = message && message.content
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
