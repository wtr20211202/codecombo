import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 审批卡 op+target 一键复制（P-20261003-81，审批语境转述出口）：
 *   1. 命令形 target → 点 op 行尾复制小钮，剪贴板含 op+target 拼合文本
 *      （「push git push origin main」），且审批仍 pending（复制与裁决链隔离）
 *   2. 路径形 target → 点复制剪贴板含拼合文本，且不开文件 tab（复制钮与
 *      target 可点态正交——不触发 OPS_OPEN_FILE_AT 探测/开文件链）
 * 夹具仓库经 API 注册为项目（approval-target-preview 同款），进入项目页建立
 * 当前项目上下文后播种审批；beforeEach/afterEach 归位审批档位 + 清账防残留
 * （全局档位是服务端共享状态，漏归位会让 POST 被直接放行恒不弹卡）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'aprv-card-copy-proj'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 清掉同名残留项目（前次运行崩溃遗留：夹具 tmpdir 已删，旧卡指向空路径） */
async function removeStaleProject(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  for (const p of list.filter(x => x.name === PROJ)) {
    await request.delete(`${BASE}/api/projects/${p.id}`, { headers }).catch(() => {})
  }
}

/** 夹具仓库：docs/notes.md 已提交（干净文件），src/app.ts 已提交后再改（未提交差异）*/
async function makeFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'sc-aprv-copy-'))
  const git = (args: string) => execSync(`git ${args}`, { cwd: repo })
  git('init')
  git('config core.autocrlf false')
  git('config user.email e2e@example.com')
  git('config user.name e2e')
  await mkdir(path.join(repo, 'docs'), { recursive: true })
  await mkdir(path.join(repo, 'src'), { recursive: true })
  await writeFile(path.join(repo, 'docs', 'notes.md'), 'clean committed note\n')
  await writeFile(path.join(repo, 'src', 'app.ts'), 'export const v = 1\n')
  git('add .')
  git('commit -m init')
  // 未提交差异：追加一行（status → Modified）
  await writeFile(path.join(repo, 'src', 'app.ts'), 'export const v = 1\nexport const w = 2\n')
  return repo
}

/** 注册项目 → 进项目页（建立当前项目上下文），返回项目 id */
async function registerAndEnter(page: import('@playwright/test').Page, request: APIRequestContext, repoDir: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const projRes = await request.post(`${BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(repoDir) },
  })
  expect([200, 201]).toContain(projRes.status())
  const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  expect(proj).toBeTruthy()

  await fixedLocale(page)
  // 剪贴板读写权限：copyText 在 secure context（localhost）走 async clipboard
  // API，授权后 e2e 可经 navigator.clipboard.readText() 断言落盘内容
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await gotoAndUnlock(page, '/')
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  return proj!.id
}

/** 播种 pending 审批并等卡片在屏 */
async function seedApproval(page: import('@playwright/test').Page, request: APIRequestContext, op: string, target: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId: 'sc_aprv_copy_e2e', op, target, detail: 'P-20261003-81 一键复制验证' },
  })
  expect(res.ok()).toBeTruthy()
  const id = ((await res.json()) as { data: { id: string } }).data.id
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  return id
}

async function approvalStatus(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { status?: string } }).data?.status || ''
}

/** 全局审批模式置位（approval-deny-reason/approval-hotkey 同款纪律）：全局档位
 *  是服务端共享状态（approval-* 域用例都吃它）——run15 实测前序 spec 中途失败
 *  把 allow 漏成持久态后，本 spec 的 POST /api/ops-confirm 会被服务端直接放行
 *  （不弹卡不广播），卡片恒不出现。beforeEach 归位 ask + afterEach 兜底还原，
 *  让本组用例对档位泄漏免疫（断言语义不变——ask 档本来就是被测前提） */
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
  await removeStaleProject(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('命令形 target：点复制 → 剪贴板含 op+target 拼合，审批仍 pending', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    const id = await seedApproval(page, request, 'push', 'git push origin main')

    // op 行尾复制小钮：tooltip 走 i18n（中文金态），点击复制拼合命令语境
    const copyBtn = page.locator('.aprv-card [data-test="aprv-copy"]')
    await expect(copyBtn).toHaveAttribute('title', '复制完整命令（op + target）')
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'))
    await copyBtn.click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('push git push origin main')

    // 复制与裁决隔离：卡片不清账、后端仍 pending
    await expect(page.locator('.aprv-card')).toHaveCount(1)
    expect(await approvalStatus(request, id)).toBe('pending')
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('路径形 target：点复制得拼合文本且不开文件 tab（与 target 点击正交）', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    await seedApproval(page, request, 'write', 'docs/notes.md')

    // 路径形态的 target 本可点击预览；点的是复制钮——不得触发开文件链
    await page.evaluate(() => navigator.clipboard.writeText('sentinel'))
    await page.locator('.aprv-card [data-test="aprv-copy"]').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('write docs/notes.md')
    await page.waitForTimeout(800)
    await expect(page.locator('.pane-primary .editor-tab', { hasText: 'notes.md' })).toHaveCount(0)
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})
