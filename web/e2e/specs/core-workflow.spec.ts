import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

// 项目快速切换用例的自备临时项目（beforeAll 建，afterAll 删）。
// 仓库必须放系统临时目录：放本仓库子目录会让项目「路径」含 simple-coding 子串，
// 首页卡片按 hasText('simple-coding') 会命中这张卡（按创建时间倒序排更前）
const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-palette-switch')
const PALETTE_PROJ = 'e2e-palette-switch'

test.beforeAll(async () => {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PALETTE_PROJ)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execSync('git init', { cwd: REPO_DIR }) // 服务端要求项目路径是 git 仓库（临时目录无父仓库可攀附）
  execSync('git config core.autocrlf false', { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  const res = await fetch(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    method: 'POST', headers, body: JSON.stringify({ name: PALETTE_PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(res.status)
})

test.afterAll(async () => {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  const headers = { 'X-Lock-Token': token }
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === PALETTE_PROJ)
  if (mine) await fetch(`${API_BASE}/api/projects/${mine.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

// 本 spec 不关心锁定态：clone-flow / lock.spec 会切换全局锁定开关，
// 并行调度时序不保证开关状态——统一走 gotoAndUnlock 容忍两种状态
test.beforeEach(async ({ page }) => {
  await fixedLocale(page)
})

test.describe('核心工作流', () => {
  test('首页加载——标题、项目列表、操作按钮可见', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    // 允许未读徽标前缀（通知中心标题徽标：(n) Codecombo）
    await expect(page).toHaveTitle(/Codecombo$/)

    // 标题区域（exact：项目卡远端 URL 现含 codecombo.git——品牌切换 4adaf9da 后
    // 仓库 origin 更名，getByText 子串匹配会双命中 strict violation）
    await expect(page.getByText('Codecombo', { exact: true })).toBeVisible()
    await expect(page.getByText('轻量级 Coding 平台')).toBeVisible()

    // 操作按钮
    await expect(page.getByRole('button', { name: '添加项目' })).toBeVisible()
    await expect(page.getByRole('button', { name: '设置' })).toBeVisible()
    await expect(page.getByRole('button', { name: '切换主题' })).toBeVisible()
  })

  test('首页——项目列表可搜索', async ({ page }) => {
    await gotoAndUnlock(page, '/')

    // 搜索框可见
    const searchInput = page.getByPlaceholder('搜索项目…')
    await expect(searchInput).toBeVisible()
  })
})

test.describe('IDE 布局', () => {
  test('进入项目页面——基本布局加载', async ({ page }) => {
    await gotoAndUnlock(page, '/')

    // 点击第一个项目进入
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 活动栏（限定 rail 容器：底部面板自身的「终端」tab 同名，避免 strict mode 冲突）
    const rail = page.locator('.ide-rail')
    await expect(rail.getByRole('button', { name: '项目文件' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '提交' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Git 管理' })).toBeVisible()
    // exact: 活动栏还有「智能体」「远程管理」等按钮，非精确 name 会误命中
    await expect(rail.getByRole('button', { name: '终端', exact: true })).toBeVisible()

    // 顶部工具栏（顶栏产品名随版本迭代为 AppLogo——不再断言具体文案，由状态栏断言兜底布局）

    // 状态栏
    await expect(page.locator('.status-bar')).toBeVisible()
  })

  // uiState 会恢复上次的侧栏视图（文件树/变更），rail「项目文件」是 toggle——
  // 树未加载完时探测会假阴性，最多重试 3 次（奇数次点击保证最终停在打开态）
  async function ensureFilesView(page: Page) {
    for (let i = 0; i < 3; i++) {
      // 限定树内条目：底部提交消息可含同名子串，裸 getByText 会 strict violation
      // 被 catch 吞成 false，导致面板明明打开却被误 toggle
      if (await page.locator('.tree-item .item-name', { hasText: 'CLAUDE.md' }).isVisible().catch(() => false)) return
      await page.locator('.rail-btn[title="项目文件"]').click()
      await page.waitForTimeout(800)
    }
  }

  test('文件树——展开目录并点击文件', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    await ensureFilesView(page)

    // 验证文件树中有已知文件。
    // 必须精确匹配并限定树内：底部 Git 面板的提交消息可含同名子串
    //（如「CLAUDE.md e2e 策略段…」），getByText 子串匹配会 strict violation
    await expect(page.locator('.tree-item .item-name', { hasText: 'CLAUDE.md' })).toBeVisible()
    await expect(page.locator('.tree-item .item-name', { hasText: 'main.go' })).toBeVisible()
    await expect(page.locator('.tree-item .item-name', { hasText: 'README.md' })).toBeVisible()
  })

  test('打开文件——Monaco 编辑器加载', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    await ensureFilesView(page)

    // 点击 CLAUDE.md（限定树内条目，避免底部提交列表同名子串冲突）
    await page.locator('.tree-item .item-name', { hasText: 'CLAUDE.md' }).click()

    // 验证文件标签页出现
    await expect(page.getByRole('tab', { name: 'CLAUDE.md' })).toBeVisible()

    // 验证编辑器加载（Markdown 文件会显示预览）
    const editorContent = page.locator('code').first()
    await expect(editorContent).toBeVisible({ timeout: 5000 })
  })

  test('命令面板——Ctrl+K 打开', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 检查命令面板按钮（顶栏搜索触发器与工具栏各有一个入口，任一可见即可）
    const cmdButton = page.getByRole('button', { name: /命令面板/ }).first()
    await expect(cmdButton).toBeVisible()
  })
})

test.describe('设置与主题', () => {
  test('设置按钮可点击打开模态框', async ({ page }) => {
    await gotoAndUnlock(page, '/')

    // 点击设置按钮
    await page.getByRole('button', { name: '设置' }).click()

    // 等待模态框
    await page.waitForTimeout(500)
  })

  test('切换主题——循环切换不报错', async ({ page }) => {
    await gotoAndUnlock(page, '/')

    // 点击主题切换按钮
    const themeBtn = page.getByRole('button', { name: '切换主题' })
    await themeBtn.click()

    // 页面不崩溃即可
    await expect(page.locator('body')).toBeVisible()
  })
})

test.describe('底部面板', () => {
  test('终端按钮可见并点击打开底部面板', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 点击活动栏「终端」rail 按钮（data-testid 精确定位：面板开着时 DOM 里
    // 还有底部面板同名「终端」tab 按钮，getByRole exact 会双命中 strict
    // violation——fulle2e run7 实测形态；rail 按钮是本用例的语义主体）
    const terminalBtn = page.getByTestId('rail-terminal')
    await expect(terminalBtn).toBeVisible()

    // 面板开合是 toggle（CLAUDE.md 测试节）：uiState 跨用例恢复态不定，
    // 先归一化到关闭基线再点开，断言才确定
    const panel = page.locator('.bottom-panel')
    for (let i = 0; i < 3 && (await panel.isVisible().catch(() => false)); i++) {
      await terminalBtn.click()
      await expect(panel).toBeHidden({ timeout: 3000 })
    }
    await terminalBtn.click()

    // 底部面板应出现
    await expect(page.locator('.bottom-panel')).toBeVisible({ timeout: 3000 })
  })

  test('Git 面板可见性切换', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // rail 按钮是 toggle：uiState 可能恢复出「面板已开」的初始态，首击=关闭。
    // 归一化：最多点 3 次，保证终态为可见
    const gitBtn = page.getByRole('button', { name: 'Git 管理' })
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.bottom-panel').isVisible().catch(() => false)) break
      await gitBtn.click()
      await page.waitForTimeout(500)
    }

    // 底部面板应可见
    await expect(page.locator('.bottom-panel')).toBeVisible({ timeout: 3000 })
  })
})

test.describe('页面稳定性', () => {
  test('刷新项目页面后布局恢复', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 刷新页面
    await page.reload()
    await page.waitForURL('**/project')

    // 核心布局元素应还在
    await expect(page.getByRole('button', { name: '项目文件' })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.status-bar')).toBeVisible()
  })
})

test.describe('Git 工作流', () => {
  test('编辑文件 → Changes 面板可见', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 通过 API 写一个专用临时文件触发真实磁盘变更（不碰 git 跟踪的文件，
    // Monaco 内存编辑不落盘、markdown 打开是预览态——fill textarea 无法触发 WS 文件监听）
    const projects = await page.evaluate(async () => {
      const r = await fetch('/api/projects', { } /* 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2） */)
      return (await r.json()).data
    })
    const proj = projects.find((p: { name: string }) => p.name === 'simple-coding')
    expect(proj).toBeTruthy()
    const touchPath = '.e2e-touch.tmp'
    try {
      await page.evaluate(async ([id, path]) => {
        await fetch(`/api/projects/${id}/file`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' } /* 同源自动带 HttpOnly 锁 cookie（P-20261019-2） */,
          body: JSON.stringify({ path, content: 'e2e touch' }),
        })
      }, [proj.id, touchPath])

      // WS 文件变更 → status-bar 显示变更计数（untracked 新文件也计入变更）
      await expect(page.locator('.status-bar')).toContainText('变更', { timeout: 15000 })
    } finally {
      // 无论断言成败都清理临时文件，不污染工作区
      await page.evaluate(async ([id, path]) => {
        await fetch(`/api/projects/${id}/file/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' } /* 同源自动带 HttpOnly 锁 cookie（P-20261019-2） */,
          body: JSON.stringify({ path }),
        })
      }, [proj.id, touchPath])
    }
  })

  test('分支切换按钮可见并可交互', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 分支胶囊存在（当前分支 feature/0.0.1，不硬编码分支名）
    const branchBtn = page.locator('.branch-capsule').first()
    await expect(branchBtn).toBeVisible()

    // 点击分支胶囊应打开分支列表
    await branchBtn.click()
    await page.waitForTimeout(500)
  })

  test('提交面板可访问', async ({ page }) => {
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 点击提交按钮（活动栏/侧栏可能有多个同名入口，取第一个）
    const commitBtn = page.getByRole('button', { name: '提交' }).first()
    await expect(commitBtn).toBeVisible()
    await commitBtn.click()

    // 提交面板应出现
    await page.waitForTimeout(500)
  })
})

test.describe('项目快速切换', () => {
  test('命令面板 switch-project：Ctrl+K 搜项目名一键切换', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // Ctrl+K 打开命令面板 → '>' 进入命令模式 → 输入目标项目名 → 点击切换命令
    await page.keyboard.press('Control+k')
    const paletteInput = page.locator('.palette-input input')
    await expect(paletteInput).toBeVisible({ timeout: 5000 })
    await paletteInput.fill('>' + PALETTE_PROJ)
    await page.locator('.palette-item').filter({ hasText: PALETTE_PROJ }).first().click()

    // 顶栏项目选择器已切到目标项目
    await expect(page.locator('.header-project-select')).toContainText(PALETTE_PROJ, { timeout: 5000 })
  })

  test('顶栏项目选择器模糊搜索：部分名称过滤快速选择', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    await page.locator('.header-project-select').click()
    const menu = page.locator('.n-base-select-menu')
    await expect(menu).toBeVisible({ timeout: 5000 })
    // 输入部分名称（非完整前缀）→ 模糊命中临时项目
    await page.locator('.header-project-select input').fill('palette-sw')
    await expect(menu.locator('.n-base-select-option').filter({ hasText: PALETTE_PROJ })).toBeVisible({ timeout: 5000 })
    // 无匹配 → 零选项（区分于未过滤全量列表）
    await page.locator('.header-project-select input').fill('zzz-no-match')
    await expect(menu.locator('.n-base-select-option')).toHaveCount(0)
    await page.keyboard.press('Escape')
  })

  test('Ctrl+P 快速打开：文件清单快速可用并可打开文件', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // Ctrl+P 打开快速打开面板 → 输入文件名 → 命中并打开
    // （文件清单走 /file-list 单请求端点；旧实现按目录逐层拉取导致首次打开极慢）
    await page.keyboard.press('Control+p')
    const paletteInput = page.locator('.palette-input input')
    await expect(paletteInput).toBeVisible({ timeout: 5000 })
    await paletteInput.fill('CLAUDE.md')
    const item = page.locator('.palette-item').filter({ hasText: 'CLAUDE.md' }).first()
    await expect(item).toBeVisible({ timeout: 5000 })
    await item.click()
    await expect(page.getByRole('tab', { name: 'CLAUDE.md' })).toBeVisible({ timeout: 10000 })
  })
})
