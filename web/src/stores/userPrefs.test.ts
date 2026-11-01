import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { settingsApi } from '../api/domains/system'
import { useUserPrefsStore, KEYMAP_OVERRIDES_STORAGE_KEY, SOUND_STORAGE_KEY, COPY_ON_SELECT_KEY } from './userPrefs'
import { useKeymapStore } from './keymap'
import { useSoundStore } from './sound'
import { useNotifySimpleStore } from './notifySimple'
import { useOpsAtomPrefs } from './opsAtomPrefs'

// mock settingsApi（userPrefs 编排 store 只经此读写服务端）
vi.mock('../api/domains/system', () => ({
  settingsApi: {
    get: vi.fn().mockResolvedValue({ data: { userPrefs: null } }),
    update: vi.fn().mockResolvedValue({}),
  },
}))

// jsdom localStorage 直读写（safeStorage 的生产路径就是它）
const store = {
  get: (k: string) => localStorage.getItem(k),
  set: (k: string, v: string) => localStorage.setItem(k, v),
  del: (k: string) => localStorage.removeItem(k),
}

/** 同步设置 GET 出参（vi.mock 提升后 settingsApi 即 mock 实例） */
function mockGet(userPrefs: unknown): void {
  ;(settingsApi.get as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
    data: { userPrefs },
  })
}

describe('userPrefs store（P-20261007-1 服务端漫游编排）', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.useFakeTimers()
    mockGet(null)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('collectLocal 稀疏偏差集：默认项不入对象，非默认项按节归位', () => {
    const s = useUserPrefsStore()
    store.set(SOUND_STORAGE_KEY, '0')
    store.set('notify-simple', '1')
    store.set(KEYMAP_OVERRIDES_STORAGE_KEY, JSON.stringify({ quickOpen: 'ctrl+alt+p' }))
    const collected = s.collectLocal()
    expect(collected).toEqual({
      keymap: { quickOpen: 'ctrl+alt+p' },
      notify: { sound: false, simple: true },
    })
    // 全默认（全新环境）时空对象：服务端无偏好且本机无偏差 → 不播种。
    // 重建 pinia 是必须的——collectLocal 读 store 态（镜像滞后于 store 是
    // 正确语义，直清 localStorage 不回流已激活 store）
    localStorage.clear()
    setActivePinia(createPinia())
    expect(useUserPrefsStore().collectLocal()).toEqual({})
  })

  it('pull：服务端真值 wins——键位/复制选中应用，缺省段回默认', async () => {
    mockGet({ keymap: { quickOpen: 'ctrl+alt+p' }, notify: { sound: false }, terminal: { copyOnSelect: false } })
    // 本机既有偏差：sound 关（远端同值）、键位另一覆盖（被远端整表替换）
    store.set(SOUND_STORAGE_KEY, '0')
    store.set(KEYMAP_OVERRIDES_STORAGE_KEY, JSON.stringify({ closeTab: 'ctrl+alt+x' }))
    const s = useUserPrefsStore()
    await s.pull()
    const keymap = useKeymapStore()
    expect(keymap.combos.quickOpen).toBe('ctrl+alt+p')
    expect(keymap.combos.closeTab).toBe('ctrl+w') // 远端无此覆盖 → 回默认
    expect(useSoundStore().enabled).toBe(false)
    expect(store.get(COPY_ON_SELECT_KEY)).toBe('0')
    // 应用经抑制窗口：不回写服务端（无回环）
    expect(settingsApi.update).not.toHaveBeenCalled()
  })

  it('opsAtoms 段（P-20261023-4）：关档项入云，远端真值 wins 整表替换', async () => {
    // 本机关两档 → collect 收稀疏偏差集（默认开不入云）
    const prefs = useOpsAtomPrefs()
    prefs.set('clipboard', false)
    prefs.set('open', false)
    expect(useUserPrefsStore().collectLocal().opsAtoms).toEqual({ clipboard: false, open: false })
    // 远端真值 wins：download 关（远端新档）+ clipboard 开（远端覆盖本机关档）；
    // open 远端缺键 = 回默认开（整表替换语义，与 sound 等布尔偏好一致）
    mockGet({ opsAtoms: { download: false, clipboard: true } })
    await useUserPrefsStore().pull()
    expect(prefs.enabled('download')).toBe(false)
    expect(prefs.enabled('clipboard')).toBe(true)
    expect(prefs.enabled('open')).toBe(true)
    // 全段缺省同理回默认开
    mockGet({ opsAtoms: {} })
    await useUserPrefsStore().pull()
    expect(prefs.enabled('download')).toBe(true)
  })

  it('pull：服务端无偏好且本机有旧值 → 播种上传；全默认不播种', async () => {
    // 全默认：不播种（此时各偏好 store 未激活、镜像为空）
    await useUserPrefsStore().pull()
    await vi.advanceTimersByTimeAsync(600)
    expect(settingsApi.update).not.toHaveBeenCalled()
    // 有旧值：播种上传——全新环境先播种后激活（store 激活即从镜像初始化，
    // 与生产「老浏览器首次连新服务端」时序一致；激活后再直改镜像不回流 store）
    setActivePinia(createPinia())
    store.set(KEYMAP_OVERRIDES_STORAGE_KEY, JSON.stringify({ closeTab: 'ctrl+alt+x' }))
    store.set(SOUND_STORAGE_KEY, '0')
    await useUserPrefsStore().pull()
    await vi.advanceTimersByTimeAsync(600)
    expect(settingsApi.update).toHaveBeenCalledWith({
      userPrefs: { keymap: { closeTab: 'ctrl+alt+x' }, notify: { sound: false } },
    }, { silent: true })
  })

  it('写路径脏标记 → 防抖合并上云（双写：镜像照旧 + PUT 真值）', async () => {
    const s = useUserPrefsStore()
    s.init()
    useSoundStore().set(false)
    useNotifySimpleStore().set(true)
    // 防抖窗口内不发
    await vi.advanceTimersByTimeAsync(200)
    expect(settingsApi.update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(settingsApi.update).toHaveBeenCalledTimes(1)
    expect(settingsApi.update).toHaveBeenCalledWith({
      userPrefs: { notify: { sound: false, simple: true } },
    }, { silent: true })
    // localStorage 镜像同步在写路径（读回/离线兜底依赖）
    expect(store.get(SOUND_STORAGE_KEY)).toBe('0')
    expect(store.get('notify-simple')).toBe('1')
  })

  it('推送在途时 pull 跳过应用（防把用户刚改的偏好回滚）', async () => {
    ;(settingsApi.update as unknown as { mockReturnValue: (v: unknown) => void })
      .mockReturnValue(new Promise(() => { /* 挂起模拟在途 */ }))
    const s = useUserPrefsStore()
    s.init()
    useSoundStore().set(false)
    await vi.advanceTimersByTimeAsync(600) // 推送起飞且挂起
    expect(s.collectLocal().notify?.sound).toBe(false)
    // 他端旧值到达：推送在途 → 跳过应用
    mockGet({ notify: { sound: true } })
    await s.pull()
    expect(useSoundStore().enabled).toBe(false)
  })

  it('推送在途期间的后续变更完成后补推（不丢最后一次改动）', async () => {
    let finishFirst: (v: unknown) => void = () => { /* 占位 */ }
    ;(settingsApi.update as unknown as { mockReturnValueOnce: (v: unknown) => void })
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve }))
    const s = useUserPrefsStore()
    s.init()
    useSoundStore().set(false)
    await vi.advanceTimersByTimeAsync(600) // 第一次推送起飞（挂起模拟慢网络）
    expect(settingsApi.update).toHaveBeenCalledTimes(1)
    // 在途期间改第二项：防抖窗口到点时进入排队而非被丢弃
    useNotifySimpleStore().set(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(settingsApi.update).toHaveBeenCalledTimes(1)
    // 首推完成 → 立即补推最新整表（含窗口内那次改动）
    finishFirst({})
    await vi.advanceTimersByTimeAsync(0)
    expect(settingsApi.update).toHaveBeenCalledTimes(2)
    expect(settingsApi.update).toHaveBeenLastCalledWith({
      userPrefs: { notify: { sound: false, simple: true } },
    }, { silent: true })
  })

  it('远端空对象 = 清空全部漫游偏好（整表替换语义）', async () => {
    store.set(KEYMAP_OVERRIDES_STORAGE_KEY, JSON.stringify({ closeTab: 'ctrl+alt+x' }))
    store.set(SOUND_STORAGE_KEY, '0')
    mockGet({})
    const s = useUserPrefsStore()
    await s.pull()
    expect(useKeymapStore().overrides).toEqual({})
    expect(useSoundStore().enabled).toBe(true)
    expect(store.get(SOUND_STORAGE_KEY)).toBeNull()
  })
})
