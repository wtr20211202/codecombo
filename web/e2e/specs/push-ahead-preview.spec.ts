import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'
import { cleanupProjectsByPathMarker, registerProjectByPath } from '../../tests/project-residue'

/**
 * 推送前 ahead 提交清单预览 E2E（P-20261003-151）：
 * 本地 bare 远端自建（不依赖 Gitea）→ 工作克隆领先 3 个提交 → 打开推送弹窗 →
 * 「3 个提交待推送」计数下列出 3 条清单（短 hash + 主题行，与实际提交一致）→
 * 推送成功 → 重开弹窗清单清零。
 *
 * 上游缺失（未 tracking）的服务端语义（空清单 + noUpstream 标志）由 Go 单测
 * server/git/log_ahead_test.go 覆盖；本 spec 管 UI 接线与推送闭环。
 */

const execFileAsync = promisify(execFile)

// 目录 marker 与父目录：与 clone-flow / push-dialog 的 e2e-* 平行，互不误清
const MARKER = 'e2e-aheadprev-'
const PARENT_DIR = 'D:/workspace/go/coding'
const PROJ = 'ahead-preview-local'

const SUBJECTS = ['ahead preview commit one', 'ahead preview commit two', 'ahead preview commit three']

async function git(dir: string, args: string[]) {
  await execFileAsync('git', ['-C', dir, ...args], { timeout: 60000 })
}

test.beforeAll(async () => {
  // 先清上次中断残留（注册 + 磁盘孤儿目录），再自建本次前置
  await cleanupProjectsByPathMarker({ marker: MARKER, localParentDir: PARENT_DIR })
  const stamp = Date.now()
  const origin = `${PARENT_DIR}/${MARKER}origin-${stamp}.git`
  const work = `${PARENT_DIR}/${MARKER}${stamp}`
  await execFileAsync('git', ['init', '--bare', '-b', 'main', origin], { timeout: 60000 })
  await execFileAsync('git', ['clone', '--quiet', origin, work], { timeout: 60000 })
  await git(work, ['config', 'user.email', 'e2e@local'])
  await git(work, ['config', 'user.name', 'e2e'])
  await git(work, ['commit', '--allow-empty', '-m', 'seed'])
  await git(work, ['push', '-u', 'origin', 'main'])
  // 领先 3 个提交（空提交即可，预览只吃主题行）
  for (const subject of SUBJECTS) {
    await git(work, ['commit', '--allow-empty', '-m', subject])
  }
  // origin URL 改写为服务端形态（P-20261005-187）：UI 推送由服务端 git 执行，
  // Windows 形态路径跨拓扑不可解析；测试侧播种/断言已在此行前完成不受影响
  await git(work, ['remote', 'set-url', 'origin', serverPath(origin)])
  await registerProjectByPath(PROJ, serverPath(work))
})

test.afterAll(async () => {
  await cleanupProjectsByPathMarker({ marker: MARKER, localParentDir: PARENT_DIR })
})

test('推送弹窗：ahead 清单预览 3 条 → 推送成功 → 清单清零', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(1500)

  // 打开推送弹窗
  await page.locator('button[title="推送"], .header-actions button:has-text("推送")').first().click()
  const dlg = page.locator('.modal-card').filter({ hasText: '推送到远程' })
  await expect(dlg).toBeVisible({ timeout: 3000 })

  // 计数行（共享 aheadBehindMap，项目进入后批量探测就绪）
  await expect(dlg.getByText('3 个提交待推送')).toBeVisible({ timeout: 10000 })

  // ahead 清单：3 条（短 hash + 主题行），与实际提交一致、最新在前
  const list = dlg.locator('[data-testid="push-ahead-list"]')
  await expect(list).toBeVisible({ timeout: 5000 })
  const rows = list.locator('.push-ahead-item')
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < SUBJECTS.length; i++) {
    await expect(rows.nth(i).locator('.push-ahead-hash')).toHaveText(/^[0-9a-f]{7,}$/)
    await expect(rows.nth(i).locator('.push-ahead-subject')).toHaveText(SUBJECTS[SUBJECTS.length - 1 - i])
  }

  // 执行推送（本地 bare 远端，凭据无关）
  await dlg.locator('.modal-footer').getByRole('button', { name: '推送' }).click()
  await expect(page.locator('.n-message').filter({ hasText: 'Push 成功' })).toBeVisible({ timeout: 15000 })
  await expect(dlg).toBeHidden({ timeout: 3000 })

  // 重开弹窗：推送成功后清单清零（服务端 range log 已归零，预览区消失）
  await page.locator('button[title="推送"], .header-actions button:has-text("推送")').first().click()
  const dlg2 = page.locator('.modal-card').filter({ hasText: '推送到远程' })
  await expect(dlg2).toBeVisible({ timeout: 3000 })
  await expect(dlg2.locator('[data-testid="push-ahead-list"]')).toBeHidden({ timeout: 10000 })
  // 计数行随 aheadBehindMap 刷新同步归零
  await expect(dlg2.getByText('个提交待推送')).toBeHidden({ timeout: 10000 })
})
