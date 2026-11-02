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
