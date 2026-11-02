const test = require('node:test')
const assert = require('node:assert/strict')
const u = require('../lib/utils.js')

test('normalizeHost strips scheme, www, port, path and lowercases', () => {
  assert.equal(u.normalizeHost('https://www.Example.com:8080/a/b'), 'example.com')
  assert.equal(u.normalizeHost('  Docs.Example.com '), 'docs.example.com')
  assert.equal(u.normalizeHost(''), '')
})

test('matchSite matches exact host and subdomains only', () => {
  assert.equal(u.matchSite('a.example.com', ['example.com']), true)
  assert.equal(u.matchSite('example.com', ['www.example.com']), true)
  assert.equal(u.matchSite('badexample.com', ['example.com']), false)
  assert.equal(u.matchSite('example.com', []), false)
  assert.equal(u.matchSite('', ['example.com']), false)
})

test('getSiteRule prefers never over always', () => {
  const cfg = { alwaysSites: ['example.com'], neverSites: ['a.example.com'] }
  assert.equal(u.getSiteRule('a.example.com', cfg), 'never')
  assert.equal(u.getSiteRule('b.example.com', cfg), 'always')
  assert.equal(u.getSiteRule('other.com', cfg), null)
})

test('parseSiteList normalizes, dedupes and drops blanks', () => {
  assert.deepEqual(u.parseSiteList('a.com\n\n https://www.b.com/x \na.com'), ['a.com', 'b.com'])
})

test('setSiteRule moves host between lists and removes covering rules', () => {
  const cfg = { alwaysSites: ['example.com', 'x.com'], neverSites: [] }
  assert.deepEqual(u.setSiteRule(cfg, 'docs.example.com', 'never'), {
    alwaysSites: ['x.com'],
    neverSites: ['docs.example.com'],
  })
  assert.deepEqual(u.setSiteRule(cfg, 'x.com', ''), { alwaysSites: ['example.com'], neverSites: [] })
})

test('isTranslatable requires at least 2 chars and a letter', () => {
  assert.equal(u.isTranslatable(''), false)
  assert.equal(u.isTranslatable('a'), false)
  assert.equal(u.isTranslatable('12:30'), false)
  assert.equal(u.isTranslatable('— · —'), false)
  assert.equal(u.isTranslatable('Hi'), true)
  assert.equal(u.isTranslatable('你好'), true)
})

test('isTargetLang detects text already in target language', () => {
  assert.equal(u.isTargetLang('今天天气很好，适合出门。', 'zh-CN'), true)
  assert.equal(u.isTargetLang('Hello world', 'zh-CN'), false)
  assert.equal(u.isTargetLang('こんにちは世界', 'zh-CN'), false)
  assert.equal(u.isTargetLang('こんにちは世界', 'ja'), true)
  assert.equal(u.isTargetLang('Hello world', 'en'), true)
  assert.equal(u.isTargetLang('Hola señor', 'en'), false)
  assert.equal(u.isTargetLang('안녕하세요', 'ko'), true)
  assert.equal(u.isTargetLang('สวัสดีครับ', 'th'), true)
  assert.equal(u.isTargetLang('Bonjour', 'fr'), false)
})

test('LruCache evicts least recently used', () => {
  const c = new u.LruCache(2)
  c.set('a', 1)
  c.set('b', 2)
  assert.equal(c.get('a'), 1) // a 变为最近使用
  c.set('c', 3)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('c'), 3)
  assert.equal(c.size, 2)
})

test('buildBatches splits by chars and item count', () => {
  assert.deepEqual(u.buildBatches(['a'.repeat(1500), 'b'.repeat(600), 'c']), [[0], [1, 2]])
  const many = Array.from({ length: 25 }, () => 'x')
  const b = u.buildBatches(many)
  assert.equal(b.length, 2)
  assert.equal(b[0].length, 20)
  assert.deepEqual(u.buildBatches(['z'.repeat(5000)]), [[0]])
  assert.deepEqual(u.buildBatches([]), [])
})

test('langName returns English name for prompts', () => {
  assert.equal(u.langName('zh-CN'), 'Simplified Chinese')
  assert.equal(u.langName('xx'), 'xx')
})
