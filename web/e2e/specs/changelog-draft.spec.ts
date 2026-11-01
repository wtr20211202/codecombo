import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更日志草稿生成 E2E（P-20261003-27）：
 *   T1 tag 基线（tags/<v>..HEAD 区间）：git 面板工具条「生成变更日志」→ 弹层默认
 *      最近 tag 自动生成 → 分区（feat/fix/docs/other）与条目正确（短 hash +
 *      去前缀去 scope + other 原文保留），区间正确（不含打 tag 之前的基线提交）；
 *      「复制 Markdown」后剪贴板含 hash 与分区
 *   T2 无 tag 仓库 fallback（④）：弹层默认「最近 N 天」自动生成，预览含全部提交
 *   T3 交给智能体润色（P-20261004-73）：弹层「交给智能体润色」→ agent 会话创建
 *      （kind=agent、dir=项目根）且 launchArgs 含润色指令头 + 草稿头部（区间标注
 *      与条目），总额收在服务端 500 字节上限内；docked 管理页激活
 * 自备临时仓库，afterAll 清理（范式与 tag-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-changelog')
const NOTAG_DIR = path.join(os.tmpdir(), 'sc-e2e-changelog-notag')
const PROJ = 'e2e-changelog'
const NOTAG_PROJ = 'e2e-changelog-notag'
const TAG_NAME = 'e2e-v1'

let projectId = ''
let notagProjectId = ''
// tag 区间内各提交的短 hash（草稿条目按前 8 位呈现）
const shortHashes: Record<string, string> = {}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

function commitFile(cwd: string, file: string, subject: string): string {
  fs.writeFileSync(path.join(cwd, file), `${subject}\n`)
  git(cwd, ['add', '.'])
  git(cwd, ['commit', '-m', subject])
  return git(cwd, ['rev-parse', 'HEAD'])
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ || p.name === NOTAG_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  // 仓库 A：根提交打 tag（区间外），tag 后 4 条规范/无前缀提交（区间内）
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 不 smudge，与 Linux 视图一致
  execFileSync('git', ['-C', REPO_DIR, 'config', 'user.name', 'e2e'])
  execFileSync('git', ['-C', REPO_DIR, 'config', 'user.email', 'e2e@test.local'])
  commitFile(REPO_DIR, 'root.txt', 'chore: e2e 基线提交')
  git(REPO_DIR, ['tag', TAG_NAME])
  shortHashes.feat = commitFile(REPO_DIR, 'a.txt', 'feat(panel): 新增过滤').slice(0, 8)
  shortHashes.fix = commitFile(REPO_DIR, 'b.txt', 'fix: 修正计数').slice(0, 8)
  shortHashes.docs = commitFile(REPO_DIR, 'c.txt', 'docs: 补充说明').slice(0, 8)
  shortHashes.other = commitFile(REPO_DIR, 'd.txt', '无前缀临时主题').slice(0, 8)
  projectId = await registerProject(headers, PROJ, REPO_DIR)

  // 仓库 B：无 tag（fallback 最近 N 天）
  try { fs.rmSync(NOTAG_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(NOTAG_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: NOTAG_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: NOTAG_DIR })
  execFileSync('git', ['-C', NOTAG_DIR, 'config', 'user.name', 'e2e'])
  execFileSync('git', ['-C', NOTAG_DIR, 'config', 'user.email', 'e2e@test.local'])
  commitFile(NOTAG_DIR, 'f.txt', 'feat: 初始功能')
  commitFile(NOTAG_DIR, 'g.txt', '直接提交无前缀')
  notagProjectId = await registerProject(headers, NOTAG_PROJ, NOTAG_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ || p.name === NOTAG_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(NOTAG_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目页并把底部面板归一化到 Git 页签（uiState 跨用例恢复态不定） */
async function openGitTab(page: import('@playwright/test').Page, proj: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: proj }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible({ timeout: 5000 })
}

test('tag 基线生成：分组与条目正确（短 hash/去前缀/other 原文），复制含 hash', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openGitTab(page, PROJ)

  // 工具条入口 → 弹层打开（默认基线 = 最近 tag，自动生成）
  await page.locator('[data-testid="changelog-open"]').click()
  const preview = page.locator('[data-testid="changelog-preview"]')
  await expect(preview).toBeVisible({ timeout: 8000 })
  // 基线下拉显示最近 tag
  await expect(page.locator('[data-testid="changelog-baseline"]')).toContainText(TAG_NAME)

  const text = await preview.textContent()
  expect(text).toContain('# Changelog')
  // 区间标注：tag..HEAD，恰好 4 条（tag 之前的 chore 基线提交不在区间内）
  expect(text).toContain(`> ${TAG_NAME}..HEAD · 4 commits`)
  expect(text).not.toContain('e2e 基线提交')

  // 分区按 feat/fix/docs/other 输出，条目 = 短 hash + 去前缀主题
  expect(text).toContain('## feat')
  expect(text).toContain(`- ${shortHashes.feat} 新增过滤`)
  expect(text).toContain('## fix')
  expect(text).toContain(`- ${shortHashes.fix} 修正计数`)
  expect(text).toContain('## docs')
  expect(text).toContain(`- ${shortHashes.docs} 补充说明`)
  // 无前缀主题入 other 且原文不丢；scope 不入条目（分区标题已表达类型）
  expect(text).toContain(`- ${shortHashes.other} 无前缀临时主题`)
  expect(text).not.toContain('panel)')

  // 二阶段注记：交给 agent 润色提示可见
  await expect(page.locator('[data-testid="changelog-agent-hint"]')).toBeVisible()

  // 复制：toast + 剪贴板含分区与短 hash
  await page.locator('[data-testid="changelog-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('# Changelog')
  expect(clip).toContain('## feat')
  expect(clip).toContain(`${shortHashes.feat} 新增过滤`)
})

test('无 tag 仓库 fallback 最近 N 天：默认基线自动生成含全部提交', async ({ page }) => {
  await openGitTab(page, NOTAG_PROJ)

  await page.locator('[data-testid="changelog-open"]').click()
  const preview = page.locator('[data-testid="changelog-preview"]')
  await expect(preview).toBeVisible({ timeout: 8000 })

  // 无 tag：基线自动落「最近 N 天」，天数输入框出现（默认 30）
  await expect(page.locator('[data-testid="changelog-days"]')).toBeVisible()
  // 30 天内全部提交入草稿：规范前缀 + 无前缀各归其组
  const text = await preview.textContent()
  expect(text).toContain('> 最近 30 天 · 2 commits')
  expect(text).toContain('## feat')
  expect(text).toContain('初始功能')
  expect(text).toContain('## other')
  expect(text).toContain('直接提交无前缀')
})

// ── T3 交给智能体润色（P-20261004-73）：prompt 断言经请求拦截读 create 请求
// 体（launchArgs 即 prompt；ask-selection 同款 watchAgentCreate 手法） ──

/** 清理全部终端会话：会话数断言基于「空白会话表」，残留会话会污染（ask-selection
 *  同款）；本 spec 其余用例不建会话，仅 T3 前后收敛 */
async function cleanupTerminals(headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers })
  }
}

/** 捕获 POST /api/terminals（创建会话）请求体：pathname 精确到 /api/terminals
 *  结尾——paste-image 等子路径不计 */
function watchAgentCreate(page: import('@playwright/test').Page) {
  const payloads: { kind?: string; dir?: string; launchArgs?: string }[] = []
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    try {
      if (new URL(req.url()).pathname.endsWith('/api/terminals')) {
        payloads.push(req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string })
      }
    } catch { /* URL 解析失败非创建请求，忽略 */ }
  })
  return payloads
}

test('润色钮发起 ask 会话：launchArgs 含指令头与草稿头部，docked 激活', async ({ page }) => {
  const headers = await unlockHeaders()
  await cleanupTerminals(headers)
  const payloads = watchAgentCreate(page)

  await openGitTab(page, PROJ)
  await page.locator('[data-testid="changelog-open"]').click()
  await expect(page.locator('[data-testid="changelog-preview"]')).toBeVisible({ timeout: 8000 })
  // 二阶段占位已兑现：润色按钮在位可用（草稿非空态）
  const polishBtn = page.locator('[data-testid="changelog-polish"]')
  await expect(polishBtn).toBeEnabled()
  await polishBtn.click()

  // create 请求体：kind=agent、dir=项目根、launchArgs = 润色指令头 + 草稿头部
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]!
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  expect(prompt, '润色指令头（zh 固定 locale）').toContain('Changelog 草稿')
  // 草稿头部注入：标题/区间标注/首条目（保头装箱的价值密度区）
  expect(prompt).toContain('# Changelog')
  expect(prompt).toContain(`> ${TAG_NAME}..HEAD · 4 commits`)
  expect(prompt).toContain(`- ${shortHashes.feat} 新增过滤`)
  // 服务端按字节计 500 上限（超限直接 400）：launchAskSession 组装器已扣除
  // git 状态摘要份额，装箱必须收在 500 内
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现、恰好一个会话且激活
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)

  await cleanupTerminals(headers)
})
