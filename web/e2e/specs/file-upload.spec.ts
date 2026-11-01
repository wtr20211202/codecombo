import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 本地 upload 全链 e2e（P-20261004-128）：文件树右键「上传文件…」选择器入口
// （openUploadPicker 置 uploadDir → 隐藏 input.upload-input → onFilePicked）→
// 逐文件串行队列 → multipart POST /file/upload → 服务端原子落盘（P-20261004-10
// uniqueTmp+rename）→ refreshTargetPath 树刷新。拖入入口的进度/失败重试与同名
// 确认两形态已有专属 spec（file-tree-upload-progress / file-tree-upload-overwrite
// 均走 DataTransfer drop），选择器入口此前零覆盖——本 spec 补齐该入口全链。
//
// 三形态：
//   ① 两文件上传 → 聚合成功 toast + 树出现两行 + API 读回内容逐字正确；
//   ② 同名上传 → P-230 确认框选「覆盖」→ 请求带 overwrite=1 → 读回为新版
//     （P-10 原子语义的黑盒佐证：rename 单一替换入口，目标要么旧完整版要么新完整版）；
//   ③ 服务端 skipped 形态 → 逐条 warning 可见 + 不入失败重试清单 + 不刷树 + 零落盘。
//     提案原文写「超限 413」，现网本地 upload 端点对超限是 200+skipped（file.go
//     UploadFiles：per-file/total 10GB 超限进 skipped，LimitBody→413 只在 JSON 写
//     路径）——按现实超限契约断言；10GB 无法在 e2e 真实送达，用 route.fulfill 按
//     服务端真实响应形状（{message,saved,skipped,dest}，reason 沿用服务端稳定原文
//     「file too large (max 10GB)」）注入该形态，钉住 UI 对 skipped 的记账契约：
//     saved 为空不计成功、不触发刷新、不进失败清单（重试同理由会再跳过）。
//
// 探针宿主与 file-tree-upload-progress 同款：simple-coding 仓库 docs/ 下种子目录
// docs/e2e-upload-pick-dest（上传落点），afterAll 整目录删除收尾。
const DEST_DIR = 'e2e-upload-pick-dest'
const F_A = 'e2e-pick-alpha.md'
const V_A = 'alpha-picked-content'
const F_B = 'e2e-pick-beta.md'
const V_B = 'beta-picked-content'
const F_SAME = 'e2e-pick-overwrite.md'
const V1 = 'v1-seeded-original-content'
const V2 = 'v2-picked-overwrite-content'
const F_BIG = 'e2e-pick-oversize.md'
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

/** API 读回文件正文（ReadFile 的 data 字段）；!ok（如 404 未落盘）返回 null */
async function apiReadFileOptional(pid: string, path: string): Promise<string | null> {
  const token = await unlockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  if (!res.ok) return null
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

/** 选择器入口上传：目录行右键 →「上传文件…」→ filechooser 事件携 buffer setFiles。
 *  走 openUploadPicker 真链路（uploadDir 快照 + input click），不用 setInputFiles
 *  直打隐藏 input——那会绕过 uploadDir 置值，落点退化为项目根 */
async function uploadViaPicker(page: Page, dirName: string, files: Array<{ name: string; content: string }>) {
  await itemByName(page, dirName).click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  const chooserPromise = page.waitForEvent('filechooser')
  await page.locator('.n-dropdown-menu').getByText('上传文件…', { exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(
    files.map(f => ({ name: f.name, mimeType: 'text/markdown', buffer: Buffer.from(f.content, 'utf8') })),
  )
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
    for (const p of [F_A, F_B, F_SAME, F_BIG]) await apiFile(pid, 'delete', p)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树选择器上传全链', () => {
  test('两文件上传：成功 toast + 树出现两行 + 内容逐字正确', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    await uploadViaPicker(page, DEST_DIR, [
      { name: F_A, content: V_A },
      { name: F_B, content: V_B },
    ])

    // 全部成功浮条自动撤下 + 聚合成功 toast（fileTree.uploadSuccess，N=2 不逐文件刷）
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    await expect(page.getByText(`已上传 2 个文件到 docs/${DEST_DIR}`)).toBeVisible({ timeout: 5000 })

    // 树刷新落地：展开目标目录可见两行（refreshTargetPath 已刷新）
    await itemByName(page, DEST_DIR).click()
    await ensureRowVisible(page, F_A)
    await expect(itemByName(page, F_A)).toBeVisible()
    await ensureRowVisible(page, F_B)
    await expect(itemByName(page, F_B)).toBeVisible()

    // 内容逐字正确：API 读回（落盘面权威，不依赖编辑器链）
    await expect.poll(() => apiReadFileOptional(pid, `docs/${DEST_DIR}/${F_A}`), { timeout: 10000 }).toBe(V_A)
    await expect.poll(() => apiReadFileOptional(pid, `docs/${DEST_DIR}/${F_B}`), { timeout: 10000 }).toBe(V_B)
  })

  test('同名上传 → 确认框「覆盖」：请求带 overwrite=1，内容替换为新版', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    // 记录 upload 请求 URL：覆盖档必须带 overwrite=1（file-upload 请求带缺省档不带键）
    const uploadUrls: string[] = []
    await page.route(UPLOAD_URL, async (route) => {
      uploadUrls.push(route.request().url())
      await route.continue()
    })

    await uploadViaPicker(page, DEST_DIR, [{ name: F_SAME, content: V2 }])

    // 同名确认框（P-230）：携同名名单，覆盖为警示档
    await expect(page.getByTestId('upload-same-name-dialog')).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('upload-same-name-dialog')).toContainText(F_SAME)
    await page.getByTestId('upload-same-name-overwrite').click()

    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    expect(uploadUrls.some(u => u.includes('overwrite=1'))).toBe(true)
    // P-10 原子语义黑盒佐证：读回 = 新完整版（rename 单一替换入口，无半截内容）
    await expect.poll(() => apiReadFileOptional(pid, `docs/${DEST_DIR}/${F_SAME}`), { timeout: 10000 }).toBe(V2)
  })

  test('服务端 skipped 形态：逐条 warning 可见，不入失败清单不刷树零落盘', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await revealDestDir(page)
    const pid = await projectId('simple-coding')

    // 按 multipart body 内文件名命中注入（abortUploadsOf 同款定位），应答体逐字段
    // 对齐 UploadFiles 的真实成功形状（{message,saved,skipped,dest}）+ 超限稳定原文
    await page.route(UPLOAD_URL, async (route) => {
      const body = route.request().postData() || ''
      if (body.includes(F_BIG)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'upload done',
            saved: [] as string[],
            skipped: [{ name: F_BIG, reason: 'file too large (max 10GB)' }],
            dest: `docs/${DEST_DIR}`,
          }),
        })
      } else {
        await route.continue()
      }
    })

    await uploadViaPicker(page, DEST_DIR, [{ name: F_BIG, content: 'oversize-probe' }])

    // 逐条 skipped warning（`${name}: ${reason}` 原文拼接）可见 = 提示可见
    await expect(page.getByText(`${F_BIG}: file too large (max 10GB)`)).toBeVisible({ timeout: 5000 })
    // saved 为空：不结算成功 toast、无失败遗留浮条自动撤下；skipped 不入失败
    // 重试清单（重试同理由会再跳过，可行动面是改名/清理而非盲目重试）
    await expect(page.getByTestId('upload-float')).toBeHidden({ timeout: 10000 })
    await expect(page.getByTestId('upload-failed-list')).toBeHidden()
    await expect(page.getByText(`已上传 1 个文件到 docs/${DEST_DIR}`)).toBeHidden()

    // 树不污染：展开目录兄弟行在窗口内而 oversize 行缺席；API 权威读回 !ok
    await itemByName(page, DEST_DIR).click()
    await ensureRowVisible(page, F_A)
    await expect(itemByName(page, F_BIG)).toBeHidden()
    await expect.poll(() => apiReadFileOptional(pid, `docs/${DEST_DIR}/${F_BIG}`), { timeout: 10000 }).toBeNull()
  })
})
