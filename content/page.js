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
