import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import i18n from '../i18n'
import {
  notificationApi,
  getNotificationWsUrl,
  getCurrentInstanceContext,
  type NotificationItem,
  type NotificationPrefs,
} from '../api/client'
import { OPS_SYNC_PROGRESS, OPS_WATCH_FALLBACK } from '../utils/opsEvents'
import { useWebSocketBase, registerWsLongBackoffNotifier, WS_CLOSE_MESSAGE_TOO_BIG } from '../composables/useWebSocketBase'
import { registerReconnectRefetch, runReconnectRefetches } from '../composables/reconnectRefetch'
import { useLockStore, getUnlockToken } from './lock'

// 全局 t 函数（store 在 setup 外，无法用 useI18n composable）
const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params as never)

// 全局通知中心 store（不依赖 currentProjectId）
// App.vue 启动时调 init()：拉取历史 + 连接全局 WS
export const useNotificationStore = defineStore('notification', () => {
  const items = ref<NotificationItem[]>([])
  const prefs = ref<NotificationPrefs>({
    enabled: { git: true, task: true, clone: true, system: true, error: true },
    longTaskThresholdMs: 5000,
    desktopNotify: true,
    webhook: { enabled: false, mode: 'post', url: '', scope: 'important' },
    longSessionNotifySec: 300,
    claudeSpendAlertTokens: 0,
    projectMutes: [],
  })
  const showPanel = ref(false)
  const reconnectAttempts = ref(0)
  const disconnectedNotified = ref(false)

  // 待消费的跳转请求（Layout watch 这两个 ref 完成路由跳转 + 面板切换）
  const pendingAction = ref<NotificationItem | null>(null)

  // 稍后提醒（P-20261003-36）：snoozeUntil 标记在位 = 延后中。延后是「专注保护」
  // 语义——徽标对延后中的条目保持沉默，到点重挂才回到未读。判定与服务端标记
  // 脱钩（不看墙钟）：到期到服务端分钟巡检重挂（清标记+置未读+广播 snoozeDue）
  // 之间的空窗若按墙钟判定，条目会提前弹回常规流且不带重挂的未读/置顶语义，
  // 违背「到点重挂才回到」契约（fulle2e run7 notification-snooze 到点重挂用例实测）
  function isSnoozed(n: NotificationItem): boolean {
    return !!n.snoozeUntil
  }

  // 到点重挂的条目 id（本会话内一次性标记，非响应式——只被 watch 回调消费）：
  // 重挂走独立 WS 消息（snoozeDue），桌面通知 watch 据此跳过弹出（不重弹，仅站内+徽标）
  const remountIds = new Set<string>()
  function consumeRemount(id: string): boolean {
    if (!remountIds.has(id)) return false
    remountIds.delete(id)
    return true
  }

  const unreadCount = computed(() => items.value.filter(n => !n.read && !isSnoozed(n)).length)

  // addLocal 仅在前端内存里插入（不调后端，用于纯前端事件如 WS 断开通知）
  function addLocal(n: Omit<NotificationItem, 'id' | 'time' | 'read'>) {
    if (!isCategoryEnabled(n.category) || isProjectMuted(n.projectId, n.category)) return
    const item: NotificationItem = {
      ...n,
      id: 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      time: new Date().toISOString(),
      read: false,
    }
    items.value = [item, ...items.value].slice(0, 200)
  }

  const { connect: connectWs, disconnect: disconnectWs } = useWebSocketBase({
    getUrl: () => getNotificationWsUrl(),
    // 子协议携带 unlock token（内存态，P-20261019-2）：内存缺省时握手不带
    // 子协议，由浏览器自动携带的 HttpOnly cookie 兜底
    getProtocols: () => {
      const token = getUnlockToken()
      return token ? [token] : undefined
    },
    onMessage: (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'notification.new' && msg.notification) {
          items.value = [msg.notification as NotificationItem, ...items.value].slice(0, 200)
        } else if (msg.type === 'sync.progress' && msg.data) {
          // 多实例同步进度（P-20261023-1）：服务端 sync.progress 广播分发为
          // 窗口事件（同步中心面板监听渲染）——非通知形状消息不入通知列表
          window.dispatchEvent(new CustomEvent(OPS_SYNC_PROGRESS, { detail: msg.data }))
        } else if (msg.type === 'watch.fallback' && msg.data) {
          // 文件监听降级兜底状态迁移（P-20261006-34）：非通知形状消息不入
          // 通知列表，分发为窗口事件供状态栏「轮询降级中」微标显隐（上款
          // sync.progress 同款二次分发）
          window.dispatchEvent(new CustomEvent(OPS_WATCH_FALLBACK, { detail: msg.data }))
        } else if (msg.type === 'notification.snoozeDue' && msg.notification) {
          // 稍后提醒到点重挂（P-20261003-36）：同 id 条目已由服务端置未读+前移
          // 时间戳，这里按 id 替换并置顶（notification.new 路径会重复入账同 id），
          // 并打一次性重挂标记供桌面通知 watch 跳过弹出
          const n = msg.notification as NotificationItem
          items.value = [n, ...items.value.filter(x => x.id !== n.id)].slice(0, 200)
          remountIds.add(n.id)
        }
      } catch {
        // 非 JSON 消息忽略
      }
    },
    onOpen: (attempts) => {
      if (attempts >= 5 && disconnectedNotified.value) {
        addLocal({ type: 'info', category: 'system', title: t('notification.event.backendReconnected') })
      }
      reconnectAttempts.value = 0
      disconnectedNotified.value = false
      // 断线窗口期错过的广播补拉：服务端广播不重放，断线期间落库的通知
      // （实测：系统更新重启窗口期持久化的"系统更新完成"，POST 成功但 WS
      // 尚未重连，回显无人接收）会一直缺席到整页刷新。
      // 必须无条件补拉（不能仅 attempts>0）：handleRecovery（切回标签页/网络
      // 恢复）会先把 attempts 归零再重连，重启窗口期恰逢用户切标签页时补拉
      // 会被跳过，通知缺席到手动刷新。loadHistory 按 id 合并，重复拉取幂等
      // （本域登记在集中注册表，此处触发的是全表遍历——其余域 fn 同为幂等）
      runReconnectRefetches()
    },
    onClose: (attempts) => {
      reconnectAttempts.value = attempts
      if (attempts === 5 && !disconnectedNotified.value) {
        disconnectedNotified.value = true
        addLocal({
          type: 'error',
          category: 'system',
          title: t('notification.event.backendDisconnected'),
        })
      }
    },
    // 门控：锁定状态下不连接，避免握手被中间件拒绝后陷入重连死循环
    shouldConnect: () => !useLockStore().isLocked,
    autoCleanup: false, // store 生命周期不绑定组件卸载
  })

  function reconnectWs() {
    disconnectWs()
    connectWs()
  }

  // WS 1009/1011 长退避的显式提示注册（P-20261005-185）：base 的关闭码特判分支
  // 经此回调入账通知中心条目（base 不反向依赖本 store——注册表解耦，见
  // useWebSocketBase.registerWsLongBackoffNotifier 注记）。store 初始化即注册，
  // 启动极窄窗内未注册时 base 侧静默跳过，长退避重连不受影响
  registerWsLongBackoffNotifier((code) => {
    addLocal({
      type: 'error',
      category: 'system',
      title: t(
        code === WS_CLOSE_MESSAGE_TOO_BIG
          ? 'notification.event.wsMessageTooBig'
          : 'notification.event.wsServerError',
      ),
    })
  })

  // 拉取通知历史（init、实例切换后重拉、WS 重连补拉共用）。
  // 响应回来时校验实例上下文未变——启动时的 init 与实例恢复触发的重拉可能并发，
  // 旧实例的响应晚到会覆盖新实例的数据，这里直接丢弃
  async function loadHistory() {
    const ctx = getCurrentInstanceContext()
    try {
      // 响应拦截器已解包 response.data，axios 泛型类型对不上，cast 在 Promise 上（文件既有约定）
      const res = await (notificationApi.list({ silent: true }) as Promise<any>)
      if (getCurrentInstanceContext().instanceId !== ctx.instanceId) return
      const server: NotificationItem[] = res.data || []
      // 按 id 合并而非整体替换：快照是拉取时刻的点值，期间 WS 实时送达或本地
      // 插入的条目（重连补拉场景必然并发——addLocal 的"后端已重连"就插在
      // 补拉之前）不在快照里，整体替换会把它们丢掉；服务端列表对已存在的
      // 同 id 条目为权威（已读/移除以其为准）
      const serverIds = new Set(server.map(n => n.id))
      const localOnly = items.value.filter(n => !serverIds.has(n.id))
      items.value = [...localOnly, ...server].slice(0, 200)
    } catch {
      // 静默：后端错误时保留现状
    }
  }

  // 重连补拉注册（P-20261003-236）：本域断线补拉迁入集中注册表，由重连触发点
  // 统一遍历执行（setup 内注册以闭包持有 loadHistory，不新增 store 公开面）。
  // 「必须无条件补拉、不能只 attempts>0」的历史裁决与断线窗口案例注记保留在
  // 上方 useWebSocketBase onOpen 处
  registerReconnectRefetch('notification', () => { void loadHistory() })

  // 初始化：并行拉取偏好与历史（相互独立，失败各自静默）+ 连接全局 WS
  async function init() {
    const [prefsRes] = await Promise.all([
      (notificationApi.getPrefs({ silent: true }) as Promise<any>).catch(() => null),
      loadHistory(),
    ])
    if (prefsRes) {
      // projectMutes 归一为数组：服务端 omitempty 对空清单省字段（undefined），
      // 不归一则设置页 isDirty 的 JSON 深比较「开页即脏」（localPrefs 侧为 []），
      // 关页误弹未保存确认
      prefs.value = { ...prefsRes, projectMutes: prefsRes.projectMutes ?? [] }
    }
    // 锁定时跳过连接：避免握手被中间件拒绝后陷入重连循环
    if (!useLockStore().isLocked) {
      connectWs()
    }
  }

  // 实例切换：清空旧实例通知 → 重连 WS → 拉取新实例历史
  // （不走 clear()——那是清远端服务端数据的 API）
  function switchInstance() {
    items.value = []
    reconnectWs()
    void loadHistory()
  }

  // 锁定状态联动：锁定 → 断开 WS；解锁 → 重连
  // 必须在 store 初始化（init 调用前）就注册 watch，确保后续状态变更都能感知
  watch(() => useLockStore().isLocked, (locked) => {
    if (locked) {
      disconnectWs()
    } else {
      reconnectWs()
    }
  })

  // 业务事件调用：走后端持久化（POST /notifications）
  async function add(n: Omit<NotificationItem, 'id' | 'time' | 'read'>) {
    if (!isCategoryEnabled(n.category) || isProjectMuted(n.projectId, n.category)) return
    try {
      await notificationApi.add(n, { silent: true })
    } catch {
      addLocal(n)
    }
  }

  function isCategoryEnabled(category: string): boolean {
    const v = prefs.value.enabled[category]
    return v === undefined ? true : v
  }

  // 项目×类别二维静音（P-20261003-168）：与类别开关 AND 同点的前端预判——
  // 命中组合免掉一次注定被服务端丢弃的 POST（服务端 Add 判定点是权威）。
  // 存量偏好缺 projectMutes 字段时按空清单兜底
  function isProjectMuted(projectId: string | undefined, category: string): boolean {
    if (!projectId) return false
    return (prefs.value.projectMutes ?? []).some(m => m.projectId === projectId && m.category === category)
  }

  // 条目快捷「静音此项目此类」：本地先行（与 updatePrefs 同约定：后端失败
  // 静默，本地已一致）。已静音的组合幂等跳过
  async function muteProjectCategory(projectId: string, category: string) {
    if (!projectId || !category || isProjectMuted(projectId, category)) return
    const mutes = [...(prefs.value.projectMutes ?? []), { projectId, category }]
    await updatePrefs({ ...prefs.value, projectMutes: mutes })
  }

  async function markAllRead() {
    items.value.forEach(n => n.read = true)
    try { await notificationApi.readAll({ silent: true }) } catch { /* 本地已置已读，后端同步失败静默 */ }
  }

  async function markRead(id: string) {
    const n = items.value.find(x => x.id === id)
    if (n) n.read = true
    try { await notificationApi.readOne(id, { silent: true }) } catch { /* 本地已置已读，后端同步失败静默 */ }
  }

  async function dismiss(id: string) {
    items.value = items.value.filter(n => n.id !== id)
    try { await notificationApi.dismiss(id, { silent: true }) } catch { /* 本地已移除，后端同步失败静默 */ }
  }

  // 批量移除：聚合组整组清除 / 按分类清空共用。先本地移除再同步后端
  //（与 dismiss 同约定：后端失败静默，本地已一致）
  async function dismissMany(ids: string[]) {
    if (ids.length === 0) return
    if (ids.length === 1) {
      const only = ids[0]
      if (only) return dismiss(only)
      return
    }
    const gone = new Set(ids)
    items.value = items.value.filter(n => !gone.has(n.id))
    try { await notificationApi.dismissMany(ids, { silent: true }) } catch { /* 本地已移除，后端同步失败静默 */ }
  }

  // 稍后提醒打标/取消（P-20261003-36）：until 为 ISO 绝对时刻，空串 = 取消
  // （条目恢复原位次与原已读态）。本地先行（与 dismiss 同约定：后端失败静默，
  // 本地已一致）；取消/重新打标都不动 time/read，到点重挂才由服务端改写
  async function snooze(id: string, until: string) {
    const n = items.value.find(x => x.id === id)
    if (!n) return
    n.snoozeUntil = until || undefined
    try { await notificationApi.snooze(id, until, { silent: true }) } catch { /* 本地已更新，后端同步失败静默 */ }
  }

  async function clear() {
    items.value = []
    try { await notificationApi.clear({ silent: true }) } catch { /* 本地已清空，后端同步失败静默 */ }
  }

  async function updatePrefs(newPrefs: NotificationPrefs) {
    prefs.value = newPrefs
    try { await notificationApi.updatePrefs(newPrefs, { silent: true }) } catch { /* 本地已更新，后端同步失败静默 */ }
  }

  function open() { showPanel.value = true }
  function close() { showPanel.value = false }
  function toggle() { showPanel.value = !showPanel.value }

  async function handleClick(n: NotificationItem) {
    // url 型动作（P-20261007-15）：新窗打开与项目页无涉，在 set 处直接
    // window.open（与消费链 openUrl 同参），不进 pendingAction、不走路由桥接。
    // 理由有二：桥接要经 Layout 懒加载 chunk + 引导恢复多次 await，脱离用户
    // 手势语境有被浏览器弹窗拦截的风险；「先落项目页再开新窗」是无谓的落点
    // 漂移。已读打标走 fire-and-forget（markRead 内本地置位是同步的），动作
    // 不被服务端同步阻塞
    if (n.action === 'url' && n.actionPayload) {
      if (!n.read) void markRead(n.id)
      showPanel.value = false
      window.open(String(n.actionPayload), '_blank', 'noopener')
      return
    }
    if (!n.read) await markRead(n.id)
    showPanel.value = false
    if (n.action) {
      pendingAction.value = n
      // 路由桥接（P-20261007-15）：pendingAction 消费面（watch）挂载于项目页
      // Layout，非 project 路由（首页/大屏）点动作条目时 store 里只有生产者
      // 没有消费者，动作静默丢失（挂到被下一条覆盖）。先路由进项目页，Layout
      // 引导完成后挂 watch（immediate）回放存量动作——手机收 webhook 推送
      // （P-31）→进站落首页→点「查看会话」的最后一公里就此接上。跨项目动作
      // （n.projectId）的 switchProject 链在回放面照走（useLayoutShell 既有
      // handlers）；与 previewPort.openInPanel 非项目页先路由同款判定
      // 惰性取 router（P-07-15 路由桥接）：本 store 被 e2e spec 经 dnd 等链传递
      // 引入时，模块级 import 主 router 会把 routes→views 整图拖进 playwright
      // 装载器（import.meta.env/window 在收集期均不可用，run11/run12 两度全毁）
      // ——动态 import 推迟到真正点动作时求值，测试收集面零触及
      void (async () => {
        const { default: r } = await import('../router')
        if (r.currentRoute.value.name !== 'project') {
          await r.push({ name: 'project' })
        }
      })()
    }
  }

  function consumeAction() {
    pendingAction.value = null
  }

  // 第二动作（P-20261005-150）：主动作旁第二小钮的派发入口——把动作槽位换成
  // 第二动作后走 handleClick 同链（已读打标 + 关面板 + pendingAction 路由桥接），
  // 消费端（useLayoutBootstrap.bindPendingActionWatch）按 action 分发，不感知
  // 动作来自哪个槽位。无第二动作的条目不可达此入口（按钮不渲染）；
  // 返回 handleClick 的 promise 供测试顺链（UI 点击处照旧不 await）
  function handleSecondAction(n: NotificationItem): Promise<void> | undefined {
    if (!n.secondAction) return undefined
    return handleClick({ ...n, action: n.secondAction, actionPayload: n.secondActionPayload })
  }

  return {
    items, prefs, showPanel, unreadCount, pendingAction,
    init, connectWs, disconnectWs, reconnectWs, switchInstance,
    add, addLocal, isCategoryEnabled, isProjectMuted, muteProjectCategory, isSnoozed, snooze, consumeRemount,
    markAllRead, markRead, dismiss, dismissMany, clear, updatePrefs,
    open, close, toggle, handleClick, handleSecondAction, consumeAction,
  }
})
