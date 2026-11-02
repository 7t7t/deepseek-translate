const $ = (id) => document.getElementById(id)
const { DEFAULTS } = DST_STORAGE

const FIELDS = {
  apiKey: 'text',
  baseUrl: 'text',
  model: 'text',
  targetLang: 'text',
  inputTargetLang: 'text',
  enableSelection: 'bool',
  enableInput: 'bool',
  maxConcurrency: 'int',
  alwaysSites: 'sites',
  neverSites: 'sites',
}

function readField(key) {
  const el = $(key)
  const kind = FIELDS[key]
  if (kind === 'bool') return el.checked
  if (kind === 'int') return Math.min(10, Math.max(1, parseInt(el.value, 10) || DEFAULTS[key]))
  if (kind === 'sites') return DST_UTILS.parseSiteList(el.value)
  return el.value.trim() || DEFAULTS[key]
}

function writeField(key, value) {
  const el = $(key)
  const kind = FIELDS[key]
  if (kind === 'bool') el.checked = value
  else if (kind === 'sites') el.value = value.join('\n')
  else el.value = value
}

function debounce(fn, ms) {
  let timer
  return (...args) => {
    clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}

let savedTimer
async function save(key) {
  await DST_STORAGE.setConfig({ [key]: readField(key) })
  $('saved').hidden = false
  clearTimeout(savedTimer)
  savedTimer = setTimeout(() => ($('saved').hidden = true), 1500)
}

async function testConnection() {
  const result = $('testResult')
  result.className = ''
  result.textContent = '测试中…'
  $('test').disabled = true
  const res = await chrome.runtime.sendMessage({
    type: 'testConnection',
    apiKey: readField('apiKey'),
    baseUrl: readField('baseUrl'),
    model: readField('model'),
  })
  $('test').disabled = false
  result.className = res && res.ok ? 'ok' : 'err'
  result.textContent = res && res.ok ? '连接成功' : '连接失败：' + ((res && res.error) || '未知错误')
}

;(async () => {
  for (const id of ['targetLang', 'inputTargetLang']) {
    for (const lang of DST_UTILS.LANGS) $(id).add(new Option(lang.name, lang.code))
  }
  const cfg = await DST_STORAGE.getConfig()
  for (const key of Object.keys(FIELDS)) {
    writeField(key, cfg[key])
    $(key).addEventListener('input', debounce(() => save(key), 400))
    $(key).addEventListener('change', () => save(key))
  }

  $('toggleKey').addEventListener('click', () => {
    const show = $('apiKey').type === 'password'
    $('apiKey').type = show ? 'text' : 'password'
    $('toggleKey').textContent = show ? '隐藏' : '显示'
  })
  $('test').addEventListener('click', testConnection)
  $('shortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))

  const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'toggle-page')
  $('shortcut').textContent = (cmd && cmd.shortcut) || '未设置'
})()
