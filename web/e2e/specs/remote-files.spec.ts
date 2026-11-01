import { test, expect, type APIRequestContext } from '@playwright/test'
import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'

/**
 * 远程文件管理器 E2E——新增交互回归：
 *   1. FTP 测试夹具驱动的实流：列表/右键菜单/复制路径/目录导航（存量缺陷回归）/
 *      路径直达/批量上传/单文件下载/目录 zip 归档/右键建删目录
 *   2. 路径历史快选（P-20261006-19）：导航两路径→历史下拉两条→点选直达→pin 置顶
 *   3. 双栏模式：左右栏主机名标识 / 对侧主机选择 / 结构切换
 *   4. 跨栏拖拽互传（gated）：FTP 目标守卫提示；WSL 实流另需 sshd
 *
 * 环境门控（与 remote-console 的 wslUp 同惯例）：
 *   夹具 = tools/testftp（内存盘 FTP，仅回环监听，凭据仅夹具用）。
 *   运行方预先启动：go build -o web/e2e/.tmp/testftp.exe ./tools/testftp
 *                 && web/e2e/.tmp/testftp.exe -port 2131
 *   端口 2131 不可达时实流用例跳过，双栏结构用例不受影响。
 * HTTP 走 Playwright request 上下文（与页面解耦，作用域自动回收）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const FTP_PORT = 2131
const HOST_NAME = 'e2e-ftp'

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let api: APIRequestContext
let ftpUp = false
let wslUp = false
let hostId = ''

/** 解锁并返回带 token 的请求头（测试实例口令来自 e2e 固定约定） */
async function authHeaders(): Promise<Record<string, string>> {
  const res = await api.post(BASE + '/api/lock/unlock', {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext()
  ftpUp = await tcpReachable(FTP_PORT)
  // WSL 探针端口以播种记录为准（槽位专用实例非 23，P-20261004-115）
  wslUp = await tcpReachable((await fetchWslHost(BASE))?.port || 23)

  if (ftpUp) {
    // 注册 FTP 主机（幂等：先清同名残留）
    const headers = await authHeaders()
    const list = await (await api.get(BASE + '/api/remotehosts', { headers })).json()
    for (const h of list?.data || []) {
      if (h.name === HOST_NAME) {
        await api.delete(`${BASE}/api/remotehosts/${h.id}`, { headers })
      }
    }
    const created = await (await api.post(BASE + '/api/remotehosts', {
      headers,
      data: {
        name: HOST_NAME, host: '127.0.0.1', port: FTP_PORT,
        user: 'e2e', authType: 'password', password: 'e2e-pass', protocol: 'ftp',
      },
    })).json()
    hostId = created?.data?.id || ''
  }
})

test.afterAll(async () => {
  if (hostId) {
    try {
      const headers = await authHeaders()
      await api.delete(`${BASE}/api/remotehosts/${hostId}`, { headers })
    } catch { /* 实例不可达时跳过清理 */ }
  }
  // 清掉 remoteConsole 视图残留：本 spec 打开过远程视图，状态会写进服务端
  // uiState，不清会让后续 spec 打开 /project 时恢复远程视图遮住编辑器主区
  try {
    const headers = await authHeaders()
    const res = await (await api.get(BASE + '/api/ui-state', { headers })).json()
    const map = res?.data as Record<string, Record<string, unknown>> | undefined
    if (map) {
      let changed = false
      for (const k of Object.keys(map)) {
        if (map[k]?.remoteConsole !== undefined) {
          delete map[k].remoteConsole
          changed = true
        }
      }
      if (changed) {
        // PUT 体是「实例名 → 命名空间」的浅合并 map（与服务端 GET 的 data 字段
        // 同构）——此前误包一层 { data: map }，把整个 map 塞进名为 data 的垃圾
        // 命名空间且每次运行再嵌套一层（第②轮全新数据面总览连挂的元凶之一）
        await api.put(BASE + '/api/ui-state', { headers, data: map })
      }
    }
  } catch { /* 实例不可达时跳过清理 */ }
  await api?.dispose()
})

/** 打开远程管理内嵌视图 */
async function openRemoteView(page: Parameters<typeof gotoAndUnlock>[0]) {
  await gotoAndUnlock(page, BASE + '/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
}

/** 经卡片悬浮快捷钮打开指定主机的文件管理器 */
async function openFileManager(page: Parameters<typeof gotoAndUnlock>[0], hostName: string) {
  await openRemoteView(page)
  const card = page.locator('.host-card').filter({ hasText: hostName }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.hover()
  await card.locator('.host-card-files').click()
  const modal = page.locator('.n-modal').filter({ hasText: '文件管理' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

test('文件管理器实流：列表 / 右键菜单 / 复制路径 / 目录导航 / 路径直达', async ({ page }) => {
  test.skip(!ftpUp, 'testftp 夹具未运行（2131），跳过实流用例')
  test.setTimeout(60000)
  await fixedLocale(page)
  const modal = await openFileManager(page, HOST_NAME)

  // 种子文件列出
  await expect(modal.locator('tr').filter({ hasText: 'docs' })).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('tr').filter({ hasText: 'hello.txt' })).toBeVisible()

  // 右键菜单（FTP 主机无「传输到主机」项）
  await modal.locator('tr').filter({ hasText: 'hello.txt' }).locator('td').first().click({ button: 'right' })
  const menu = page.locator('.rfc-menu')
  await expect(menu.locator('.rfc-item').filter({ hasText: '复制路径' })).toBeVisible()
  await expect(menu.locator('.rfc-item').filter({ hasText: '传输到主机' })).toHaveCount(0)
  await menu.locator('.rfc-item').filter({ hasText: '复制路径' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' })).toBeVisible()

  // 目录导航回归（存量缺陷：此前进入子目录列表不刷新）
  await modal.locator('.rfc-name').filter({ hasText: 'docs/' }).click()
  await expect(modal.locator('tr').filter({ hasText: 'readme.md' })).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('tr').filter({ hasText: 'hello.txt' })).toHaveCount(0)

  // 路径直达：编辑路径 → /docs/sub → note.txt
  await modal.locator('button[title="编辑路径直达"]').click()
  await modal.locator('.rf-path-input input').fill('/docs/sub')
  await modal.locator('.rf-path-input input').press('Enter')
  await expect(modal.locator('tr').filter({ hasText: 'note.txt' })).toBeVisible({ timeout: 5000 })
})

// 路径历史快选（P-20261006-19）：导航两路径 → 历史下拉两条（根不入史）→
// 点选直达 → pin 置顶（最近区迁入置顶区，点选 pin 项仍直达）。
// 每用例独立浏览器上下文（localStorage 隔离）+ beforeAll 重建主机（新 id），
// 历史从零起跑无跨用例串扰
test('路径历史快选：导航两路径 / 历史下拉两条 / 点选直达 / pin 置顶', async ({ page }) => {
  test.skip(!ftpUp, 'testftp 夹具未运行（2131），跳过实流用例')
  test.setTimeout(60000)
  await fixedLocale(page)
  const modal = await openFileManager(page, HOST_NAME)
  await expect(modal.locator('tr').filter({ hasText: 'hello.txt' })).toBeVisible({ timeout: 5000 })

  // 导航两路径：点入 /docs → 直达 /docs/sub（根 / 不入史）
  await modal.locator('.rfc-name').filter({ hasText: 'docs/' }).click()
  await expect(modal.locator('tr').filter({ hasText: 'readme.md' })).toBeVisible({ timeout: 5000 })
  await modal.locator('button[title="编辑路径直达"]').click()
  await modal.locator('.rf-path-input input').fill('/docs/sub')
  await modal.locator('.rf-path-input input').press('Enter')
  await expect(modal.locator('tr').filter({ hasText: 'note.txt' })).toBeVisible({ timeout: 5000 })

  // 历史下拉两条，最近访问（/docs/sub）在前
  await modal.locator('.rf-hist-btn').click()
  const hist = page.locator('[data-testid="rf-history"]')
  await expect(hist).toBeVisible()
  const items = hist.locator('.rf-hist-item')
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toHaveAttribute('title', '/docs/sub')
  await expect(items.nth(1)).toHaveAttribute('title', '/docs')

  // 点选直达：/docs 一次点选跳转（note.txt 消失、readme.md 回归）
  await items.nth(1).click()
  await expect(hist).toBeHidden()
  await expect(modal.locator('tr').filter({ hasText: 'readme.md' })).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('tr').filter({ hasText: 'note.txt' })).toHaveCount(0)

  // pin 置顶：/docs/sub 从最近区迁入置顶区（重复访问的重排不影响条目身份）
  await modal.locator('.rf-hist-btn').click()
  await expect(hist).toBeVisible()
  // pin/unpin 微操作钮 hover 才显形（visibility:hidden）：先悬停条目再点钮
  const subItem = hist.locator('.rf-hist-item[title="/docs/sub"]')
  await subItem.hover()
  await subItem.locator('button[title="钉选到顶部"]').click()
  await expect(hist.locator('.rf-hist-head').filter({ hasText: '置顶' })).toBeVisible()
  await subItem.hover()
  await expect(subItem.locator('button[title="取消钉选"]')).toBeVisible()
  await expect(items).toHaveCount(2) // pin 迁移不复制条目：置顶 1 + 最近 1

  // 置顶项点选仍直达
  await hist.locator('.rf-hist-item[title="/docs/sub"]').click()
  await expect(modal.locator('tr').filter({ hasText: 'note.txt' })).toBeVisible({ timeout: 5000 })
})

test('文件管理器实流：批量上传 / 单文件下载 / 目录 zip 归档 / 右键建删目录', async ({ page }) => {
  test.skip(!ftpUp, 'testftp 夹具未运行（2131），跳过实流用例')
  test.setTimeout(90000)
  await fixedLocale(page)
  const modal = await openFileManager(page, HOST_NAME)
  await expect(modal.locator('tr').filter({ hasText: 'hello.txt' })).toBeVisible({ timeout: 5000 })

  // 批量上传（一次拨号传两文件）→ 列表刷新可见
  await modal.locator('input[type="file"]').setInputFiles([
    { name: 'e2e-upload-a.txt', mimeType: 'text/plain', buffer: Buffer.from('aaa') },
    { name: 'e2e-upload-b.txt', mimeType: 'text/plain', buffer: Buffer.from('bbb') },
  ])
  await expect(modal.locator('tr').filter({ hasText: 'e2e-upload-a.txt' })).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('tr').filter({ hasText: 'e2e-upload-b.txt' })).toBeVisible()

  // 单文件下载：右键 → 菜单下载 → 保存名保持原名
  await modal.locator('tr').filter({ hasText: 'e2e-upload-a.txt' }).locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: /^下载（\d+）$|^下载$/ }).first().click()
  const dl = await page.waitForEvent('download')
  expect(dl.suggestedFilename()).toBe('e2e-upload-a.txt')

  // 目录归档下载：右键 docs → 下载（打包 zip）
  await modal.locator('tr').filter({ hasText: 'docs/' }).locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: '下载（打包 zip）' }).click()
  const zipDl = await page.waitForEvent('download')
  expect(zipDl.suggestedFilename()).toBe('docs.zip')
  const tmpPath = await zipDl.path()
  expect(fs.statSync(tmpPath).size).toBeGreaterThan(0)

  // 右键空白区 → 新建目录（prompt 弹窗 teleport 到 body，用 page 级定位）→ 右键删除（确认）
  await modal.locator('.rf-dropzone').click({ button: 'right', position: { x: 20, y: 20 } })
  await page.locator('.rfc-item').filter({ hasText: '新建目录' }).click()
  await page.locator('.n-input input:visible').last().fill('e2e-dir')
  await page.locator('button:visible').filter({ hasText: '确认' }).last().click()
  await expect(modal.locator('tr').filter({ hasText: 'e2e-dir' })).toBeVisible({ timeout: 5000 })
  await modal.locator('tr').filter({ hasText: 'e2e-dir' }).locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: '删除' }).first().click()
  await page.locator('.n-modal').filter({ hasText: '删除远程文件' }).locator('button')
    .filter({ hasText: '确认' }).click()
  await expect(modal.locator('tr').filter({ hasText: 'e2e-dir' })).toHaveCount(0, { timeout: 5000 })
})

test('双栏模式：左右栏主机名标识 / 对侧主机选择 / 结构切换', async ({ page }) => {
  test.skip(!ftpUp, 'testftp 夹具未运行（2131），无法注册 FTP 主机')
  test.setTimeout(60000)
  await fixedLocale(page)
  const modal = await openFileManager(page, HOST_NAME)

  // 开双栏：左栏标识 = 当前主机；右侧主机选择器出现
  await modal.locator('button').filter({ hasText: '双栏' }).click()
  await expect(modal.locator('.rfm-pane-label').filter({ hasText: HOST_NAME })).toBeVisible()
  await expect(modal.locator('.rfm-dual-hint')).toContainText('双栏模式')
  // 数据目录预置 WSL 主机 → 选择后右栏面板渲染
  await modal.locator('.rfm-pane-label-select .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'WSL' }).first().click()
  await expect(modal.locator('.rf-pane')).toHaveCount(2)
  // 关回单栏
  await modal.locator('button').filter({ hasText: '双栏' }).click()
  await expect(modal.locator('.rf-pane')).toHaveCount(1)
})

test('跨栏拖拽互传：FTP 目标守卫提示', async ({ page }) => {
  test.skip(!ftpUp || !wslUp, 'testftp 夹具或 WSL sshd 不可达，跳过实流用例')
  test.setTimeout(60000)
  await fixedLocale(page)
  const modal = await openFileManager(page, 'WSL')
  await expect(modal.locator('tr').first()).toBeVisible({ timeout: 10000 })

  await modal.locator('button').filter({ hasText: '双栏' }).click()
  await modal.locator('.rfm-pane-label-select .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: HOST_NAME }).first().click()
  await expect(modal.locator('.rf-pane')).toHaveCount(2)

  // SFTP → FTP 拖拽：客户端守卫提示（不发请求）；拖拽源 = 文件名 span
  await modal.locator('.rf-pane').first().locator('.rfc-name').first().dragTo(
    modal.locator('.rf-pane').nth(1).locator('.rf-dropzone'),
  )
  await expect(page.locator('.n-message').filter({ hasText: 'FTP 主机不支持跨主机传输' })).toBeVisible()
})

test('跨栏拖拽互传：SFTP↔SFTP 实传成功', async ({ page }) => {
  test.skip(!wslUp, 'WSL sshd 不可达，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  await openRemoteView(page)

  // 复制 WSL 主机得到第二台 SFTP（凭据服务端复制，测试无需知道明文）
  // 精确匹配主机名：粘贴后「WSL 副本」同样以 WSL 开头，前缀匹配会错拿副本
  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()
  await wslCard.hover()
  await wslCard.locator('.host-card-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '复制主机' }).first().click()
  await page.locator('.sidebar-actions button').filter({ hasText: '粘贴主机副本' }).click()
  const dupCard = page.locator('.host-card').filter({ hasText: '副本' }).first()
  await expect(dupCard).toBeVisible({ timeout: 10000 })

  try {
    // 视图已打开（副本粘贴后仍在本视图），直接经悬浮快捷钮开文件管理器
    const card = page.locator('.host-card').filter({
      has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
    }).first()
    await expect(card).toBeVisible({ timeout: 10000 })
    await card.hover()
    await card.locator('.host-card-files').click()
    const modal = page.locator('.n-modal').filter({ hasText: '文件管理' })
    await expect(modal).toBeVisible({ timeout: 5000 })
    await expect(modal.locator('tr').first()).toBeVisible({ timeout: 15000 })

    // 双栏：右栏选 WSL 副本
    await modal.locator('button').filter({ hasText: '双栏' }).click()
    await modal.locator('.rfm-pane-label-select .n-base-selection').click()
    // 主机列表为异步拉取：等选项渲染（应用侧同时以 disabled 防空选项）
    await expect(page.locator('.n-base-select-option').filter({ hasText: '副本' }).first()).toBeVisible({ timeout: 10000 })
    await page.locator('.n-base-select-option').filter({ hasText: '副本' }).first().click()
    await expect(modal.locator('.rf-pane')).toHaveCount(2)

    // 左栏 /tmp 造一个待传文件。
    // 预清理历史残留：前序运行失败中断时 /tmp/e2e-xfer.txt 会留存（本用例末尾
    // 的删除清理只在全链路走通后执行），残留会让本用例从「上传新文件」退化为
    // 「命中旧行」，失败形态随远端状态漂移——先经 API 删除保证从零上传
    try {
      const headers = await authHeaders()
      const hosts = (await (await api.get(BASE + '/api/remotehosts', { headers })).json())?.data || []
      const wsl = hosts.find((h: { name?: string }) => h.name === 'WSL')
      if (wsl) {
        await api.post(`${BASE}/api/remotehosts/${wsl.id}/files/delete`, {
          headers, data: { paths: ['/tmp/e2e-xfer.txt'] }, failOnStatusCode: false, timeout: 15000,
        })
      }
    } catch { /* 预清理失败不影响用例：上传本身幂等覆盖 */ }
    // WSL sshd 对高频新建连接有 MaxStartups 节流：连续拨号期上传可能被暂时
    // 拒绝（502 auth rejected），这里重试一次等节流窗口过去
    const left = modal.locator('.rf-pane').first()
    await left.locator('button[title="编辑路径直达"]').click()
    await left.locator('.rf-path-input input').fill('/tmp')
    await left.locator('.rf-path-input input').press('Enter')
    await expect(left.locator('tr').first()).toBeVisible({ timeout: 20000 })
    // 虚拟滚动只渲染可视区行：/tmp 被并行门禁 wsl-verify 的残留目录污染时
    // （实测已从 79 条涨到 500+ 条），目标文件按序落在列表中段——滚到底反而把
    // 它推出可视窗口（本次失败实证：文件已在远端、底窗口只剩 v/x 段行）。
    // 改用面板自带的按名过滤收敛到单行（单行列表无虚拟滚动窗口问题，且拖拽源
    // 随之必进 DOM），不再依赖滚动位置
    const leftRowVisible = async (timeout: number) => {
      await left.locator('.rf-filter input').fill('e2e-xfer')
      await expect(left.locator('tr').filter({ hasText: 'e2e-xfer.txt' })).toBeVisible({ timeout })
    }
    await test.step('上传待传文件（被节流时重试一次）', async () => {
      const doUpload = async () => {
        await left.locator('input[type="file"]').setInputFiles([
          { name: 'e2e-xfer.txt', mimeType: 'text/plain', buffer: Buffer.from('drag-me') },
        ])
      }
      await doUpload()
      try {
        await leftRowVisible(8000)
      } catch {
        // 两类失败形态都兜住：
        // a) 上传成功但列表渲染竞态（实测文件已落远端、面板仍显示旧列表）
        //    → 点刷新重拉一次再断言；
        // b) 上传被 MaxStartups 节流暂时拒绝 → 刷新后仍缺则原样重传一次
        await left.locator('button[title="刷新"]').click()
        try {
          await leftRowVisible(8000)
        } catch {
          await doUpload()
          await leftRowVisible(8000)
        }
      }
    })

    // 拖拽 → 确认弹窗 → 成功 toast；右栏刷新后出现同名文件
    await left.locator('.rfc-name').filter({ hasText: 'e2e-xfer.txt' }).dragTo(
      modal.locator('.rf-pane').nth(1).locator('.rf-dropzone'),
    )
    await page.locator('.n-modal button').filter({ hasText: '确认' }).click()
    await expect(page.locator('.n-message').filter({ hasText: '已传输到' })).toBeVisible({ timeout: 60000 })
    const right = modal.locator('.rf-pane').nth(1)
    // 虚拟滚动只渲染可视区行：/tmp 残留污染致目标文件落在列表中段（上方左栏
    // 同款实证），滚到底反而推出窗口——同改按名过滤收敛到单行再断言/右键删除
    await right.locator('.rf-filter input').fill('e2e-xfer')
    await expect(right.locator('tr').filter({ hasText: 'e2e-xfer.txt' })).toBeVisible({ timeout: 15000 })

    // 清理远端文件（右栏删除，右栏同样是 WSL 的 /tmp）
    await right.locator('tr').filter({ hasText: 'e2e-xfer.txt' }).locator('td').first().click({ button: 'right' })
    await page.locator('.rfc-item').filter({ hasText: '删除' }).first().click()
    await page.locator('.n-modal').filter({ hasText: '删除远程文件' }).locator('button')
      .filter({ hasText: '确认' }).click()
    await expect(right.locator('tr').filter({ hasText: 'e2e-xfer.txt' })).toHaveCount(0, { timeout: 5000 })
  } finally {
    // 清理副本主机
    try {
      const headers = await authHeaders()
      const list = await (await api.get(BASE + '/api/remotehosts', { headers })).json()
      for (const h of list?.data || []) {
        if (String(h.name).includes('副本')) {
          await api.delete(`${BASE}/api/remotehosts/${h.id}`, { headers })
        }
      }
    } catch { /* 清理失败不影响断言 */ }
  }
})
