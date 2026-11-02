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
