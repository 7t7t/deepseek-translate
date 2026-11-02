// 生成纯色圆角方块 + 三条横线的扩展图标，无第三方依赖
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([len, typeAndData, crc])
}

function png(size, pixel) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(size * stride)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size)
      const o = y * stride + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function inRoundRect(x, y, s, r) {
  const cx = Math.min(Math.max(x, r), s - r)
  const cy = Math.min(Math.max(y, r), s - r)
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
}

function pixel(x, y, s) {
  if (!inRoundRect(x, y, s, s * 0.22)) return [0, 0, 0, 0]
  const u = x / s
  const v = y / s
  const bar = (y0, y1, x1) => v >= y0 && v <= y1 && u >= 0.22 && u <= x1
  if (bar(0.26, 0.38, 0.78)) return [255, 255, 255, 255]
  if (bar(0.46, 0.58, 0.62)) return [255, 255, 255, 255]
  if (bar(0.66, 0.76, 0.7)) return [199, 210, 255, 255]
  return [77, 107, 254, 255]
}

const dir = path.join(__dirname, '..', 'icons')
fs.mkdirSync(dir, { recursive: true })
for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(dir, `icon${s}.png`), png(s, pixel))
console.log('icons written to', dir)
