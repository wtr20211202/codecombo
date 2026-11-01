import { test, expect } from '@playwright/test'
import type { ChildProcess } from 'node:child_process'
import { spawn, execSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { dualTmpDir, dualTmpClean, serverPath } from '../../tests/dualpath'

/**
 * 端口预览面板全链路（P-20261001-29）：
 * 本地起两个静态服务（故意带 X-Frame-Options: DENY——顺带验证服务端反代剥头，
 * iframe 能渲染即剥头生效）→ 底部「预览」面板输入端口打开 → 断言 iframe 内容
 * （HTML + 相对子资源经 /preview/:port 前缀正确回源）→ 改端口切换 →
 * 新窗口打开（noopener）→ 刷新后会话恢复自动装载上次端口。
 *
 * 拓扑守卫：静态服务必须活在服务端网络命名空间——同拓扑（全 Windows / WSL 内
 * 全量）进程内 node 起服；跨拓扑（Windows Playwright 打 WSL 实例）经 wsl.exe
 * 在 WSL 内起 python3 http.server（WSL2 localhost 转发对浏览器侧透明）。
 */

const PROJ_DIR = dualTmpDir('sc-e2e-preview-')
const PROJ_NAME = 'e2e-preview-panel'

// 两个目标的标记内容（随机后缀防跨实例/跨用例串扰）
const SUF = String(Date.now() % 100000)
const MARKER_A = `pv-a-${SUF}`
const MARKER_B = `pv-b-${SUF}`
// 第三个目标：不可达→重试恢复用例里「服务此刻就绪」的装载内容
const MARKER_C = `pv-c-${SUF}`

/** 服务端同拓扑判定：spec 进程与服务实例同侧（node 静态服务直接可达） */
const sameSideAsServer = process.platform === 'linux' || process.env.E2E_SERVER_OS !== 'linux'

let nodeServers: http.Server[] = []
let wslProc: ChildProcess | null = null
let portA = 0
let portB = 0

function writeFixture(dir: { win: string }, marker: string) {
  // span 必须先于外链脚本：app.js 同步执行时目标节点须已在 DOM
  fs.writeFileSync(path.join(dir.win, 'index.html'),
    `<!DOCTYPE html><html><body><h1 id="pv-marker">${marker}</h1>` +
    `<span id="pv-appjs"></span><script src="app.js"></script></body></html>`)
  fs.writeFileSync(path.join(dir.win, 'app.js'),
    `document.getElementById('pv-appjs').textContent='js-ok'`)
}

// 进程内 node 静态服务：故意回 X-Frame-Options: DENY（剥头由服务端反代负责，
// 未剥则 iframe 拒渲染 → 用例红）
function startNodeStatic(dir: string, port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0])
    const file = path.join(dir, rel, rel.endsWith('/') ? 'index.html' : '')
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return }
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Content-Type',
        file.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8')
      res.end(data)
    })
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

async function freePortLocal(): Promise<number> {
  return new Promise((resolve, reject) => {
    const l = net.createServer()
    l.once('error', reject)
    l.listen(0, '127.0.0.1', () => {
      const { port } = l.address() as net.AddressInfo
      l.close(() => resolve(port))
    })
  })
}

// 跨拓扑：端口与服务都必须取自 WSL 侧（bind :0 让内核分配，回显解析）
function wslFreePort(): number {
  const out = execSync(
    'wsl.exe -e bash -c "python3 -c \'import socket;s=socket.socket();s.bind((\\\'127.0.0.1\\\',0));print(s.getsockname()[1]);s.close()\'"',
  ).toString().trim()
  const port = Number(out)
  if (!Number.isInteger(port) || port <= 0) throw new Error(`wsl free port parse: ${out}`)
  return port
}

function startWslStatic(winDir: string, port: number): void {
  const dir = serverPath(winDir)
  wslProc = spawn('wsl.exe', ['-e', 'bash', '-c',
    `cd '${dir}' && exec python3 -m http.server ${port} --bind 127.0.0.1`],
  { stdio: 'ignore' })
}

async function startPreviewTarget(winDir: string, wantPort?: number): Promise<number> {
  if (sameSideAsServer) {
    const port = wantPort ?? await freePortLocal()
    const srv = await startNodeStatic(winDir, port)
    nodeServers.push(srv)
    return port
  }
  const port = wantPort ?? wslFreePort()
  startWslStatic(winDir, port)
  // python http.server 就绪等待：从 WSL 侧探测（避免 Windows 侧探测受端口转发干扰）
  for (let i = 0; i < 30; i++) {
    try {
      execSync(`wsl.exe -e bash -c "curl -s -o /dev/null http://127.0.0.1:${port}/"`)
      return port
    } catch { /* 未就绪继续等 */ }
  }
  throw new Error(`wsl static server not ready on ${port}`)
}

async function enterProject(page: import('@playwright/test').Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = page.locator('.project-card').filter({ hasText: PROJ_NAME }).first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 展开底部面板并切到「预览」tab（幂等：面板已开/tab 已激活时点击无害） */
async function openPreviewTab(page: import('@playwright/test').Page) {
  // 底部面板未开时先经活动栏终端按钮展开（bottom tab 按钮在面板内部）
  if (!(await page.locator('.bottom-panel').isVisible().catch(() => false))) {
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
  }
  await page.locator('.bottom-tabs button').filter({ hasText: '预览' }).click()
}

test.beforeAll(async () => {
  // 自备临时项目（首页卡片点击进入项目页——底部面板的挂载宿主）
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  fs.mkdirSync(PROJ_DIR.win, { recursive: true })
  execSync('git init', { cwd: PROJ_DIR.win })
  execSync('git config core.autocrlf false', { cwd: PROJ_DIR.win })
  const res = await fetch(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(PROJ_DIR.win) }),
  })
  expect([200, 201]).toContain(res.status)

  writeFixture(PROJ_DIR, MARKER_A)
  const dirB = { win: path.join(PROJ_DIR.win, 'b') }
  fs.mkdirSync(dirB.win, { recursive: true })
  writeFixture(dirB, MARKER_B)
  portA = await startPreviewTarget(PROJ_DIR.win)
  portB = await startPreviewTarget(dirB.win)
})

test.afterAll(async () => {
  nodeServers.forEach(s => s.close())
  nodeServers = []
  if (wslProc) {
    wslProc.kill()
    try { execSync(`wsl.exe -e bash -c "pkill -f 'http.server ${portA}' ; pkill -f 'http.server ${portB}'"`) } catch { /* 尽力清理 */ }
  }
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await fetch(`${API_BASE}/api/projects/${mine.id}`, { method: 'DELETE', headers })
  dualTmpClean(PROJ_DIR.win)
})

test.describe('端口预览面板', () => {
  test('输入端口打开预览：iframe 内容（HTML + 相对 JS 子资源）经反代正确回源', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    // 首次进入无历史端口：空态提示
    await expect(page.locator('.preview-panel .n-empty')).toBeVisible()

    // 输入端口 A 打开：iframe 渲染 = 反代剥 X-Frame-Options 生效
    const input = page.locator('.preview-panel .preview-port-input input')
    await input.fill(String(portA))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()

    const frame = page.frameLocator('.preview-frame')
    await expect(frame.locator('#pv-marker')).toHaveText(MARKER_A)
    // 相对路径子资源（app.js）经 /preview/<port>/ 前缀正确回源
    await expect(frame.locator('#pv-appjs')).toHaveText('js-ok')

    // 端口 A 进最近记忆
    await expect(page.locator('.preview-recent-tag').filter({ hasText: String(portA) })).toBeVisible()
  })

  test('改端口切换：iframe 内容随端口切换，两个端口都在最近记忆', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    const input = page.locator('.preview-panel .preview-port-input input')
    // 先开 A 再切 B（用例间浏览器上下文隔离，本用例内自建两个端口的记忆）
    await input.fill(String(portA))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_A)

    await input.fill(String(portB))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_B)

    // 当前端口 tag 高亮（active 类，不耦合 naive-ui 内部 class），两个记忆均在
    await expect(page.locator('.preview-recent-tag--active')).toHaveText(String(portB))
    await expect(page.locator('.preview-recent-tag').filter({ hasText: String(portA) })).toBeVisible()
  })

  test('新窗口打开：popup URL 为 /preview/<port>/（noopener）', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    const input = page.locator('.preview-panel .preview-port-input input')
    await input.fill(String(portA))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_A)

    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.locator('.preview-panel button[title="新窗口打开"]').click(),
    ])
    await expect(popup).toHaveURL(new RegExp(`/preview/${portA}/$`))
    await popup.close()
  })

  test('非法端口被拒：越界端口不发起预览', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    const input = page.locator('.preview-panel .preview-port-input input')
    await input.fill('80')
    // 打开按钮禁用（输入组件 min/max + 前端校验双层）
    await expect(page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true })).toBeDisabled()
    await expect(page.locator('.preview-frame')).toHaveCount(0)
  })

  test('会话恢复：刷新后重进面板自动装载上次端口', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    const input = page.locator('.preview-panel .preview-port-input input')
    await input.fill(String(portB))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_B)

    await page.reload()
    await enterProject(page)
    await openPreviewTab(page)

    // 输入框回填 + iframe 自动装载上次端口 B（免重复输入）
    await expect(input).toHaveValue(String(portB))
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_B)
  })

  test('未监听端口：加载 spinner → 超时不可达错误卡 → 服务就绪后重试恢复', async ({ page }) => {
    // 15s 冷启动宽容窗口占大头，整体超时上调防误判
    test.setTimeout(60_000)
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    // 紧邻释放的自由端口：无服务监听，代理层回 502 落地页
    const deadPort = await freePortLocal()
    const input = page.locator('.preview-panel .preview-port-input input')
    await input.fill(String(deadPort))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()

    // 加载态：spinner + 等待文案（502 落地页不算加载成功，不被裸露）
    const loading = page.locator('.preview-panel .preview-state--loading')
    await expect(loading).toBeVisible()
    await expect(loading).toContainText(String(deadPort))

    // 超时 → 不可达错误卡：端口号 + 提示 + 重试 + 新窗口兜底
    const errorCard = page.locator('.preview-panel .preview-state--error')
    await expect(errorCard).toBeVisible({ timeout: 18_000 })
    await expect(errorCard).toContainText(String(deadPort))
    await expect(errorCard.getByRole('button', { name: '重试' })).toBeVisible()
    await expect(errorCard.getByRole('button', { name: '新窗口打开' })).toBeVisible()

    // 服务此刻就绪（同拓扑守卫起服）→ 重试恢复：真实内容取代错误卡
    const dirC = { win: path.join(PROJ_DIR.win, 'c') }
    fs.mkdirSync(dirC.win, { recursive: true })
    writeFixture(dirC, MARKER_C)
    await startPreviewTarget(dirC.win, deadPort)
    await errorCard.getByRole('button', { name: '重试' }).click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_C)
    await expect(page.locator('.preview-panel .preview-state--loading')).toHaveCount(0)
    await expect(page.locator('.preview-panel .preview-state--error')).toHaveCount(0)
  })

  test('状态重置：加载中切端口无错误卡残留，刷新回加载态后正常就绪', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewTab(page)

    // 死端口进入加载态，随即切到监听端口：不经过超时、无错误卡残留
    const deadPort = await freePortLocal()
    const input = page.locator('.preview-panel .preview-port-input input')
    await input.fill(String(deadPort))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.locator('.preview-panel .preview-state--loading')).toBeVisible()

    await input.fill(String(portA))
    await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_A)
    await expect(page.locator('.preview-panel .preview-state--loading')).toHaveCount(0)
    await expect(page.locator('.preview-panel .preview-state--error')).toHaveCount(0)

    // 手动刷新：回加载态重新判定再就绪，错误卡始终不出现
    await page.locator('.preview-panel button[title="重新加载"]').click()
    await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER_A)
    await expect(page.locator('.preview-panel .preview-state--loading')).toHaveCount(0)
    await expect(page.locator('.preview-panel .preview-state--error')).toHaveCount(0)
  })
})
