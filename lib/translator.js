;(function (root) {
  const utils = root.DST_UTILS || require('./utils.js')
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  function createTranslator({ getConfig, translateBatch, cacheSize = 2000, retryDelay = 1000 }) {
    const cache = new utils.LruCache(cacheSize)
    let active = 0
    const waiting = []

    async function acquire(limit) {
      if (active < limit) {
        active++
        return
      }
      await new Promise((resolve) => waiting.push(resolve))
    }

    function release() {
      const next = waiting.shift()
      // 直接把名额交给下一个等待者，active 不变
      if (next) next()
      else active--
    }

    async function withRetry(fn) {
      try {
        return await fn()
      } catch (e) {
        if (!e || !e.retryable) throw e
        await sleep(retryDelay)
        return fn()
      }
    }

    async function translate(texts, targetLang) {
      const cfg = await getConfig()
      const keyOf = (t) => targetLang + '\u0000' + t
      const results = texts.map((t) => cache.get(keyOf(t)))
      const missIdx = []
      results.forEach((r, i) => {
        if (r === undefined) missIdx.push(i)
      })
      if (!missIdx.length) return results

      const missTexts = missIdx.map((i) => texts[i])
      await Promise.all(
        utils.buildBatches(missTexts).map(async (batch) => {
          await acquire(cfg.maxConcurrency || 3)
          try {
            const out = await withRetry(() => translateBatch(cfg, batch.map((j) => missTexts[j]), targetLang))
            batch.forEach((j, k) => {
              results[missIdx[j]] = out[k]
              cache.set(keyOf(missTexts[j]), out[k])
            })
          } finally {
            release()
          }
        }),
      )
      return results
    }

    return { translate }
  }

  const api = { createTranslator }
  root.DST_TRANSLATOR = api
  if (typeof module !== 'undefined' && module.exports) module.exports = api
})(globalThis)
