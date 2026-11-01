import { test, expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote, serverPath } from '../../tests/dualpath'
import { cleanupProjectsByPathMarker, registerProjectByPath } from '../../tests/project-residue'

/**
 * 推送弹窗流 E2E（anonymous push 允许的 Gitea :3000）：
 * 进入项目 → 顶栏「推送」打开弹窗 → remote 下拉含 origin → 执行推送 →
 * toast「Push 成功」→ 弹窗关闭。
 *
 * 前置自建：此前假设 git-test 项目卡已在（clone-flow 注册、其 afterAll 又删除）
 * ——同一次全量内的顺序脆弱依赖，spec 单独跑必挂。现改为 beforeAll 自克隆一份
 * 到 e2e-pushdlg-* 目录并以独立项目名注册，afterAll/beforeAll 双端清理（与
 * clone-flow 同款 helper）。独立项目名与播种的 git-test 卡互不干扰：卡片按名
 * 过滤不会命中播种卡；推送语义不受 ahead 计数影响（同步态 push = Everything
 * up-to-date，同样走成功路径出「Push 成功」toast）。
 * Gitea 不可达时条件跳过。
 */

const execFileAsync = promisify(execFile)

// 目录 marker 与父目录：与 clone-flow 的 e2e-clone-* 平行，互不误清
const MARKER = 'e2e-pushdlg-'
const PARENT_DIR = 'D:/workspace/go/coding'
const REPO_URL = 'http://localhost:3000/zhouchangjian/git-test.git'
const PROJ = 'git-test-pushdlg'

let giteaUp = false

test.beforeAll(async ({ request }) => {
  // 先清上次中断残留（注册 + 磁盘孤儿目录），再自建本次前置
  await cleanupProjectsByPathMarker({ marker: MARKER, localParentDir: PARENT_DIR })
  // Gitea 可达性预检（NAT 模式下 Windows localhost:3000 不转发 → 环境缺失跳过）
  const res = await request.get('http://localhost:3000/').catch(() => null)
  giteaUp = !!res?.ok()
  if (!giteaUp) return
  const dir = `${PARENT_DIR}/${MARKER}${Date.now()}`
  await execFileAsync('git', ['clone', '--quiet', REPO_URL, dir], { timeout: 60000 })
  await registerProjectByPath(PROJ, serverPath(dir))
})

test.afterAll(async () => {
  await cleanupProjectsByPathMarker({ marker: MARKER, localParentDir: PARENT_DIR })
})

test('推送弹窗：remote 下拉 → 推送成功 → 弹窗关闭', async ({ page }) => {
  // giteaUp 是测试侧探测；UI 推送由服务端 git 执行——跨拓扑（WSL NAT）下
  // 服务端 localhost:3000 到不了 Windows 侧 Gitea，结构性不可跑（镜像网络
  // 形态可达），serverIsRemote 一并门控（P-20261005-187）
  test.skip(!giteaUp || serverIsRemote, 'Gitea :3000 不可达或跨拓扑 NAT 不可及，跳过')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(1500)

  // 打开推送弹窗
  await page.locator('button[title="推送"], .header-actions button:has-text("推送")').first().click()
  const dlg = page.locator('.modal-card').filter({ hasText: '推送到远程' })
  await expect(dlg).toBeVisible({ timeout: 3000 })

  // remote 下拉：默认选中 origin（远程列表接口真实加载）
  await expect(dlg.locator('text=origin').first()).toBeVisible({ timeout: 5000 })

  // 执行推送（自建前置 = 全新克隆，与远程同步或领先均可推送成功）
  await dlg.locator('.modal-footer').getByRole('button', { name: '推送' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Push 成功' })).toBeVisible({ timeout: 15000 })
  await expect(dlg).toBeHidden({ timeout: 3000 })
})
