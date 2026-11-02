const $ = (id) => document.getElementById(id)

async function forward(tabId, payload) {
  const res = await chrome.runtime.sendMessage({ type: 'forwardToTab', tabId, payload })
  return res && res.result
}

function renderToggle(state) {
  $('toggle').textContent = !state || !state.active ? '翻译本页' : state.hidden ? '显示译文' : '显示原文'
}

;(async () => {
  const openOptions = () => chrome.runtime.openOptionsPage()
  $('openOptions').addEventListener('click', openOptions)
  $('goOptions').addEventListener('click', openOptions)

  const cfg = await DST_STORAGE.getConfig()
  if (!cfg.apiKey) {
    $('noKey').hidden = false
    return
  }
  $('main').hidden = false

  for (const lang of DST_UTILS.LANGS) $('targetLang').add(new Option(lang.name, lang.code))
  $('targetLang').value = cfg.targetLang
  $('targetLang').addEventListener('change', () => DST_STORAGE.setConfig({ targetLang: $('targetLang').value }))

  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-page')
  $('shortcut').textContent = (cmd && cmd.shortcut) || '未设置'

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const url = (tab && tab.url) || ''
  if (!/^(https?|file):/.test(url)) {
    $('toggle').disabled = true
    $('siteRule').disabled = true
    $('unsupported').hidden = false
    return
  }

  const host = new URL(url).hostname
  $('host').textContent = DST_UTILS.normalizeHost(host)
  $('siteRule').value = DST_UTILS.getSiteRule(host, cfg) || ''
  $('siteRule').addEventListener('change', async () => {
    const latest = await DST_STORAGE.getConfig()
    await DST_STORAGE.setConfig(DST_UTILS.setSiteRule(latest, host, $('siteRule').value))
  })

  renderToggle(await forward(tab.id, { type: 'getPageState' }))
  $('toggle').addEventListener('click', async () => {
    renderToggle(await forward(tab.id, { type: 'togglePage' }))
  })
})()
