// Generates the PrintYard raster icons for every accent skin (run before `vite build` and `vite`).
// The logo is made only of straight-edged polygons, so a tiny supersampling rasterizer + PNG encoder is enough:
// no native/raster dependency, works the same on Windows and in the Docker build stage.
//
// Output (gitignored):  public/icons/<skin>/{icon-192,icon-512,icon-maskable-192,icon-maskable-512,apple-touch-icon}.png
//                       public/icons/<skin>/favicon.svg   (used by /theme.js before React mounts)
//                       public/icons/badge-96.png          (white mark on transparent, shared by every skin)
// Also refreshes the committed public/favicon.svg + public/favicon.ico (default sky skin).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')

/** Brand constants (status/logos/printyard/README.md). */
const INK = '#0f172a'
const TILE = 'M0 0H256V208L208 256H0Z'
const MARK = 'M40 28H216V128L176 168H80V212L64 228H40ZM84 54H112L128 78 144 54H172L142 96V120L128 136 114 120V96ZM84 146H126V156H84Z'

/** Skin → accent-400, read from the [data-skin] blocks of src/index.css (single source of truth). */
function readSkins() {
  const css = readFileSync(join(root, 'src', 'index.css'), 'utf8')
  const out = {}
  for (const m of css.matchAll(/\[data-skin='([a-z]+)'\]\s*\{([^}]*)\}/g)) {
    const c = /--accent-400:\s*(#[0-9a-fA-F]{6})/.exec(m[2])
    if (c) out[m[1]] = c[1].toLowerCase()
  }
  if (!out.sky) throw new Error('gen-icons: no sky skin found in src/index.css')
  return out
}

/** Absolute-command path (M/H/V/L/Z, implicit L) → list of polygons. */
function parsePath(d) {
  const polys = []
  let cur = null
  let x = 0
  let y = 0
  const tokens = d.match(/[MHVLZ]|-?\d*\.?\d+/gi)
  let cmd = 'M'
  for (let i = 0; i < tokens.length; ) {
    const t = tokens[i]
    if (/[MHVLZ]/i.test(t)) {
      cmd = t.toUpperCase()
      i++
      if (cmd === 'Z') {
        cur = null
        continue
      }
    }
    const n = () => Number(tokens[i++])
    if (cmd === 'M') {
      x = n(); y = n()
      cur = [[x, y]]
      polys.push(cur)
      cmd = 'L'
    } else if (cmd === 'L') {
      x = n(); y = n()
      cur.push([x, y])
    } else if (cmd === 'H') {
      x = n()
      cur.push([x, y])
    } else if (cmd === 'V') {
      y = n()
      cur.push([x, y])
    }
  }
  return polys
}

const transform = (polys, s, tx, ty) => polys.map((p) => p.map(([x, y]) => [x * s + tx, y * s + ty]))
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))

/** Even-odd coverage (0..1) of polygons in 256-unit space rendered at `size` px, SS×SS samples per pixel. */
function coverage(polys, size, SS = 8) {
  const k = size / 256
  const edges = []
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i]
      const [x1, y1] = p[(i + 1) % p.length]
      if (y0 !== y1) edges.push([x0 * k, y0 * k, x1 * k, y1 * k])
    }
  }
  const counts = new Uint16Array(size * size)
  const W = size * SS
  const xs = []
  for (let sy = 0; sy < size * SS; sy++) {
    const y = (sy + 0.5) / SS
    xs.length = 0
    for (const [x0, y0, x1, y1] of edges) {
      if ((y0 <= y && y < y1) || (y1 <= y && y < y0)) xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0))
    }
    xs.sort((a, b) => a - b)
    const row = Math.floor(sy / SS) * size
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const c0 = Math.max(0, Math.ceil(xs[i] * SS - 0.5))
      const c1 = Math.min(W, Math.ceil(xs[i + 1] * SS - 0.5))
      for (let c = c0; c < c1; c++) counts[row + ((c / SS) | 0)]++
    }
  }
  const out = new Float32Array(size * size)
  for (let i = 0; i < out.length; i++) out[i] = counts[i] / (SS * SS)
  return out
}

/** Paints layers ({polys, color}) over a transparent canvas → RGBA bytes. */
function render(size, layers) {
  const px = new Float32Array(size * size * 4) // premultiplied
  for (const { polys, color } of layers) {
    const cov = coverage(polys, size)
    const [r, g, b] = hex(color).map((v) => v / 255)
    for (let i = 0; i < cov.length; i++) {
      const a = cov[i]
      if (!a) continue
      const o = i * 4
      px[o] = r * a + px[o] * (1 - a)
      px[o + 1] = g * a + px[o + 1] * (1 - a)
      px[o + 2] = b * a + px[o + 2] * (1 - a)
      px[o + 3] = a + px[o + 3] * (1 - a)
    }
  }
  const rgba = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const a = px[i * 4 + 3]
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = a ? Math.round((px[i * 4 + c] / a) * 255) : 0
    rgba[i * 4 + 3] = Math.round(a * 255)
  }
  return rgba
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
/** ICO with embedded PNG images (Vista+ / every current browser). */
function ico(images) {
  const head = Buffer.alloc(6 + images.length * 16)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    head[e] = size % 256
    head[e + 1] = size % 256
    head.writeUInt16LE(1, e + 4) // planes
    head.writeUInt16LE(32, e + 6) // bpp
    head.writeUInt32LE(data.length, e + 8)
    head.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([head, ...images.map((i) => i.data)])
}

const tile = parsePath(TILE)
const mark = parsePath(MARK)
const full = parsePath('M0 0H256V256H0Z')
/** Mark scaled around the centre of its 256 box (its bbox is centred on 128,128). */
const markAt = (s) => transform(mark, s, 128 - 128 * s, 128 - 128 * s)

const VARIANTS = {
  // "any": the chamfered tile on transparent, mark as in the SVG
  icon: (accent) => [{ polys: tile, color: INK }, { polys: markAt(0.8), color: accent }],
  // maskable: full-bleed ink, mark inside the 80% safe circle (corner distance 133·0.7 = 93 < 102)
  maskable: (accent) => [{ polys: full, color: INK }, { polys: markAt(0.7), color: accent }],
  // apple-touch: iOS rounds the corners itself and turns transparency black, so full-bleed ink
  apple: (accent) => [{ polys: full, color: INK }, { polys: markAt(0.8), color: accent }],
}

/** The SVG icon; in a dark OS scheme the tile takes the accent and the mark the ink (browser tab chrome). */
function faviconSvg(accent) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">` +
    `<style>.t{fill:${INK}}.m{fill:${accent}}@media (prefers-color-scheme:dark){.t{fill:${accent}}.m{fill:${INK}}}</style>` +
    `<path class="t" d="${TILE}"/>` +
    `<path class="m" fill-rule="evenodd" transform="translate(25.6 25.6) scale(.8)" d="${MARK}"/></svg>\n`
  )
}

const skins = readSkins()
const icons = join(pub, 'icons')
for (const [skin, accent] of Object.entries(skins)) {
  const dir = join(icons, skin)
  mkdirSync(dir, { recursive: true })
  const out = (name, size, variant) => writeFileSync(join(dir, name), png(size, render(size, VARIANTS[variant](accent))))
  out('icon-192.png', 192, 'icon')
  out('icon-512.png', 512, 'icon')
  out('icon-maskable-192.png', 192, 'maskable')
  out('icon-maskable-512.png', 512, 'maskable')
  out('apple-touch-icon.png', 180, 'apple')
  writeFileSync(join(dir, 'favicon.svg'), faviconSvg(accent))
}
// Notification badge: Android only uses the alpha channel, so one white silhouette serves every skin
writeFileSync(join(icons, 'badge-96.png'), png(96, render(96, [{ polys: markAt(0.9), color: '#ffffff' }])))

writeFileSync(join(pub, 'favicon.svg'), faviconSvg(skins.sky))
writeFileSync(
  join(pub, 'favicon.ico'),
  ico([16, 32, 48].map((size) => ({ size, data: png(size, render(size, VARIANTS.icon(skins.sky))) }))),
)
console.log(`gen-icons: ${Object.keys(skins).length} skins → public/icons/`)
