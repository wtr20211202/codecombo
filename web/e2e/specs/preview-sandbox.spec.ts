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
 * 预览面板沙箱隔离（P-20261019-1）：
 *   - 默认沙箱：iframe 带 sandbox 最小授权（不含 allow-same-origin）——探针页
 *     读 parent.localStorage / 改 parent.document 全部抛错、cookie 读不到、
 *     同源带凭据 fetch /api/settings 响应不可读（不透明源 CORS 拒绝）——
 *     攻击链三要素（令牌窃取 / DOM 操作 / 冒名 API）逐一断言被切断；
 *     探针页经 sc-preview-probe 上报 ok=false → 面板挂「切兼容模式」提示条
 *   - 兼容模式（settings 键 previewCompatMode=true）：iframe 无 sandbox 属性
 *     回落同源直挂，同一探针页全部攻击原语变成「可行」（正向对照——沙箱确实
 *     是这道关挡住的，而非探针页写错）；提示条不出现
 *   - 设置 UI 确认流：通用分区勾选「预览兼容模式」必经红色警示确认（取消不
 *     勾 / 确认才勾），保存后服务端键可读（agent 查询面）
 *
 * 拓扑守卫与 preview-panel.spec 同款：静态探针服务必须活在服务端网络命名空间。
 */

const PROJ_DIR = dualTmpDir('sc-e2e-pvsandbox-')
const PROJ_NAME = 'e2e-preview-sandbox'
const MARKER = `pv-sandbox-${String(Date.now() % 100000)}`

/** 服务端同拓扑判定：spec 进程与服务实例同侧（node 静态服务直接可达） */
const sameSideAsServer = process.platform === 'linux' || process.env.E2E_SERVER_OS !== 'linux'

let nodeServers: http.Server[] = []
let wslProc: ChildProcess | null = null
let portA = 0

/**
 * 探针页：逐项尝试安全审计里的现实攻击原语，结果 JSON 落 DOM 供断言。
 * 刻意只回「可达性」不回真实令牌值——夹具自身不复制敏感值。
 *   parentStorage  读 parent.localStorage['sc.unlockToken']：沙箱访问即抛 THROWN
 *   parentDom      改 parent.document.title：沙箱抛错 THROWN
 *   cookie         读自身 document.cookie 找 sc_lock_token：沙箱为不可达（THROWN，
 *                  个别内核回空串 ABSENT）
 *   apiRead        同源带凭据 fetch /api/settings 读体：沙箱 CORS 拒绝 BLOCKED
 * 注：e2e 实例锁默认停用，令牌/cookie 键常缺——兼容档断言判「访问权恢复」
 * （非 THROWN；empty/ABSENT = 同源可读但键不存在），不判键存在。
 * 结论随 postMessage（sc-preview-probe 协议）上报父页——面板据此挂受限提示条
 */
function writeProbeFixture(dir: { win: string }, marker: string) {
  fs.writeFileSync(path.join(dir.win, 'index.html'),
    `<!DOCTYPE html><html><body><h1 id="pv-marker">${marker}</h1>` +
    `<pre id="probe-out">pending</pre><script>(function(){
var out={};
try{out.parentStorage=(window.parent.localStorage.getItem('sc.unlockToken')!==null)?'READ':'empty'}
catch(e){out.parentStorage='THROWN'}
try{window.parent.document.title='PWNED';out.parentDom='WRITTEN'}
catch(e){out.parentDom='THROWN'}
try{out.cookie=(document.cookie.indexOf('sc_lock_token')>=0)?'PRESENT':'ABSENT'}
catch(e){out.cookie='THROWN'}
var done=false;
function report(api){
if(done)return;done=true;
out.apiRead=api;
document.getElementById('probe-out').textContent=JSON.stringify(out);
try{window.parent.postMessage({type:'sc-preview-probe',ok:out.parentStorage!=='THROWN'},'*')}catch(e){}
}
try{fetch('/api/settings',{credentials:'include'})
.then(function(r){return r.text()})
.then(function(){report('READ')})
.catch(function(){report('BLOCKED')})}
catch(e){report('BLOCKED')}
setTimeout(function(){report('TIMEOUT')},3000)
})();<\/script></body></html>`)
}

// 进程内 node 静态服务：故意回 X-Frame-Options: DENY（剥头由服务端反代负责，
// 未剥则 iframe 拒渲染 → 用例红；顺带覆盖「反代剥头」既有语义不回归）
function startNodeStatic(dir: string, port: number): Promise<http.Server> {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0])
    const file = path.join(dir, rel, rel.endsWith('/') ? 'index.html' : '')
    fs.readFile(file, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return }
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
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

// 跨拓扑：端口取自 WSL 侧（bind :0 让内核分配，回显解析）
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

async function startPreviewTarget(winDir: string): Promise<number> {
  if (sameSideAsServer) {
    const port = await freePortLocal()
    const srv = await startNodeStatic(winDir, port)
    nodeServers.push(srv)
    return port
  }
  const port = wslFreePort()
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

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 兼容模式档位读写（settings API——agent 查询/调整的同一张面） */
async function getCompatMode(): Promise<boolean | undefined> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/settings`, { headers })
  const data = ((await res.json()) as { data?: { previewCompatMode?: boolean } }).data
  return data?.previewCompatMode
}

async function putCompatMode(v: boolean): Promise<void> {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ previewCompatMode: v }),
  })
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
  if (!(await page.locator('.bottom-panel').isVisible().catch(() => false))) {
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
  }
  await page.locator('.bottom-tabs button').filter({ hasText: '预览' }).click()
}

async function openPreviewPort(page: import('@playwright/test').Page, port: number) {
  await openPreviewTab(page)
  const input = page.locator('.preview-panel .preview-port-input input')
  await input.fill(String(port))
  await page.locator('.preview-panel').getByRole('button', { name: '打开', exact: true }).click()
  // 探针页落地（沙箱/同源两种姿态下 marker 都可达）
  await expect(page.frameLocator('.preview-frame').locator('#pv-marker')).toHaveText(MARKER)
  // 探针结论落 DOM（fetch 判定毫秒级完成；给满余量防偶发慢）
  await expect(page.frameLocator('.preview-frame').locator('#probe-out')).not.toHaveText('pending', { timeout: 10_000 })
}

interface ProbeOut {
  parentStorage: string
  parentDom: string
  cookie: string
  apiRead: string
}

async function readProbe(page: import('@playwright/test').Page): Promise<ProbeOut> {
  const raw = await page.frameLocator('.preview-frame').locator('#probe-out').textContent()
  return JSON.parse(raw || '{}') as ProbeOut
}

test.beforeAll(async () => {
  // 兜底复位：上次中途失败的运行可能把兼容档留在开位（全局 settings，污染
  // 其他 spec 的默认沙箱前提）——开跑前先归零
  await putCompatMode(false)

  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  fs.mkdirSync(PROJ_DIR.win, { recursive: true })
  execSync('git init', { cwd: PROJ_DIR.win })
  execSync('git config core.autocrlf false', { cwd: PROJ_DIR.win })
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(PROJ_DIR.win) }),
  })
  expect([200, 201]).toContain(res.status)
  writeProbeFixture(PROJ_DIR, MARKER)
  portA = await startPreviewTarget(PROJ_DIR.win)
})

test.afterAll(async () => {
  nodeServers.forEach(s => s.close())
  nodeServers = []
  if (wslProc) {
    wslProc.kill()
    try { execSync(`wsl.exe -e bash -c "pkill -f 'http.server ${portA}'"`) } catch { /* 尽力清理 */ }
  }
  await putCompatMode(false)
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await fetch(`${API_BASE}/api/projects/${mine.id}`, { method: 'DELETE', headers })
  dualTmpClean(PROJ_DIR.win)
})

test.describe('预览面板沙箱隔离', () => {
  test('默认沙箱：iframe 无 allow-same-origin，探针页攻击原语全部被切 + 受限提示条', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await openPreviewPort(page, portA)

    // iframe 带 sandbox 最小授权：allow-scripts 在列（SPA 必需）、
    // allow-same-origin 绝不在列（不透明源 = 同源权限清零的关键）
    const sandbox = await page.locator('.preview-frame').getAttribute('sandbox')
    expect(sandbox, '默认姿态必须挂 sandbox 属性').toBeTruthy()
    expect(sandbox).toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')

    // 探针页攻击原语逐一被切：令牌读不到（THROWN）、父页 DOM 摸不到（THROWN）、
    // 锁 cookie 读不到（不透明源下 document.cookie 访问即抛 THROWN，个别内核
    // 回空串 ABSENT——两者同为「不可达」）、同源带凭据 API 响应不可读（BLOCKED）
    const probe = await readProbe(page)
    expect(probe.parentStorage).toBe('THROWN')
    expect(probe.parentDom).toBe('THROWN')
    expect(['THROWN', 'ABSENT']).toContain(probe.cookie)
    expect(probe.apiRead).toBe('BLOCKED')

    // 探活上报（sc-preview-probe ok=false）→ 面板挂「切兼容模式」提示条
    await expect(page.locator('[data-testid="preview-sandbox-hint"]')).toBeVisible()
  })

  test('兼容模式：settings 键置真后回落同源直挂，探针原语可行（正向对照）且提示条不出现', async ({ page }) => {
    await putCompatMode(true)
    expect(await getCompatMode()).toBe(true)

    await fixedLocale(page)
    await enterProject(page)
    await openPreviewPort(page, portA)

    // 无 sandbox 属性 = 同源直挂（个别依赖同源存储/Service Worker 的 dev app 回落形态）
    expect(await page.locator('.preview-frame').getAttribute('sandbox')).toBeNull()

    // 正向对照：同一探针页原语全部「访问权恢复」——parentStorage 可读（键在
    // 则 READ、锁停用则 empty，两者同为非 THROWN）、父页 DOM 可写、cookie 可达、
    // 同源带凭据 API 可读——证明沙箱测试里的「全部被切」是沙箱挡的，不是探针页
    // 写错（e2e 实例锁默认停用，令牌/cookie 键常缺，见夹具头注）
    const probe = await readProbe(page)
    expect(probe.parentStorage).not.toBe('THROWN')
    expect(probe.parentDom).toBe('WRITTEN')
    expect(['PRESENT', 'ABSENT']).toContain(probe.cookie)
    expect(probe.apiRead).toBe('READ')

    // 探活上报 ok=true：不挂受限提示条
    await expect(page.locator('[data-testid="preview-sandbox-hint"]')).toHaveCount(0)
  })

  test('设置 UI：勾选必经红色警示确认（取消不勾/确认才勾），保存落盘服务端可查', async ({ page }) => {
    await putCompatMode(false)
    await fixedLocale(page)
    await enterProject(page)

    await page.locator('.rail-btn[title="设置"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-general"]').click()

    const row = page.locator('[data-testid="settings-preview-compat"]')
    await expect(row).toBeVisible()
    await expect(page.locator('[data-testid="settings-preview-compat-hint"]')).toBeVisible()

    // 勾选 → 红色警示弹层 → 取消：不勾
    await row.locator('.n-checkbox').click()
    const dialog = page.locator('.n-dialog').filter({ hasText: '开启预览兼容模式？' })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    // naive-ui n-checkbox 无真实 input：勾选态走根元素 aria-checked（既有口径）
    await expect(row.locator('.n-checkbox')).toHaveAttribute('aria-checked', 'false')

    // 再勾选 → 确认「仍要开启」：勾上（pending 态）
    await row.locator('.n-checkbox').click()
    const dialog2 = page.locator('.n-dialog').filter({ hasText: '开启预览兼容模式？' })
    await expect(dialog2).toBeVisible()
    await dialog2.getByRole('button', { name: '仍要开启' }).click()
    await expect(dialog2).toHaveCount(0)
    await expect(row.locator('.n-checkbox')).toHaveAttribute('aria-checked', 'true')

    // 保存落盘 → 服务端键可查（agent 经 settings API 查询同一张面）
    await page.locator('.n-modal.settings-modal .settings-footer').getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 10_000 })
    expect(await getCompatMode()).toBe(true)
  })
})
