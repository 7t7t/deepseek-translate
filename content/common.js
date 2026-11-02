;(() => {
  // 通知同一页面里的旧实例（扩展重载后遗留 / 重复注入）停止工作，DOM 事件可跨 isolated world
  document.dispatchEvent(new CustomEvent('dst:dispose'))

  const D = (window.__DST__ = {})
  const disposers = []
  D.utils = window.DST_UTILS
  D.config = null
  D.host = location.hostname
  D.disposed = false

  D.onDispose = (fn) => disposers.push(fn)
  D.listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options)
    disposers.push(() => target.removeEventListener(type, fn, options))
  }
  D.onMessage = (fn) => {
    chrome.runtime.onMessage.addListener(fn)
    disposers.push(() => chrome.runtime.onMessage.removeListener(fn))
  }

  document.addEventListener(
    'dst:dispose',
    () => {
      D.disposed = true
      for (const fn of disposers.splice(0)) {
        try {
          fn()
        } catch {
          // 扩展上下文失效时移除监听可能抛错，忽略
        }
      }
    },
    { once: true },
  )

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

  // 配置由后台提供（不含 API Key），content script 无法直接读取 storage
  D.ready = D.send({ type: 'getConfig' }).then(
    (res) => (D.config = res.config),
    () => null,
  )
  D.onMessage((msg) => {
    if (msg.type === 'configChanged') D.config = msg.config
  })

  D.siteRule = () => D.utils.getSiteRule(D.host, D.config)

  D.translate = async (texts, targetLang) => (await D.send({ type: 'translate', texts, targetLang })).results

  // 同一提示 5 秒内只显示一次，避免整页失败时刷屏
  let last = { text: '', at: 0 }
  D.toast = (text) => {
    const now = Date.now()
    if (text === last.text && now - last.at < 5000) return
    last = { text, at: now }
    const el = document.createElement('div')
    el.className = 'dst-root dst-toast'
    el.textContent = text
    document.documentElement.appendChild(el)
    setTimeout(() => el.remove(), 3000)
  }
})()
