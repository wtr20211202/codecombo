import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树拖入上传的同名覆盖确认（P-20261003-230）：拖入命中目标目录同名文件时
// 弹「N 个同名文件：跳过/覆盖」确认框（默认跳过安全）——跳过保留现有文件且不
// 发上传请求（就地跳过反馈）；覆盖带 ?overwrite=1 请求替换为拖入内容，服务端
// 覆盖前把旧内容留档本地历史（P-130 钩子，内容面归 Go 单测，此处断言替换生效）。
//
// 外部文件拖入与 file-tree-upload-progress 同款：page.evaluate 构造
// DataTransfer + items.add(File)（Chromium 支持，dt.types 含 'Files' 命中
// hasExternalFiles 外部上传分支）。文件内容经 API 读回断言（不依赖编辑器链）。
//
// 探针宿主与 file-tree-upload-progress 同款：docs/ 下种子目录
// docs/e2e-upload-overwrite-dest（上传落点），afterAll 整目录删除收尾。
const DEST_DIR = 'e2e-upload-overwrite-dest'
const F_SAME = 'e2e-upload-overwrite.md'
const V1 = 'v1-seeded-original-content'
const V2 = 'v2-dropped-overwrite-content'
const V3 = 'v3-dropped-again-must-not-land'
const UPLOAD_URL = '**/api/projects/*/file/upload*'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function unlockToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  })
  return (await res.json()).token || ''
}

async function projectId(name: string): Promise<string> {
  const token = await unlockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === name)
  if (!mine) throw new Error(`${name} 项目不存在`)
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'delete' | 'mkdir', path: string, content = 'probe') {
  const token = await unlockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content }),
  }).catch(() => {})
}

/** API 读回文件正文（ReadFile 的 data 字段）：内容断言不依赖编辑器链 */
async function apiReadFile(pid: string, path: string): Promise<string> {
  const token = await unlockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  const j = await res.json()
  return (j?.data ?? '') as string
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——可见即就位，否则奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

/** 虚拟列表行进 DOM 保证（upload-progress 同款）：未命中自顶逐步进滚动 */
async function ensureRowVisible(page: Page, name: string) {
  for (let i = 0; i < 25; i++) {
    if (await itemByName(page, name).isVisible().catch(() => false)) return
    await page.locator('.virtual-list-container').evaluate((el, step) => {
      el.scrollTop = step === 0 ? 0 : el.scrollTop + 200
    }, i)
    await page.waitForTimeout(150)
  }
  throw new Error(`tree row ${name} 未进入虚拟窗口`)
}

async function revealDestDir(page: Page) {
  await ensureRowVisible(page, 'docs')
  for (let i = 0; i < 6; i++) {
    const arrow = (await itemByName(page, 'docs').locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') break
    await itemByName(page, 'docs').click()
    await page.waitForTimeout(600)
  }
  await ensureRowVisible(page, DEST_DIR)
}

/** 外部文件拖入：目录行 dispatch dragover+drop，DataTransfer 携指定内容的 File */
async function dropFileWithContent(page: Page, dirName: string, fileName: string, content: string) {
  const row = await itemByName(page, dirName).elementHandle()
  await page.evaluate(([el, name, body]) => {
    const dt = new DataTransfer()
    dt.items.add(new File([body!], name!, { type: 'text/markdown' }))
    el!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [row, fileName, content])
}

test.beforeAll(async () => {
  const pid = await projectId('simple-coding')
  // 落点目录整树重置 + 种子同名文件 V1（上一轮残留会让内容断言翻车）
  await apiFile(pid, 'delete', `docs/${DEST_DIR}`)
  await apiFile(pid, 'mkdir', `docs/${DEST_DIR}`)
  await apiFile(pid, 'create', `docs/${DEST_DIR}/${F_SAME}`, V1)
})

test.afterAll(async () => {
  try {
    const pid = await projectId('simple-coding')
    await apiFile(pid, 'delete', `docs/${DEST_DIR}`)
    // 根目录保险清理：探针误落项目根不留垃圾
    await apiFile(pid, 'delete', F_SAME)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树拖入上传的同名覆盖确认', () => {
  test('同名拖入 → 确认框 → 覆盖：请求带 overwrite=1，内容替换为拖入版本', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    // 记录 upload 请求 URL：覆盖档必须带 overwrite=1（缺省跳过档不带键）
    const uploadUrls: string[] = []
    await page.route(UPLOAD_URL, async (route) => {
      uploadUrls.push(route.request().url())
      await route.continue()
    })

    await dropFileWithContent(page, DEST_DIR, F_SAME, V2)

    // 确认框：携同名名单 + 两个处置按钮（默认跳过安全，覆盖为警示档）
    await expect(page.getByTestId('upload-same-name-dialog')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('upload-same-name-dialog')).toContainText(F_SAME)
    await page.getByTestId('upload-same-name-overwrite').click()

    // 上传完成浮条撤下；请求带覆盖档；目标内容替换为拖入版本
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    expect(uploadUrls.some(u => u.includes('overwrite=1'))).toBe(true)
    await expect.poll(() => apiReadFile(pid, `docs/${DEST_DIR}/${F_SAME}`), { timeout: 10000 }).toBe(V2)
  })

  test('同名拖入 → 默认跳过：保留现有内容，零上传请求 + 就地跳过反馈', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    // 上一用例覆盖后盘上是 V2；本用例跳过档必须原样保留
    let uploadCount = 0
    await page.route(UPLOAD_URL, async (route) => {
      uploadCount++
      await route.continue()
    })

    await dropFileWithContent(page, DEST_DIR, F_SAME, V3)

    await expect(page.getByTestId('upload-same-name-dialog')).toBeVisible({ timeout: 5000 })
    await page.getByTestId('upload-same-name-skip').click()

    // 跳过：不发任何上传请求（缺省档安全语义），就地反馈跳过清单
    await page.waitForTimeout(1200)
    expect(uploadCount).toBe(0)
    await expect(page.getByText('已跳过 1 个同名文件：e2e-upload-overwrite.md')).toBeVisible({ timeout: 5000 })
    await expect.poll(() => apiReadFile(pid, `docs/${DEST_DIR}/${F_SAME}`), { timeout: 10000 }).toBe(V2)
  })
})
