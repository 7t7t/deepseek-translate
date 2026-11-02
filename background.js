importScripts('lib/utils.js', 'lib/storage.js', 'lib/deepseek.js', 'lib/translator.js')

const MENU_ID = 'dst-translate-selection'
const { js: CONTENT_JS, css: CONTENT_CSS } = chrome.runtime.getManifest().content_scripts[0]

const translator = DST_TRANSLATOR.createTranslator({
  getConfig: DST_STORAGE.getConfig,
  translateBatch: (cfg, texts, targetLang) => DST_DEEPSEEK.translateBatch(cfg, texts, targetLang),
})

// 禁止 content script 直接读取 storage（API Key 只留在扩展页面和后台）
if (chrome.storage.local.setAccessLevel) {
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
}

const getPublicConfig = async () => DST_UTILS.publicConfig(await DST_STORAGE.getConfig())

// 配置变化时推送给所有已注入的页面
chrome.storage.onChanged.addListener(async (_changes, area) => {
  if (area !== 'local') return
  const config = await getPublicConfig()
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id != null) chrome.tabs.sendMessage(tab.id, { type: 'configChanged', config }).catch(() => {})
  }
})

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: 'DeepSeek 翻译选中内容', contexts: ['selection'] })
  })
  if (details.reason === 'install') chrome.runtime.openOptionsPage()
})

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab && tab.id != null) {
    sendToTab(tab.id, { type: 'translateSelection', text: info.selectionText || '' })
  }
})

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-page') return
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  if (target && target.id != null) sendToTab(target.id, { type: 'togglePage' })
})

// 发消息到页面；页面还没有 content script（扩展安装前打开的标签页）时先补注入
async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg)
  } catch (e) {
    // 只有页面里确实没有接收方时才注入，避免同一页面运行两份 content script
    if (!/Receiving end does not exist/i.test(e && e.message)) return undefined
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: CONTENT_CSS })
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_JS })
      return await chrome.tabs.sendMessage(tabId, msg)
    } catch {
      // chrome:// 、应用商店等受限页面无法注入
      return undefined
    }
  }
}

async function handle(msg) {
  switch (msg && msg.type) {
    case 'getConfig':
      return { ok: true, config: await getPublicConfig() }
    case 'translate':
      return { ok: true, results: await translator.translate(msg.texts, msg.targetLang) }
    case 'testConnection':
      await DST_DEEPSEEK.translateOne(
        { apiKey: msg.apiKey, baseUrl: msg.baseUrl, model: msg.model },
        'Hello',
        'zh-CN',
      )
      return { ok: true }
    case 'forwardToTab':
      return { ok: true, result: await sendToTab(msg.tabId, msg.payload) }
    default:
      return { ok: false, error: '未知消息类型' }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (e) =>
    sendResponse({ ok: false, error: (e && e.message) || String(e), code: e && e.code }),
  )
  return true
})
