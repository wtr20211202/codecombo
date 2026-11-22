import { test, expect, type APIRequestContext } from '@playwright/test'
import { deflateSync } from 'node:zlib'
import { DEFAULT_PASSWORD, gotoAndUnlock } from '../../tests/helpers'

/**
 * 项目文件直接预览（统一双视图）E2E（P-20261119-4 S3，用户主诉路径）：
 * 「现在要预览文档必须先生成一个分享链接自己才能查看」的根治验收——
 *   ① docx 点击打开即预览态：不再弹「binary not previewable」信息卡，
 *      S2 渲染管线直出（payload 懒加载到 content），「原文件|预览」分段
 *      开关在面包屑区；
 *   ② 双态切换：预览 → 原文件（二进制类=信息卡+下载出口）→ 预览，往返
 *      不断链；偏好记忆（per 扩展名 localStorage）跨重开生效；
 *   ③ 文本类零回归：md 打开仍默认 Monaco 编辑器（编辑工作流不回归），
 *      切预览走前端 marked+DOMPurify 管线整幅渲染；代码文件预览=只读
 *      文本态（统一双视图的预览半边）；csv 切预览出服务端净化表格；
 *   ④ 硬红线：html 预览 iframe 恒不含 allow-same-origin（静态默认 +
 *      opt-in scripts 两层同步）。
 *   ⑤ md 宽图适配+灯箱（P-20261120-3）：属性图（HTML img 带显式宽高）
 *      缩放适配容器宽（height:auto 释放属性高度）、三形态图片点击开
 *      灯箱（点击/Esc 关），编辑器侧栏预览同语义。
 * 字节级/净化链断言在 Go 单测（filepreview/extract_test、api/files/
 * preview_test）钉死，本 spec 钉 UI 分流与切换闭环。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'simple-coding'
const DIR = 'e2e-file-preview'
const DOCX = `${DIR}/report.docx`
const LONG_DOCX = `${DIR}/report-long.docx`
const CSV = `${DIR}/data.csv`
const MD = `${DIR}/notes.md`
const HTML = `${DIR}/page.html`
const MD_WIDE = `${DIR}/wide-img.md`

/** 真·宽 PNG（1600x2 8-bit 灰度，几十字节）：灰度 IHDR + 全零扫描线 deflate。
 *  标准语法形态用它证明「原图宽于容器」的缩放前提；data URI 内联规避应用侧
 *  md 相对路径不回源 raw 端点的现势（样张重点在尺寸链不在路径解析） */
function buildWidePng(): Buffer {
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    }
    return t
  })()
  const crc32 = (b: Buffer) => {
    let c = 0xFFFFFFFF
    for (const v of b) {
      c = crcTable[(c ^ v) & 0xFF] ^ (c >>> 8)
    }
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1600, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const raw = Buffer.alloc(2 * (1 + 1600))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 最小 docx（零压缩 zip；服务端按 zip 结构解）——正文一个标题段；
 *  paragraphs 参数撑出超长文档（P-20261120-5 布局收容用例：滚动收容断言
 *  需要内容高度数倍于视口） */
function buildDocx(paragraphs = 1): Buffer {
  const body = Array.from({ length: paragraphs }, (_, i) =>
    `<w:p><w:r><w:t>长文档收容验收段 ${i + 1}：本段用于把文档撑到视口多倍高度验证预览容器滚动收容。</w:t></w:r></w:p>`,
  ).join('')
  const doc = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>预览验收标题</w:t></w:r></w:p>${body}</w:body></w:document>`
  const crcTable = (() => {
    const t = new Uint32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      t[i] = c >>> 0
    }
    return t
  })()
  const crc32 = (b: Buffer) => {
    let c = 0xFFFFFFFF
    for (const v of b) c = crcTable[(c ^ v) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
  }
  const entries = [
    { name: 'word/document.xml', data: Buffer.from(doc) },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>') },
  ]
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const nameB = Buffer.from(e.name)
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30 + nameB.length)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6) // store
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(nameB.length, 26)
    nameB.copy(lh, 30)
    parts.push(lh, e.data)
    const ch = Buffer.alloc(46 + nameB.length)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(0, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(e.data.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(nameB.length, 28)
    ch.writeUInt32LE(offset, 42)
    nameB.copy(ch, 46)
    central.push(ch)
    offset += lh.length + e.data.length
  }
  const cdStart = offset
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(cdStart, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function putFile(request: APIRequestContext, headers: Record<string, string>, projectId: string, path: string, content: string) {
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  const res = await request.put(`${BASE}/api/projects/${projectId}/file`, {
    headers, data: { path, content },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJ)
  if (!p) throw new Error(`project ${PROJ} not found`)
  return p.id
}

let headers: Record<string, string>
let projectId = ''

test.beforeAll(async ({ request }) => {
  headers = await unlockHeaders(request)
  projectId = await getProjectId(request, headers)
  // 夹具：docx 走 multipart 上传（二进制直写无端点；files 数组形态在本仓
  // Playwright 版本有 stream 兼容问题，逐文件传）；文本文件走 PUT
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: DOCX } })
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: LONG_DOCX } })
  const up = await request.post(`${BASE}/api/projects/${projectId}/file/upload?dest=${DIR}`, {
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    multipart: { files: { name: 'report.docx', mimeType: 'application/octet-stream', buffer: buildDocx() } },
  })
  expect(up.ok(), await up.text()).toBeTruthy()
  const upLong = await request.post(`${BASE}/api/projects/${projectId}/file/upload?dest=${DIR}`, {
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    multipart: { files: { name: 'report-long.docx', mimeType: 'application/octet-stream', buffer: buildDocx(240) } },
  })
  expect(upLong.ok(), await upLong.text()).toBeTruthy()
  await putFile(request, headers, projectId, CSV, 'name,tip\nalice,hello\n')
  await putFile(request, headers, projectId, MD, '# 预览验收\n\n正文段落\n')
  await putFile(request, headers, projectId, HTML, '<!doctype html><html><head><title>p4</title></head><body><p id="ok">static body</p></body></html>')
  // 宽图样张（P-20261120-3）：三形态引用同一真·宽 PNG（data URI 内联）
  const wideURI = `data:image/png;base64,${buildWidePng().toString('base64')}`
  const wideMd = [
    '# 宽图适配与灯箱验收',
    '',
    `![标准宽图](${wideURI})`,
    '',
    `<img src="${wideURI}" width="3000" height="1600">`,
    '',
    '| 场景 | 截图 |',
    '| - | - |',
    `| 表格内 | <img src="${wideURI}"> |`,
    '',
  ].join('\n')
  await putFile(request, headers, projectId, MD_WIDE, wideMd)
})

test.afterAll(async ({ request }) => {
  for (const p of [DOCX, LONG_DOCX, CSV, MD, HTML, MD_WIDE]) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: p } })
  }
})

async function openFile(page: import('@playwright/test').Page, path: string) {
  await gotoAndUnlock(page, `${BASE}/project?project=${projectId}&file=${encodeURIComponent(path)}`)
  const tab = page.locator('.editor-tab.active')
  await expect(tab).toContainText(path.split('/').pop()!, { timeout: 10000 })
}

test('docx 打开即预览态：不再弹 binary 信息卡，S2 渲染直出（用户主诉路径）', async ({ page }) => {
  await openFile(page, DOCX)
  // 预览视图在场（懒加载完成后正文标题可见）
  await expect(page.getByTestId('file-preview-view')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('fpv-payload')).toContainText('预览验收标题')
  // 元信息卡不得出现（「binary not previewable」从用户路径消失）
  await expect(page.locator('.file-meta-card')).toHaveCount(0)
  // 双态开关在面包屑区，预览侧激活
  const switcher = page.getByTestId('pv-mode-switch')
  await expect(switcher).toBeVisible()
  await expect(page.getByTestId('pv-mode-preview')).toHaveClass(/on/)
})

test('双态切换：预览 → 原文件（信息卡+下载出口）→ 预览，往返闭环', async ({ page }) => {
  await openFile(page, DOCX)
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 15000 })
  // 切「原文件」：二进制类 = 信息卡 + 下载出口（不再是死胡同）
  await page.getByTestId('pv-mode-source').click()
  const card = page.getByTestId('file-source-card')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('file-source-download')).toBeVisible()
  await expect(page.locator('.CodeMirror, .monaco-editor')).toHaveCount(0)
  // 切回「预览」：payload 缓存复用立即呈现
  await page.getByTestId('pv-mode-preview').click()
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 15000 })
})

test('docx 视图偏好记忆：切原文件后重开同扩展名文件直接落原文件态', async ({ page }) => {
  await openFile(page, DOCX)
  await page.getByTestId('pv-mode-source').click()
  await expect(page.getByTestId('file-source-card')).toBeVisible()
  // 重开（同 context 新页面 = localStorage 延续；模拟「下次打开同类型」）
  await openFile(page, DOCX)
  await expect(page.getByTestId('file-source-card')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('file-preview-view')).toHaveCount(0)
  // 收尾复位偏好，防污染同 context 的后续用例
  await page.getByTestId('pv-mode-preview').click()
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 15000 })
})

test('md 零回归：默认编辑器 + 切预览走前端管线整幅渲染', async ({ page }) => {
  await openFile(page, MD)
  // 默认原文件态 = Monaco 编辑器（编辑工作流零回归——评审必改1 定案）
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  const switcher = page.getByTestId('pv-mode-switch')
  await expect(switcher).toBeVisible()
  await expect(page.getByTestId('pv-mode-source')).toHaveClass(/on/)
  // 切预览：前端 marked+DOMPurify 管线整幅渲染（S2 不产 md payload）
  await page.getByTestId('pv-mode-preview').click()
  const pv = page.locator('.file-preview-view .md-preview-content')
  await expect(pv).toBeVisible({ timeout: 10000 })
  await expect(pv).toContainText('预览验收')
  // 切回源码：Monaco 回归（视图状态缓存保光标/滚动）
  await page.getByTestId('pv-mode-source').click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  // 偏好记忆（S3 增补①）：文本类同享 per 扩展名记忆——切预览后重开同
  // 扩展名文件直接落预览态（缺省仍是原文件，编辑工作流零回归）
  await page.getByTestId('pv-mode-preview').click()
  await expect(page.locator('.file-preview-view .md-preview-content')).toContainText('预览验收', { timeout: 10000 })
  await openFile(page, MD)
  await expect(page.getByTestId('pv-mode-preview')).toHaveClass(/on/, { timeout: 15000 })
  await expect(page.locator('.file-preview-view .md-preview-content')).toContainText('预览验收', { timeout: 15000 })
  // 复位偏好（同 context 后续用例不吃 md 的遗留选择）
  await page.getByTestId('pv-mode-source').click()
})

test('csv 切预览：服务端净化表格直出（text 类的预览半边）', async ({ page }) => {
  await openFile(page, CSV)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.getByTestId('pv-mode-preview').click()
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('fpv-payload')).toContainText('alice')
})

test('md 宽图适配+灯箱（P-20261120-3）：属性图高度释放随宽等比，三形态点击开灯箱', async ({ page }) => {
  await openFile(page, MD_WIDE)
  // 前序用例收尾已复位源码偏好，这里防御双态：落在源码态就切预览
  if (await page.locator('.monaco-editor').count()) {
    await page.getByTestId('pv-mode-preview').click()
  }
  const pv = page.locator('.file-preview-view .md-preview-content')
  await expect(pv).toBeVisible({ timeout: 10000 })
  const imgs = pv.locator('img')
  await expect(imgs).toHaveCount(3)

  // 适配断言：三形态逐图 boundingBox ≤ 容器宽（横向溢出切片消失）；
  // 属性图（width=3000 height=1600）高度随宽等比释放——缺陷形态是 1600px
  // 巨条 + overflow:auto 只见切片（用户红箭头三处即被裁边缘）
  const cw = await pv.evaluate((el) => el.clientWidth)
  for (let i = 0; i < 3; i++) {
    const box = await imgs.nth(i).boundingBox()
    expect(box, `形态 ${i + 1} 缩放适配容器宽`).toBeTruthy()
    expect(box!.width).toBeLessThanOrEqual(cw + 1)
  }
  const attrBox = await imgs.nth(1).boundingBox()
  expect(attrBox!.height, '属性钉死高度释放（缺陷形态 ~1600px 巨条）').toBeLessThan(600)
  expect(Math.abs(attrBox!.height / attrBox!.width - 1600 / 3000), '等比守恒').toBeLessThan(0.02)

  // 灯箱（整幅预览面）：点击开 → Esc 关 → 重开 → 点击遮罩关
  await imgs.nth(1).click()
  const lb = page.locator('.md-lightbox')
  await expect(lb).toBeVisible()
  expect(await lb.locator('img').getAttribute('src')).toContain('data:image/png;base64,')
  await page.keyboard.press('Escape')
  await expect(lb).toHaveCount(0)
  await imgs.nth(2).click()
  await expect(lb).toBeVisible()
  await lb.click()
  await expect(lb).toHaveCount(0)

  // 编辑器侧栏预览同语义（EditorMdPreviewPane 同源接入）：切 split 后点
  // 侧栏预览内的图同样开灯箱
  await page.getByTestId('pv-mode-source').click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.locator('.pane-primary .md-mode-bar .md-mode-btn').filter({ hasText: /^源码\+预览$/ }).click()
  const paneImg = page.locator('.pane-primary .md-preview .md-preview-content img').first()
  await expect(paneImg).toBeVisible({ timeout: 10000 })
  await paneImg.click()
  await expect(lb).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lb).toHaveCount(0)
})

test('代码文件：预览态 = 只读文本半边（统一双视图全覆盖）', async ({ page }) => {
  // 仓内既有代码文件（主入口）：预览半边 = 只读文本态（不发请求）
  await openFile(page, 'main.go')
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.getByTestId('pv-mode-preview').click()
  const text = page.locator('.file-preview-view .fpv-text')
  await expect(text).toBeVisible({ timeout: 10000 })
  const body = await text.textContent()
  expect(body && body.length).toBeGreaterThan(0)
  // 切回源码编辑器
  await page.getByTestId('pv-mode-source').click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
})

test('html 预览：沙箱 iframe 恒不含 allow-same-origin（硬红线），opt-in 才加脚本', async ({ page }) => {
  await openFile(page, HTML)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.getByTestId('pv-mode-preview').click()
  // 静态默认：零脚本 iframe 在场（src 带 htmlview 无 scripts 参数）
  const frame = page.locator('.file-preview-view iframe.fpv-frame')
  await expect(frame).toBeVisible({ timeout: 15000 })
  const src = await frame.getAttribute('src')
  expect(src).toContain('/file/htmlview')
  expect(src).not.toContain('scripts=1')
  const sandbox = await frame.getAttribute('sandbox')
  expect(sandbox).not.toContain('allow-same-origin')
  // opt-in（两段确认）：脚本档仍无 allow-same-origin（父页登录态红线）
  await page.getByTestId('fpv-html-run-scripts').click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '运行该页面的脚本' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '确认' }).click()
  const frame2 = page.locator('.file-preview-view iframe.fpv-frame')
  await expect(frame2).toBeVisible()
  await expect(frame2).toHaveAttribute('src', /scripts=1/)
  const sandbox2 = await frame2.getAttribute('sandbox')
  expect(sandbox2).toContain('allow-scripts')
  expect(sandbox2).not.toContain('allow-same-origin')
})

// ── 布局收容（P-20261120-5，用户实测三症状）：曾因 .editor-content 缺
// display:flex 退化块流——预览高度失控撑破整条 flex 收容链：文档级滚动把
// 左侧工具栏滚出视口、内容透过底部面板下缘外泄。回归目标 = 预览滚动收口
// 在自身容器 + 文档零滚动 + 工具栏常驻 + 面板开合零遮挡 ──

test('超长文档收容：预览内滚收口、文档零滚动、深滚动后左侧工具栏常驻视口', async ({ page }) => {
  await openFile(page, LONG_DOCX)
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 20000 })
  // 断言①文档零滚动：修复前 doc scrollHeight ≈ 内容高（7000+px）＞视口
  const doc = await page.evaluate(() => ({
    docH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
  }))
  expect(doc.docH).toBeLessThanOrEqual(doc.winH)
  // 断言②预览容器被钳在视口内且自身是滚动容器（clientH < scrollH）
  const pv = page.getByTestId('file-preview-view')
  const pvBox = await pv.boundingBox()
  expect(pvBox!.y).toBeGreaterThanOrEqual(0)
  expect(pvBox!.height).toBeLessThan(doc.winH)
  const pvScroll = await page.evaluate(() => {
    const el = document.querySelector('.file-preview-view')!
    return { clientH: el.clientHeight, scrollH: el.scrollHeight }
  })
  expect(pvScroll.scrollH).toBeGreaterThan(pvScroll.clientH)
  // 深滚动（滚轮打在预览内容上=用户真实滚动形态）：滚动收口在预览容器，
  // 窗口与左侧工具栏零位移（修复前窗口滚到底、工具栏被滚出视口）
  await page.getByTestId('fpv-payload').hover()
  await page.mouse.wheel(0, 30000)
  await expect.poll(async () =>
    page.evaluate(() => document.querySelector('.file-preview-view')!.scrollTop),
  ).toBeGreaterThan(3000)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  const rail = await page.locator('.ide-rail').boundingBox()
  expect(rail!.y).toBe(0)
  expect(rail!.y + rail!.height).toBeLessThanOrEqual(doc.winH)
})

test('git 面板开合：预览滚动口与面板矩形零交叠，工具栏恒在视口，关面板回收幅面', async ({ page }) => {
  await openFile(page, LONG_DOCX)
  await expect(page.getByTestId('fpv-payload')).toBeVisible({ timeout: 20000 })
  // 打开底部 git 面板（rail 终端钮 → git 页签；git-panel-focus-refresh 同款定位纪律）
  await page.locator('.rail-btn[title="终端"]').click()
  await expect(page.getByTestId('bottom-panel')).toBeVisible()
  await page.getByTestId('bottom-tab-git').click()
  await expect(page.getByTestId('bottom-tab-git')).toHaveClass(/primary/, { timeout: 10000 })
  // 几何断言：预览滚动口（钳制后的可见范围）底缘 ≤ 面板顶缘——修复前预览
  // 内容直灌文档流、几何上穿越面板区（白表格内容透出面板下缘）
  const rects = await page.evaluate(() => {
    const pv = document.querySelector('.file-preview-view')!.getBoundingClientRect()
    const panel = document.querySelector('.bottom-panel')!.getBoundingClientRect()
    const rail = document.querySelector('.ide-rail')!.getBoundingClientRect()
    return {
      pvBottom: pv.bottom,
      panelTop: panel.top,
      panelBottom: panel.bottom,
      railTop: rail.top,
      railBottom: rail.bottom,
      winH: window.innerHeight,
      docH: document.documentElement.scrollHeight,
    }
  })
  expect(rects.pvBottom).toBeLessThanOrEqual(rects.panelTop + 1)
  expect(rects.panelBottom).toBeLessThanOrEqual(rects.winH)
  expect(rects.railTop).toBeGreaterThanOrEqual(0)
  expect(rects.railBottom).toBeLessThanOrEqual(rects.winH)
  expect(rects.docH).toBeLessThanOrEqual(rects.winH)
  // 面板挤压下预览仍是滚动容器（收口保持，不随挤压重新逃逸）
  await page.getByTestId('fpv-payload').hover()
  await page.mouse.wheel(0, 30000)
  await expect.poll(async () =>
    page.evaluate(() => document.querySelector('.file-preview-view')!.scrollTop),
  ).toBeGreaterThan(1000)
  // 关面板：预览回收释放幅面（底缘回到视口内但不越界）
  await page.getByTestId('bottom-panel-close').click()
  await expect(page.getByTestId('bottom-panel')).toBeHidden()
  const after = await page.evaluate(() => ({
    pvBottom: document.querySelector('.file-preview-view')!.getBoundingClientRect().bottom,
    winH: window.innerHeight,
    docH: document.documentElement.scrollHeight,
  }))
  expect(after.pvBottom).toBeLessThanOrEqual(after.winH)
  expect(after.docH).toBeLessThanOrEqual(after.winH)
})
