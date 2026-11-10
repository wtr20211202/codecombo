import { test, expect, type Page } from '@playwright/test'
import net from 'node:net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * OSC 52 写失败兜底浮条 + 「切换到复制优先」一键直达（P-20261109-7 B/C）E2E
 * —— 远程主机终端面（SSH PTY 直通链路，terminal-mouse-mode-hint.spec 同款注入面）：
 *   1. 终端侧剪贴板写全链失败（本 spec 以 addInitScript 摘除 navigator.clipboard
 *      + execCommand('copy') 恒 false 合成「非安全上下文/权限拒绝」的确定性失败
 *      ——真实 e2e 实例 127.0.0.1 属安全上下文，写链天然成功无法自然触发失败分支）
 *      → 应用 printf OSC 52 → 兜底浮条出现，**必须带内容预览**（v-text 渲染：
 *      HTML 形态载荷以纯文本呈现、不产生元素节点——PTY 内容不可信的反注入面）；
 *   2. 长载荷截断（>200 字符以省略号收尾）；
 *   3. 重放幂等：同会话再次失败只刷新单条内容不叠条；
 *   4. ✕ 只清本条（非 sticky）：再次失败照常出现（诚实语义）；
 *   5. 鼠标教育条「切换到复制优先」一键直达：PUT settings terminalTmuxMouseEnabled=
 *      false（服务端热切换 tmux mouse 的前端面），按钮随开关翻转隐藏，finally 还原。
 *
 * 注入面为何是远程主机终端：Windows 本地终端走 ConPTY（消费 DECSET 鼠标模式，
 * terminal-mouse-mode-hint.spec 头注同款论证），远程终端是 SSH PTY 原样中继，
 * printf 的 OSC 52 原样到达 xterm。三终端面共享同一实现（RemoteTerminalPane 即
 * TerminalPane 包装）。失败分支的簿记语义（分叉收口/FIFO/TTL 起算/幂等）由单测
 * terminalOsc52Clipboard.test.ts 钉死——e2e 只验可视化面与设置联动。
 */

const BASE = API_BASE
const DISMISS_KEY = 'sc.terminal.mouseModeHintDismissed'
// 锚定可见远程窗格：页内可能同时存在项目终端（底部面板），断言不读到它
const PANE = '.remote-pane-wrap:visible'
const FALLBACK = `${PANE} [data-testid="term-osc52-fallback"]`
const HINT = `${PANE} [data-testid="term-mouse-mode-hint"]`
const HINT_COPY_FIRST = `${PANE} [data-testid="term-mouse-mode-hint-copy-first"]`

// WSL sshd 端口可达性预检（端口取播种的主机记录，槽位专用实例非 23）
function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let wslUp = false
test.beforeAll(async () => {
  const wslHost = await fetchWslHost(BASE)
  wslUp = !!wslHost && await tcpReachable(wslHost.port)
})

/** 解锁请求头（裸 fetch，remote-console.spec helper 同款） */
async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理远程管理持久化状态（服务端 uiState remoteConsole），保证从空态开始 */
async function clearRemoteConsoleState() {
  const headers = await unlockHeaders()
  const res = await fetch(`${BASE}/api/ui-state`, { headers })
  const body = (await res.json().catch(() => null)) as { data?: Record<string, { remoteConsole?: unknown }> } | null
  const map = body?.data
  if (!map) return
  const clear: Record<string, { remoteConsole: null }> = {}
  for (const k of Object.keys(map)) {
    if (map[k]?.remoteConsole !== undefined) clear[k] = { remoteConsole: null }
  }
  if (Object.keys(clear).length > 0) {
    await fetch(`${BASE}/api/ui-state`, { method: 'PUT', headers, body: JSON.stringify(clear) })
  }
}

/** 读写全局设置（页面上下文 fetch，带解锁 cookie；remote-console.spec 同款） */
async function putSetting(page: Page, body: Record<string, unknown>) {
  await page.evaluate(async (payload) => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' } /* 同源自动带 HttpOnly 锁 cookie */,
      body: JSON.stringify(payload),
    })
  }, body)
}
async function getSetting(page: Page, key: string): Promise<unknown> {
  return page.evaluate(async (k) => {
    const r = await fetch('/api/settings')
    return (await r.json())?.data?.[k]
  }, key)
}

/** 向远程终端输入命令：聚焦 xterm helper textarea 再击键（terminal-mouse-mode-hint
 *  spec 同款：焦点路径与模式状态解耦） */
async function typeInRemoteTerm(page: Page, text: string) {
  const ta = page.locator(`${PANE} textarea.xterm-helper-textarea`).first()
  await expect(ta).toBeVisible({ timeout: 10000 })
  await ta.focus()
  await expect(ta).toBeFocused()
  await page.keyboard.type(text)
}

/** bash printf 合成 OSC 52（ESC ] 52 ; c ; <base64> BEL——claude code setClipboard
 *  同形态；命令文本纯 ASCII，ESC/BEL 只出现在输出侧） */
function osc52Command(base64Payload: string): string {
  return `printf '\\033]52;c;${base64Payload}\\a'\r`
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function mouseModeCommand(enable: boolean, mode: number): string {
  return `printf '\\033[?${mode}${enable ? 'h' : 'l'}'\r`
}

/** 远程管理视图开 WSL 终端并等到 root 提示符（terminal-mouse-mode-hint 同款前置）。
 *  rail 按钮是 toggle（usePanelLayout.toggleRemoteConsole——编辑器 ↔ 远程控制台
 *  主区切换）：远程控制台已是活动主区时再点一次会收起视图（.remote-root 挂着但
 *  v-show 隐藏，重开链路实测踩坑），故仅在视图未打开时才点，幂等打开 */
async function openWslTerminal(page: Page) {
  const remoteRoot = page.locator('.remote-root')
  if ((await remoteRoot.count()) === 0 || !(await remoteRoot.isVisible())) {
    await page.locator('[data-testid="rail-remote-console"]').click()
  }
  await expect(remoteRoot).toBeVisible({ timeout: 10000 })
  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()
  await wslCard.locator('.host-card-term').click()
  const xterm = page.locator(`${PANE} .xterm`).first()
  await expect(xterm).toBeVisible({ timeout: 30000 })
  await expect(xterm).toContainText('#', { timeout: 45000 })
  return xterm
}

/** 清场：关模式（防御，tab 删除本会终结 SSH 会话）→ 关 tab → 还原两开关 → 清记忆 */
async function cleanupRemoteTerm(page: Page, originalTmux: unknown, originalMouse: unknown) {
  await typeInRemoteTerm(page, mouseModeCommand(false, 1000)).catch(() => {})
  while (await page.locator('.remote-tab .remote-tab-close').count() > 0) {
    await page.locator('.remote-tab .remote-tab-close').first().click()
    await page.waitForTimeout(400)
  }
  await putSetting(page, { terminalRemoteTmux: !!originalTmux }).catch(() => {})
  if (typeof originalMouse === 'boolean') {
    await putSetting(page, { terminalTmuxMouseEnabled: originalMouse }).catch(() => {})
  }
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY).catch(() => {})
}

test('OSC 52 写失败 → 兜底浮条带预览出现（v-text 反注入/截断/重放幂等/✕ 非 sticky）', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  test.setTimeout(180000)
  await clearRemoteConsoleState()
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  // 剪贴板写链全断（确定性失败合成）：摘 navigator.clipboard + execCommand('copy')
  // 恒 false——copyText 降级链两分支都失败，OSC 52 handler 的 then(ok=false) 分叉
  // 登记兜底簿记（真实浏览器形态：非安全上下文/权限拒绝）。其余命令透传原实现
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { get: () => undefined })
    const orig = document.execCommand.bind(document) as unknown as (...a: unknown[]) => boolean
    document.execCommand = ((cmd: string, ...rest: unknown[]) =>
      cmd === 'copy' ? false : orig(cmd, ...rest)) as typeof document.execCommand
  })
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY)

  const originalTmux = await getSetting(page, 'terminalRemoteTmux')
  const originalMouse = await getSetting(page, 'terminalTmuxMouseEnabled')
  await putSetting(page, { terminalRemoteTmux: false })

  await openWslTerminal(page)

  try {
    // 无失败前无浮条
    await expect(page.locator(FALLBACK)).toHaveCount(0)

    // 应用 OSC 52 携带 HTML 形态载荷（claude 诈骗面同形态：任意程序可控内容）
    // → 写链失败 → 浮条出现且**必须带内容预览**
    const payload1 = '<script>alert(1)</script> 复制我 ✓'
    await typeInRemoteTerm(page, osc52Command(b64(payload1)))
    await expect(page.locator(FALLBACK)).toBeVisible({ timeout: 15000 })
    await expect(page.locator(FALLBACK)).toHaveCount(1)
    // 诚实文案 + 预览以纯文本呈现（v-text：script 标签不成为元素、无注入执行）
    const preview = page.locator(`${FALLBACK} pre`).first()
    await expect(preview).toHaveText(payload1)
    await expect(preview.locator('script')).toHaveCount(0)

    // 长载荷截断：>200 字符以省略号收尾（预览是提示诈骗面最低防线）。
    // 长载荷由**远端 printf 生成**（base64 在输出侧拼接，命令本身仅 ~90 字符）：
    // 逐键打入 400+ 字符命令会以 0 间隔灌满终端写链路（pendingWrites 上限 256
    // 的风暴保护丢帧，P-20261004-47）——真实 OSC 52 本就作为输出到达（claude
    // setClipboard 同形态），输出侧注入才是等价观测面。断言等的是**内容**而非
    // 可见性：同会话重复失败只刷新单条（Map 键控替换），可见性断言会在上一条
    // 内容仍渲染时即时通过，textContent 读到旧内容竞态
    await typeInRemoteTerm(
      page,
      `printf '\\033]52;c;'$(head -c 300 /dev/zero | tr '\\0' 'L' | base64 | tr -d '\\n')'\\a'\r`,
    )
    await expect(page.locator(`${FALLBACK} pre`).first()).toHaveText(
      'L'.repeat(200) + '…', { timeout: 15000 },
    )

    // 重放幂等：同会话只刷新单条不叠条（同会话第二次失败仍 toHaveCount(1)）
    await typeInRemoteTerm(page, osc52Command(b64('third')))
    await expect(page.locator(FALLBACK)).toHaveCount(1)
    await expect(page.locator(`${FALLBACK} pre`).first()).toHaveText('third')

    // ✕ 只清本条（非 sticky）：清后再次失败照常出现
    await page.locator(`${PANE} [data-testid="term-osc52-fallback-dismiss"]`).click()
    await expect(page.locator(FALLBACK)).toBeHidden()
    await typeInRemoteTerm(page, osc52Command(b64('again')))
    await expect(page.locator(FALLBACK)).toBeVisible({ timeout: 15000 })
    await expect(page.locator(`${FALLBACK} pre`).first()).toHaveText('again')
  } finally {
    await cleanupRemoteTerm(page, originalTmux, originalMouse)
  }
})

test('鼠标教育条「切换到复制优先」一键直达 → settings 落盘 + 按钮随开关隐藏（C）', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  test.setTimeout(180000)
  await clearRemoteConsoleState()
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY)

  const originalTmux = await getSetting(page, 'terminalRemoteTmux')
  const originalMouse = await getSetting(page, 'terminalTmuxMouseEnabled')
  // 开关钉为开（前序用例可能遗留 false）：教育条按钮仅在开态展示
  await putSetting(page, { terminalRemoteTmux: false, terminalTmuxMouseEnabled: true })

  await openWslTerminal(page)

  try {
    // 应用开启鼠标上报 → 教育条出现，且带「切换到复制优先」按钮（开态）
    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    await expect(page.locator(HINT)).toBeVisible({ timeout: 15000 })
    await expect(page.locator(HINT_COPY_FIRST)).toBeVisible()

    // 一键直达：PUT settings 落盘（服务端随后热切换 tmux mouse off——本地专有
    // socket 语义，本用例只验前端面与落盘）
    await page.locator(HINT_COPY_FIRST).click()
    await expect.poll(() => getSetting(page, 'terminalTmuxMouseEnabled'), { timeout: 10000 }).toBe(false)
    // 按钮随开关翻转隐藏（已处复制优先则无从再切）；教育条本体仍在（Shift 旁
    // 路教育独立于开关语义）
    await expect(page.locator(HINT_COPY_FIRST)).toHaveCount(0)
    await expect(page.locator(HINT)).toBeVisible()
  } finally {
    await cleanupRemoteTerm(page, originalTmux, originalMouse)
  }
})

test('远端 tmux 版本地板横幅（A2）：create 响应携两档地板 → pane 横幅带版本文案', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  test.setTimeout(180000)
  await clearRemoteConsoleState()
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY)

  const originalTmux = await getSetting(page, 'terminalRemoteTmux')
  const originalMouse = await getSetting(page, 'terminalTmuxMouseEnabled')
  await putSetting(page, { terminalRemoteTmux: true })

  // 路由拦截注入两档地板：真实 WSL tmux 版本 ≥3.3（ok 档无横幅），版本不足的
  // 横幅面用响应注入合成——route.fetch 保住真实 sessionId/PTY 会话，只改写
  // 探测字段（WS/PTY 全真实，观测面与「远端 tmux 版本不足」等价；服务端探测
  // 的超时收割/静默降级语义由 Go 侧单测与实机覆盖，此处只验 plumbing 与文案）
  const BANNER = `${PANE} [data-testid="remote-tmux-floor-banner"]`
  let phase: 'drag-copy' | 'passthrough' = 'drag-copy'
  await page.route('**/api/remotehosts/*/terminals', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    const res = await route.fetch()
    let body: { data?: Record<string, unknown> } = {}
    try { body = await res.json() } catch { /* 解析失败按原响应透传 */ }
    if (body?.data) {
      if (phase === 'drag-copy') {
        body.data.tmuxVersion = 'tmux 3.1b'
        body.data.tmuxClipboardFloor = 'drag-copy'
      } else {
        body.data.tmuxVersion = 'tmux 3.2a'
        body.data.tmuxClipboardFloor = 'passthrough'
      }
    }
    await route.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' })
  })

  // 第一开：drag-copy 档横幅（版本文案内插）
  await openWslTerminal(page)
  try {
    const banner = page.locator(BANNER).first()
    await expect(banner).toBeVisible({ timeout: 15000 })
    await expect(banner).toContainText('tmux 3.1b')

    // 重开翻档（reopen 走同一 POST 端点）：passthrough 档横幅随响应刷新
    phase = 'passthrough'
    while (await page.locator('.remote-tab .remote-tab-close').count() > 0) {
      await page.locator('.remote-tab .remote-tab-close').first().click()
      await page.waitForTimeout(400)
    }
    await openWslTerminal(page)
    const banner2 = page.locator(BANNER).first()
    await expect(banner2).toBeVisible({ timeout: 15000 })
    await expect(banner2).toContainText('tmux 3.2a')
  } finally {
    phase = 'drag-copy' // 清场期间再触发 POST 时不再翻档
    await cleanupRemoteTerm(page, originalTmux, originalMouse)
  }
})
