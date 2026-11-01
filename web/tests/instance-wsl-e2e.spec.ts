import { test, expect } from '@playwright/test'
import { execSync as runSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * WSL 远程实例全链路 E2E（opt-in，路线图测试盲区补齐）：
 *
 * 默认 skip；SC_E2E_WSL_INSTANCE=1 时启用。spec 自供给整套环境：
 *   1. 交叉编译 linux 二进制（go build，产物进 Windows 临时目录）
 *   2. 经 /mnt/c 拷入 WSL，setsid 启动独立服务（端口 13010，数据目录隔离）
 *   3. WSL 服务端 lock setup（首启强制）→ 建 sc_ 访问令牌 → 建项目
 *   4. 向被测服务（PLAYWRIGHT_BASE_URL）注册为远程实例（带令牌）
 *
 * 覆盖点：
 *   A. 多实例总览远程路径：/proxy/<id>/api 读（列表）+ 写（UI 重命名/结束，
 *      经服务端直查 WSL API 断言落地）——补此前「远程操作靠推理」的盲区
 *   B. tmux SC_TERMINAL_ID 注入固化（Linux 真机）：双会话各自持正确 ID、
 *      全局环境无污染（此前只有 WSL 手工验证，无可重复自动化）
 *
 * afterAll 全量清场：注销实例、杀 WSL 服务、删 /tmp/sc-e2e。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const ENABLED = process.env.SC_E2E_WSL_INSTANCE === '1'
const WSL_PORT = 13010
const WSL_BASE = `http://127.0.0.1:${WSL_PORT}`

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WIN_TMP = path.join(os.tmpdir(), 'sc-wsl-e2e')
const WSL_DIR = '/tmp/sc-e2e'
// Windows 临时目录 → WSL 挂载路径（C:\Users\...\Temp → /mnt/c/Users/...\Temp）
const WSL_TMP_MNT = '/mnt/' + (() => {
  const p = os.tmpdir().replace(/\\/g, '/')
  return p[0]!.toLowerCase() + p.slice(2) // 去掉盘符冒号
})()

function runWsl(script: string, timeoutMs = 60_000): string {
  return runSync('wsl.exe -e bash -s', { input: script, encoding: 'utf-8', timeout: timeoutMs })
}

async function poll(fn: () => Promise<boolean>, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return true
    await new Promise(r => setTimeout(r, intervalMs))
  }
  return false
}

test.describe('WSL 远程实例全链路（opt-in）', () => {
  test.skip(!ENABLED, 'SC_E2E_WSL_INSTANCE=1 时启用（自供给 WSL 服务与实例注册）')

  let centralHeaders: Record<string, string> = {}
  let wslUnlockToken = ''
  let instanceId = ''
  let instanceName = ''
  let wslProjectId = ''

  test.beforeAll(async ({ request }) => {
    test.setTimeout(180_000)
    // WSL 可用性门控（无 WSL 环境直接 skip 而非报错）
    try {
      runSync('wsl.exe -e true', { timeout: 15_000 })
    } catch {
      test.skip(true, 'WSL 不可用')
      return
    }

    // 1. 交叉编译 linux 二进制（GOOS=linux；产物进 Windows 临时目录，不污染仓库）
    fs.mkdirSync(WIN_TMP, { recursive: true })
    const binWin = path.join(WIN_TMP, 'sc-server').replace(/\\/g, '/')
    runSync(`go build -o "${binWin}" .`, {
      cwd: REPO_ROOT,
      timeout: 180_000,
      env: { ...process.env, GOOS: 'linux', GOARCH: 'amd64' },
    })

    // 2. 部署进 WSL 并启动独立服务
    let provisionOut: string
    try {
      provisionOut = runWsl(`
        set -x
        pkill -f "sc-server" 2>/dev/null || true
        rm -rf ${WSL_DIR}
        mkdir -p ${WSL_DIR}/proj ${WSL_DIR}/data
        cp "${WSL_TMP_MNT}/sc-wsl-e2e/sc-server" ${WSL_DIR}/sc-server
        chmod +x ${WSL_DIR}/sc-server
        cd ${WSL_DIR}
        setsid nohup ./sc-server start --data-dir ${WSL_DIR}/data --port ${WSL_PORT} --no-tls > server.log 2>&1 < /dev/null &
        disown
        sleep 2
        ls -la ${WSL_DIR}/ | head -6
        ss -tln | grep ${WSL_PORT} || echo "PORT_NOT_LISTENING"
        set +x
      `, 90_000)
    } catch (e) {
      provisionOut = `provision exec failed: ${(e as Error).message.slice(0, 300)}`
    }
    const up = await poll(async () => {
      const r = await request.get(`${WSL_BASE}/api/lock/state`)
      return r.ok()
    }, 30_000)
    if (!up) {
      const log = runWsl(`tail -8 ${WSL_DIR}/server.log 2>/dev/null || echo "no log"`).trim()
      throw new Error(`WSL server failed to start in 30s. provision:\n${provisionOut}\nserver.log:\n${log}`)
    }

    // 3. WSL 侧供给：lock setup（首启强制）→ sc_ 令牌 → 项目
    const setupRes = await request.post(`${WSL_BASE}/api/lock/setup`, { data: { password: DEFAULT_PASSWORD } })
    wslUnlockToken = ((await setupRes.json()) as { token?: string }).token || ''
    const wslHeaders = { 'X-Lock-Token': wslUnlockToken, 'Content-Type': 'application/json' }
    const tokenRes = await request.post(`${WSL_BASE}/api/tokens`, {
      headers: wslHeaders, data: { name: 'e2e-proxy', expiresInDays: 1 },
    })
    const scToken = ((await tokenRes.json()) as { data?: { token?: string } }).data?.token || ''
    if (!scToken) throw new Error('failed to create sc_ token on WSL server')
    const projRes = await request.post(`${WSL_BASE}/api/projects`, {
      headers: wslHeaders, data: { name: 'wsl-e2e-proj', path: `${WSL_DIR}/proj` },
    })
    wslProjectId = ((await projRes.json()) as { data?: { id?: string } }).data?.id || ''
    if (!wslProjectId) throw new Error('failed to create project on WSL server')

    // 4. 向被测服务注册为远程实例
    const unlockRes = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
    const centralToken = ((await unlockRes.json()) as { token?: string }).token || ''
    centralHeaders = { 'X-Lock-Token': centralToken, 'Content-Type': 'application/json' }
    instanceName = `e2e-wsl-${Math.random().toString(36).slice(2, 7)}`
    const addRes = await request.post(`${BASE}/api/instances`, {
      headers: centralHeaders,
      data: { name: instanceName, url: WSL_BASE, token: scToken },
    })
    instanceId = ((await addRes.json()) as { data?: { id?: string } }).data?.id || ''
    if (!instanceId) throw new Error('failed to register WSL instance')
  })

  test.afterAll(async ({ request }) => {
    // 全量清场（逐项容忍失败）
    if (instanceId) {
      await request.delete(`${BASE}/api/instances/${instanceId}`, { headers: centralHeaders }).catch(() => {})
    }
    runWsl(`
      pkill -f "sc-server" 2>/dev/null || true
      rm -rf ${WSL_DIR}
    `, 30_000)
  })

  test('代理读：/proxy/<id>/api/terminals 经中心实例可达 WSL 会话列表', async ({ request }) => {
    const res = await request.get(`${BASE}/proxy/${instanceId}/api/terminals`, { headers: centralHeaders })
    expect(res.ok()).toBeTruthy()
    const j = (await res.json()) as { data?: unknown[] }
    expect(Array.isArray(j.data)).toBe(true)
  })

  test('代理写：总览 UI 对 WSL 会话重命名/结束，落地到远端真实状态', async ({ page, request }) => {
    test.setTimeout(60_000)
    // 经中心代理在 WSL 上建 shell 会话（本身即代理写路径）
    const createRes = await request.post(`${BASE}/proxy/${instanceId}/api/terminals`, {
      headers: centralHeaders, data: { projectId: wslProjectId, name: 'proxy-会话' },
    })
    const sessionId = ((await createRes.json()) as { data?: { id?: string } }).data?.id || ''
    expect(sessionId).toBeTruthy()

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    // 打开总览（Ctrl+K >多实例）→ WSL 块列出该会话
    await page.keyboard.press('Control+k')
    await expect(page.locator('.palette-card')).toBeVisible({ timeout: 5000 })
    await page.keyboard.type('>多实例')
    await page.keyboard.press('Enter')
    const modal = page.locator('.n-modal').filter({ hasText: '多实例会话总览' })
    await expect(modal).toBeVisible({ timeout: 5000 })
    const wslBlock = modal.locator('.iso-block').filter({ hasText: instanceName })
    await expect(wslBlock.locator('.iso-tag.ok')).toBeVisible({ timeout: 8000 })
    const row = wslBlock.locator(`.iso-row[title="${sessionId}"]`)
    await expect(row).toBeVisible({ timeout: 8000 })

    // 查看输出（远程路径）：tmux send-keys 产出确定性内容 → 只读弹层经
    // /proxy/<id>/api/terminals/<sid>/scrollback 拿到（组合路径此前无覆盖）
    const tmuxReady = await poll(async () => {
      const out = runWsl(`tmux -L simple-coding has-session -t ${sessionId} 2>/dev/null && echo OK || true`)
      return out.includes('OK')
    }, 15000)
    expect(tmuxReady).toBe(true)
    runWsl(`tmux -L simple-coding send-keys -t ${sessionId} 'echo WSL-OUT-MARKER' Enter`)
    const markerInPane = await poll(async () => {
      const out = runWsl(`tmux -L simple-coding capture-pane -p -t ${sessionId} 2>/dev/null || true`)
      return out.includes('WSL-OUT-MARKER')
    }, 10000)
    expect(markerInPane).toBe(true)

    await row.hover()
    await row.locator('button[title="查看输出"]').click()
    const outModal = page.locator('.n-modal').filter({ hasText: '查看输出' })
    await expect(outModal.locator('.iso-out-pre')).toContainText('WSL-OUT-MARKER', { timeout: 8000 })
    await page.keyboard.press('Escape')
    await expect(outModal).toHaveCount(0, { timeout: 5000 })

    // UI 重命名 → 轮询 WSL 直连 API 断言落地（远程写路径闭环）
    await row.hover()
    await row.locator('button[title="重命名"]').click()
    const input = row.locator('input')
    await expect(input).toBeVisible()
    await input.fill('远程改名会话')
    await input.press('Enter')
    const wslHeaders = { 'X-Lock-Token': wslUnlockToken }
    const renamed = await poll(async () => {
      const list = ((await (await request.get(`${WSL_BASE}/api/terminals`, { headers: wslHeaders })).json()).data) || []
      return list.some((s: { id: string; name: string }) => s.id === sessionId && s.name === '远程改名会话')
    }, 8000)
    expect(renamed).toBe(true)

    // UI 两击结束 → 轮询 WSL 直连 API 断言消失
    await row.hover()
    await row.locator('button[title="结束会话"]').click()
    await row.locator('button.armed').click()
    const gone = await poll(async () => {
      const list = ((await (await request.get(`${WSL_BASE}/api/terminals`, { headers: wslHeaders })).json()).data) || []
      return !list.some((s: { id: string }) => s.id === sessionId)
    }, 8000)
    expect(gone).toBe(true)
  })

  test('tmux SC_TERMINAL_ID（Linux 真机固化）：双会话隔离 + 全局无污染', async ({ request }) => {
    test.setTimeout(90_000)
    // 直连 WSL API 建两个 shell 会话
    const wslHeaders = { 'X-Lock-Token': wslUnlockToken, 'Content-Type': 'application/json' }
    const ids: string[] = []
    for (const name of ['scid-one', 'scid-two']) {
      const res = await request.post(`${WSL_BASE}/api/terminals`, {
        headers: wslHeaders, data: { projectId: wslProjectId, name },
      })
      ids.push(((await res.json()) as { data?: { id?: string } }).data?.id || '')
    }
    expect(ids.every(Boolean)).toBe(true)

    // tmux 会话异步创建：轮询直至两个 session 均就绪
    const ready = await poll(async () => {
      const out = runWsl(`tmux -L simple-coding list-sessions -F '#{session_name}' 2>/dev/null || true`)
      return ids.every(id => out.split('\n').some(line => line.trim() === id))
    }, 20_000)
    expect(ready).toBe(true)

    // 断言：各自持有正确 ID；全局环境无 SC_TERMINAL_ID
    const check = runWsl(`
      S1=${ids[0]}
      S2=${ids[1]}
      T1=$(tmux -L simple-coding show-environment -t "$S1" SC_TERMINAL_ID 2>/dev/null)
      T2=$(tmux -L simple-coding show-environment -t "$S2" SC_TERMINAL_ID 2>/dev/null)
      if tmux -L simple-coding show-environment -g SC_TERMINAL_ID >/dev/null 2>&1; then
        echo "GLOBAL_PRESENT"
      else
        echo "GLOBAL_ABSENT"
      fi
      echo "T1=$T1"
      echo "T2=$T2"
    `)
    expect(check).toContain(`T1=SC_TERMINAL_ID=${ids[0]}`)
    expect(check).toContain(`T2=SC_TERMINAL_ID=${ids[1]}`)
    expect(check).toContain('GLOBAL_ABSENT')

    // agent 回调令牌加固断言：SC_LOCK_TOKEN 只进会话级环境（sca_ 前缀），
    // 全局环境必须缺席——值不回显（避免令牌泄入测试日志）
    const tok = runWsl(`
      S1=${ids[0]}
      if tmux -L simple-coding show-environment -g SC_LOCK_TOKEN >/dev/null 2>&1; then
        echo "TOKEN_GLOBAL_PRESENT"
      else
        echo "TOKEN_GLOBAL_ABSENT"
      fi
      V=$(tmux -L simple-coding show-environment -t "$S1" SC_LOCK_TOKEN 2>/dev/null)
      case "$V" in
        SC_LOCK_TOKEN=sca_*) echo "TOKEN_SESSION_OK" ;;
        "") echo "TOKEN_SESSION_MISSING" ;;
        *) echo "TOKEN_SESSION_PREFIX_BAD" ;;
      esac
    `)
    expect(tok).toContain('TOKEN_GLOBAL_ABSENT')
    expect(tok).toContain('TOKEN_SESSION_OK')

    // 清场：结束测试会话（连带 tmux session 消失）
    for (const id of ids) {
      await request.delete(`${WSL_BASE}/api/terminals/${id}`, { headers: wslHeaders })
    }
  })
})
