import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'
import { notifyUserPrefsDirty } from './userPrefsLink'

/**
 * frontend 动词族原子开关 store（P-20261023-4 安全边界第④层）：agent 经
 * ops-notify 触发的浏览器即时效应（下载框/剪贴板直写/开标签）按原子可关——
 * 三原子默认开（能力发现优先：关掉即 agent 交付链断裂，fail-open 与等待音效
 * 同向），关某原子 = 该效应不再发生（handler 门控跳过 + 每窗口至多一条「已
 * 关闭」提示，agent 侧可感知而非静默失联）。
 *
 * 持久化方式与 stores/sound.ts 同款：localStorage 镜像（读路径启动期同步可用
 * + 离线兜底，safeStorage 通道防隐私模式抛错）+ 服务端漫游双写（跟人走的
 * 管制偏好，notifyUserPrefsDirty → userPrefs 防抖上云，opsAtoms 段稀疏偏差集
 * ——只存 ≠ 出厂默认项，见 stores/userPrefs.ts collectLocal/applyRemote）。
 */

/** 原子 id（frontend.download/clipboard/open 的目标段，handler 按此寻档） */
export type FrontendAtomId = 'download' | 'clipboard' | 'open'

// 存储 key：关 = '0'，开/缺省 = 清键（默认开；未来若翻转默认值自动跟随，
// sound.ts 同款语义）
const ATOM_STORAGE_KEYS: Record<FrontendAtomId, string> = {
  download: 'ops-atom-download',
  clipboard: 'ops-atom-clipboard',
  open: 'ops-atom-open',
}

export const OPS_ATOM_IDS: readonly FrontendAtomId[] = ['download', 'clipboard', 'open']

export const useOpsAtomPrefs = defineStore('opsAtomPrefs', () => {
  const atoms = ref<Record<FrontendAtomId, boolean>>({ download: true, clipboard: true, open: true })

  function load() {
    for (const id of OPS_ATOM_IDS) {
      atoms.value[id] = safeStorage.getItem(ATOM_STORAGE_KEYS[id]) !== '0'
    }
  }

  function set(id: FrontendAtomId, v: boolean) {
    atoms.value[id] = v === true
    if (atoms.value[id]) safeStorage.removeItem(ATOM_STORAGE_KEYS[id])
    else safeStorage.setItem(ATOM_STORAGE_KEYS[id], '0')
    // 服务端漫游双写（P-20261007-1）：原子管制属「跟人走」的用户偏好
    notifyUserPrefsDirty()
  }

  function enabled(id: FrontendAtomId): boolean {
    return atoms.value[id] === true
  }

  load()

  return { atoms, load, set, enabled }
})
