const test = require('node:test')
const assert = require('node:assert/strict')
const { createTranslator } = require('../lib/translator.js')

const retryable = (msg) => Object.assign(new Error(msg), { retryable: true })
const fatal = (msg) => Object.assign(new Error(msg), { retryable: false })

test('translate caches results per target language', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({ maxConcurrency: 3 }),
    translateBatch: async (cfg, texts, lang) => {
      calls++
      return texts.map((x) => `${lang}:${x}`)
    },
  })
  assert.deepEqual(await t.translate(['a', 'b'], 'zh-CN'), ['zh-CN:a', 'zh-CN:b'])
  assert.deepEqual(await t.translate(['b', 'a'], 'zh-CN'), ['zh-CN:b', 'zh-CN:a'])
  assert.equal(calls, 1)
  assert.deepEqual(await t.translate(['a'], 'ja'), ['ja:a'])
  assert.equal(calls, 2)
})

test('translate only requests cache misses', async () => {
  const seen = []
  const t = createTranslator({
    getConfig: async () => ({}),
    translateBatch: async (cfg, texts) => {
      seen.push(texts)
      return texts.map((x) => x.toUpperCase())
    },
  })
  await t.translate(['a'], 'en')
  assert.deepEqual(await t.translate(['a', 'b'], 'en'), ['A', 'B'])
  assert.deepEqual(seen, [['a'], ['b']])
})

test('retries once on retryable error', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({}),
    retryDelay: 1,
    translateBatch: async (cfg, texts) => {
      if (++calls === 1) throw retryable('busy')
      return texts
    },
  })
  assert.deepEqual(await t.translate(['x'], 'en'), ['x'])
  assert.equal(calls, 2)
})

test('does not retry fatal errors and does not cache failures', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({}),
    retryDelay: 1,
    translateBatch: async () => {
      calls++
      throw fatal('API Key 无效')
    },
  })
  await assert.rejects(t.translate(['x'], 'en'), { message: 'API Key 无效' })
  assert.equal(calls, 1)
  await assert.rejects(t.translate(['x'], 'en'))
  assert.equal(calls, 2)
})

test('gives up after one retry', async () => {
  let calls = 0
  const t = createTranslator({
    getConfig: async () => ({}),
    retryDelay: 1,
    translateBatch: async () => {
      calls++
      throw retryable('timeout')
    },
  })
  await assert.rejects(t.translate(['x'], 'en'), { message: 'timeout' })
  assert.equal(calls, 2)
})

test('respects maxConcurrency across batches and calls', async () => {
  let active = 0
  let peak = 0
  const t = createTranslator({
    getConfig: async () => ({ maxConcurrency: 2 }),
    translateBatch: async (cfg, texts) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 10))
      active--
      return texts
    },
  })
  // 每段 1500 字符 → 每段一个批次
  const big = (c) => c.repeat(1500)
  await Promise.all([t.translate([big('a'), big('b'), big('c')], 'en'), t.translate([big('d'), big('e')], 'en')])
  assert.equal(peak, 2)
})
