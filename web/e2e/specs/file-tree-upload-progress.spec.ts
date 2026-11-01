import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树拖拽上传进度与失败重试（P-20261003-117）：外部文件拖入/右键上传走
// 逐文件串行队列——树头浮条 N/M + 当前文件名推进、全部成功自动撤下（聚合
// 成功 toast 沿用）、失败文件进清单可定点/全部重试、可手动关闭放弃。
//
// 外部文件拖放以 page.evaluate 构造 DataTransfer + items.add(File) 模拟
// （Chromium 支持，dt.types 含 'Files' 命中 hasExternalFiles 外部上传分支）。
// 失败注入用 page.route 按 multipart body 内文件名 abort 对应请求——逐文件
// 串行队列正是本提案的结构前提：每文件独立请求才可独立失败/独立重试。
//
// 探针宿主与 file-tree-multi-move 同款：simple-coding 仓库 docs/ 下种子目录
// docs/e2e-upload-dest（上传落点），afterAll 整目录删除收尾。
const DEST_DIR = 'e2e-upload-dest'
const F_A = 'e2e-upload-a.md'
const F_B = 'e2e-upload-b.md'
const F_FLAKY1 = 'e2e-upload-flaky1.md'
const F_FLAKY2 = 'e2e-upload-flaky2.md'
const F_FLAKY3 = 'e2e-upload-flaky3.md'
const F_FLAKY4 = 'e2e-upload-flaky4.md'
const F_C = 'e2e-upload-c.md'
const UPLOAD_URL = '**/api/projects/*/file/upload*'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

function itemName(page: Page, name: string) {
  return page.locator('.item-name').filter({ hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) })
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

async function apiFile(pid: string, action: 'create' | 'delete' | 'mkdir', path: string) {
  const token = await unlockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content: 'probe' }),
  }).catch(() => {})
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

/** 虚拟列表行进 DOM 保证（multi-move 同款）：未命中自顶逐步进滚动 */
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

/** 外部文件拖入：目录行 dispatch dragover+drop，DataTransfer 携真实 File 对象 */
async function dropFilesOnto(page: Page, dirName: string, fileNames: string[]) {
  const row = await itemByName(page, dirName).elementHandle()
  await page.evaluate(([el, names]) => {
    const dt = new DataTransfer()
    for (const n of names!) dt.items.add(new File(['e2e upload probe'], n!, { type: 'text/markdown' }))
    el!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    el!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [row, fileNames])
}

/** 首个 upload 请求拖 800ms 再放行：给浮条进度断言留稳定窗口 */
async function holdFirstUpload(page: Page) {
  let held = false
  await page.route(UPLOAD_URL, async (route) => {
    if (!held) {
      held = true
      await new Promise(r => setTimeout(r, 800))
    }
    await route.continue()
  })
}

/** 按 multipart body 内文件名 abort：只失败指定文件（逐文件请求的前提红利） */
async function abortUploadsOf(page: Page, names: string[]) {
  await page.route(UPLOAD_URL, async (route) => {
    const body = route.request().postData() || ''
    if (names.some(n => body.includes(n))) await route.abort('failed')
    else await route.continue()
  })
}

test.beforeAll(async () => {
  const pid = await projectId('simple-coding')
  // 落点目录整树重置（上一轮残留会让重名断言翻车）
  await apiFile(pid, 'delete', `docs/${DEST_DIR}`)
  await apiFile(pid, 'mkdir', `docs/${DEST_DIR}`)
})

test.afterAll(async () => {
  try {
    const pid = await projectId('simple-coding')
    await apiFile(pid, 'delete', `docs/${DEST_DIR}`)
    // 根目录保险清理：探针误落项目根（如行级 drop 冒泡回归）不留垃圾
    for (const p of [F_A, F_B, F_FLAKY1, F_FLAKY2, F_FLAKY3, F_FLAKY4, F_C]) await apiFile(pid, 'delete', p)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树拖拽上传进度与失败重试', () => {
  test('多文件拖入：浮条进度推进 → 全部成功自动撤下 + 聚合 toast + 文件落地', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    await holdFirstUpload(page)

    await dropFilesOnto(page, DEST_DIR, [F_A, F_B])

    // 进度浮条：N/M 文件 + 当前文件名（首个请求被拖住，稳定在 0/2）
    const floatText = page.getByTestId('upload-progress-text')
    await expect(floatText).toBeVisible({ timeout: 5000 })
    await expect(floatText).toHaveText(/正在上传 [01]\/2：e2e-upload-a\.md/)

    // 完成即撤：浮条消失，聚合成功 toast 沿用（一条，不逐文件刷）
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText(`已上传 2 个文件到 docs/${DEST_DIR}`)).toBeVisible({ timeout: 5000 })

    // 文件真实落地：展开目标目录可见（refreshTargetPath 已刷新）
    await itemByName(page, DEST_DIR).click()
    await ensureRowVisible(page, F_A)
    await expect(itemByName(page, F_A)).toBeVisible()
    await ensureRowVisible(page, F_B)
    await expect(itemByName(page, F_B)).toBeVisible()
  })

  test('单文件失败：清单呈现 → 定点重试成功收尾', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    await abortUploadsOf(page, [F_FLAKY1])

    await dropFilesOnto(page, DEST_DIR, [F_FLAKY1])

    // 失败清单：标题计数 + 文件名 + 逐个重试钮；silent 上传无拦截器错误 toast
    await expect(page.getByTestId('upload-failed-title')).toHaveText('1 个文件上传失败', { timeout: 10000 })
    await expect(page.getByTestId('upload-failed-list')).toContainText(F_FLAKY1)
    await expect(page.getByTestId('upload-retry-one')).toBeVisible()

    // 解除注入后定点重试：成功结算（toast + 浮条撤下 + 文件落地）
    await page.unrouteAll()
    await page.getByTestId('upload-retry-one').click()
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText(`已上传 1 个文件到 docs/${DEST_DIR}`)).toBeVisible({ timeout: 5000 })
    await itemByName(page, DEST_DIR).click()
    await ensureRowVisible(page, F_FLAKY1)
    await expect(itemByName(page, F_FLAKY1)).toBeVisible()
  })

  test('多文件失败：全部重试一次收编 → 成功后浮条撤下', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    // P-230 同名确认后本文件各用例的拖入名单互不重叠（F_FLAKY1 已在上一用例
    // 落地，重拖会触发同名确认框——覆盖确认面归 file-tree-upload-overwrite.spec）
    await abortUploadsOf(page, [F_FLAKY2, F_FLAKY3])

    await dropFilesOnto(page, DEST_DIR, [F_FLAKY2, F_FLAKY3])

    await expect(page.getByTestId('upload-failed-title')).toHaveText('2 个文件上传失败', { timeout: 10000 })
    // 多项失败时「全部重试」可见（单项只有逐个钮）
    await expect(page.getByTestId('upload-retry-all')).toBeVisible()

    await page.unrouteAll()
    await page.getByTestId('upload-retry-all').click()
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText(`已上传 2 个文件到 docs/${DEST_DIR}`)).toBeVisible({ timeout: 5000 })
  })

  test('手动关闭放弃失败项：浮条撤下不再发请求', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)

    let uploadCount = 0
    await page.route(UPLOAD_URL, async (route) => {
      uploadCount++
      const body = route.request().postData() || ''
      if (body.includes(F_FLAKY4)) await route.abort('failed')
      else await route.continue()
    })

    // F_FLAKY4 为本用例专属新名（此前用例的文件已在目录内，重拖即同名确认框）
    await dropFilesOnto(page, DEST_DIR, [F_FLAKY4])
    await expect(page.getByTestId('upload-failed-title')).toHaveText('1 个文件上传失败', { timeout: 10000 })

    // 关闭 = 放弃失败项：浮条撤下；随后不再有任何 upload 请求（计数不涨）
    await page.getByTestId('upload-dismiss').click()
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 5000 })
    await page.waitForTimeout(1000)
    const countAtDismiss = uploadCount
    expect(countAtDismiss).toBe(1)

    // 关闭后再拖一个正常文件：队列照常工作（上一会话的放弃不影响新会话）。
    // F_C 同为专属新名，避免命中同名确认框（P-230）
    await dropFilesOnto(page, DEST_DIR, [F_C])
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText(`已上传 1 个文件到 docs/${DEST_DIR}`)).toBeVisible({ timeout: 5000 })
  })
})
