const test = require('node:test')
const assert = require('node:assert/strict')
const ds = require('../lib/deepseek.js')

const cfg = { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/', model: 'deepseek-chat' }

function okResponse(content) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) }
}

test('buildBatchContent numbers paragraphs', () => {
  assert.equal(ds.buildBatchContent(['A', 'B']), '<<0>>\nA\n<<1>>\nB')
})

test('parseBatchContent handles newline and same-line markers', () => {
  assert.deepEqual(ds.parseBatchContent('<<0>>\n甲\n<<1>>\n乙', 2), ['甲', '乙'])
  assert.deepEqual(ds.parseBatchContent('<<0>> 甲\n<<1>> 乙\n', 2), ['甲', '乙'])
})

test('parseBatchContent returns null when a paragraph is missing', () => {
  assert.equal(ds.parseBatchContent('<<0>>\n甲', 2), null)
  assert.equal(ds.parseBatchContent('甲乙', 2), null)
})

test('chat posts OpenAI-compatible request and trims content', async () => {
  let call
  const fetchImpl = async (url, init) => {
    call = { url, init }
    return okResponse('  你好 \n')
  }
  const out = await ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl })
  assert.equal(out, '你好')
  assert.equal(call.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test')
  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'deepseek-chat')
  assert.equal(body.temperature, 0.3)
  assert.equal(body.stream, false)
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'U' },
  ])
})

test('chat without key throws nokey and does not call fetch', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
  }
  await assert.rejects(ds.chat({ ...cfg, apiKey: '', system: 'S', user: 'U', fetchImpl }), (e) => {
    assert.equal(e.code, 'nokey')
    assert.equal(e.message, '请先在设置页配置 DeepSeek API Key')
    return true
  })
  assert.equal(called, false)
})

test('chat maps HTTP errors', async () => {
  const cases = [
    [401, 'auth', 'API Key 无效', false],
    [402, 'balance', 'DeepSeek 账户余额不足', false],
    [429, 'rate', '请求过于频繁，请稍后再试', true],
    [503, 'server', 'DeepSeek 服务异常（503）', true],
    [400, 'http', '请求失败（400）', false],
  ]
  for (const [status, code, message, retryable] of cases) {
    const fetchImpl = async () => ({ ok: false, status, json: async () => ({}) })
    await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl }), (e) => {
      assert.equal(e.code, code)
      assert.equal(e.message, message)
      assert.equal(e.retryable, retryable)
      return true
    })
  }
})

test('chat maps network failure and timeout', async () => {
  const failing = async () => {
    throw new TypeError('Failed to fetch')
  }
  await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl: failing }), { code: 'network' })

  const hanging = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted')
        e.name = 'AbortError'
        reject(e)
      })
    })
  await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl: hanging, timeout: 10 }), {
    code: 'timeout',
    message: '请求超时',
  })
})

test('chat rejects malformed response', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })
  await assert.rejects(ds.chat({ ...cfg, system: 'S', user: 'U', fetchImpl }), { code: 'bad' })
})

test('translateOne prompt names the target language', async () => {
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    return okResponse('你好')
  }
  assert.equal(await ds.translateOne(cfg, 'Hello', 'zh-CN', fetchImpl), '你好')
  assert.match(body.messages[0].content, /Simplified Chinese/)
  assert.equal(body.messages[1].content, 'Hello')
})

test('translateBatch parses numbered output in one request', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    return okResponse('<<0>>\n甲\n<<1>>\n乙')
  }
  assert.deepEqual(await ds.translateBatch(cfg, ['A', 'B'], 'zh-CN', fetchImpl), ['甲', '乙'])
  assert.equal(calls, 1)
})

test('translateBatch falls back to one-by-one when markers mismatch', async () => {
  const replies = ['甲乙（格式错乱）', '甲', '乙']
  const fetchImpl = async () => okResponse(replies.shift())
  assert.deepEqual(await ds.translateBatch(cfg, ['A', 'B'], 'zh-CN', fetchImpl), ['甲', '乙'])
  assert.equal(replies.length, 0)
})

test('translateBatch with single text uses single prompt', async () => {
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    return okResponse('甲')
  }
  assert.deepEqual(await ds.translateBatch(cfg, ['A'], 'zh-CN', fetchImpl), ['甲'])
  assert.equal(body.messages[1].content, 'A')
})
