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
      // 扩展失效时 config 可能未加载，D.translate 会给出「扩展已更新」提示
      const [result] = await D.translate([text], D.config ? D.config.targetLang : 'zh-CN')
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

  D.listen(
    document,
    'mouseup',
    (e) => {
      if (e.button !== 0 || inHost(e)) return
      // 选区在 mouseup 之后才更新
      setTimeout(onSelect, 0)
    },
    true,
  )
  D.listen(
    document,
    'mousedown',
    (e) => {
      if (!inHost(e)) hideAll()
    },
    true,
  )
  D.listen(
    document,
    'keydown',
    (e) => {
      if (e.key === 'Escape') hideAll()
    },
    true,
  )
  D.listen(window, 'scroll', hideAll, { capture: true, passive: true })
  D.onDispose(() => host && host.remove())

  D.onMessage((msg, _sender, sendResponse) => {
    if (msg.type !== 'translateSelection') return
    // 必须应答，否则后台会把「无应答」当作页面没有 content script
    sendResponse({ ok: true })
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
