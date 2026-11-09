import { test, expect, type Page } from '@playwright/test'
import net from 'node:net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端鼠标接管提示条（P-20261106-6）E2E —— 远程主机终端面（SSH PTY 直通链路）：
 *   1. 应用开启鼠标上报（DECSET 1000h 经 bash printf 写 PTY 输出）→ pane 顶部提示条出现；
 *   2. 关闭（DECRST 1000l）→ 提示条自动隐藏（显隐随模式序列即时切换）；
 *   3. ✕ = 永久不再提示：safeStorage 键 sc.terminal.mouseModeHintDismissed=1，
 *      模式再开不再显示，reload 后仍不显示（持久化）；
 *   4. 设置页「重置鼠标选择提示」恢复显示路径；
 *   5. OSC 52 粘性抑制（P-20261107-6）：应用经 OSC 52 写剪贴板成功（claude code
 *      应用内复制的真实路径，printf 合成序列 → xterm OSC 52 handler → copyText
 *      落 navigator.clipboard，并回读剪贴板断言真写入了）= 复制本就可用，提示条
 *      即时收起且本会话内模式再开不复现；粘性 ≠ ✕ 记忆（safeStorage 不落键）。
 *
 * 注入面为何是远程主机终端：Windows 本地终端走 ConPTY，应用侧输出的
 * DECSET/DECRST 1000/1002/1003 被 ConPTY 消费为自身鼠标输入翻译内部态、不再
 * 上游转发——slot 实例 scrollback 原始字节实测：`printf '\033[?1000h'` 执行
 * 成功（OSC 133 D 退码 0）但 `?1000h` 不在字节流里，而 shell 启动期 ConPTY
 * 自身发出的 `?9001h`/`?1004h` 在上。远程终端是 SSH PTY 原样中继（无 ConPTY
 * 环节），printf 的 DECSET/OSC 52 原样到达 xterm，与 Linux/macOS 本地 tmux/
 * native 链路同构。检测与提示面三终端全共享（RemoteTerminalPane 即
 * TerminalPane 包装、useTerminalSession 同一连接链挂 handler），本 spec 验证的
 * 是同一实现。WSL sshd 不可达的环境整用例 skip（remote-console.spec 同款门控）。
 * 协议透传语义（handler 恒返回 false、xterm 默认鼠标上报行为不变）由单测
 * terminalMouseModeHint.test.ts 钉死；OSC 52 写入分支语义（独占消费/primary
 * 不动作/读请求不回应/会话粘性）由单测 terminalOsc52Clipboard.test.ts 钉死——
 * e2e 只验可视化面与真实剪贴板落地。
 */

const BASE = API_BASE
const DISMISS_KEY = 'sc.terminal.mouseModeHintDismissed'
// 锚定可见远程窗格：页内可能同时存在项目终端（底部面板），提示条断言不读到它
const PANE = '.remote-pane-wrap:visible'
const HINT = `${PANE} [data-testid="term-mouse-mode-hint"]`
const HINT_DISMISS = `${PANE} [data-testid="term-mouse-mode-hint-dismiss"]`

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

/** 解锁请求头（裸 fetch，与 remote-console.spec helper 同款） */
async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理远程管理持久化状态（服务端 uiState remoteConsole），保证从空态开始。
 *  调用前提：页面未打开或已卸载（SPA 卸载 beacon 会把旧内存态写回覆盖直写） */
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

/** 向远程终端输入命令：聚焦 xterm helper textarea 再击键（不走 xterm 容器点击
 *  ——鼠标上报开启后点击画布会被 xterm 当 mouse report 发给应用，焦点路径
 *  与模式状态解耦更稳；remote-console 断线重连用例同款先例） */
async function typeInRemoteTerm(page: Page, text: string) {
  const ta = page.locator(`${PANE} textarea.xterm-helper-textarea`).first()
  await expect(ta).toBeVisible({ timeout: 10000 })
  await ta.focus()
  await expect(ta).toBeFocused()
  await page.keyboard.type(text)
}

/** bash printf 合成 DECSET/DECRST 鼠标模式序列（命令文本纯 ASCII，ESC 字节只
 *  出现在输出侧；`\\033` 经模板字面量落到 bash 的文本 `\033` 由 printf 内建
 *  转义解释，bash/zsh 同语义；尾部 \r = 真实回车执行） */
function mouseModeCommand(enable: boolean, mode: number): string {
  return `printf '\\033[?${mode}${enable ? 'h' : 'l'}'\r`
}

/** bash printf 合成 OSC 52 写剪贴板序列（ESC ] 52 ; c ; <base64> BEL——claude code
 *  setClipboard 同形态；命令文本纯 ASCII，ESC/BEL 只出现在输出侧） */
function osc52Command(base64Payload: string): string {
  return `printf '\\033]52;c;${base64Payload}\\a'\r`
}

/** 远程管理视图开 WSL 终端并等到 root 提示符（两用例共用的前置） */
async function openWslTerminal(page: Page) {
  // 远程视图 + WSL 卡片快捷钮开终端（卡片点击 P-20261030-3 起是编辑弹窗，
  // 开终端走 hover 快捷钮）
  await page.locator('[data-testid="rail-remote-console"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()
  await wslCard.locator('.host-card-term').click()
  const xterm = page.locator(`${PANE} .xterm`).first()
  await expect(xterm).toBeVisible({ timeout: 30000 })
  // root 提示符（45s：WSL 冷启动 PTY 建连可能超 20s，remote-console 先例）
  await expect(xterm).toContainText('#', { timeout: 45000 })
  return xterm
}

/** 清场：关模式（防御，tab 删除本会终结 SSH 会话）→ 关 tab → 还原 tmux 开关 → 清记忆 */
async function cleanupRemoteTerm(page: Page, originalTmux: unknown) {
  await typeInRemoteTerm(page, mouseModeCommand(false, 1000)).catch(() => {})
  while (await page.locator('.remote-tab .remote-tab-close').count() > 0) {
    await page.locator('.remote-tab .remote-tab-close').first().click()
    await page.waitForTimeout(400)
  }
  await putSetting(page, { terminalRemoteTmux: !!originalTmux }).catch(() => {})
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY).catch(() => {})
}

test('鼠标上报开启显示提示条、关闭自动隐藏、✕ 永久记忆可重置', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  test.setTimeout(180000)
  // 归一化前置：清掉远程管理残留 tab（页面未打开，无 beacon 覆盖）
  await clearRemoteConsoleState()
  await fixedLocale(page)
  // 关 tab 免确认：用例结束清场，防残留 tab 影响后续运行
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await gotoAndUnlock(page, `${BASE}/project`)
  // 清「不再提示」记忆（前序运行/字母序相邻 spec 遗留）
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY)

  // 远程终端 tmux 开关钉为关（tmux 会把窗格内应用的 DECSET 消费为自己的鼠标
  // 模式再以自身名义向外重发，钉关走纯 SSH PTY 注入路径更确定）；原值 finally 还原
  const originalTmux = await getSetting(page, 'terminalRemoteTmux')
  await putSetting(page, { terminalRemoteTmux: false })

  const xterm = await openWslTerminal(page)

  try {
    // 模式未开启：无提示条
    await expect(page.locator(HINT)).toHaveCount(0)

    // 应用开启鼠标上报（DECSET 1000h）：提示条出现
    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    await expect(page.locator(HINT)).toBeVisible({ timeout: 15000 })
    await expect(page.locator(HINT)).toHaveCount(1)

    // 应用关闭鼠标上报（DECRST 1000l）：提示条自动隐藏
    await typeInRemoteTerm(page, mouseModeCommand(false, 1000))
    await expect(page.locator(HINT)).toBeHidden({ timeout: 15000 })

    // ✕ = 永久不再提示：safeStorage 落键
    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    await expect(page.locator(HINT)).toBeVisible({ timeout: 15000 })
    await page.locator(HINT_DISMISS).click()
    await expect(page.locator(HINT)).toBeHidden()
    expect(await page.evaluate((key) => window.localStorage.getItem(key), DISMISS_KEY)).toBe('1')

    // 记忆即时生效（模式再开不显示，无需 reload）+ 关掉模式再 reload：
    // 持久化——reload 后模式再开仍不显示（组件初始化读键）
    await typeInRemoteTerm(page, mouseModeCommand(false, 1000))
    await page.reload()
    await gotoAndUnlock(page, page.url())
    await expect(page.locator('.remote-tab').filter({ hasText: 'WSL · 1' })).toBeVisible({ timeout: 20000 })
    await expect(xterm).toContainText('#', { timeout: 45000 })
    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    await expect(page.locator(HINT)).toBeHidden({ timeout: 15000 })
    await typeInRemoteTerm(page, mouseModeCommand(false, 1000))

    // 设置页「重置鼠标选择提示」恢复显示：先关模式（重置只清记忆，不造模式）
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-terminal"]').click()
    await expect(page.locator('[data-testid="settings-pane-terminal"]')).toBeVisible({ timeout: 5000 })
    await page.getByRole('button', { name: '重置鼠标选择提示' }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
    expect(await page.evaluate((key) => window.localStorage.getItem(key), DISMISS_KEY)).toBeNull()

    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    await expect(page.locator(HINT)).toBeVisible({ timeout: 15000 })
  } finally {
    await cleanupRemoteTerm(page, originalTmux)
  }
})

test('OSC 52 应用自复制成功 → 提示条即时收起且本会话粘性不复现（P-20261107-6）', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  test.setTimeout(180000)
  await clearRemoteConsoleState()
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.evaluate((key) => window.localStorage.removeItem(key), DISMISS_KEY)
  // OSC 52 落地走 navigator.clipboard（e2e 实例 127.0.0.1 属安全上下文）；序列
  // 到达时无用户手势，须显式授剪贴板写权限，读权限供回读断言真实写入
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  // 预置哨兵值：回读断言能区分「OSC 52 真写入」与「剪贴板本就是该值」
  await page.evaluate(() => navigator.clipboard.writeText('osc52-e2e-sentinel'))

  const originalTmux = await getSetting(page, 'terminalRemoteTmux')
  await putSetting(page, { terminalRemoteTmux: false })

  await openWslTerminal(page)

  try {
    // 应用开启鼠标上报：提示条出现（尚无 OSC 52 写入，能力未证）
    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    await expect(page.locator(HINT)).toBeVisible({ timeout: 15000 })

    // 应用经 OSC 52 写剪贴板（base64 "ClickMe"）：handler → copyText 写入成功
    // → 能力已证，提示条收起。剪贴板回读先断言（既是真实落地证据，也是同步
    // 点——writeText 落定后 handler 的 .then 才登记能力，随后 computed 翻转）
    await typeInRemoteTerm(page, osc52Command('Q2xpY2tNZQ=='))
    await expect.poll(
      () => page.evaluate(() => navigator.clipboard.readText()),
      { timeout: 10000 },
    ).toBe('ClickMe')
    await expect(page.locator(HINT)).toBeHidden({ timeout: 15000 })
    // 粘性抑制 ≠ ✕ 永久记忆：safeStorage 不落键（其他会话的提示条照常）
    expect(await page.evaluate((key) => window.localStorage.getItem(key), DISMISS_KEY)).toBeNull()

    // 本会话内模式反复开合不复现（粘性：不是「近 N 秒无写入」窗口语义）
    await typeInRemoteTerm(page, mouseModeCommand(false, 1000))
    await typeInRemoteTerm(page, mouseModeCommand(true, 1000))
    // 顺序同步点：其后命令的输出落屏 = 前序 printf 的 DECSET 已被 xterm 依序解析、
    // 模式确已重新在位（标记输出与输入文本异形——算术展开——防命令回显误命中）
    await typeInRemoteTerm(page, 'echo osc52-sync-$((20+22))\r')
    await expect(page.locator(`${PANE} .xterm`).first()).toContainText('osc52-sync-42', { timeout: 15000 })
    await expect(page.locator(HINT)).toHaveCount(0)
  } finally {
    await cleanupRemoteTerm(page, originalTmux)
  }
})
