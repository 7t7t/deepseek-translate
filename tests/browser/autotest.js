// 由 harness.html?autotest 加载，结果写入 <pre id="results">，供无头 Chrome --dump-dom 读取
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const results = []
  const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`)
  const tr = (el) => {
    const t = el && el.querySelector(':scope > .dst-translation .dst-text')
    return t ? t.textContent : null
  }
  const $ = (id) => document.getElementById(id)

  await sleep(100)
  const state = await window.__dispatch({ type: 'togglePage' })
  check('toggle starts page translation', state && state.active === true, JSON.stringify(state))
  await sleep(800)

  check(
    'english paragraph translated',
    tr($('p1')) === '译:The quick brown fox jumps over the lazy dog.',
    `${tr($('p1'))} state=${$('p1').getAttribute('data-dst')} requests=${JSON.stringify(window.__requests)}`,
  )
  check('chinese paragraph skipped', !$('p2').hasAttribute('data-dst'))
  check('pre not translated', !document.querySelector('pre .dst-translation'))
  check('heading translated', !!tr(document.querySelector('h1')))

  // Review #6: 折叠内容展开后翻译
  check('hidden paragraph not translated yet', !tr($('hiddenP')), $('hiddenP').getAttribute('data-dst'))
  $('det').open = true
  await sleep(800)
  check(
    'hidden paragraph translated after reveal',
    tr($('hiddenP')) === '译:Hidden paragraph revealed later.',
    `${tr($('hiddenP'))} state=${$('hiddenP').getAttribute('data-dst')} rects=${$('hiddenP').getClientRects().length}`,
  )

  // Review #2: 已翻译段落的文字被页面改写后重新翻译
  $('p1').firstChild.data = 'Changed sentence for retranslation.'
  await sleep(900)
  check('changed text retranslated', tr($('p1')) === '译:Changed sentence for retranslation.', tr($('p1')))
  check('only one translation in p1', $('p1').querySelectorAll('.dst-translation').length === 1)

  // Review #2: 框架用 textContent 重写（译文被移除）后恢复
  $('p1').textContent = 'React rewrote this paragraph.'
  await sleep(900)
  check('rewritten paragraph retranslated', tr($('p1')) === '译:React rewrote this paragraph.', tr($('p1')))

  // 动态新增内容
  const added = document.createElement('p')
  added.id = 'added'
  added.textContent = 'Dynamically added paragraph.'
  $('dyn').appendChild(added)
  await sleep(900)
  check('dynamic paragraph translated', tr(added) === '译:Dynamically added paragraph.', tr(added))

  // 输入框：三连空格
  const space = (el, repeat = false) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, repeat }))
  const ta = $('ta')
  ta.focus()
  ta.value = '你好世界  '
  space(ta)
  space(ta)
  space(ta)
  await sleep(300)
  check('triple space translates textarea', ta.value === '译:你好世界', ta.value)

  // Review #4: 按住空格（auto-repeat）不触发
  ta.value = 'hold  '
  space(ta)
  space(ta, true)
  space(ta, true)
  await sleep(300)
  check('auto-repeat space ignored', ta.value === 'hold  ', ta.value)

  // Review #4: 代码编辑器里的 textarea 不触发
  const editor = document.createElement('div')
  editor.className = 'CodeMirror'
  const cm = document.createElement('textarea')
  cm.style.cssText = 'width:300px;height:60px'
  editor.appendChild(cm)
  $('dyn').appendChild(editor)
  cm.focus()
  cm.value = 'code  '
  space(cm)
  space(cm)
  space(cm)
  await sleep(300)
  check('code editor textarea ignored', cm.value === 'code  ', cm.value)

  // Review #5: 等待翻译期间继续输入，不覆盖
  ta.focus()
  ta.value = 'typing  '
  space(ta)
  space(ta)
  space(ta)
  ta.value = 'typing more'
  await sleep(300)
  check('typing during wait is kept', ta.value === 'typing more', ta.value)

  // Review #3: 整体替换 <body>
  const newBody = document.createElement('body')
  newBody.innerHTML = '<p id="nb">Paragraph in a replaced body.</p><pre id="results"></pre>'
  document.documentElement.replaceChild(newBody, document.body)
  await sleep(900)
  check('replaced body translated', tr($('nb')) === '译:Paragraph in a replaced body.', tr($('nb')))

  // Review #1: 重复注入 —— 旧实例被 dispose，新实例接管
  const oldD = window.__DST__
  const s = document.createElement('script')
  s.src = '../../content/common.js'
  await new Promise((r) => {
    s.onload = r
    document.head.appendChild(s)
  })
  check('old instance disposed on reinjection', oldD.disposed === true && window.__DST__ !== oldD)

  // toast 去重（Review #5）
  window.__DST__.toast('same')
  window.__DST__.toast('same')
  const sameToasts = [...document.querySelectorAll('.dst-toast')].filter((t) => t.textContent === 'same')
  check('toast deduplicated', sameToasts.length === 1)
  check('toast itself not translated', !document.querySelector('.dst-toast .dst-translation'))

  const out = document.getElementById('results') || document.body.appendChild(document.createElement('pre'))
  out.id = 'results'
  out.className = 'dst-root'
  out.textContent = 'AUTOTEST-DONE\n' + results.join('\n')
})()
