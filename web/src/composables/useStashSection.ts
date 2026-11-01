import { ref, watch } from 'vue'
import { stashApi } from '../api/client'
import type { StashRef } from '../api/client'
import type { PromptRadioGroup } from './useDialog'
import { validateBranchName } from '../utils/git'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'

/** stash 列表项（服务端 StashEntry 子集）：index 供展示/回退，hash 是稳定引用
 * （P-20261003-264：多标签页并发 drop/pop 后 index 会移位，操作优先按 hash） */
export interface StashItem {
  index: number
  message: string
  hash?: string
}

/**
 * CommitPanel 的 stash 区块逻辑（列表/创建/pop/drop/应用到新分支），自 CommitPanel.vue 抽出。
 * deps.currentProjectId 变化时自动重拉。
 */
export function useStashSection(options: {
  currentProjectId: () => string
  onChanged: () => Promise<void> | void
  message: { success(m: string): void }
  // params 传插值（vue-i18n t 具名参数形态）：stashAppliedBranch 的 {name} 等用
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
  const { currentProjectId, onChanged, message, t, prompt } = options

  const stashes = ref<StashItem[]>([])
  const stashLoading = ref(false)
  // 仅已暂存（--staged）能力位：list 响应顺带下发（GET /stashes 的 stagedSupported，
  // 服务端 git 2.35+ 探测）。严格 === true：旧服务端不带该字段时必须禁用而非放行
  //——旧服务端会静默忽略 scope 落成全量 stash，与弹窗宣称的范围语义相反
  const stashStagedSupported = ref(false)
  // 创建弹窗的范围三态（all/staged/unstaged），handleStashCreate 打开时归位
  const stashScope = ref<string>('all')

  async function fetchStashes() {
    if (!currentProjectId()) return
    stashLoading.value = true
    try {
      const res: any = await stashApi.list(currentProjectId())
      stashes.value = (res.data || []).map((s: any, i: number) => ({
        index: s.index ?? i,
        message: s.message || `stash@{${i}}`,
        // 旧服务端无 hash 字段 → undefined，操作链走 index 回退（渐进兼容）
        hash: typeof s.hash === 'string' && s.hash ? s.hash : undefined,
      }))
      stashStagedSupported.value = res.stagedSupported === true
    } catch { stashes.value = [] }
    finally { stashLoading.value = false }
  }

  async function handleStashCreate() {
    if (!currentProjectId()) return
    stashScope.value = 'all' // 每次打开回默认：上次的范围选择不残留
    const msg = await prompt({
      title: t('commitPanel.createStash'),
      label: t('commitPanel.stashMsgPrompt'),
      placeholder: t('commitPanel.stashMsgPlaceholder'),
      radio: {
        value: stashScope,
        options: [
          { label: t('commitPanel.stashScopeAll'), value: 'all' },
          // 版本不足禁用 + 注记（P-20261003-119 降级语义）：选项可见但不可选
          { label: t('commitPanel.stashScopeStaged'), value: 'staged', disabled: !stashStagedSupported.value },
          { label: t('commitPanel.stashScopeUnstaged'), value: 'unstaged' },
        ],
        hint: stashStagedSupported.value ? undefined : t('commitPanel.stashScopeStagedUnsupported'),
      },
    })
    if (msg === null) return
    try {
      // all 不下发（缺省即全量，与服务端缺省语义对齐，payload 保持旧形态）
      await stashApi.create(
        currentProjectId(),
        msg || undefined,
        undefined,
        stashScope.value === 'all' ? undefined : (stashScope.value as 'staged' | 'unstaged'),
      )
      message.success(t('commitPanel.stashCreated'))
      await onChanged()
      await fetchStashes()
    } catch { /* 拦截器处理 */ }
  }

  // stash 操作按列表项寻址（P-20261003-264）：有 hash 时服务端按 hash 稳定
  // 定位，index 仅作旧服务端回退——多标签页在「列表刷新 → 点击」窗口内
  // drop/pop 不会把操作落到移位后的相邻条目
  function stashRef(item: StashItem): StashRef {
    return { index: item.index, hash: item.hash }
  }

  async function handleStashPop(item: StashItem) {
    if (!currentProjectId()) return
    try {
      await stashApi.pop(currentProjectId(), stashRef(item))
      message.success(t('commitPanel.stashPopped'))
      await onChanged()
      await fetchStashes()
    } catch { /* 拦截器处理 */ }
  }

  async function handleStashDrop(item: StashItem) {
    if (!currentProjectId()) return
    try {
      await stashApi.drop(currentProjectId(), stashRef(item))
      message.success(t('commitPanel.stashDropped'))
      await fetchStashes()
    } catch { /* 拦截器处理 */ }
  }

  // 应用到新分支（P-20261003-263 实验性应用）：「先开个分支试试这个 stash」——
  // git stash branch 原子链（checkout -b 基于 stash 原基线 + apply），成功后新
  // 分支被检出、stash 条目按 git 语义移除（内容落在新分支工作区），原分支不被
  // 污染。分支名前端先行校验（validateBranchName，P-221 同源镜像），冲突以服务
  // 端裁决为准（稳定原文经 KNOWN_ERROR_I18N 本地化）；确认前静态 hint 交代
  // 「检出 + 条目移除」后果，避免 git 语义 surprise
  async function handleStashApplyToBranch(item: StashItem) {
    if (!currentProjectId()) return
    const name = await prompt({
      title: t('commitPanel.stashApplyBranchTitle'),
      label: t('commitPanel.stashBranchNameLabel'),
      placeholder: t('commitPanel.stashBranchNamePlaceholder'),
      hint: t('commitPanel.stashApplyBranchHint'),
      validate: validateBranchName,
    })
    if (name === null) return
    const branch = name.trim()
    try {
      await stashApi.applyToBranch(currentProjectId(), stashRef(item), branch)
      message.success(t('commitPanel.stashAppliedBranch', { name: branch }))
      await onChanged()
      await fetchStashes()
      // 分支已切换：文件树/打开中的编辑器随检出重读（useBranchCheckout 同款广播）
      window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
    } catch { /* 拦截器处理 */ }
  }

  function bindProjectWatch(): void {
    watch(currentProjectId, (id) => {
      if (id) {
        onChanged()
        fetchStashes()
      }
    })
  }

  return { stashes, stashLoading, stashStagedSupported, fetchStashes, handleStashCreate, handleStashPop, handleStashDrop, handleStashApplyToBranch, bindProjectWatch }
}
