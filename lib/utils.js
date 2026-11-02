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
    han: /[一-鿿]/g,
    kana: /[぀-ヿ]/g,
    hangul: /[가-힯]/g,
    thai: /[฀-๿]/g,
    cyrillic: /[Ѐ-ӿ]/g,
    latin: /[a-zA-ZÀ-ɏ]/g,
    accented: /[À-ɏ]/g,
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

  // 发给 content script 的配置：去掉 API Key，只告知是否已配置
  function publicConfig(cfg) {
    const { apiKey, ...rest } = cfg
    return { ...rest, hasKey: !!apiKey }
  }

  const api = {
    LANGS,
    publicConfig,
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
