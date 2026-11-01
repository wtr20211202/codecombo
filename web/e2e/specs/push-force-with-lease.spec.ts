import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'
import { cleanupProjectsByPathMarker, registerProjectByPath } from '../../tests/project-residue'
import { e2eCloneParentDir } from '../../tests/e2e-local-env'

/**
 * 推送弹层 force-with-lease 选项 E2E（P-20261003-213）：
 * reword 分叉夹具（本地 bare 远端，远端仍停在跟踪位上——lease 必然成立）→
 * 打开推送弹窗 →「高级」区默认折叠（force 选项与覆盖警示不可见=默认关不可达）→
 * 展开 → 勾选「强制覆盖远端 (force-with-lease)」→ 红字警示「将覆盖远端 1 个提交」→
 * 推送成功 → bare 远端 HEAD 真实改写为 reword 后的提交（lease 语义端到端成立）。
 *
 * 夹具同 push-ahead-preview：本地 bare 远端自建，不依赖 Gitea。
 */

const execFileAsync = promisify(execFile)

// 目录 marker 与父目录：与 push-dialog / push-ahead-preview 的 e2e-* 平行，互不误清
const MARKER = 'e2e-fwlease-'
const PARENT_DIR = e2eCloneParentDir()
const PROJ = 'fwlease-local'

const SEED_SUBJECT = 'fwlease seed'
const REWORED_SUBJECT = 'fwlease seed rewored'

async function git(dir: string, args: string[]) {
  await execFileAsync('git', ['-C', dir, ...args], { timeout: 60000 })
}

async function remoteHeadSubject(origin: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', origin, 'log', '-1', '--format=%s', 'main'], { timeout: 60000 })
  return stdout.trim()
}

let originDir = ''

test.beforeAll(async () => {
  // 先清上次中断残留（注册 + 磁盘孤儿目录），再自建本次前置
  await cleanupProjectsByPathMarker({ marker: MARKER, localParentDir: PARENT_DIR })
  const stamp = Date.now()
  originDir = `${PARENT_DIR}/${MARKER}origin-${stamp}.git`
  const work = `${PARENT_DIR}/${MARKER}${stamp}`
  await execFileAsync('git', ['init', '--bare', '-b', 'main', originDir], { timeout: 60000 })
  await execFileAsync('git', ['clone', '--quiet', originDir, work], { timeout: 60000 })
  await git(work, ['config', 'user.email', 'e2e@local'])
  await git(work, ['config', 'user.name', 'e2e'])
  await git(work, ['commit', '--allow-empty', '-m', SEED_SUBJECT])
  await git(work, ['push', '-u', 'origin', 'main'])
  // reword 已推送的种子提交 → ahead1/behind1 分叉；远端与本地跟踪 ref 仍一致
  // （未 fetch），--force-with-lease 的 lease 期望恰好命中 → 推送成功改写远端
  // （种子是空提交，amend 须 --allow-empty 同 push-ahead-preview 夹具口径）
  await git(work, ['commit', '--amend', '--allow-empty', '-m', REWORED_SUBJECT])
  // origin URL 改写为服务端形态（P-20261005-187）：UI 推送由服务端 git 执行，
  // Windows 形态路径跨拓扑不可解析；测试侧播种/断言用 originDir 原形态不受影响
  await git(work, ['remote', 'set-url', 'origin', serverPath(originDir)])
  await registerProjectByPath(PROJ, serverPath(work))
})

test.afterAll(async () => {
  await cleanupProjectsByPathMarker({ marker: MARKER, localParentDir: PARENT_DIR })
})

test('推送弹窗：高级区默认折叠 → 勾选 force-with-lease 出红字警示 → 推送成功改写远端', async ({ page }) => {
  expect(await remoteHeadSubject(originDir)).toBe(SEED_SUBJECT)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(1500)

  // 打开推送弹窗
  await page.locator('button[title="推送"], .header-actions button:has-text("推送")').first().click()
  const dlg = page.locator('.modal-card').filter({ hasText: '推送到远程' })
  await expect(dlg).toBeVisible({ timeout: 3000 })

  // 分叉计数就绪（reword 后 ahead=1，覆盖警示的 N 事实源）
  await expect(dlg.getByText('1 个提交待推送')).toBeVisible({ timeout: 10000 })

  // 默认关不可达：高级区折叠——force 选项与覆盖警示都不在 DOM
  await expect(dlg.getByTestId('push-advanced-toggle')).toBeVisible()
  await expect(dlg.getByTestId('push-advanced-toggle')).toHaveText(/高级/)
  await expect(dlg.getByText('强制覆盖远端 (force-with-lease)')).toHaveCount(0)
  await expect(dlg.getByTestId('push-overwrite-warning')).toHaveCount(0)

  // 展开高级区：选项可见但默认未勾选、警示仍未出现
  await dlg.getByTestId('push-advanced-toggle').click()
  const leaseRow = dlg.locator('label').filter({ hasText: '强制覆盖远端 (force-with-lease)' })
  await expect(leaseRow).toBeVisible()
  await expect(leaseRow.locator('.n-checkbox')).not.toHaveClass(/n-checkbox--checked/)
  await expect(dlg.getByTestId('push-overwrite-warning')).toHaveCount(0)

  // 勾选 → 红字警示当场出现（ahead=1 派生）
  await leaseRow.locator('.n-checkbox').click()
  await expect(leaseRow.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await expect(dlg.getByTestId('push-overwrite-warning')).toHaveText('将覆盖远端 1 个提交')

  // 推送（lease 成立）→ 成功 → 弹窗关闭
  await dlg.locator('.modal-footer').getByRole('button', { name: '推送' }).click()
  await expect(page.locator('.n-message').filter({ hasText: 'Push 成功' })).toBeVisible({ timeout: 15000 })
  await expect(dlg).toBeHidden({ timeout: 3000 })

  // bare 远端 HEAD 真实改写为 reword 后的提交（force-with-lease 端到端生效）
  await expect
    .poll(() => remoteHeadSubject(originDir), { timeout: 10000 })
    .toBe(REWORED_SUBJECT)
})
