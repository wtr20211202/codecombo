import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 粘贴图片前端压缩（P-20261003-204）E2E：
 *   1. 大图粘贴 → 重采样压缩为 JPEG：上传体积 < 原图一半（工具内「编码结果
 *      不比原图小即回退原图」守卫下，严格小于 = 压缩路径真实生效）+ 落盘文件
 *      是 JPEG（SOI FFD8）
 *   2. 透明 PNG 大图粘贴 → 检测到实际透明像素保留 PNG 格式（魔数 + IHDR
 *      宽度 1920 = 触发了保 PNG 的缩放重编码而非原样直传）
 *   3. 压缩失败（stub createImageBitmap reject）→ 降级原图：上传字节数与
 *      剪贴板读回原图完全一致 + 仍为 PNG 未缩放
 * 前置（spec 内自备）：临时空项目；剪贴板图片读写走 Chromium 权限授予
 * （paste-threshold.spec.ts 同款）；测试图在浏览器内 canvas 现生成（种子化
 * 随机内容贴近真实截图熵量）。体积基线取「剪贴板读回」而非写入侧——Windows
 * 剪贴板经系统格式中转会对图片字节重编码（实测写入 2885511 → 读回 2516529），
 * 前端压缩管线看到的正是读回形态。上传结果文件从响应 path 直接 fs 读取断言
 * 后清理
 */

// Chromium 剪贴板 API 需显式授予（share-rotate.spec.ts 同款）
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-paste-image-compress'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-paste-image-compress')

let unlockToken = ''
const servedPaths: string[] = []

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test.afterEach(async () => {
  // 清理本用例落盘的 sc-paste-* 临时文件（服务端 24h 清理兜底，这里用完即清）
  while (servedPaths.length > 0) {
    const p = servedPaths.pop()!
    try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ }
  }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

/**
 * 在浏览器内 canvas 生成「截图样」PNG 并写入剪贴板，返回写入侧 blob 字节数。
 * 两模式都画满致密内容（渐变底 + 高熵彩色块 + 密集文本行）：
 * mode='alpha-frame' 额外 clearRect 四边 80px 透明边框——真实透明像素必然检出，
 * 且内部致密保证缩放重编码体积确实下降（稀疏透明图 PNG 压得极好，缩放重编码
 * 反而可能更大，会触发「不比原图小即回退」守卫，测不到保 PNG 路径——实测踩坑）
 */
async function putScreenshotPngInClipboard(
  page: Page,
  width: number,
  height: number,
  mode: 'opaque' | 'alpha-frame',
): Promise<number> {
  return await page.evaluate(async ([w, h, mode]) => {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    const grad = ctx.createLinearGradient(0, 0, w, h)
    grad.addColorStop(0, '#fafafa')
    grad.addColorStop(1, '#dfe3ee')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    let seed = 42
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    ctx.globalAlpha = 0.9
    for (let i = 0; i < 2500; i++) {
      ctx.fillStyle = `hsl(${Math.floor(rnd() * 360)}, ${40 + Math.floor(rnd() * 50)}%, ${25 + Math.floor(rnd() * 55)}%)`
      ctx.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * h), 6 + rnd() * 26, 6 + rnd() * 26)
    }
    ctx.globalAlpha = 1
    ctx.fillStyle = '#101418'
    ctx.font = '15px monospace'
    for (let y = 22; y < h; y += 22) {
      ctx.fillText('const answer = compute(x, y) // paste-image-compress e2e 行', 8, y)
    }
    if (mode === 'alpha-frame') {
      const m = 80
      ctx.clearRect(0, 0, w, m)
      ctx.clearRect(0, h - m, w, m)
      ctx.clearRect(0, 0, m, h)
      ctx.clearRect(w - m, 0, m, h)
    }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob(b => resolve(b!), 'image/png'))
    ;(window as unknown as { __e2ePasteBlob: Blob }).__e2ePasteBlob = blob
    return blob.size
  }, [width, height, mode])
}

async function writeStoredBlobToClipboard(page: Page) {
  await page.evaluate(() => {
    const blob = (window as unknown as { __e2ePasteBlob: Blob }).__e2ePasteBlob
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  })
}

/** 剪贴板读回图片的体积与尺寸：前端压缩管线实际看到的输入形态（体积基线）。
 * 尺寸经 Image 解码取 naturalWidth/Height——createImageBitmap 在压缩失败用例里
 * 被页面级 stub 掉，辅助函数不能依赖它 */
async function readBackClipboardImage(page: Page): Promise<{ size: number; width: number; height: number }> {
  return await page.evaluate(async () => {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      const t = item.types.find(x => x.startsWith('image/'))
      if (!t) continue
      const blob = await item.getType(t)
      const url = URL.createObjectURL(blob)
      try {
        const img = new Image()
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve()
          img.onerror = () => reject(new Error('decode failed'))
          img.src = url
        })
        return { size: blob.size, width: img.naturalWidth, height: img.naturalHeight }
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    throw new Error('no image in clipboard')
  })
}

// 右键终端 → 菜单「粘贴」（pasteFromClipboard → tryPasteImage 图片优先链路）
async function pasteViaContextMenu(page: Page, xterm: ReturnType<Page['locator']>) {
  await xterm.click({ button: 'right' })
  const menu = page.locator('.term-context-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.term-context-item').filter({ hasText: '粘贴' }).first().click()
}

interface PasteUpload {
  size: number
  diskPath: string
}

/** 触发右键粘贴并捕获 paste-image 上传响应（size=服务端实收字节数）+ 落盘文件路径 */
async function pasteImageAndCaptureUpload(page: Page, xterm: ReturnType<Page['locator']>): Promise<PasteUpload> {
  const respPromise = page.waitForResponse(
    r => r.url().includes('/api/terminals/paste-image') && r.request().method() === 'POST',
    { timeout: 30000 },
  )
  await pasteViaContextMenu(page, xterm)
  const resp = await respPromise
  expect(resp.status()).toBe(200)
  const body = (await resp.json()) as { data?: { path?: string; size?: number } }
  expect(body.data?.path).toBeTruthy()
  expect(typeof body.data?.size).toBe('number')
  servedPaths.push(body.data!.path!)
  return { size: body.data!.size!, diskPath: body.data!.path! }
}

test('大图粘贴：重采样压缩后上传体积降，落盘为 JPEG', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 2600x1600（Retina 截图量级，超 1920 上限必触发缩放）
  const originalSize = await putScreenshotPngInClipboard(page, 2600, 1600, 'opaque')
  expect(originalSize).toBeGreaterThan(300 * 1024)
  await writeStoredBlobToClipboard(page)

  const upload = await pasteImageAndCaptureUpload(page, xterm)
  // 严格小于原图才可能是压缩产物：工具内「编码结果 >= 原图即回退原图」守卫下，
  // 相等只属于降级路径。实测量级为原图的 ~1/4（JPEG 0.85 @1920 对高熵内容）
  expect(upload.size).toBeLessThan(originalSize)
  expect(upload.size).toBeLessThan(Math.floor(originalSize / 2))

  // 落盘文件确为 JPEG（SOI FFD8）——PNG→JPEG 格式转换发生
  const served = fs.readFileSync(upload.diskPath)
  expect(served[0]).toBe(0xff)
  expect(served[1]).toBe(0xd8)
  expect(served.length).toBe(upload.size)

  // 路径文本贴入终端（粘贴闭环正证据）
  await expect(xterm).toContainText('sc-paste-', { timeout: 20000 })
})

test('透明 PNG 大图粘贴：保留 PNG 格式（缩放重编码）', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 3000x2000 带透明边框（内部致密）：alpha=0 像素必检出；超 1920 必触发缩放
  await putScreenshotPngInClipboard(page, 3000, 2000, 'alpha-frame')
  await writeStoredBlobToClipboard(page)
  const readBack = await readBackClipboardImage(page)
  expect(readBack.width).toBe(3000)

  const upload = await pasteImageAndCaptureUpload(page, xterm)
  await expect(xterm).toContainText('sc-paste-', { timeout: 20000 })

  // 仍是 PNG（魔数）：透明像素保 PNG 格式，未塌成 JPEG
  const served = fs.readFileSync(upload.diskPath)
  expect(served[0]).toBe(0x89)
  expect(served[1]).toBe(0x50) // 'P'
  expect(served.length).toBe(upload.size)

  // IHDR 宽度（大端，偏移 16）=1920：证明走的是「保 PNG 的缩放重编码」而非原样直传
  expect(served.readUInt32BE(16)).toBe(1920)
  // 缩放重编码后体积下降（0.64 线性 / 0.41 面积，内部致密足以覆盖边框与抗锯齿增量）
  expect(upload.size).toBeLessThan(readBack.size)
})

test('压缩失败降级原图：上传字节数与剪贴板读回原图一致且未缩放', async ({ page }) => {
  test.setTimeout(180000)
  // 在应用脚本之前把 createImageBitmap 打成必 reject：压缩链第一步解码即失败，
  // 降级原图上传（强制失败注入，覆盖③降级语义）
  await page.addInitScript(() => {
    Object.defineProperty(window, 'createImageBitmap', {
      value: () => Promise.reject(new Error('e2e forced decode failure')),
      configurable: true,
    })
  })
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  await putScreenshotPngInClipboard(page, 2600, 1600, 'opaque')
  await writeStoredBlobToClipboard(page)
  // 体积基线 = 剪贴板读回形态（Windows 剪贴板系统格式中转会重编码图片字节，
  // 与前端管线看到的输入一致）
  const readBack = await readBackClipboardImage(page)

  const upload = await pasteImageAndCaptureUpload(page, xterm)
  // 原图直传：字节数一字不差，且未被缩放（IHDR 宽度仍为原始 2600）
  expect(upload.size).toBe(readBack.size)
  const served = fs.readFileSync(upload.diskPath)
  expect(served.length).toBe(readBack.size)
  expect(served[0]).toBe(0x89)
  expect(served[1]).toBe(0x50) // 'P'
  expect(served.readUInt32BE(16)).toBe(2600)
  await expect(xterm).toContainText('sc-paste-', { timeout: 20000 })
})
