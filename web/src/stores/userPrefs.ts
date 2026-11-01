import { defineStore } from 'pinia'
import { settingsApi } from '../api/domains/system'
import { useKeymapStore, KEYMAP_OVERRIDES_STORAGE_KEY, type KeymapAction } from './keymap'
import { DND_STORAGE_KEY, DND_DEFAULTS, useDndStore } from './dnd'
import { SOUND_STORAGE_KEY, useSoundStore } from './sound'
import { NOTIFY_SIMPLE_STORAGE_KEY, useNotifySimpleStore } from './notifySimple'
import { TERMINAL_THEME_FOLLOW_KEY, TERMINAL_THEME_FOLLOW_DEFAULT, useTerminalThemeStore } from './terminal-theme'
import { COPY_ON_SELECT_KEY, isCopyOnSelectEnabled, setCopyOnSelectEnabled } from '../composables/useTerminalClipboard'
import { OPS_ATOM_IDS, useOpsAtomPrefs } from './opsAtomPrefs'
import { DND_EXCEPTION_DEFAULTS, type DndWindow } from '../utils/dndSchedule'
import { onUserPrefsDirty } from './userPrefsLink'

/**
 * 用户偏好层服务端漫游（P-20261007-1 Settings Sync）编排 store：分轨原则下
 * 「跟人走」的用户偏好（键位覆盖 / 通知偏好三件 dnd·音效·精简 / 终端复制选中 /
 * 终端主题跟随）以稀疏偏差集（仅存 ≠ 出厂默认项）落服务端 settings 单键
 * `userPrefs`（schema 前端自治，服务端仅合法 JSON + ≤64KB 两道校验）；设备
 * 偏好（字号/缩放/光标形态/滚动已读等 per-device 立场）刻意不进本键，仍留
 * 浏览器 localStorage——收编 P-87/P-69 的 per-device 立场为显式分轨约定
 * （scrollRead 保持设备本地是其 store 注记的既有立场，不在提案①的漫游清单）。
 *
 * 双写语义（写路径：服务端 PUT 真值 + localStorage 镜像缓存）：
 * - 各偏好 store 的既有 setter 是唯一写正门（消毒与响应性都经正门，同
 *   settingsTransfer 纪律），setter 内仍写 localStorage 镜像（读路径启动期
 *   同步可用 + 离线兜底），再经 userPrefsLink 脏标记通知本 store 防抖上云；
 * - 读路径启动时服务端值 wins：init() 拉取并整表应用（缺省段=回默认，即
 *   「B 机完全跟随 A 机的偏好集」；脏值段宁保本地不误清）；
 * - 播种：服务端无 userPrefs（GET 出参 null，旧配置/旧服务端）且本机有旧值
 *   → 上传播种，主力机无损过渡；
 * - 多端跟随：写入后服务端 settings.changed 广播 → OpsChannelBridge 调
 *   pull() 重读应用；自广播回流与本机镜像一致时短路，推送在途时跳过应用
 *   （防把用户刚改的偏好回滚）。
 *
 * 键域（提案①漫游清单）：keymap / notify{dnd,sound,simple} / terminal
 * {copyOnSelect,followAppTheme} / opsAtoms{download,clipboard,open}（P-20261023-4
 * frontend 原子管制）。后续新用户偏好在此登记一行即完成收编。
 */

// 键位覆盖表（sc.keymapOverrides）等存储键常量已由各 store 导出；此处集中
// 再导出供 e2e 播种/断言 import，避免字面量散落（同 dnd.ts DND_STORAGE_KEY 惯例）
export {
  KEYMAP_OVERRIDES_STORAGE_KEY, DND_STORAGE_KEY, SOUND_STORAGE_KEY,
  NOTIFY_SIMPLE_STORAGE_KEY, TERMINAL_THEME_FOLLOW_KEY, COPY_ON_SELECT_KEY,
}

export interface UserPrefsPayload {
  keymap?: Record<string, string>
  notify?: { dnd?: Record<string, unknown>; sound?: boolean; simple?: boolean }
  terminal?: { copyOnSelect?: boolean; followAppTheme?: boolean }
  /** frontend 原子管制（P-20261023-4）：true = 出厂默认（开），稀疏偏差集只存
   * 关档项——缺省段/缺键 = 回默认开，与 sound 等布尔偏好同一整表替换语义 */
  opsAtoms?: { download?: boolean; clipboard?: boolean; open?: boolean }
}

// 本地变更上云的防抖：偏好 setter 可能被设置页保存链一次触发多次（通知分区
// 一次保存四件套），合并为一次 PUT；500ms 内的多端竞态由 last-write-wins 收敛
const PUSH_DEBOUNCE_MS = 500

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 键序无关的深比较（序列化）：远端对象可能来自 agent 编程写入，键序不定，
 *  稳定序列化避免「值相同但每次 pull 都重放应用」的抖动 */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (isPlainObject(v)) {
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** dnd 时段偏好是否等于出厂默认（稀疏偏差集判定：默认不入服务端对象） */
function dndEqualsDefault(w: DndWindow): boolean {
  const except = w.except ?? []
  return w.enabled === DND_DEFAULTS.enabled
    && w.start === DND_DEFAULTS.start
    && w.end === DND_DEFAULTS.end
    && w.exceptError !== false
    && except.length === DND_EXCEPTION_DEFAULTS.length
    && DND_EXCEPTION_DEFAULTS.every(c => except.includes(c))
}

export const useUserPrefsStore = defineStore('userPrefs', () => {
  let inited = false
  let applyingRemote = false
  let pushTimer: ReturnType<typeof setTimeout> | null = null
  let pushInFlight = false
  // 在途期间又有变更：本轮 PUT 发出的是旧快照，完成后必须补推一次——
  // 否则「PUT 慢于防抖窗口」时窗口内最后一次改动会永久丢失（要等下一次
  // 用户改动才重推），与本机镜像已落的状态相悖
  let pushQueued = false

  // ---- 本机现值采集（镜像只读，写永远走各 store setter 正门） ----------------

  function collectLocal(): UserPrefsPayload {
    const out: UserPrefsPayload = {}
    const overrides = useKeymapStore().overrides
    if (Object.keys(overrides).length > 0) out.keymap = { ...overrides }
    const notify: NonNullable<UserPrefsPayload['notify']> = {}
    const dnd = useDndStore().prefs
    if (!dndEqualsDefault(dnd)) notify.dnd = { ...dnd }
    if (!useSoundStore().enabled) notify.sound = false
    if (useNotifySimpleStore().enabled) notify.simple = true
    if (Object.keys(notify).length > 0) out.notify = notify
    const terminal: NonNullable<UserPrefsPayload['terminal']> = {}
    if (!isCopyOnSelectEnabled()) terminal.copyOnSelect = false
    if (!useTerminalThemeStore().followAppTheme) terminal.followAppTheme = false
    if (Object.keys(terminal).length > 0) out.terminal = terminal
    // frontend 原子管制（P-20261023-4）：稀疏偏差集只收关档项（默认开不入云）
    const opsAtomStore = useOpsAtomPrefs()
    const opsAtoms: NonNullable<UserPrefsPayload['opsAtoms']> = {}
    for (const id of OPS_ATOM_IDS) {
      if (!opsAtomStore.enabled(id)) opsAtoms[id] = false
    }
    if (Object.keys(opsAtoms).length > 0) out.opsAtoms = opsAtoms
    return out
  }

  // ---- 远端值应用（经各 store setter 正门，静默——不回写服务端） -------------

  /** 布尔偏好应用：段在而键缺省 = 回默认（整表替换语义）；键值脏（非布尔）
   *  忽略宁保本地；值已一致短路（自广播回流的常态） */
  function applyBool(
    section: Record<string, unknown>, key: string, def: boolean,
    current: () => boolean, set: (v: boolean) => void,
  ): void {
    const raw = section[key]
    const want = raw === undefined ? def : (typeof raw === 'boolean' ? raw : undefined)
    if (want === undefined || want === current()) return
    set(want)
  }

  function applyRemote(remote: UserPrefsPayload): void {
    applyingRemote = true
    try {
      // keymap：整表替换（逐项规范化+保留键拒绝在 store.replaceAll 内）
      if (remote.keymap === undefined) {
        if (Object.keys(useKeymapStore().overrides).length > 0) useKeymapStore().resetAll()
      } else if (isPlainObject(remote.keymap)) {
        useKeymapStore().replaceAll(remote.keymap as Partial<Record<KeymapAction, string>>)
      }
      const notify = remote.notify
      if (notify === undefined || isPlainObject(notify)) {
        const n = notify ?? {}
        if (n.dnd === undefined) {
          if (!dndEqualsDefault(useDndStore().prefs)) {
            useDndStore().set({ ...DND_DEFAULTS, except: [...DND_EXCEPTION_DEFAULTS] })
          }
        } else if (isPlainObject(n.dnd)) {
          useDndStore().set(n.dnd as unknown as DndWindow) // 逐字段归一在 store.set 内
        }
        applyBool(n, 'sound', true, () => useSoundStore().enabled, v => useSoundStore().set(v))
        applyBool(n, 'simple', false, () => useNotifySimpleStore().enabled, v => useNotifySimpleStore().set(v))
      }
      const terminal = remote.terminal
      if (terminal === undefined || isPlainObject(terminal)) {
        const tc = terminal ?? {}
        applyBool(tc, 'copyOnSelect', true, isCopyOnSelectEnabled, setCopyOnSelectEnabled)
        applyBool(tc, 'followAppTheme', TERMINAL_THEME_FOLLOW_DEFAULT,
          () => useTerminalThemeStore().followAppTheme, v => useTerminalThemeStore().setFollowAppTheme(v))
      }
      // frontend 原子管制（P-20261023-4）：缺段/缺键 = 回默认开（整表替换语义）
      const opsAtoms = remote.opsAtoms
      if (opsAtoms === undefined || isPlainObject(opsAtoms)) {
        const oa = opsAtoms ?? {}
        const ops = useOpsAtomPrefs()
        for (const id of OPS_ATOM_IDS) {
          applyBool(oa, id, true, () => ops.enabled(id), v => ops.set(id, v))
        }
      }
    } finally {
      applyingRemote = false
    }
  }

  // ---- 上云（防抖合并 + 失败保留待重试） -------------------------------------

  function schedulePush(): void {
    if (applyingRemote) return
    if (pushTimer !== null) clearTimeout(pushTimer)
    pushTimer = setTimeout(() => {
      pushTimer = null
      void pushNow()
    }, PUSH_DEBOUNCE_MS)
  }

  async function pushNow(): Promise<void> {
    if (applyingRemote) return
    if (pushInFlight) {
      pushQueued = true
      return
    }
    pushInFlight = true
    try {
      // 整表替换：本机采集即全量偏差集（用户在 A 机恢复默认 → 采集缺段 →
      // 他端同段回默认，语义闭环）。上云失败静默：镜像仍在，下轮脏标记或
      // 广播重试；期间 pull 的推送在途守卫防止旧值回滚本地新值。
      // silent：后台同步失败不弹错误 toast（离线常态下每次改偏好都弹窗是噪音），
      // 镜像兜底 + 下轮重试仍在；设置页用户主动保存仍走各自非静默链
      await settingsApi.update({ userPrefs: collectLocal() as Record<string, unknown> }, { silent: true })
    } catch {
      // 静默重试交给下一轮（dirty 再触发 / settings.changed pull 兜底）
    } finally {
      pushInFlight = false
      // 在途期间排队的变更补推（pushQueued 同步清位，防补推失败自旋）
      if (pushQueued) {
        pushQueued = false
        if (!applyingRemote) void pushNow()
      }
    }
  }

  // ---- 拉取与应用（启动首拉 + settings.changed 跟随共用） --------------------

  /**
   * 拉取服务端 userPrefs 并对账：
   * - 服务端有真值：与本机镜像一致即短路（自广播回流常态）；推送在途跳过
   *   （等自身 PUT 触发的广播回流对账）；否则整表应用（服务端 wins）。
   * - 服务端无（null/缺字段=旧配置或旧服务端）：本机有旧值则播种上传（无害
   *   竞态：两设备同时首启，last-write-wins 取任一为初值）。
   * 拉取失败回落本地镜像现状（离线兜底），下次广播重试。
   */
  async function pull(): Promise<void> {
    try {
      const res = await settingsApi.get() as unknown as { data?: { userPrefs?: Record<string, unknown> | null } }
      const remote = res.data?.userPrefs
      if (isPlainObject(remote)) {
        if (stableStringify(remote) === stableStringify(collectLocal())) return
        if (pushTimer !== null || pushInFlight || pushQueued) return
        applyRemote(remote as UserPrefsPayload)
      } else if (Object.keys(collectLocal()).length > 0) {
        schedulePush()
      }
    } catch {
      /* 拉取失败保本地镜像，静默 */
    }
  }

  /** 初始化（OpsChannelBridge 挂载时调用一次）：订阅写路径脏标记 + 启动首拉 */
  function init(): void {
    if (inited) return
    inited = true
    onUserPrefsDirty(schedulePush)
    void pull()
  }

  return { init, pull, collectLocal }
})
