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

  const textOf = new WeakMap() // 规范化后的待翻译文本
  const srcOf = new WeakMap() // 标记时的原始 textContent，用于发现内容被页面改写
  const wrapperOf = new WeakMap()
  const waiting = new Set()
  const queue = new Set()
  const dirty = new Set()
  const touched = new Set()
  let observer = null
  let mutation = null
  let active = false
  let flushTimer = null
  let scanTimer = null

  const isHidden = () => document.documentElement.classList.contains('dst-hide')
  const normalize = (s) =>
    String(s || '')
      .replace(/[ \t ]+/g, ' ')
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

  // 当前隐藏的元素（折叠面板、未激活标签页）也标记并交给 IntersectionObserver，显示后再翻译
  function consider(el) {
    // 折叠的 <details> 等 content-visibility 隐藏内容 innerText 为空，退回 textContent
    const text = normalize(el.innerText || el.textContent)
    if (!utils.isTranslatable(text) || utils.isTargetLang(text, D.config.targetLang)) return
    el.setAttribute('data-dst', 'wait')
    textOf.set(el, text)
    srcOf.set(el, el.textContent)
    waiting.add(el)
    observer.observe(el)
  }

  function scan(root) {
    if (!root || !root.isConnected || !document.body || !document.body.contains(root)) return
    if (root.closest('[data-dst],' + SKIP)) return
    visit(root)
  }

  function rawText(el) {
    const w = wrapperOf.get(el)
    const t = el.textContent
    return w && el.contains(w) ? t.replace(w.textContent, '') : t
  }

  // 原文被页面改写，或我们插入的译文被框架移除
  function isStale(el) {
    if (!srcOf.has(el)) return false
    const w = wrapperOf.get(el)
    return rawText(el) !== srcOf.get(el) || (!!w && !w.isConnected)
  }

  function reset(el) {
    const w = wrapperOf.get(el)
    if (w) w.remove()
    wrapperOf.delete(el)
    srcOf.delete(el)
    el.removeAttribute('data-dst')
    waiting.delete(el)
    queue.delete(el)
    if (observer) observer.unobserve(el)
  }

  function scheduleMutations() {
    if ((dirty.size || touched.size) && !scanTimer) scanTimer = setTimeout(processMutations, 300)
  }

  function processMutations() {
    scanTimer = null
    for (const el of touched) {
      if (el.isConnected && el.getAttribute('data-dst') !== 'loading' && isStale(el)) {
        reset(el)
        dirty.add(el)
      }
    }
    touched.clear()
    const roots = [...dirty]
    dirty.clear()
    roots.forEach(scan)
  }

  function onMutations(records) {
    for (const record of records) {
      const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement
      if (!target || target.closest('.dst-translation,.dst-root')) continue
      const owner = target.closest('[data-dst]')
      if (owner) touched.add(owner)
      for (const node of record.addedNodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
        if (el && !el.closest('.dst-translation,.dst-root')) dirty.add(el)
      }
    }
    scheduleMutations()
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
    let results = null
    let error = null
    try {
      results = await D.translate(
        els.map((el) => textOf.get(el)),
        D.config.targetLang,
      )
    } catch (e) {
      error = e
    }
    if (D.disposed) {
      els.forEach(reset)
      return
    }
    els.forEach((el, i) => {
      if (!el.isConnected) return
      if (isStale(el)) {
        reset(el)
        dirty.add(el)
        return
      }
      if (error) {
        el.setAttribute('data-dst', 'error')
        setError(wrappers[i], el)
        return
      }
      const r = normalize(results[i])
      if (!r || r === textOf.get(el)) {
        wrappers[i].remove()
        wrapperOf.delete(el)
      } else {
        setResult(wrappers[i], r)
      }
      el.setAttribute('data-dst', 'done')
    })
    if (error) D.toast(error.message)
    scheduleMutations()
  }

  function start() {
    active = true
    document.documentElement.classList.remove('dst-hide')
    observer = new IntersectionObserver(onIntersect, { rootMargin: '600px 0px' })
    // 观察 documentElement 而不是 body：部分 SPA（如 Turbo）导航时会整体替换 <body>
    mutation = new MutationObserver(onMutations)
    mutation.observe(document.documentElement, { childList: true, subtree: true, characterData: true })
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
    if (!D.config.hasKey) {
      D.toast('请先在设置页配置 DeepSeek API Key')
      return
    }
    if (!active) start()
    else setHidden(!isHidden())
  }

  const pageState = () => ({ active, hidden: isHidden() })

  D.onDispose(() => {
    if (observer) observer.disconnect()
    if (mutation) mutation.disconnect()
    clearTimeout(flushTimer)
    clearTimeout(scanTimer)
    // 未开始翻译的段落交还给新实例重新扫描
    for (const el of [...waiting, ...queue]) el.removeAttribute('data-dst')
  })

  D.onMessage((msg, _sender, sendResponse) => {
    if (msg.type === 'getPageState') {
      sendResponse(pageState())
      return
    }
    if (msg.type === 'togglePage') {
      D.ready.then(() => {
        if (D.config) toggle()
        sendResponse(pageState())
      })
      return true
    }
  })

  D.ready.then(() => {
    if (D.config && D.config.hasKey && D.siteRule() === 'always') start()
  })
})()
