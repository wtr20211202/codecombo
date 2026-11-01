// site-assets-gen.mjs —— 品牌视觉资产的 SVG→PNG/ICO 派生器（P-20261101-1）。
//
// 单一事实源 = SVG 设计稿（手改这些）：
//   web/public/favicon.svg                    → web/public/favicon.ico（16/32/48 三档，PNG 压缩 ICO）
//   site/assets/logo/codecombo-tile.svg       → web/public/icons/icon-192.png / icon-512.png
//                                              + web/public/icons/apple-touch-icon.png（180）
//   site/assets/og-image.svg                  → site/assets/og-image.png（1200×630）
//
// 用法：cd web && node scripts/site-assets-gen.mjs
// 依赖：playwright（web/node_modules 内，e2e 同款 Chromium）——无新依赖引入。
// ICO 封装：纯 JS 手写头部（Vista+ 支持 PNG 直嵌条目），不需要额外库。
// 幂等可重跑：输出覆盖写。
//
// 历史注记：PWA icons 首代（P-20261004-134）由一次性 Playwright 渲染派生、
// 「派生脚本不入库」；本提案把派生管线入库（品牌再精修时无需考古当时命令）。

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const rel = (...p) => path.join(repoRoot, ...p)

/**
 * SVG 文本 → 指定尺寸 PNG Buffer。注入 HTML 包裹层钉死渲染尺寸
 * （裸 <svg> 只有 viewBox 时 Chromium 落 300×150 intrinsic，必须显式 sizing），
 * omitBackground 保留 SVG 自身透明区（favicon 无底板、tile 圆角外透明）。
 */
async function renderPng(browser, svgText, width, height) {
  const page = await browser.newPage({ viewport: { width, height } })
  try {
    await page.setContent(
      `<!doctype html><style>` +
        `body{margin:0}` +
        `#wrap{width:${width}px;height:${height}px}` +
        `svg{width:100%;height:100%;display:block}` +
        `</style><div id="wrap">${svgText}</div>`,
    )
    return await page.locator('#wrap').screenshot({ omitBackground: true, type: 'png' })
  } finally {
    await page.close()
  }
}

/** PNG Buffer 数组 → ICO（PNG 直嵌条目，按宽度升序） */
function packIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // width（256 写 0）
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // palette
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

const browser = await chromium.launch()
try {
  // 1) favicon.svg → favicon.ico（16/32/48）
  const faviconSvg = await readFile(rel('web', 'public', 'favicon.svg'), 'utf8')
  const icoPngs = []
  for (const size of [16, 32, 48]) {
    icoPngs.push({ size, data: await renderPng(browser, faviconSvg, size, size) })
  }
  await writeFile(rel('web', 'public', 'favicon.ico'), packIco(icoPngs))
  console.log('  favicon.ico  (16/32/48)')

  // 2) codecombo-tile.svg → PWA icons + apple-touch-icon
  const tileSvg = await readFile(rel('site', 'assets', 'logo', 'codecombo-tile.svg'), 'utf8')
  for (const [size, out] of [
    [192, 'icon-192.png'],
    [512, 'icon-512.png'],
    [180, 'apple-touch-icon.png'],
  ]) {
    await writeFile(rel('web', 'public', 'icons', out), await renderPng(browser, tileSvg, size, size))
    console.log(`  icons/${out}  (${size})`)
  }

  // 3) og-image.svg → og-image.png（1200×630；file:// 文档形态加载使相对
  //    @font-face 生效——SVG 被 <img>/setContent 内联时外部字体不加载）
  const ogPage = await browser.newPage({ viewport: { width: 1200, height: 630 } })
  try {
    await ogPage.goto('file:///' + rel('site', 'assets', 'og-image.svg').replace(/\\/g, '/'))
    await ogPage.waitForFunction(() => document.fonts.status === 'loaded', null, { timeout: 10_000 })
    await ogPage.screenshot({
      path: rel('site', 'assets', 'og-image.png'),
      clip: { x: 0, y: 0, width: 1200, height: 630 },
    })
    console.log('  og-image.png  (1200x630)')
  } finally {
    await ogPage.close()
  }
  console.log('==> site assets generated')
} finally {
  await browser.close()
}
