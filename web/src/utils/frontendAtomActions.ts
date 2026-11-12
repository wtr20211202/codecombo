import { h } from 'vue'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import i18n from '../i18n'
import { clipApi } from '../api/domains/system'
import { CLIP_MAX_BYTES, clipByteLength, ownClipDeviceId } from './clipRelay'
import { copyText } from './clipboard'
import { maskSensitive } from './sensitiveMask'
import { useNotificationStore } from '../stores/notification'
import { useOpsAtomPrefs, type FrontendAtomId } from '../stores/opsAtomPrefs'
import type { FrontendClipboardDetail, FrontendDownloadDetail, FrontendOpenDetail, FrontendReloadDetail } from './opsEvents'
import { useClipRelay } from '../composables/useClipRelay'
import { bumpViewReload } from '../composables/useViewReload'

/**
 * frontend 动词族原子的前端消费链（P-20261023-4 首批三原子 + P-20261111-3
 * 整页·视图重载）：下载框弹出 / 剪贴板直写 / 新标签开外链 / 整页·当前视图
 * 重载——协议从「引导注意力」升维「替用户执行浏览器动作」。OpsChannelBridge
 * 每事件委托一行，本模块不持视图状态（view 重载的 tick 状态收口在
 * composables/useViewReload，本模块只 bump）——与 previewPortNotify
 * （P-20261002-70）/ watchInviteNotify（P-20261005-165）同构拆分。
 *
 * 安全边界（族内原子都是用户设备上的即时效应，滥用对策四层，缺一不可）：
 * ①服务端发布口 60 条/分钟/会话限流（ai/opsentry.go opsNotifyLimiter）；
 * ②下方效应面独立预算（10 次/分钟/原子，超限**可见** warning——效应面丢弃
 *   不允许静默，agent 侧 bug 死循环下载会变成下载框轰炸）；
 * ③全部必带可见反馈 toast——下载/剪贴板/打开/重载均无静默效应（剪贴板的
 *   写入前可见预告是投毒防线第一层；整页重载本身就是最响的可见效应，toast
 *   承担归因提示。此处刻意**不**参与免打扰静默：安全反馈与 notify.toast 的
 *   即逝提醒不同性质，夜间挂机也不许在用户设备上无痕生效）；
 * ④设置按原子开关（stores/opsAtomPrefs，默认开；关闭后 handler 门控跳过，
 *   每窗口至多一条「已关闭」提示——agent 可感知而非静默失联）。
 */

// —— 效应面预算（每原子独立固定窗口）——
// 服务端 60 条/分钟是广播预算（全部 ops-notify 共享）；效应面 10 次/分钟/原子
// 更紧：下载框/剪贴板/标签页是用户感官面，10 次已远超任何正常 agent 会话的
// 单原子用量（正常链路一个会话至多几次），触顶即 bug 循环
const ATOM_BUDGET_LIMIT = 10
const ATOM_BUDGET_WINDOW_MS = 60_000

interface AtomBudget {
  windowStart: number
  count: number
  /** 本窗口是否已弹过触顶 warning（超限丢弃必可见，但每窗口一条——
   *  死循环 agent 刷掉的丢弃不转化为 toast 面的新一轮轰炸） */
  warned: boolean
}

// 模块级预算表：键 = 原子 id（3 个，容量有界）；多标签页各自一份（效应本就
// per-tab 触发，跨页合账需服务端配合，收益不成比例）
const atomBudgets = new Map<FrontendAtomId, AtomBudget>()

// 「已关闭」提示的每窗口节流（防关档后 agent 死循环刷提示自身变噪音）
const disabledNoticeBudgets = new Map<FrontendAtomId, AtomBudget>()

/** 测试钩子：清模块级状态（用例间隔离，previewPortNotify 同惯例） */
export function resetFrontendAtomStateForTest(): void {
  atomBudgets.clear()
  disabledNoticeBudgets.clear()
}

function t(key: string, params?: Record<string, unknown>): string {
  return i18n.global.t(key, params as never)
}

/** 带稳定 testid 的 toast 内容（e2e 以语义锚点断言，不绑文案措辞） */
function atomToast(text: string, testid: string): () => ReturnType<typeof h> {
  return () => h('span', { 'data-testid': testid }, text)
}

type AtomMessage = MessageApiInjection

/**
 * 消费一次效应预算：窗口内首 10 次放行，超限丢弃并弹可见 warning（返回 false）。
 * 与服务端「静默丢弃」刻意相反：效应面发生在用户设备上，丢弃必须可见——
 * agent 的 ops-channel 回告链感知不到前端效应面预算，可见 toast 是唯一反馈
 */
function consumeAtomBudget(atom: FrontendAtomId, message: AtomMessage): boolean {
  const now = Date.now()
  let b = atomBudgets.get(atom)
  if (!b || now - b.windowStart >= ATOM_BUDGET_WINDOW_MS) {
    b = { windowStart: now, count: 0, warned: false }
    atomBudgets.set(atom, b)
  }
  b.count++
  if (b.count > ATOM_BUDGET_LIMIT) {
    if (!b.warned) {
      b.warned = true
      message.warning(atomToast(t('opsAtom.rateLimited', { atom: t(`opsAtom.atom.${atom}`) }), 'ops-atom-rate-limited-toast'))
    }
    return false
  }
  return true
}

/** 设置开关门控：关闭 = 效应不发生；每窗口至多一条「已关闭」提示（agent
 * 可感知、用户不被刷屏）。返回 false = 调用方直接返回 */
function ensureAtomEnabled(atom: FrontendAtomId, message: AtomMessage): boolean {
  if (useOpsAtomPrefs().enabled(atom)) return true
  const now = Date.now()
  let b = disabledNoticeBudgets.get(atom)
  if (!b || now - b.windowStart >= ATOM_BUDGET_WINDOW_MS) {
    b = { windowStart: now, count: 0, warned: false }
    disabledNoticeBudgets.set(atom, b)
  }
  if (b.count === 0) {
    b.count++
    message.info(atomToast(t('opsAtom.disabledNotice', { atom: t(`opsAtom.atom.${atom}`) }), 'ops-atom-disabled-toast'))
  }
  return false
}

// —— 载荷形态复验（服务端发布口已校验，此处防其它来源——直通分发面任何
// 脚本都可 dispatch 同名 window 事件，与 previewPortNotify 复验同口径）——

/** 项目相对路径守卫：与 agentops.isOpenFilePath 同语义的正侧镜像（正斜杠、
 *  无 / 前缀、无盘符、无 .. 段） */
export function isProjectRelativePath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/')) return false
  if (path.length >= 2 && path[1] === ':') return false
  return !path.split('/').includes('..')
}

/** http(s) 绝对外链守卫：与 agentops.isHTTPExternalURL 同防线（scheme 白名单
 *  拒伪协议 + 主机非空 + 禁空白控制符）。该值是 window.open 的直接消费值，
 *  scheme 是唯一防线 */
export function isHTTPExternalURL(url: string): boolean {
  // eslint-disable-next-line no-control-regex -- 控制字符即匹配目标（禁空白/控制符防线，同 server/agentops isHTTPExternalURL）
  if (!url || /\s|[\x00-\x1f\x7f]/.test(url)) return false
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host !== ''
  } catch {
    return false
  }
}

/**
 * frontend.download：隐藏 `<a download>` 指向既有文件下载端点（同源，锁 token
 * 走 cookie 载体 P-20261020-1），点击即弹浏览器下载框——文件字节不经事件通道，
 * 下载管理器原生承接（大文件/断点续传免费获得）。
 * 返回 true = 已触发（含触顶/关闭被拒的可见反馈已给出），false = 载荷非法静默忽略
 */
export function handleFrontendDownload(d: FrontendDownloadDetail, message: AtomMessage): boolean {
  const path = (d.path || '').trim()
  const projectId = (d.projectId || '').trim()
  if (!path || !projectId || !isProjectRelativePath(path)) return false
  if (!ensureAtomEnabled('download', message)) return false
  if (!consumeAtomBudget('download', message)) return false
  // 同源下载：Content-Disposition（服务端净化链）是文件名权威，download 属性
  // 只兜头缺失的形态；路径项目相对恒正斜杠，basename 用 split 即可
  const name = path.split('/').pop() || 'download'
  const a = document.createElement('a')
  a.href = `/api/projects/${encodeURIComponent(projectId)}/file/download?path=${encodeURIComponent(path)}`
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  message.success(atomToast(t('opsAtom.downloadStarted', { name }), 'ops-atom-download-toast'))
  return true
}

// 剪贴板预告预览：遮蔽（敏感值纪律）→ 空白折叠（toast 单行扫读面）→ rune 截断
const CLIPBOARD_PREVIEW_MAX = 64

function clipboardPreview(text: string): string {
  const masked = maskSensitive(text).replace(/\s+/g, ' ').trim()
  const chars = Array.from(masked)
  if (chars.length <= CLIPBOARD_PREVIEW_MAX) return masked
  return chars.slice(0, CLIPBOARD_PREVIEW_MAX).join('') + '…'
}

/**
 * frontend.clipboard：copyText 直写用户剪贴板（健壮性红线：禁裸调
 * writeText——copyText 自带 execCommand 降级与剪贴板历史入史）。写入前 toast
 * 预告必带（敏感值遮蔽 + 64 rune 截断预览）——无静默写入。
 * 失败回落 P-20261002-32 中继链：写服务端单槽 + 到达式可点击 toast（点击
 * GET 读取即焚落本地剪贴板）——功能不缺失只是多一次点击。返回值语义同上
 */
export async function handleFrontendClipboard(d: FrontendClipboardDetail, message: AtomMessage): Promise<boolean> {
  const text = typeof d.text === 'string' ? d.text : ''
  if (!text || clipByteLength(text) > CLIP_MAX_BYTES) return false
  if (!ensureAtomEnabled('clipboard', message)) return false
  if (!consumeAtomBudget('clipboard', message)) return false
  const ok = await copyText(text)
  if (ok) {
    message.success(atomToast(t('opsAtom.clipboardWritten', { preview: clipboardPreview(text) }), 'ops-atom-clipboard-toast'))
    return true
  }
  // 回落链（焦点/权限浏览器边界诚实兜底）：clipApi.send 成功即向其他设备广播
  // clipboard.arrived（本设备 tab 因 origin 回声过滤不弹，由本 toast 兜位），
  // 点击经 useClipRelay.takeArrived 读取即焚——与到达 toast 同款可点击交互与
  // 时长（naive-ui message 选项不含 onClick，渲染函数内 span 自挂 click，
  // OpsChannelBridge.onClipArrived 同款）；testid 沿用到达 toast 语义锚点
  try {
    await clipApi.send(text, ownClipDeviceId())
    const relay = useClipRelay(message)
    message.info(() => h('span', {
      style: 'cursor:pointer;text-decoration:underline;text-underline-offset:3px;',
      'data-testid': 'clip-arrive-toast',
      onClick: () => { void relay.takeArrived() },
    }, t('opsAtom.clipboardFallback')), { duration: 8000 })
    return true
  } catch {
    message.error(atomToast(t('opsAtom.clipboardFailed'), 'ops-atom-clipboard-failed-toast'))
    return false
  }
}

/**
 * frontend.open：window.open noopener 新标签打开 http(s) 外链（红线：noopener
 * 必带）。popup blocker 是浏览器边界不硬求：open 返回 null = 被拦，回落通知
 * 中心 action='url' 条目（既有形态，watchInviteNotify 同门类）+ warning toast
 * ——功能不缺失只是多一次点击。返回值语义同上
 */
export function handleFrontendOpen(d: FrontendOpenDetail, message: AtomMessage): boolean {
  const url = (d.url || '').trim()
  if (!isHTTPExternalURL(url)) return false
  if (!ensureAtomEnabled('open', message)) return false
  if (!consumeAtomBudget('open', message)) return false
  const win = window.open(url, '_blank', 'noopener')
  if (win) {
    let host = url
    try { host = new URL(url).host } catch { /* 校验已过，host 解析失败原样展示 */ }
    message.success(atomToast(t('opsAtom.opened', { host }), 'ops-atom-open-toast'))
    return true
  }
  let host = url
  try { host = new URL(url).host } catch { /* 同上 */ }
  // 通知中心入账：后端失败 store.add 自动降级本地插入。归类 task（agent 上报链
  // 同门类）；动作 url → 通知 store handleClick 直开新窗（P-20261007-15 语义）
  void useNotificationStore().add({
    type: 'info',
    category: 'task',
    title: t('opsAtom.openBlockedTitle', { host }),
    body: url,
    action: 'url',
    actionPayload: url,
  })
  message.warning(atomToast(t('opsAtom.openBlocked', { host }), 'ops-atom-open-blocked-toast'))
  return true
}

// scope=page 的 toast 上屏窗口：naive-ui message 下一帧即渲染，留出一次可见
// 上屏再触发卸载（即时 reload 会连 toast 一起带走）；对重载体感无感知差异
const PAGE_RELOAD_TOAST_DELAY_MS = 300

/**
 * frontend.reload（P-20261111-3）：要求前端重载——page = location.reload()
 * 整页重载；view = 当前路由整树 remount（bump useViewReloadTick 翻转 App 层
 * RouterView :key，路由/URL 零变化）。未保存编辑有 IndexedDB 草稿自动保存
 * 兜底，page 档另有既有 beforeunload 确认框（脏文件在位时浏览器弹确认，
 * 用户可取消——重载被拒是用户裁决，非静默失败）。
 * 返回 true = 已触发（含触顶/关闭被拒的可见反馈已给出），false = 载荷非法静默忽略
 */
export function handleFrontendReload(d: FrontendReloadDetail, message: AtomMessage): boolean {
  // scope 复验（服务端已规整枚举，此处防其它来源——同三原子防呆口径）：
  // 未知值按缺省 page 收敛而非静默丢弃——重载意图明确，粒度存疑时取更彻底
  // 的重取形态（与提案「scope 缺省 page」同向）
  const scope = d.scope === 'view' ? 'view' : 'page'
  if (!ensureAtomEnabled('reload', message)) return false
  if (!consumeAtomBudget('reload', message)) return false
  if (scope === 'view') {
    bumpViewReload()
    message.success(atomToast(t('opsAtom.viewReloaded'), 'ops-atom-reload-toast'))
    return true
  }
  message.info(atomToast(t('opsAtom.pageReloading'), 'ops-atom-reload-toast'))
  window.setTimeout(() => { window.location.reload() }, PAGE_RELOAD_TOAST_DELAY_MS)
  return true
}
