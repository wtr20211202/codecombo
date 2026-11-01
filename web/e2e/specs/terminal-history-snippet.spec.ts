import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端命令历史面板（C1）+ 命令片段库（C2）E2E：
 *   1. 跑一条失败命令 → 历史面板出现该命令（退出码徽章/只看失败过滤）→ 点击插入不执行
 *      → ▶ 副按钮插入并执行（P-20261003-61：命令出输出；主点击仍仅插入）
 *   2. 片段选择器：系统预置片段可见 → 点击插入终端
 *   3. 设置 → 终端 → 命令片段管理区块：系统片段不可删
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-hist'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-hist')
// 失败命令按服务端 shell 语义选（退出码同为 7）：Windows 服务端 PowerShell 下
// 借道 cmd；Linux 服务端 bash 无 cmd，用 sh -c
const FAIL_CMD = serverIsLinux ? 'sh -c "exit 7"' : 'cmd /c exit 7'

let unlockToken = ''
let projectId = ''

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
  // 注册路径按服务端形态交接（linux 实例经 /mnt/d 同见仓库 .sc-tmp 夹具）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  // 用 rail 按钮精确定位：底部面板展开时 DOM 里还有面板切换钮/新建终端钮，
  // getByRole('终端') 会命中多个元素（strict violation）。
  // 面板可能已由 uiState 恢复为展开态：此时再点 rail 会把它收起，需幂等处理
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    // 项目切换的异步布局应用可能在点击后把面板收起（持久化布局 showBottomPanel=
    // false 迟到覆盖，分片负载下恢复请求常晚于单次点击，run9 实测）——rail 点击
    // 幂等重验（terminal-history-repeat 同款守卫）
    for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
      await page.locator('.rail-btn[title="终端"]').click()
      await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  // 清 uiState 恢复的历史 tab
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  // 项目切换的异步布局应用可能在上面的步骤之间把面板收起（新项目无持久化
  // 布局，apply 默认收起）：点新建前重验一次，收起则重开（幂等）
  await ensureOpen()
  // 先前用例可能把底部面板留在 Git/控制台分区且经 uiState 持久化（服务端
  // 状态跨 spec 存活）：面板开着 ≠ 终端分区，归一化到终端分区再点新建
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell（PS ...）；
  // Linux bash 提示符以 $（普通用户）或 #（root，如 WSL 实例）收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

test('命令历史面板：失败命令入史 + 只看失败 + 插入不执行 + ▶ 插入并执行', async ({ page }) => {
  // Linux 服务端（tmux 后端）保留守卫：OSC 133 消费族本体已打通（C/D/E 帧产
  // 出、失败命令入史带退出码、主点击插入均实测通过，P-20261004-82），但历史
  // 面板「插入不执行」经 writeInput 写 PTY 的文本在 tmux 输入路径存在首字节
  // 丢失（`sh -c "exit 7"` 实到 bash 为 `h -c "exit 7"`，历史落盘畸行实证），
  // 与本提案的 shell 集成链路无关，属终端输入完整性缺陷，修复后删除本守卫。
  // 下方理由串的 P-20261004-82 系缺口登记出处（守卫解除时实证），非修复提案
  // ——修复提案落地后以其号替换并解除守卫（缺口类 skip 须引用提案号：
  // check-e2e-conventions，见 CLAUDE.md「测试」节）
  test.skip(serverIsLinux, 'Linux tmux 面板插入文本首字节丢失（终端输入完整性缺陷，独立提案跟进——P-20261004-82 实证登记），跳过')
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 跑一条失败命令（shellint 上报退出码 → 服务端历史；命令按平台分支见 FAIL_CMD）
  await xterm.click()
  await page.keyboard.type(FAIL_CMD + '\r')
  await expect(xterm).toContainText('exit 7', { timeout: 10000 })
  await page.waitForTimeout(2500) // 等 D 事件上报落盘

  // 打开命令历史面板（工具栏按钮）
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const panel = page.locator('.history-panel')
  await expect(panel).toBeVisible()

  // 失败命令在列（退出码 7）。预算 20s：D 事件上报（OSC 133 → WS → 服务端
  // 落盘）在负载下可能显著超过固定等待的 2.5s
  const item = panel.locator('.history-item').filter({ hasText: FAIL_CMD }).first()
  await expect(item).toBeVisible({ timeout: 20000 })
  await expect(item.locator('.history-exit')).toHaveText(/7/, { timeout: 15000 })

  // 只看失败过滤：成功命令不出现，失败命令仍在
  // （.first()：历史按项目持久化、跨用例重试会累积同命令条目，须取最新一条）
  await panel.locator('.n-checkbox').click()
  await expect(panel.locator('.history-item').filter({ hasText: FAIL_CMD }).first()).toBeVisible({ timeout: 10000 })

  // 点击插入不执行：命令文本出现在输入行（无第二行输出 = 未执行）
  await item.click()
  await expect(xterm).toContainText(FAIL_CMD, { timeout: 5000 })
  await item.hover()
  // 失败条目仅剩复制入口（AI 分析已随功能精简移除）
  await expect(item.locator('.history-mini-btn.is-ai')).toHaveCount(0)

  // ============== ▶ 插入并执行（P-20261003-61）==============
  // 先还原上一段留下的「只看失败」过滤（否则成功的 echo 标记命令会被滤掉）；
  // 面板列表是挂载时拉取、不自动刷新（P-20261004-35 起单次拉全量 + 搜索/失败/
  // 会话过滤全前端算零请求）：关闭再重开面板触发挂载重拉，让面板开着期间
  // 新入史的命令进列表（搜索框随后仍作前端过滤隔离出目标条目）
  await panel.locator('.n-checkbox').click()
  await xterm.click()
  await page.keyboard.press('Control+c') // 清掉上一步插入残留的输入行（同片段测试惯例）
  await page.keyboard.type('echo sc-run-61\r')
  await page.waitForTimeout(2500) // 等 D 事件上报落盘（同前）
  await page.locator('.history-panel .history-header-actions button[title="关闭"]').click()
  await expect(panel).toHaveCount(0)
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  await expect(panel).toBeVisible({ timeout: 10000 })
  await panel.locator('input').first().fill('sc-run-61')
  const runItem = panel.locator('.history-item').filter({ hasText: 'echo sc-run-61' }).first()
  await expect(runItem).toBeVisible({ timeout: 20000 })

  // 计数前剥离全部空白：Linux 长提示符下插入的命令会在面板宽度处回绕，
  // 标记文本被行边界劈开（实测 `echo sc-run` + `-61` 两行），按原文 split 永不命中
  const markerCount = async () => (await xterm.innerText()).replace(/\s+/g, '').split('sc-run-61').length - 1

  // 主点击仍仅插入（安全默认）：计数恰好 +1——多出的只是输入行里的命令文本，无新输出
  const cnt0 = await markerCount()
  await runItem.click()
  await expect.poll(markerCount, { timeout: 5000 }).toBe(cnt0 + 1)

  // ▶ 副按钮：插入并执行——判别器用历史 API：再次执行会再次上报落史，同命令
  // 出现两条带不同时间戳的条目（视口行数计数在长提示符回绕 + 面板滚动下不可靠）。
  // 先敲一条不同命令：bash 侧 HISTCMD 去重对「与上一条完全相同的命令」天然不记
  // （HISTCONTROL=ignoredups 下连 history 都不进，HISTCMD 不前进，实测复现），
  // 紧邻重跑同命令不会产生第二条记录
  await xterm.click()
  await page.keyboard.press('Control+c')
  await page.keyboard.type('true\r')
  await page.waitForTimeout(1500)
  await runItem.hover()
  const runBtn = runItem.locator('.history-mini-btn.is-run')
  await expect(runBtn).toHaveAttribute('title', '插入并执行')
  await runBtn.click()
  await expect.poll(async () => {
    const res = await api('GET', `/api/projects/${projectId}/terminal-history?limit=50`)
    const entries = ((res.json?.data || []) as { command: string }[]).filter(e => e.command.includes('echo sc-run-61'))
    if (entries.length < 2) {
      const all = ((res.json?.data || []) as { command: string }[]).map(e => e.command)
      console.log('[diag] history entries:', JSON.stringify(all))
      console.log('[diag] terminal tail:', JSON.stringify((await xterm.innerText()).slice(-200)))
    }
    return entries.length
  }, { timeout: 20000 }).toBe(2)
})

test('片段库：系统片段可见 + 点击插入；设置内管理区块', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 打开片段选择器：系统预置片段在列
  await page.locator('.term-toolbar button[title="命令片段"]').click()
  const panel = page.locator('.snippet-panel')
  await expect(panel).toBeVisible()
  const sysItem = panel.locator('.snippet-item').filter({ hasText: '启动 agent' }).first()
  await expect(sysItem).toBeVisible({ timeout: 10000 })

  // 点击系统片段（直接 claude）→ 命令插入输入行不执行
  await panel.locator('.snippet-item').filter({ hasText: 'claude' }).first().click()
  await expect(xterm).toContainText('claude', { timeout: 5000 })
  // 清掉插入残留
  await xterm.click()
  await page.keyboard.press('Control+c')

  // 带参片段：内联参数输入区展开（如 tmp 的占位符片段）——系统片段无参数，此处验证面板关闭
  await panel.locator('.snippet-header-actions button').last().click()
  await expect(panel).toHaveCount(0)

  // 设置 → 终端 → 命令片段管理区块：系统片段在列且无删除按钮
  await page.locator('.rail-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '终端' }).click()
  const manager = page.locator('.snippet-manager')
  await expect(manager).toBeVisible({ timeout: 10000 })
  const sysRow = manager.locator('.snippet-row').filter({ hasText: '启动 agent' }).first()
  await expect(sysRow).toBeVisible()
  // 系统片段行没有删除按钮（popconfirm 触发按钮不渲染）
  await expect(sysRow.locator('button[type="button"].n-button--error-type')).toHaveCount(0)
})

test('片段编辑回归：编辑系统片段保存后仍在（存量无 ID 不再导致编辑消失）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.locator('.rail-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '终端' }).click()
  const manager = page.locator('.snippet-manager')
  await expect(manager).toBeVisible({ timeout: 10000 })

  // 系统片段「启动 agent（claude）」用精确标题计数观察增减
  const titled = (title: string) =>
    manager.locator('.snippet-row').filter({ has: page.locator('.snippet-row-title', { hasText: new RegExp(`^${title}$`) }) })
  const before = await titled('启动 agent（claude）').count()
  expect(before).toBeGreaterThanOrEqual(1)

  // 点击编辑：表单打开且命令已回填（bug 时表单不可编辑/打开即丢）
  await titled('启动 agent（claude）').first().locator('button[title="编辑"]').click()
  const form = manager.locator('.snippet-form')
  await expect(form).toBeVisible()
  await expect(form.locator('.snippet-form-cmd textarea')).not.toHaveValue('')

  // 改标题保存 → 行仍在且标题已更新（bug 时走 create 分支 + key 冲突导致片段消失）
  await form.locator('input').first().fill('启动 agent（claude）X1')
  await form.locator('button').filter({ hasText: '保存' }).click()
  await expect(titled('启动 agent（claude）X1')).toHaveCount(1, { timeout: 10000 })
  await expect(titled('启动 agent（claude）')).toHaveCount(before - 1)

  // 还原标题（再次编辑回写，二次验证编辑链路）
  await titled('启动 agent（claude）X1').locator('button[title="编辑"]').click()
  await expect(form).toBeVisible()
  await form.locator('input').first().fill('启动 agent（claude）')
  await form.locator('button').filter({ hasText: '保存' }).click()
  await expect(titled('启动 agent（claude）')).toHaveCount(before, { timeout: 10000 })
  await expect(titled('启动 agent（claude）X1')).toHaveCount(0)
})
