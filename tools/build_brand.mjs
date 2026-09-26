// Build the custom brand mark: signature artwork + recoloured HARNESS badge.
// node build_brand.mjs <primitives/lib/index.js> <name-transparent.png> <outdir> [badgeScale]
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/Akizuki/.dsh/profiles/node_modules/')
const sharp = require('sharp')

const [, , primPath, sigPath, outDir, scaleArg] = process.argv
const BADGE_SCALE = scaleArg ? Number(scaleArg) : 0.6
fs.mkdirSync(outDir, { recursive: true })

// ---------------------------------------------------------------- signature gold
const { data, info } = await sharp(sigPath).ensureAlpha().raw()
  .toBuffer({ resolveWithObject: true })
const { width: SW, height: SH, channels: C } = info
const at = (x, y, c) => data[(y * SW + x) * C + c]

// erode 3x3 -> stroke cores only, then median => the artwork's own body colour
const cores = [[], [], []]
let n = 0
for (let y = 1; y < SH - 1; y++) {
  for (let x = 1; x < SW - 1; x++) {
    let solid = true
    for (let dy = -1; dy <= 1 && solid; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (at(x + dx, y + dy, 3) < 250) { solid = false; break }
    if (!solid) continue
    for (let c = 0; c < 3; c++) cores[c].push(at(x, y, c))
    n++
  }
}
const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] }
const GOLD = [med(cores[0]), med(cores[1]), med(cores[2])]
const hex = (r) => '#' + r.map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
console.log(`stroke cores: ${n}px   gold = rgb(${GOLD.join(',')}) = ${hex(GOLD)}`)

// ---------------------------------------------------------------- badge geometry
const src = fs.readFileSync(primPath, 'utf8')
const start = src.indexOf('function BrandWordmark')
const region = src.slice(start, src.indexOf('//#endregion', start))
const paths = [...region.matchAll(/[,\s{]d:\s*"([^"]+)"/g)].map(m => m[1])
const badgeGlyphs = paths.slice(10)                       // 10.. = H A R N E S S
const rect = region.match(/x:\s*"([\d.]+)",\s*y:\s*"([\d.]+)",\s*width:\s*"([\d.]+)",\s*height:\s*"([\d.]+)",\s*rx:\s*"([\d.]+)"/)
const [RX, RY, RW, RH, RR] = rect.slice(1).map(Number)
const clip = region.match(/id:\s*"dsh-wordmark-badge-clip",[\s\S]*?width:\s*"([\d.]+)",\s*height:\s*"([\d.]+)",[\s\S]*?translate\(([\d.]+)\s+([\d.]+)\)/)
const [CW, CH, CX, CY] = clip.slice(1).map(Number)
console.log(`badge ${RW}x${RH} r${RR} @ (${RX},${RY}); clip ${CW}x${CH} @ (${CX},${CY}); ${badgeGlyphs.length} glyphs`)

// The badge, self-contained in its own 52x14 space. Nested <svg> gives it a clean
// coordinate system so the userSpaceOnUse mask resolves correctly at any scale.
const badgeBody = (knockout = true, fill = hex(GOLD), invert = '#FFFFFF') => `
  <defs>
    <clipPath id="bclip"><rect width="${CW}" height="${CH}" transform="translate(${CX} ${CY})"/></clipPath>
    <mask id="knock" maskUnits="userSpaceOnUse" x="${RX}" y="${RY}" width="${RW}" height="${RH}">
      <rect x="${RX}" y="${RY}" width="${RW}" height="${RH}" rx="${RR}" fill="#fff"/>
      <g clip-path="url(#bclip)">${badgeGlyphs.map(d => `<path d="${d}" fill="#000"/>`).join('')}</g>
    </mask>
  </defs>
  <rect x="${RX}" y="${RY}" width="${RW}" height="${RH}" rx="${RR}" fill="${fill}" ${knockout ? 'mask="url(#knock)"' : ''}/>
  ${knockout ? '' : `<g clip-path="url(#bclip)">${badgeGlyphs.map(d => `<path d="${d}" fill="${invert}"/>`).join('')}</g>`}`

const standaloneBadge = (knockout, px) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${RX} ${RY} ${RW} ${RH}" width="${px}" height="${px * RH / RW}">
${badgeBody(knockout)}
</svg>`

fs.writeFileSync(path.join(outDir, 'harness-badge.svg'), standaloneBadge(true, 416).trim())
fs.writeFileSync(path.join(outDir, 'harness-badge-solid-letters.svg'), standaloneBadge(false, 416).trim())
await sharp(Buffer.from(standaloneBadge(true, RW * 32))).png()
  .toFile(path.join(outDir, 'harness-badge.png'))
console.log('wrote harness-badge.svg (letters knocked out) + harness-badge-solid-letters.svg (white letters)')

// ---------------------------------------------------------------- lockup
const sigTrim = await sharp(sigPath).trim({ threshold: 1 })
  .resize({ height: 288, fit: 'inside', kernel: 'lanczos3' })
  .png({ compressionLevel: 9, palette: false }).toBuffer()
const sigMeta = await sharp(sigTrim).metadata()

const SIG_H = 24
const SIG_W = +(SIG_H * sigMeta.width / sigMeta.height).toFixed(3)
const GAP = 6
const bW = +(RW * BADGE_SCALE).toFixed(3)
const bH = +(RH * BADGE_SCALE).toFixed(3)
const bX = +(SIG_W + GAP).toFixed(3)
const bY = +((SIG_H - bH) / 2).toFixed(3)
const TOTAL_W = +(bX + bW).toFixed(3)

console.log(`signature trimmed ${sigMeta.width}x${sigMeta.height} (aspect ${(sigMeta.width / sigMeta.height).toFixed(3)}) -> ${SIG_W} units wide`)

const lockup = (scale = BADGE_SCALE) => {
  const w = +(RW * scale).toFixed(3), h = +(RH * scale).toFixed(3)
  const x = +(SIG_W + GAP).toFixed(3), y = +((SIG_H - h) / 2).toFixed(3)
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(x + w).toFixed(3)} ${SIG_H}" width="${((x + w) * 8).toFixed(0)}" height="${SIG_H * 8}">
  <image x="0" y="0" width="${SIG_W}" height="${SIG_H}" preserveAspectRatio="xMinYMid meet"
         href="data:image/png;base64,${sigTrim.toString('base64')}"/>
  <svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${RX} ${RY} ${RW} ${RH}">${badgeBody(true)}
  </svg>
</svg>`
}

fs.writeFileSync(path.join(outDir, 'kokona-brand.svg'), lockup().trim())
await sharp(Buffer.from(lockup())).png().toFile(path.join(outDir, 'kokona-brand.png'))
console.log(`wrote kokona-brand.svg + .png   viewBox 0 0 ${TOTAL_W} ${SIG_H}  badge x${BADGE_SCALE} = ${bW}x${bH}  (aspect ${(TOTAL_W / SIG_H).toFixed(2)}:1)`)

// ---------------------------------------------------------------- comparisons
const light = { r: 255, g: 255, b: 255, alpha: 1 }
const dark = { r: 0x12, g: 0x12, b: 0x16, alpha: 1 }

// A: the lockup at several badge scales, 48px tall on dark
const scales = [1, 0.8, 0.6, 0.5]
const rowBufs = []
for (const s of scales) {
  const lk = lockup(s)
  const img = await sharp(Buffer.from(lk), { density: 600 })
    .resize({ height: 48, fit: 'inside', kernel: 'lanczos3' })
    .flatten({ background: dark }).png().toBuffer()
  const m = await sharp(img).metadata()
  const label = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="48">
       <text x="0" y="30" font-family="monospace" font-size="15" fill="#8a8a92">x${s}</text></svg>`))
    .png().toBuffer()
  rowBufs.push({ img, label, w: m.width, h: m.height })
}
const maxW = Math.max(...rowBufs.map(r => r.w)) + 110
const rowsH = rowBufs.reduce((a, r) => a + Math.max(r.h, 48) + 14, 14)
await sharp({ create: { width: maxW, height: rowsH, channels: 4, background: '#121216' } })
  .composite(rowBufs.flatMap((r, i) => {
    const top = 14 + i * (Math.max(r.h, 48) + 14)
    return [
      { input: r.label, left: 10, top: top + (Math.max(r.h, 48) - 48) / 2 },
      { input: r.img, left: 100, top: top + (Math.max(r.h, 48) - r.h) / 2 }
    ]
  }))
  .png().toFile(path.join(outDir, 'badge-scale-compare.png'))
console.log('wrote badge-scale-compare.png (badge scale x1 / x0.8 / x0.6 / x0.5, 48px tall on dark)')

// B: final lockup at 24/48/96px, white and dark
const cells = []
for (const h of [24, 48, 96]) {
  for (const bg of [light, dark]) {
    cells.push(await sharp(Buffer.from(lockup()), { density: 600 })
      .resize({ height: h, fit: 'inside', kernel: 'lanczos3' })
      .flatten({ background: bg }).png().toBuffer())
  }
}
const metas = await Promise.all(cells.map(b => sharp(b).metadata()))
const padX = 24, padY = 16
const colW = Math.max(...metas.map(m => m.width)) + padX * 2
const totalH = [24, 48, 96].reduce((a, h, i) => a + Math.max(metas[i * 2].height, metas[i * 2 + 1].height) + padY, padY)
const comps = []
let y = padY
for (let i = 0; i < 3; i++) {
  const l = metas[i * 2], d = metas[i * 2 + 1], rm = Math.max(l.height, d.height)
  comps.push({ input: cells[i * 2], left: padX, top: y + (rm - l.height) / 2 })
  comps.push({ input: cells[i * 2 + 1], left: colW + padX, top: y + (rm - d.height) / 2 })
  y += rm + padY
}
await sharp({ create: { width: colW * 2, height: totalH, channels: 4, background: '#ffffff' } })
  .composite(comps).png().toFile(path.join(outDir, 'kokona-brand-sizes.png'))
console.log('wrote kokona-brand-sizes.png (left white / right dark, rows 24/48/96px)')
