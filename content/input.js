;(() => {
  const D = window.__DST__
  const CODE_EDITORS = '.monaco-editor,.CodeMirror,.cm-editor,.ace_editor'
  const busy = new WeakSet()
  let presses = []

  function editableOf(target) {
    if (!(target instanceof Element) || target.closest(CODE_EDITORS)) return null
    let el = null
    if (target.tagName === 'TEXTAREA') el = target
    else if (target.tagName === 'INPUT') el = ['text', 'search'].includes(target.type) ? target : null
    else if (target.isContentEditable) {
      el = target
      while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement
    }
    // 编辑器常用不可见的小 textarea 接收按键，跳过
    if (el && (el.offsetWidth < 20 || el.offsetHeight < 10)) return null
    return el
  }

  const valueOf = (el) => (el.isContentEditable ? el.innerText : el.value)

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
    const original = valueOf(el)
    // 去掉前两次空格按键输入的空格
    const text = original.replace(/ {1,2}$/, '').trim()
    if (!text) return
    busy.add(el)
    el.classList.add('dst-input-loading')
    try {
      const [result] = await D.translate([text], D.config.inputTargetLang)
      // 等待期间用户继续输入或已切换到别的输入框时，不覆盖内容、不抢焦点
      if (valueOf(el) !== original || el.getRootNode().activeElement !== el) {
        D.toast('输入内容已变化，已取消替换')
        return
      }
      setValue(el, result)
    } catch (e) {
      D.toast(e.message)
    } finally {
      busy.delete(el)
      el.classList.remove('dst-input-loading')
    }
  }

  D.listen(
    document,
    'keydown',
    (e) => {
      if (e.key !== ' ' || e.repeat || e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
        presses = []
        return
      }
      // composedPath()[0] 能拿到 Shadow DOM 内部的真实输入框
      const el = editableOf(e.composedPath()[0])
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
