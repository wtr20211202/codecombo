// site-screenshots.mjs —— 产品官网/README 截图矩阵重摄脚本（P-20261101-1）。
//
// 对运行中的实例（缺省 http://localhost:9999，SC_SHOT_BASE_URL 覆盖）以
// en-US 界面 + Dark 主题 + 1600×950@2x 视口播种真实数据并截图 9 张到
// docs/img/（唯一截图事实源，README 与 site/ 只引用）。播种一律用真实
// 功能产物（真实 PTY 输出/真实 pending 审批/真实分享记录），不摆拍假数据。
//
// 用法：cd web && node scripts/site-screenshots.mjs
//       SC_SHOT_BASE_URL=http://localhost:9999 node scripts/site-screenshots.mjs
// 前置：目标实例已在运行（e2e 共享实例语义，解锁密码同 DEFAULT_PASSWORD）。
//
// 数据卫生（共享实例纪律）：本脚本创建的会话/审批/分享/实例注册项在
// finally 清理；locale/theme 只写本脚本浏览器上下文的 localStorage，不动
// 服务端全局态；布局态（uiState）先存后还、镜头间清 editor 命名空间防
// 旧开文件 toast 污染；项目列表零改动。
// 截图导出后须逐张人工过目（文件树路径/终端 prompt/实例名是人眼防线，
// PNG 屏幕内容不进 release-scan 的文本扫描）。

import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE = process.env.SC_SHOT_BASE_URL || 'http://localhost:9999'
const REPO = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..')
const OUT = path.join(REPO, 'docs', 'img')
const PASSWORD = 'admin'
const VW = 1600
const VH = 950

// ---------- API 助手（锁令牌鉴权面） ----------
let lockToken = ''
async function api(p, opts = {}) {
  const res = await fetch(`${BASE}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': lockToken, ...(opts.headers || {}) },
  })
  const text = await res.text()
  let body = null
  try { body = JSON.parse(text) } catch { /* 非 JSON 响应原样返回 */ }
  if (!res.ok) throw new Error(`API ${p} -> ${res.status}: ${text.slice(0, 200)}`)
  return body
}
async function unlock() {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`unlock failed: ${res.status}`)
  lockToken = (await res.json()).token || ''
}

// ---------- 浏览器助手 ----------
async function newPage(browser) {
  const ctx = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    locale: 'en-US',
  })
  await ctx.addInitScript(() => {
    localStorage.setItem('locale-settings', 'en-US')
    localStorage.setItem('theme-settings', 'dark')
    // 审批卡「首次说明条」不进任何镜头（真实用户看过一次后也不再出现）
    localStorage.setItem('sc.approvalGuideDismissed', '1')
  })
  const page = await ctx.newPage()
  return { ctx, page }
}

async function gotoApp(page, url) {
  await page.goto(url)
  await page.locator('.app-boot-loading').waitFor({ state: 'detached', timeout: 20000 }).catch(() => {})
  const overlay = page.locator('.lock-overlay')
  if (await overlay.count()) {
    await overlay.locator('.lock-form input').first().fill(PASSWORD)
    await overlay.locator('button').filter({ hasText: /unlock/i }).first().click()
    await overlay.waitFor({ state: 'detached', timeout: 10000 })
    // 「建议修改默认密码」弹层让路（EN 文案 best-effort）
    const later = page.getByRole('button', { name: /later/i })
    if (await later.count()) await later.first().click().catch(() => {})
  }
  await page.waitForTimeout(800)
}

async function shot(page, name) {
  await page.waitForTimeout(500)
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  console.log(`  shot ${name}.png`)
}

// 终端 WS 写入（raw bytes 直通 PTY；锁令牌走 HttpOnly cookie，页面侧免带）
async function ptyWrite(page, sessionId, text) {
  await page.evaluate(
    ({ sessionId, text, base }) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${new URL(base).host}/ws/terminal/${sessionId}`)
        ws.onopen = () => ws.send(text)
        ws.onmessage = () => {}
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => { ws.close(); resolve() }, 800)
      }),
    { sessionId, text, base: BASE },
  )
}

// ---------- 清理台账（finally 全量回收，倒序执行） ----------
const cleanup = []
function track(fn) { cleanup.push(fn) }

// ---------- 主流程 ----------
const browser = await chromium.launch()
try {
  await unlock()
  await mkdir(OUT, { recursive: true })

  const projects = (await api('/api/projects')).data
  const main = projects.find((p) => p.name === 'simple-coding')
  const fixture = projects.find((p) => p.name === 'git-test') || main
  if (!main) throw new Error('simple-coding project not found on instance')

  // 布局态先存后还（截图把 layout/面板开合写进服务端全局态）
  const uiStateBefore = await api('/api/ui-state')
  track(() => api('/api/ui-state', { method: 'PUT', body: JSON.stringify(uiStateBefore.data || uiStateBefore) }).catch(() => {}))
  // 出片布局基调：files 侧栏 + terminal 底栏（经典 IDE 观感；PATCH 按命名空间
  // 浅合并，layout 命名空间整包带上覆写键）
  const localBefore = (uiStateBefore.data || uiStateBefore).local || {}
  await api('/api/ui-state', { method: 'PATCH', body: JSON.stringify({ local: { layout: { ...(localBefore.layout || {}), sideView: 'files', bottomTab: 'terminal' } } }) })

  // —— 播种（真实功能产物，台账清理） ——
  // 1) 项目终端（真实 PTY：git 短日志输出，进 project-editor 镜头）
  const t = await api('/api/terminals', { method: 'POST', body: JSON.stringify({ name: 'build', projectId: main.id, kind: 'shell' }) })
  const termId = t.data?.id || t.data?.sessionId
  track(() => api(`/api/terminals/${termId}`, { method: 'DELETE' }).catch(() => {}))
  // 2) 两个真实 agent 会话（PTY 命令输出，dir 落在项目根——输出是真 git 历史）
  // 注：launchArgs 走 git 默认 pager（less 经管道渲染 UTF-8 正确）——这台中文
  // Windows 上 git 直写控制台的 CJK 会经 ConPTY 代码页纠缠成乱码；且 pager
  // 打开期间绝不向同会话补发键入（会落进 less 的保存提示，2026-11-01 实录）。
  const a1 = await api('/api/terminals', { method: 'POST', body: JSON.stringify({ name: 'agent log survey', kind: 'agent', runtime: 'shell', dir: main.path, launchArgs: 'git log --graph --oneline --all -16' }) })
  const a2 = await api('/api/terminals', { method: 'POST', body: JSON.stringify({ name: 'agent env probe', kind: 'agent', runtime: 'shell', dir: main.path, launchArgs: 'go version; git status -sb; go build ./...; echo BUILD OK' }) })
  const s1 = a1.data?.id || a1.data?.sessionId
  const s2 = a2.data?.id || a2.data?.sessionId
  track(() => api(`/api/terminals/${s1}`, { method: 'DELETE' }).catch(() => {}))
  track(() => api(`/api/terminals/${s2}`, { method: 'DELETE' }).catch(() => {}))
  // 3) 分享记录（文件/片段/终端直播——真实创建，share-manager 镜头，拍完撤销）
  const shares = []
  try {
    shares.push(await api('/api/share', { method: 'POST', body: JSON.stringify({ projectId: fixture.id, path: 'README.md' }) }))
  } catch (e) { console.log('  (file share seed skipped)', String(e).slice(0, 80)) }
  try {
    shares.push(await api('/api/share/snippet', { method: 'POST', body: JSON.stringify({ name: 'deploy snippet', content: 'go build -o codecombo .\n./codecombo start --daemon\n' }) }))
  } catch (e) { console.log('  (snippet share seed skipped)', String(e).slice(0, 80)) }
  const term2 = await api('/api/terminals', { method: 'POST', body: JSON.stringify({ name: 'ops shell', projectId: fixture.id, kind: 'shell' }) })
  const term2Id = term2.data?.id || term2.data?.sessionId
  track(() => api(`/api/terminals/${term2Id}`, { method: 'DELETE' }).catch(() => {}))
  try {
    shares.push(await api('/api/share/terminal', { method: 'POST', body: JSON.stringify({ sessionId: term2Id, name: 'live ops terminal' }) }))
  } catch (e) { console.log('  (terminal share seed skipped)', String(e).slice(0, 80)) }
  for (const sh of shares) {
    const tok = sh?.data?.token || sh?.token
    if (tok) track(() => api(`/api/share/${tok}`, { method: 'DELETE' }).catch(() => {}))
  }
  // 4) 双实例拓扑注册（对端 = 本机 19999 真实第二实例；拍完移除）
  const inst = await api('/api/instances', { method: 'POST', body: JSON.stringify({ name: 'build-runner', url: 'http://localhost:19999' }) })
  const instId = inst.data?.id || inst.id
  track(() => api(`/api/instances/${instId}`, { method: 'DELETE' }).catch(() => {}))

  // —— 等播种的 PTY 输出积累（真实命令在跑，给足时间） ——
  await new Promise((r) => setTimeout(r, 5000))

  // 通知中心清账：播种动作产生的徽标不进镜头
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers: { 'X-Lock-Token': lockToken } }).catch(() => {})

  // —— 出片（单页多镜头：同一 context 逐镜头点选，镜头间清 editor 态防 toast） ——
  console.log('==> shooting frames')
  const { ctx, page } = await newPage(browser)
  const projectUrl = `${BASE}/project?project=${main.id}`

  // 镜头 1/9：project-editor —— files 侧栏 + main.go 编辑器 + 底部终端真实输出
  await gotoApp(page, `${projectUrl}&file=main.go`)
  await page.locator('.monaco-editor, [data-testid="rail-files"]').first().waitFor({ timeout: 15000 })
  await page.locator('[data-testid="bottom-tab-terminal"]').click()
  // 经 less 分页渲染（CJK 正确，见上方注记）；此后不得再向本会话写入
  await ptyWrite(page, termId, 'git log --oneline -12\r')
  await page.waitForTimeout(2500)
  await shot(page, 'project-editor')

  // 镜头 2/9：file-tree-menu —— 右键菜单浮层（悬停中性项，避免 Delete 高亮入镜）
  const item = page.locator('.tree-item', { hasText: 'main.go' }).first()
  await item.waitFor({ timeout: 10000 })
  await item.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').waitFor({ timeout: 5000 })
  await page.locator('.n-dropdown-menu').getByText('Copy Path').first().hover().catch(() => {})
  await page.waitForTimeout(400)
  await shot(page, 'file-tree-menu')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 镜头 3/9：share-dialog —— 右键「Create Share Link」弹层（不真正创建）
  const readme = page.locator('.tree-item', { hasText: 'README.md' }).first()
  await readme.waitFor({ timeout: 10000 })
  await readme.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await menu.waitFor({ timeout: 5000 })
  await menu.getByText('Create Share Link').first().click()
  await page.locator('.n-modal', { hasText: 'Share Project Content' }).waitFor({ timeout: 8000 })
  await shot(page, 'share-dialog')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // 镜头 4/9：commit-diff —— 近期提交里挑代码文件双击进双栏对比
  await page.locator('[data-testid="rail-git"]').click()
  await page.locator('.commit-item').first().waitFor({ timeout: 12000 })
  // 第 2 条提交（fix(claude) 前端代码变更，diff 内容肉眼可辨；第 1 条是 docs merge）
  await page.locator('.commit-item').nth(1).locator('.commit-meta').first().click()
  const node = page.locator('.commits-right .diff-node', { has: page.locator('.diff-name').filter({ hasText: /\.(go|ts|vue)$/ }) }).first()
  await node.waitFor({ timeout: 10000 })
  await node.dblclick()
  await page.locator('.monaco-diff-editor').waitFor({ timeout: 15000 })
  await page.waitForTimeout(1800)
  await shot(page, 'commit-diff')
  // 清 editor 命名空间：diff 打开的版本化文件不留恢复态（防后续镜头 File not found toast）
  await api('/api/ui-state', { method: 'PATCH', body: JSON.stringify({ local: { editor: null } }) })

  // 镜头 5/9：instance-sync —— 多实例同步中心（双实例拓扑）
  await gotoApp(page, projectUrl)
  await page.locator('[data-testid="rail-sync"]').click()
  await page.waitForTimeout(2500)
  await shot(page, 'instance-sync')
  await page.locator('[data-testid="rail-sync"]').click() // 合上侧栏，不带入下一镜
  await page.waitForTimeout(500)

  // 镜头 6/9：share-manager —— 分享管理列表（真实分享记录）
  await page.locator('[data-testid="rail-share-manager"]').click()
  await page.locator('.sm-card table').waitFor({ timeout: 10000 })
  await page.waitForTimeout(700)
  await shot(page, 'share-manager')

  // 镜头 7/9：agent-session —— 智能体会话真实运行（PTY 输出）
  await gotoApp(page, projectUrl)
  await page.locator('[data-testid="rail-agent-terminal"]').click()
  await page.locator('.atv-root').waitFor({ timeout: 10000 })
  const row = page.locator('.ats-item', { hasText: 'agent log survey' }).first()
  await row.waitFor({ timeout: 10000 })
  await row.click()
  await page.waitForTimeout(2500)
  await shot(page, 'agent-session')

  // 镜头 8/9：pending 审批卡（真实高危请求卡）
  const appr = await api('/api/ops-confirm', { method: 'POST', body: JSON.stringify({ sessionId: 'sc_shot_approval', op: 'git reset --hard origin/main', target: 'main', detail: 'Discard local commits on main to match upstream' }) })
  const apprId = appr.data?.id
  track(() => api(`/api/ops-confirm/${apprId}/resolve`, { method: 'POST', body: JSON.stringify({ allow: false, always: false }) }).catch(() => {}))
  await gotoApp(page, projectUrl)
  await page.locator('.aprv-card', { hasText: 'git reset --hard' }).waitFor({ timeout: 12000 })
  await page.waitForTimeout(700)
  await shot(page, 'approval-card')

  // 镜头 9/9：值班大屏 —— 活跃面（pending 审批 + 实时会话协作消息入镜）
  await gotoApp(page, `${BASE}/monitor`)
  await page.waitForTimeout(2000)
  // 页面在场时投递会话间消息：Agent Collaboration 卡是实时事件流，播种早了不入镜
  await fetch(`${BASE}/api/ops-message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lock-Token': lockToken, 'X-Session-ID': s1 }, body: JSON.stringify({ to: s2, body: 'handoff: build finished on main, taking over release notes' }) }).catch(() => {})
  await page.waitForTimeout(2500)
  await shot(page, 'oncall-dashboard')

  await ctx.close()
  console.log('==> done — review each frame by eye before export')
} finally {
  for (const fn of cleanup.reverse()) await fn().catch(() => {})
  await browser.close()
}
