import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令面板快速切实例 E2E（P-20261002-111，配方同 palette-branch + instance-guard）：
 *   - Ctrl+K 命令模式输实例名 → 「切换到实例：<name>」命令出现 → Enter → 真实切换
 *     （指示器 title 变为目标实例名；目标为离线远程实例，切换落其空首页）
 *   - 当前实例命令带「当前实例」标注；对当前实例执行幂等无副作用
 *   - 关键词含主机地址：输 url 端口也能过滤直达，分组标签「实例」
 * 自备离线远程实例（指向无监听端口），afterAll 清理，不污染其他 spec。
 * 切换目标选离线实例的原因：可达远程需要第二个服务实例（环境不保证）；
 * 离线目标同样走完整 selectInstance 链路（确认/遮罩/清 store/切上下文/remount），
 * 切走后自动保存被 switching 守卫跳过、离线侧 PUT 失败——local 的 uiState 记录
 * 仍指向本机，重启天然落回本机，无需用例内切回。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-palette-instance')
const PROJ = 'e2e-palette-instance'
const INST_NAME = 'e2e-pal-inst'
// 无监听端口：登记合法但状态离线（自引用 URL 会被服务端 400 拒，见 instance-guard）。
// 刻意避开 9998（e2e 播种的 WSL 服务实例端口，撞上会变「可达」）
const INST_URL = 'http://localhost:9499'
let instanceId = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
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

/** 实例指示器（首页/项目页各一，任一时点仅一个挂载）的 title = 当前实例展示名 */
function indicator(page: import('@playwright/test').Page) {
  return page.locator('.instance-indicator')
}

/** 关掉「建议修改默认密码」提醒（若弹出）：按实例再次弹出，遮后续点击 */
async function dismissPwdReminder(page: import('@playwright/test').Page) {
  const btn = page.getByRole('button', { name: '稍后提醒' })
  if (await btn.isVisible().catch(() => false)) {
    await btn.click()
    await expect(btn).toHaveCount(0, { timeout: 3000 })
  }
}

/** 进自备项目页（命令面板仅项目空间可用：Layout 挂载） */
async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理同名残留实例（前次中断）
  const stale = await (await fetch(`${API_BASE}/api/instances`, { headers })).json()
  for (const inst of ((stale?.data || []) as { id: string; name: string }[])) {
    if (inst.name === INST_NAME) {
      await fetch(`${API_BASE}/api/instances/${inst.id}`, { method: 'DELETE', headers })
    }
  }
  // 登记离线远程实例（parentId=local 同 instance-guard 合法形态）
  const create = await fetch(`${API_BASE}/api/instances`, {
    method: 'POST', headers, body: JSON.stringify({ name: INST_NAME, url: INST_URL, parentId: 'local' }),
  })
  expect([200, 201]).toContain(create.status)
  instanceId = ((await create.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId, '实例登记应返回 id').toBeTruthy()

  // 自备最小项目（残留先清）
  const staleProjects = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((staleProjects?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.txt'), 'palette instance e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 面板切实例基线提交'])
  const reg = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(reg.status)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  // 清 uiState 本机命名空间（防本项目的工作区状态残留给其他 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
  if (instanceId) {
    await fetch(`${API_BASE}/api/instances/${instanceId}`, { method: 'DELETE', headers })
  }
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('命令面板输实例名 → 命令出现 → Enter 切换生效', async ({ page }) => {
  await openProject(page)

  // 当前实例标注 + 幂等守卫：对「本机」执行切换命令无副作用（仍在项目空间、
  // 指示器仍是本机——selectInstance 对当前实例直接返回）
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>本机')
  const localCmd = page.locator('.palette-item').filter({ hasText: '切换到实例：本机' }).first()
  await expect(localCmd).toContainText('当前实例', { timeout: 5000 })
  await page.keyboard.press('Enter')
  await expect(localCmd).toBeHidden({ timeout: 5000 }) // 面板关闭即已分发
  await expect(page).toHaveURL(new RegExp('/project'))
  await expect(indicator(page)).toHaveAttribute('title', '本机', { timeout: 5000 })
  await dismissPwdReminder(page)

  // 输实例名（非完整命令文案）：目标实例命令命中且为唯一激活项；
  // 当前在本地，目标命令不带「当前实例」标注
  await page.keyboard.press('Control+k')
  await input.fill(`>${INST_NAME}`)
  const active = page.locator('.palette-item.active')
  await expect(active).toHaveText(new RegExp(`切换到实例：${INST_NAME}`), { timeout: 5000 })
  await expect(active).not.toContainText('当前实例')

  // Enter → 既有实例切换链路生效：指示器 title 变为目标实例名。
  //（目标为离线远程实例：切换照常进行，等价项目匹配失败落其首页）
  await page.keyboard.press('Enter')
  await expect(indicator(page)).toHaveAttribute('title', INST_NAME, { timeout: 15000 })
  await dismissPwdReminder(page)
})

test('关键词含主机地址：输 url 端口过滤直达，分组标签「实例」', async ({ page }) => {
  // 新页面 = 回到本机（上一用例的切换只在前端内存，服务端 uiState 的 local
  // 记录仍指向本机，见文件头说明）
  await openProject(page)
  await expect(indicator(page)).toHaveAttribute('title', '本机', { timeout: 15000 })
  await dismissPwdReminder(page)

  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>9499')
  await expect(page.locator('.palette-item').filter({ hasText: `切换到实例：${INST_NAME}` }).first())
    .toBeVisible({ timeout: 5000 })
  await expect(page.locator('.palette-group-label').filter({ hasText: '实例' }).first())
    .toBeVisible({ timeout: 5000 })
  // Esc 双层退出（P-20261004-95）：有查询先清——两连 Esc 才落到关闭
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})
