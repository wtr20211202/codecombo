import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, gotoAndUnlock } from '../../tests/helpers'
import { serverIsRemote, serverPath } from '../../tests/dualpath'
import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 实例族总览 E2E（P-20261003-56）：同机多实例 fleet 一览——
 *   1. 双实例存活态：本机行（self 恒活）+ 对端行（claim 指向的真实 HTTP 服务，
 *      /api/settings 返回本应用格式 → 探活判活）两行俱活
 *   2. 打开期间周期重探活（P-20261004-51）：弹层不关、不点刷新，杀对端 →
 *      下一轮询周期行态自行转死（已停止）；同端口复活 → 转回活态（保鲜双向）
 *   3. 杀对端 → 刷新族表显死态（已停止）+ 清理按钮两击清残留：行消失且
 *      claim 文件物理删除（服务端删除前重探活，真死才删）
 *
 * 环境说明：对端实例用 spec 进程内的最小 HTTP 真身模拟——族表链路的被测面
 * 是「claim 聚合 + 探活分类 + 清理」，对端 claim 的写入方（claims 模块）属
 * P-20261003-3 已落地域且有自己的 Go 单测；真身按探活协议回答 /api/settings
 * 即走通同一判定路径（checkInstanceURL 三态分类）。项目锚点用临时 git 仓
 * （API 注册进实例 → project.added 事件让 claims 模块写 self claim），不碰
 * 播种项目所在仓库的 .git。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:9999'
const PEER_ID = 'e2e-fleet-peer'
const PEER_VERSION = '9.9.9-fleet-e2e'
const PROJ_NAME = 'e2e-fleet-anchor'

let unlockToken = ''
let tmpRepo = ''
let projectId = ''
let peer: http.Server
let peerPort = 0

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

/** claim 目录：与 claims 包同构（<gitdir>/simple-coding/project-claims） */
function claimDirOf(repo: string): string {
  return path.join(repo, '.git', 'simple-coding', 'project-claims')
}

function plantPeerClaim(port: number) {
  const now = new Date().toISOString()
  mkdirSync(claimDirOf(tmpRepo), { recursive: true })
  writeFileSync(path.join(claimDirOf(tmpRepo), `${PEER_ID}.json`), JSON.stringify({
    instanceId: PEER_ID,
    port,
    startedAt: now,
    updatedAt: now,
  }))
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 临时 git 仓作 claim 锚点：注册进实例，claims 模块经 project.added 写 self claim
  tmpRepo = mkdtempSync(path.join(tmpdir(), 'sc-fleet-e2e-'))
  execSync('git init', { cwd: tmpRepo })
  // 注册路径按服务端形态交接（P-20261005-187）：claims 聚合是服务端读注册目录，
  // 跨拓扑经 /mnt/c 同见同一物理 claim 文件；测试侧 claim 断言用 tmpRepo 原形态
  const addRes = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(tmpRepo) })
  expect(addRes.ok, '注册锚点项目应成功').toBeTruthy()
  const added = (await addRes.json()) as { data?: { id?: string } }
  projectId = added.data?.id || ''
  expect(projectId).toBeTruthy()

  // 对端真身：按探活协议回答 /api/settings（本应用 JSON 形）
  peer = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/settings')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: { version: PEER_VERSION } }))
    } else {
      res.statusCode = 404
      res.end('not the endpoint the probe hits')
    }
  })
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  peerPort = (peer.address() as AddressInfo).port
  plantPeerClaim(peerPort)
})

test.afterAll(async () => {
  peer?.close()
  if (projectId) {
    await api('DELETE', `/api/projects/${projectId}`).catch(() => { /* 尽力而为 */ })
  }
  if (tmpRepo) rmSync(tmpRepo, { recursive: true, force: true })
})

/** 实例菜单直达族表（免命令面板）；返回族表弹层 Locator */
async function openFleet(page: Page) {
  await page.locator('.rail-instance').first().click()
  const menuItem = page.locator('[data-testid="menu-instance-fleet"]')
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()
  const modal = page.locator('.n-modal').filter({ hasText: '实例族总览' }).first()
  await expect(modal).toBeVisible({ timeout: 8000 })
  return modal
}

/** 对端行：族表显截短实例号（前 8 位），完整号在 .ifo-instance 的 title——按 title 定位 */
function peerRowOf(page: Page, modal: ReturnType<Page['locator']>) {
  return modal.locator('[data-testid="fleet-row"]').filter({
    has: page.locator(`[title="${PEER_ID}"]`),
  })
}

test('双实例存活态：本机行恒活 + 对端行探活判活', async ({ page }) => {
  // 对端「存活」= 服务端探活 HTTP 打到测试侧 127.0.0.1 伪对端，跨拓扑 WSL NAT
  // 下结构性不可达（镜像网络形态可达）——按环境门控 skip；死态用例不受此限
  //（连接拒绝两拓扑同形）（P-20261005-187）
  test.skip(serverIsRemote, '对端探活目标在测试侧 127.0.0.1，跨拓扑 NAT 不可达——仅同机拓扑')
  await gotoAndUnlock(page, BASE + '/project')
  const modal = await openFleet(page)

  // self 行恒在最前：本机徽标 + 注册锚点项目出现在项目清单
  const selfRow = modal.locator('[data-testid="fleet-row"]').first()
  await expect(selfRow).toContainText('本机', { timeout: 15000 })
  await expect(selfRow).toContainText(PROJ_NAME)

  // 对端行：claim 聚合出端口与项目，探活（真实 HTTP /api/settings）判活
  const peerRow = peerRowOf(page, modal)
  await expect(peerRow).toHaveCount(1)
  await expect(peerRow).toContainText(`:${peerPort}`)
  await expect(peerRow.locator('[data-testid="fleet-status"]')).toHaveText('存活', { timeout: 15000 })
  await expect(peerRow).toContainText(PROJ_NAME)
  // 存活行无清理按钮（服务端也会拒，UI 不给入口）
  await expect(peerRow.locator('[data-testid="fleet-clean"]')).toHaveCount(0)
})

test('打开期间周期重探活：对端停止/复活下一轮询周期即反映（P-20261004-51）', async ({ page }) => {
  // 存活相位依赖服务端探活打到测试侧 127.0.0.1，同「双实例存活态」按拓扑门控
  test.skip(serverIsRemote, '对端探活目标在测试侧 127.0.0.1，跨拓扑 NAT 不可达——仅同机拓扑')
  // 两个方向的翻转各需等最多一个 15s 轮询周期，默认 30s 用例超时不够
  test.setTimeout(90_000)

  // 重植对端 claim 刷新 updatedAt：本用例排第二，防前序用例耗时累计把 claim
  // 顶进 3min stale 窗（StaleAfter）干扰行态断言
  plantPeerClaim(peerPort)

  await gotoAndUnlock(page, BASE + '/project')
  const modal = await openFleet(page)
  const peerRow = peerRowOf(page, modal)
  await expect(peerRow.locator('[data-testid="fleet-status"]')).toHaveText('存活', { timeout: 15000 })

  // 杀对端：弹层保持打开、不点刷新——下一轮询周期行态自行转死（保鲜核心断言；
  // 连接拒绝即时返回，等待上界 ≈ 轮询间隔，25s 给足余量）
  await new Promise<void>(resolve => peer.close(() => resolve()))
  await expect(peerRow.locator('[data-testid="fleet-status"]')).toHaveText('已停止', { timeout: 25_000 })

  // 同端口原地复活：下一周期转回活态——保鲜是双向的（对端重启不换号的场景）
  peer = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/settings')) {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: { version: PEER_VERSION } }))
    } else {
      res.statusCode = 404
      res.end('not the endpoint the probe hits')
    }
  })
  await new Promise<void>(resolve => peer.listen(peerPort, '127.0.0.1', resolve))
  await expect(peerRow.locator('[data-testid="fleet-status"]')).toHaveText('存活', { timeout: 25_000 })

  // 收尾停回对端：交接给下一用例「杀对端清理残留」的既定前置（死态 + claim 在场）
  await new Promise<void>(resolve => peer.close(() => resolve()))
})

test('杀对端：死态显 + 清理按钮两击清残留（claim 文件物理删除）', async ({ page }) => {
  // 先杀对端再开族表：本次 load 的探活即得死态（连接拒绝即时返回）
  await new Promise<void>(resolve => peer.close(() => resolve()))
  const claimFile = path.join(claimDirOf(tmpRepo), `${PEER_ID}.json`)
  expect(existsSync(claimFile), '清理前 claim 文件应在场').toBeTruthy()

  await gotoAndUnlock(page, BASE + '/project')
  const modal = await openFleet(page)

  const peerRow = peerRowOf(page, modal)
  await expect(peerRow.locator('[data-testid="fleet-status"]')).toHaveText('已停止', { timeout: 15000 })

  // 两击确认清理（同结束会话交互形）：第一击进入确认态，第二击执行
  const cleanBtn = peerRow.locator('[data-testid="fleet-clean"]')
  await expect(cleanBtn).toBeVisible()
  await expect(cleanBtn).toHaveAttribute('title', '清理残留 claim')
  await cleanBtn.click()
  await expect(cleanBtn).toHaveAttribute('title', '再点一次确认清理')
  await cleanBtn.click()

  // 清理成功反馈 + 族表刷新后行消失 + 磁盘 claim 文件真删
  await expect(peerRow).toHaveCount(0, { timeout: 15000 })
  expect(existsSync(claimFile), '清理后 claim 文件应被删除').toBeFalsy()
  // 清理接口回执（直查服务端，防 UI 假阳性）
  const probe = await fetch(BASE + '/api/instances/fleet', { headers: { 'X-Lock-Token': unlockToken } })
  const body = (await probe.json()) as { data?: { instanceId: string }[] }
  expect(body.data?.some(r => r.instanceId === PEER_ID)).toBeFalsy()
})
