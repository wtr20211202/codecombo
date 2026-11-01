import { test, expect, type Page } from '@playwright/test'
import net from 'node:net'
import {
  fixedLocale,
  waitForAppReady,
  unlockIfNeeded,
  setLockEnabled,
  DEFAULT_PASSWORD,
} from './helpers'
import { cleanupProjectsByPathMarker } from './project-residue'

/**
 * Clone 流程 E2E 测试
 *
 * 区分两个「锁定」概念：
 *   - enabled=true（锁定功能开启）：后端 WithWSLockAuth 中间件要求所有 WS 握手带 unlock token
 *   - isLocked=true（UI 当前被遮罩）：前端显示 .lock-overlay，按钮点不到——此时根本无法发起 clone
 *
 * Bug 2 的真实触发场景：enabled=true（后端要 token）+ 已解锁（UI 可交互）
 *   旧代码 clone WS 不传 token → 握手 423 → 前端永远卡 loading
 *
 * 用例覆盖：
 *  - enabled=false（功能关闭）clone 公开仓库 → 项目注册
 *  - enabled=true（功能开启）+ 已解锁 clone 公开仓库 → WS 握手带 unlock token → 项目注册
 *
 * 不测 enabled=true + isLocked=true：遮罩态下用户点不到按钮，无法发起 clone，无意义
 *
 * 仓库：http://localhost:3000/zhouchangjian/git-test.git（Gitea 公开仓库，匿名 clone 可用）
 * 前置：simple-coding 已在 :9999 运行（嵌入构建产物）
 */

const REPO_URL = 'http://localhost:3000/zhouchangjian/git-test.git'

// clone 目标目录 marker 与父目录：清理 helper 与 nextCloneDir 共用同一常量，
// 改目录布局不会出现「注册按 A 清、磁盘按 B 扫」的错位
const CLONE_MARKER = 'e2e-clone-'
const CLONE_PARENT_DIR = 'D:/workspace/go/coding'

// Gitea（WSL docker）可达性预检：WSL 处于 NAT 模式时 Windows 侧 localhost:3000
// 不再转发，clone 必然失败——这是环境缺失而非功能回归，条件跳过（与 wslUp 同惯例）
function giteaReachable(timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: 3000 })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let giteaUp = false
test.beforeAll(async () => {
  giteaUp = await giteaReachable()
  // 自愈式清理（beforeAll + afterAll 双端）：beforeAll 删本 spec 与历史失败运行
  // 遗留的全部 e2e-clone 注册项目 + 磁盘目录（含注册已删的孤儿目录），上次运行
  // afterAll 未执行（中断）时不再拖到本次跑完才清
  await cleanupProjectsByPathMarker({ marker: CLONE_MARKER, localParentDir: CLONE_PARENT_DIR })
})

// 每个用例独立目标目录，避免互相污染
// 拼接 TEST_WORKER_INDEX 防止多 worker 并发时同毫秒+同 seq 路径碰撞
let cloneDirSeq = 0
function nextCloneDir(): string {
  cloneDirSeq += 1
  const worker = process.env.TEST_WORKER_INDEX || '0'
  return `${CLONE_PARENT_DIR}/${CLONE_MARKER}${Date.now()}-w${worker}-${cloneDirSeq}`
}

async function startClone(page: Page, targetDir: string, projectName: string): Promise<void> {
  const addBtn = page.getByRole('button', { name: '添加项目' }).first()
  await addBtn.click()
  await page.getByText('从 Git 克隆').click()

  await page.getByPlaceholder('https://github.com/user/repo.git').fill(REPO_URL)
  await page.getByPlaceholder('克隆到哪个目录').fill(targetDir)
  // 唯一项目名：断言只可能命中本用例自己的 clone 注册——同名的播种卡/
  // 前序用例卡会让 getByText('git-test') 假绿（用例秒过而 clone 仍在途中，
  // 注册落在 afterAll 清理之后成为残留——实测踩坑）
  await page.getByPlaceholder('留空自动从路径推断').fill(projectName)

  await page.getByRole('dialog').getByRole('button', { name: '添加项目' }).click()
}

async function waitForProjectVisible(page: Page, projectName: string): Promise<void> {
  await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible({ timeout: 30000 })
}

test.describe('Clone 流程 E2E', () => {
  test.afterAll(async ({ request }) => {
    // afterAll 清本次运行尾巴（双端清理的另一半，见 beforeAll 注释）
    await cleanupProjectsByPathMarker({ marker: CLONE_MARKER, localParentDir: CLONE_PARENT_DIR })
    // 还原锁定开关：第二个用例把它置回 enabled，共享实例不再遗留锁定态
    // （与 lock.spec 的 afterAll 同款收尾）
    const unlockRes = await request.post('/api/lock/unlock', {
      data: { password: DEFAULT_PASSWORD },
    })
    if (unlockRes.ok()) {
      const token = (await unlockRes.json()).token as string
      await request.put('/api/lock/config', {
        headers: { 'X-Lock-Token': token },
        data: { enabled: false, currentPassword: DEFAULT_PASSWORD },
        failOnStatusCode: false,
      })
    }
  })

  test.beforeEach(async ({ page }) => {
    await fixedLocale(page)
    await page.goto('/')
    await waitForAppReady(page)
    await unlockIfNeeded(page)
  })

  test('enabled=false（锁定功能关闭）下 clone 公开仓库成功注册项目', async ({ page }) => {
    test.skip(!giteaUp, 'Gitea（localhost:3000）不可达，跳过 clone 用例')
    await setLockEnabled(page, false)
    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    const dir = nextCloneDir()
    await startClone(page, dir, 'git-test-e2e-1')

    await waitForProjectVisible(page, 'git-test-e2e-1')
  })

  test('enabled=true（锁定功能开启）+ 已解锁 下 clone 公开仓库也能成功（WS 子协议携带 unlock token）', async ({ page }) => {
    test.skip(!giteaUp, 'Gitea（localhost:3000）不可达，跳过 clone 用例')
    await setLockEnabled(page, true)
    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    const dir = nextCloneDir()
    await startClone(page, dir, 'git-test-e2e-2')

    // clone WS 握手不再因 423 卡 loading，项目卡片应在 30s 内出现
    await waitForProjectVisible(page, 'git-test-e2e-2')
  })
})
