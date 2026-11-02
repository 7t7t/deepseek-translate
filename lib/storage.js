;(function (root) {
  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    targetLang: 'zh-CN',
    inputTargetLang: 'en',
    alwaysSites: [],
    neverSites: [],
    enableSelection: true,
    enableInput: true,
    maxConcurrency: 3,
  }

  function getConfig() {
    return chrome.storage.local.get(DEFAULTS)
  }

  function setConfig(patch) {
    return chrome.storage.local.set(patch)
  }

  root.DST_STORAGE = { DEFAULTS, getConfig, setConfig }
})(globalThis)
