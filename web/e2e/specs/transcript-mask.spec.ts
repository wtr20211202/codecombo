import { test, expect, type Locator, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * transcript 展示面敏感遮蔽 E2E（P-20261004-14）：回放时间线与全文搜索命中
 * 两大展示面默认经 P-108 maskSensitive() 遮蔽（sc?_ 令牌 / password 赋值 /
 * AKIA 密钥），头部「显示原文」经确认弹窗放行（纯展示层——timeline API 与
 * transcript 文件返回原文不变）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/:id/timeline 与
 * /api/claude/sessions/search）。
 *
 * 测试数据：播种一条 fixture transcript 到真实 ~/.claude/projects（与
 * claude-timeline.spec.ts / session-search.spec.ts 同款约定——标题带 [e2e-tm]
 * 标记，关键词为随机 token 保证全语料唯一，utimes 控制在 activeWindow(5 分钟)
 * 之外），afterAll 精确删除 fixture 文件。敏感值只进 fixture（本机临时文件），
 * 断言其不出现在任一展示面。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude 会话族 spec 一致）。
 */

const MARK = '[e2e-tm]'
const FAKE_DIR_NAME = 'D--e2e-tm-fixtures'
// 随机关键词：真实语料（本机其他会话）不会含有的子串，保证全文命中确定
const KEYWORD = 'tm-mask-e2e-k7q3'
const TOKEN = 'sca_e2etmQ7x9Kp2Rw'
const SECRET = 'e2etm-secret-3n8v-neverleak'
const SESSION_ID = 'e2e-tm-a1b2c3d4-0001'
const createdFiles: string[] = []

function at(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

/** 播种 fixture：首条用户消息作标题（不含敏感值），敏感值落在末条用户消息
 * （sc?_ 令牌 + password 赋值两形态）——该消息同时是全文搜索的命中行 */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} transcript 敏感遮蔽回放会话"},"timestamp":"${at(30)}","cwd":"D:\\\\e2e-tm-fixtures"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的，已记录上下文"}]},"timestamp":"${at(29)}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${KEYWORD} 令牌 ${TOKEN} 与 export password=${SECRET} 勿外泄"},"timestamp":"${at(28)}","cwd":"D:\\\\e2e-tm-fixtures"}`,
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 落在服务端 activeWindow(5 分钟) 外：行可交互（非「进行中」）
  const m = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, m, m)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function openClaudeTab(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  return picker
}

/** 全文搜索响应返回后的首条命中行（fixture 语料唯一关键词保证确定性） */
async function firstHitLine(page: Page, picker: Locator): Promise<Locator> {
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions/search'))
  await picker.locator('input').fill(KEYWORD)
  await searchResp
  const hit = picker.locator('[data-test="session-search-hit"]').first()
  await expect(hit).toBeVisible({ timeout: 15000 })
  return hit.locator('.csp-hit-line').first()
}

test.describe('transcript 展示面敏感遮蔽（P-20261004-14）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('搜索命中行先遮蔽后渲染；时间线默认 ***→确认开原文→收回', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)

    // 全文命中区（P-19 摘要行）：服务端已遮（P-108 修正项），前端兜底再遮
    // ——先遮蔽后高亮/渲染的次序下，命中行只见 *** 不见原文
    const hitLine = await firstHitLine(page, picker)
    await expect(hitLine).toContainText('令牌 ***')
    await expect(hitLine).toContainText('export password=***')
    const ftText = await picker.locator('.csp-ft').innerText()
    expect(ftText).not.toContain(TOKEN)
    expect(ftText).not.toContain(SECRET)

    // 点击命中 → 回放弹层：时间线默认遮蔽（timeline API 返回原文，展示层收口）
    await picker.locator('[data-test="session-search-hit"]').first().click()
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 10000 })
    const step = modal.locator('.cstl-step').filter({ hasText: KEYWORD }).first()
    await expect(step).toBeVisible({ timeout: 15000 })
    await expect(step).toContainText('令牌 ***')
    await expect(step).toContainText('export password=***')
    const timelineText = await modal.locator('.cstl-list').innerText()
    expect(timelineText).not.toContain(TOKEN)
    expect(timelineText).not.toContain(SECRET)

    // 开原文：确认弹窗知情提示（含敏感值警示）→「仍要显示」→ 原文在场
    await modal.locator('[data-test="timeline-mask-toggle"]').click()
    const dialog = page.locator('.n-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('显示敏感原文')
    await page.getByRole('button', { name: '仍要显示' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(step).toContainText(TOKEN)
    await expect(step).toContainText(SECRET)

    // 收回原文（无风险，不需确认）：回到遮蔽视图
    await modal.locator('[data-test="timeline-mask-toggle"]').click()
    await expect(modal.locator('.cstl-list')).toContainText('令牌 ***')
    await expect(modal.locator('.cstl-list')).not.toContainText(TOKEN)

    // 关闭弹层
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
