import { computed, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { changelistApi, shelveApi } from '../api/client'
import type { Changelist } from '../api/domains/git'
import { confirmDialog } from './useDialog'
import type { PromptRadioGroup } from './useDialog'
/**
 * 变更面板「变更列表」分区逻辑（P-20261007-19，changelist 死代码激活）：
 * 清单拉取（按项目过滤）/ 新建·删除·切换活跃 / 文件移入 / 搁置本组（shelve）。
 *
 * 数据面是服务端 config 存储（changelist 条目带 projectId 归属项目，存量全局
 * 条目全项目可见——服务端 VisibleChangelists 过滤口径）；「只看活跃组」过滤
 * 开关是会话内显示态（与变更树其余过滤维度同「不持久化」口径），切项目归位。
 *
 * 搁置语义（JetBrains shelve）：组内文件的未提交变更整体入一条 stash 条目
 * （服务端 pathspec 限定，无关变更不碰），恢复走既有 stash pop 通道——搁置
 * 前圈定「组内文件 ∩ 当前变更集」，组内无变更时如实回告不发请求。
 */
export function useChangelists(options: {
  currentProjectId: () => string
  /** 当前变更集路径全集（shelve 前求交集：组内文件可能已提交/回滚，无变更的路径不必下发） */
  currentChangedPaths: () => string[]
  /** 搁置成功后刷新（变更状态 + stash 列表由面板组合回调） */
  onChanged: () => Promise<void> | void
  message: {
    success(m: string): void
    error(m: string): void
    info?(m: string): void
  }
  t: (k: string, params?: Record<string, unknown>) => string
  prompt: (o: {
    title: string
    label: string
    placeholder: string
    hint?: string
    radio?: PromptRadioGroup
    validate?: (v: string) => string | null
  }) => Promise<string | null>
}) {
  const { currentProjectId, currentChangedPaths, onChanged, message, t, prompt } = options

  const lists = ref<Changelist[]>([])
  const loading = ref(false)
  // 「只看活跃组」过滤开关（分组维度，与路径/归属/状态过滤 AND 叠加）；
  // 活跃组本身是服务端持久态，这个开关只是显示层 opt-in
  const filterByActive = ref(false)
  // 活跃组：优先项目归属条目，回落存量全局条目（升级兼容——老配置的全局
  // Default 可能 active=true，与项目活跃并存时项目侧优先才符合「当前在做」语义）
  const activeList = computed<Changelist | null>(
    () => lists.value.find((l) => l.active && l.projectId) || lists.value.find((l) => l.active) || null,
  )

  async function fetch() {
    const pid = currentProjectId()
    if (!pid) return
    loading.value = true
    try {
      const res = await changelistApi.list(pid)
      lists.value = (res.data || []) as Changelist[]
    } catch { lists.value = [] }
    finally { loading.value = false }
  }

  function bindProjectWatch(onLoaded?: () => void): void {
    watch(currentProjectId, (id) => {
      filterByActive.value = false // 活跃组随项目走，过滤开关不跨项目残留
      if (id) void fetch().then(() => onLoaded?.())
    })
  }

  async function createList(): Promise<void> {
    const pid = currentProjectId()
    if (!pid) return
    const name = await prompt({
      title: t('changes.changelist.newTitle'),
      label: t('changes.changelist.nameLabel'),
      placeholder: t('changes.changelist.namePlaceholder'),
      validate: (v) => (v.trim() === '' ? t('changes.changelist.nameRequired') : null),
    })
    if (name === null) return
    try {
      await changelistApi.create(name.trim(), pid)
      message.success(t('changes.changelist.created', { name: name.trim() }))
      await fetch()
    } catch { /* 拦截器处理（重名 409 经 KNOWN_ERROR_I18N 本地化） */ }
  }

  async function removeList(list: Changelist): Promise<void> {
    const pid = currentProjectId()
    if (!pid) return
    const ok = await confirmRemove(list)
    if (!ok) return
    try {
      await changelistApi.remove(list.name, pid)
      message.success(t('changes.changelist.deleted', { name: list.name }))
      // 删的是活跃组时关掉过滤开关：留着会让「下次设活跃」瞬间切换视图，
      // 用户却没重新选择过（开关的语义是「看我选的那组」）
      if (list.active) filterByActive.value = false
      await fetch()
    } catch { /* 拦截器处理 */ }
  }

  // 删除确认沿 confirmDialog 先例（回滚同款守卫）：误删代价低（分组视图可
  // 重建）但反馈仍明确
  async function confirmRemove(list: Changelist): Promise<boolean> {
    return confirmDialog({
      type: 'warning',
      title: t('changes.changelist.deleteTitle'),
      content: t('changes.changelist.deleteConfirm', { name: list.name }),
      confirmText: t('changes.changelist.deleteBtn'),
    })
  }

  async function setActive(list: Changelist): Promise<void> {
    const pid = currentProjectId()
    if (!pid) return
    try {
      await changelistApi.setActive(list.name, pid)
      await fetch()
    } catch { /* 拦截器处理 */ }
  }

  async function moveFileTo(file: string, list: Changelist): Promise<void> {
    const pid = currentProjectId()
    if (!pid) return
    try {
      await changelistApi.moveFile(list.name, file, pid)
      message.success(t('changes.changelist.moved', { name: list.name }))
      await fetch()
    } catch { /* 拦截器处理 */ }
  }

  // 搁置本组：组内文件 ∩ 当前变更集（无变更的路径不下发——git 对全无变更的
  // pathspec 是 no-op，混入只会让「搁置了什么」失真）；交集为空如实回告不发请求
  async function shelveList(list: Changelist): Promise<void> {
    const pid = currentProjectId()
    if (!pid) return
    const changed = new Set(currentChangedPaths())
    const files = list.files.filter((f) => changed.has(f))
    if (files.length === 0) {
      message.info?.(t('changes.changelist.shelveNothing'))
      return
    }
    const msg = await prompt({
      title: t('changes.changelist.shelveTitle', { name: list.name }),
      label: t('changes.changelist.shelveMsgLabel'),
      placeholder: t('changes.changelist.shelveMsgPlaceholder'),
      hint: t('changes.changelist.shelveHint', { n: files.length }),
    })
    if (msg === null) return
    try {
      const res = await shelveApi.shelve(pid, files, msg || undefined) as unknown as { created?: boolean }
      if (res?.created === false) {
        // 组内文件在请求间隙已无变更（竞态兜底，常态被上方交集拦下）
        message.info?.(t('changes.changelist.shelveNothing'))
      } else {
        message.success(t('changes.changelist.shelved', { n: files.length }))
      }
      await onChanged()
      await fetch()
    } catch { /* 拦截器处理 */ }
  }

  return {
    lists: lists as Ref<Changelist[]>,
    loading,
    filterByActive,
    activeList,
    fetch,
    bindProjectWatch,
    createList,
    removeList,
    setActive,
    moveFileTo,
    shelveList,
  }
}
