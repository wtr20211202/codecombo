import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName, fixedLocale, waitForAppReady, setLockEnabled } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath, dualTmpClean } from '../../tests/dualpath'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 回放深链 E2E（P-20261003-154）：/project?session=<id>&turn=<N> 直达回放弹层
 * 并定位到目标条目（P-132 映射同款定位：滚动定位 + is-focus 呼吸高亮）。
 *   ① ?session=&turn= 直达：bootstrap 后消费，弹层打开 + 定位目标轮，
 *      消费后 URL 清 query（防刷新重复消费）
 *   ② turn 指向未加载段（> 首屏 50）：自动「加载更多」追加到位再定位
 *   ③ SPA 再入（sc-ops:navigate，agent/通知深链同路）：query 变化即时消费，
 *      目标条目呼吸高亮（is-focus）——高亮 2s 自行消退，SPA 路径断言零延迟
 *      才接得住；整页 goto 路径的定位证据改用持久的进度条位号（title 属性）
 *   ④ 非法 turn（非数值）：忽略定位参数按无定位打开
 *   ⑤ 会话不存在：诚实 toast 降级，不开空弹层
 *   ⑥ 复制链接回环：时间线步骤「复制此轮链接」→ 剪贴板 URL（含
 *      session/project/turn 参数——cwd 反查归属项目）→ 粘贴再进 → 直达定位，
 *      且先切到归属项目（?file= 深链同语义）
 *
 * 时序注：gotoAndUnlock 的锁定遮罩轮询固定耗 ~5s（锁定关闭也要等满 deadline），
 * 深链消费的短寿命反馈（toast 3s / 呼吸高亮 2s）经不起该延迟后再断言——
 * 先经 API 关掉锁定开关再直连 goto（file-deeplink.spec enterProjectA 同款规避）。
 *
 * 前置：simple-coding 已运行。测试数据两件套（同机拓扑限定，与
 * timeline-progress.spec.ts 同款约定——服务端直读其所在文件系统的
 * ~/.claude/projects；60 步 fixture 标记 [e2e-sdl]，utimes 控制在 activeWindow
 * 5 分钟外避免被判「进行中」，afterAll 精确删除）；另经 API 注册临时项目
 * （路径 = fixture cwd）使 cwd 反查归属项目成立，afterAll 删除并重置 uiState。
 */

const MARK = '[e2e-sdl]'
const SESSION_ID = 'e2e-sdl-a1b2c3d4-e5f6'
const PROJ_NAME = 'e2e-sdl-proj'
const STEP_COUNT = 60
// 项目目录（= transcript cwd）：真实存在（注册项目服务端校验路径），跨拓扑
// 经 serverPath 换算服务端形态——transcript 行内 cwd 与注册 path 同源同形
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-sdl-proj-'))
const projPathServer = serverPath(projDir)
const FAKE_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects', 'e2e-sdl-fixtures')

let projId = ''
const createdFiles: string[] = []

/** 播种 fixture transcript：count 条用户指令步（时间正序，每步隔 1 分钟），
 *  行内 cwd = 注册项目路径（复制链接的项目反查依赖两者一致） */
function seedTranscript(sessionId: string, count: number, tag: string) {
  fs.mkdirSync(FAKE_CLAUDE_DIR, { recursive: true })
  const file = path.join(FAKE_CLAUDE_DIR, `${sessionId}.jsonl`)
  const lines = [`{"type":"last-prompt","sessionId":"${sessionId}"}`]
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.now() - (count + 10 - i) * 60_000).toISOString()
    lines.push(JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `${tag} 进度步骤 ${i}` },
      timestamp: at, cwd: projPathServer, sessionId,
    }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 留 10 分钟余量：落在服务端 activeWindow(5 分钟) 外，行可交互
  const at = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at, at)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(FAKE_CLAUDE_DIR) } catch { /* non-empty or gone */ }
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

/** 关掉锁定开关（服务端全局，跨用例持续）：后续深链 goto 走直连——短寿命
 *  反馈（toast/高亮）经不起 gotoAndUnlock 的 ~5s 遮罩轮询延迟 */
async function disableLock(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await setLockEnabled(page, false)
}

test.beforeAll(async () => {
  // 注册临时项目（路径 = fixture cwd）：cwd 反查归属项目 + project= 切项目断言的载体
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  fs.mkdirSync(projDir, { recursive: true })
  fs.writeFileSync(path.join(projDir, 'marker.txt'), 'e2e-sdl\n')
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: projPathServer }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  projId = body.data?.id || ''

  seedTranscript(SESSION_ID, STEP_COUNT, MARK)
})

test.afterAll(async () => {
  cleanupFixtures()
  if (projId) {
    const headers = await unlockHeaders()
    await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers }).catch(() => {})
  }
  dualTmpClean(projDir)
  // 项目切换/进入残留清掉（uiState 服务端全局，防污染后续 spec 的入口假设）
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers, body: JSON.stringify({ local: null }),
  }).catch(() => {})
})

/** 整页 goto 深链的定位断言（持久证据）：弹层出现、目标条目存在且内容正确、
 *  进度条位号 = 目标轮（visibleIdx 被定位赋值，persistent 不随高亮消退）、
 *  URL 清 query（防刷新重复消费） */
async function expectDeepLinkedTurn(page: Page, turn: number) {
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 20000 })
  const target = modal.locator(`.cstl-step[data-step="${turn - 1}"]`)
  await expect(target).toContainText(`${MARK} 进度步骤 ${turn - 1}`, { timeout: 10000 })
  // 进度条位号即定位目标（P-132 映射参照系：位号 = idx+1 / total）
  await expect(modal.locator('[data-test="timeline-progress"]')).toHaveAttribute(
    'title', `${turn} / ${STEP_COUNT}`, { timeout: 10000 })
  await expect(page).toHaveURL(/\/project$/)
  return modal
}

test.describe('回放深链（P-20261003-154）', () => {
  test('?session=&turn= 直达：弹层打开且定位到目标轮，URL 清 query', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await disableLock(page)
    // turn=48 → 0-based idx 47：首屏 50 条内（窗口内定位）
    await page.goto(`${API_BASE}/project?session=${SESSION_ID}&turn=48`)
    await waitForAppReady(page)
    await expectDeepLinkedTurn(page, 48)
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(page.locator('.n-modal .cstl-root')).toHaveCount(0)
  })

  test('turn 指向未加载段（> 首屏 50）：追加加载到位再定位末条', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.goto(`${API_BASE}/project?session=${SESSION_ID}&turn=60`)
    await waitForAppReady(page)
    const modal = await expectDeepLinkedTurn(page, 60)
    // 定位驱动的「加载更多」已追加到全量（入口消失）；虚拟切片下 DOM 仍有界，
    // 末条经 scrollTo 进窗（P-20261003-182）
    await expect(modal.locator('[data-test="timeline-load-more"]')).toHaveCount(0, { timeout: 10000 })
    const rendered = await modal.locator('.cstl-step').count()
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(STEP_COUNT)
    await page.locator('.n-modal .n-base-close').first().click()
  })

  test('SPA 再入（sc-ops:navigate）：query 变化即时消费并呼吸高亮目标轮', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await disableLock(page)
    await page.goto(`${API_BASE}/project`)
    await waitForAppReady(page)
    // 已在 /project 的 SPA 内，模拟 agent 经 ops 通道 navigate 推送深链
    //（与 file 深链 navigate 事件同款回环）：query.session 变化触发即时消费
    await page.evaluate((sid) => {
      window.dispatchEvent(new CustomEvent('sc-ops:navigate', {
        detail: { path: `/project?session=${sid}&turn=6` },
      }))
    }, SESSION_ID)
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 15000 })
    // 呼吸高亮（is-focus）2s 后自行消退——SPA 路径断言零延迟启动才接得住；
    // 高亮本身由 SessionTimeline 单测覆盖，这里验证真实链路里点亮
    const target = modal.locator('.cstl-step[data-step="5"]')
    await expect(target).toHaveClass(/is-focus/, { timeout: 8000 })
    await expect(target).toContainText(`${MARK} 进度步骤 5`)
    await expect(page).toHaveURL(/\/project$/)
    await page.locator('.n-modal .n-base-close').first().click()
  })

  test('非法 turn 忽略：按无定位打开（不炸、无高亮）', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.goto(`${API_BASE}/project?session=${SESSION_ID}&turn=abc`)
    await waitForAppReady(page)
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 20000 })
    await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 10000 })
    // 无定位源（turn 非法被忽略）：无呼吸高亮、进度条不跳位（停在首条）
    await expect(modal.locator('.cstl-step.is-focus')).toHaveCount(0)
    await expect(page).toHaveURL(/\/project$/)
    await page.locator('.n-modal .n-base-close').first().click()
  })

  test('会话不存在：诚实 toast 降级，不开空弹层', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.goto(`${API_BASE}/project?session=e2e-sdl-nope&turn=1`)
    await waitForAppReady(page)
    // 消费在 boot 后立刻发生：toast（3s 寿命）在断言启动前尚未过期
    await expect(page.locator('.n-message').filter({ hasText: '会话不存在或已删除' })).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.n-modal .cstl-root')).toHaveCount(0)
    await expect(page).toHaveURL(/\/project$/)
  })

  test('复制链接回环：步骤复制 → 剪贴板 URL（session/project/turn）→ 粘贴再进直达且切归属项目', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    // 经会话中心 UI 打开回放弹层（管理页 → Claude 页签 → 行「回放」）
    await disableLock(page)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    await expect(picker).toBeVisible({ timeout: 8000 })
    const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.hover()
    await row.locator('.csp-row-replay').click()
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 10000 })
    await expect(modal.locator('.cstl-step[data-step="5"]')).toBeVisible({ timeout: 15000 })

    // 悬停第 6 步（idx 5）浮现复制钮，点击复制
    const step = modal.locator('.cstl-step[data-step="5"]')
    await step.hover()
    await step.locator('[data-test="timeline-copy-link"]').click()
    await expect(page.locator('.n-message').filter({ hasText: '此轮链接已复制' })).toBeVisible({ timeout: 5000 })
    const link = await page.evaluate(() => navigator.clipboard.readText())
    // cwd 反查命中注册项目 → project= 在列；turn 按 1 计（idx 5 → turn 6）
    expect(link).toBe(`${API_BASE}/project?session=${SESSION_ID}&project=${projId}&turn=6`)

    // 粘贴再进（= 用户把链接发给别人后打开）：直达定位且先切归属项目
    await page.goto(link)
    await waitForAppReady(page)
    await expectDeepLinkedTurn(page, 6)
    await expect(page.locator('.header-project-select')).toContainText(PROJ_NAME)
    await page.locator('.n-modal .n-base-close').first().click()
  })
})
