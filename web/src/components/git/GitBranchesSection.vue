<script setup lang="ts">
import { computed, h, inject, ref, watch } from 'vue'
import { NButton, NDropdown, NIcon, NInput, NRadio, NRadioGroup, NSpin } from 'naive-ui'
import { ChevronDownOutline, ChevronForwardOutline, SearchOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useGitOpsStore } from '../../stores/gitOps'
import { branchApi, projectApi, remoteApi, tagApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { useBranchCheckout } from '../../composables/useBranchCheckout'
import { useGitPanelAutoRefresh } from '../../composables/useGitPanelAutoRefresh'
import { usePushPrToast } from '../../composables/usePushPrToast'
import { promptDialog } from '../../composables/useDialog'
import { useDialog, useMessage } from 'naive-ui'
import { copyText } from '../../utils/clipboard'
import { validateBranchName } from '../../utils/git'
import GitCreateBranchModal from './GitCreateBranchModal.vue'
import GitUpstreamModal from './GitUpstreamModal.vue'
import GitPushRefModal from './GitPushRefModal.vue'
import GitMergePreviewModal from './GitMergePreviewModal.vue'
import BranchLogPopover from './BranchLogPopover.vue'

/**
 * Git 侧栏分支/标签分节（从 GitPanel.vue 抽出）：
 * 本地分支/远程分组/标签列表 + 右键菜单（checkout/merge/rebase/push/上游/重命名/删除）
 * + 创建分支弹窗 + 设置上游弹窗。
 * 折叠状态（collapsedSections）由宿主持有并下传——Layout 的 uiState 恢复
 * 直接写入 GitPanel 暴露的同一份 Set；选中分支同理（宿主持有，回传 select）。
 */
const props = defineProps<{
  selectedBranch: string
  collapsedSections: Set<string>
  /** 远程仓库名列表（RemotesSection 变更后由宿主回传，上游弹窗下拉用） */
  remoteNames: string[]
}>()

const emit = defineEmits<{
  (e: 'select', name: string): void
  (e: 'toggleSection', key: string): void
  (e: 'current', info: { name: string; isDetached: boolean }): void
  (e: 'loading', v: boolean): void
  /** merge/rebase/push 等可能产生冲突或改变远端状态，宿主刷新冲突横幅 */
  (e: 'conflictActivity'): void
}>()

const message = useMessage()
// 分支右键推送成功回执（P-20261005-215）：首推新分支时 toast 附「创建 PR」外链
const prToast = usePushPrToast()
const dialog = useDialog()
const projectStore = useProjectStore()
const { t } = useI18n()
// push 成功后刷新全局 ahead/behind（与原 GitPanel 同一注入）
const fetchAllAheadBehind = inject<() => Promise<void>>('sharedFetchAllAheadBehind', async () => {})

interface Branch { name: string; current: boolean; isRemote: boolean; isMerged?: boolean; isDetached?: boolean; detachedCommit?: string }
interface TagItem { name: string }

const branches = ref<Branch[]>([])
const tags = ref<TagItem[]>([])
const loading = ref(false)
const showCreateBranchModal = ref(false)
const newBranchName = ref('')
const newBranchFromRef = ref('')
const showSetUpstreamModal = ref(false)
const upstreamBranch = ref('')
const upstreamRemote = ref('origin')
const upstreamRemoteBranch = ref('')
// 推送到远程弹窗（分支/标签通用；远程名可改）
const showPushRefModal = ref(false)
const pushRefRemote = ref('origin')
const pushRefRemoteName = ref('')
// 合并预演弹层（P-20261005-174）：入口可见性 = 列表顺带下发的本机 git 版本位
//（merge-tree 现代模式需 ≥2.38；旧服务端无此字段同样隐藏，端点不存在）
const mergePreviewSupported = ref(false)
const showMergePreview = ref(false)
const previewSource = ref('')
// 分支悬停浮窗的缓存纪元（P-20261003-274）：列表每次刷新递增，BranchLogPopover
// 据此失效已缓存预览——悬停摘要不滞留旧数据面
const refreshEpoch = ref(0)

function toggleSection(key: string) {
  emit('toggleSection', key)
}
function isCollapsed(key: string) { return props.collapsedSections.has(key) }

const localBranches = computed(() => branches.value.filter(b => !b.isRemote))
interface RemoteGroup { remote: string; branches: Array<Branch & { displayName: string }> }
// 远程分支分组：git 的远程分支名形如 "remotes/<remote>/<branch>"，分组键取
// remote 名（origin / upstream…），条目只显示去掉 "remotes/<remote>/" 前缀的
// 分支名——窄列表里前缀会占满宽度导致真正的分支名永远看不到；分组头已提供
// remote 上下文，条目 tooltip 保留全名。动作（检出/选中/对比）仍用全名
const remoteGroups = computed(() => {
  const groups: RemoteGroup[] = []
  const map = new Map<string, Array<Branch & { displayName: string }>>()
  for (const b of branches.value.filter(b => b.isRemote)) {
    let rest = b.name
    let remote = b.name
    const remotesPrefix = 'remotes/'
    if (rest.startsWith(remotesPrefix)) {
      rest = rest.slice(remotesPrefix.length)
      const slash = rest.indexOf('/')
      if (slash >= 0) {
        remote = rest.slice(0, slash)
        rest = rest.slice(slash + 1)
      } else {
        remote = rest
      }
    }
    if (!map.has(remote)) map.set(remote, [])
    map.get(remote)!.push({ ...b, displayName: rest })
  }
  for (const [remote, brs] of map) groups.push({ remote, branches: brs })
  return groups
})

// ============== 即时分支过滤（本地/远程/标签统一按子串匹配，不分大小写） ==============
// 过滤激活时忽略折叠状态直接展示命中项（用户搜分支就是为了检出，不再多点一次
// 展开）；空分节隐藏，全部未命中给引导提示
const branchFilter = ref('')
const isFiltering = computed(() => branchFilter.value.trim() !== '')
function hitBranch(target: string): boolean {
  const q = branchFilter.value.trim().toLowerCase()
  return !q || target.toLowerCase().includes(q)
}
const filteredLocalBranches = computed(() => localBranches.value.filter(b => hitBranch(b.name)))
const filteredRemoteGroups = computed(() =>
  remoteGroups.value
    .map(g => ({ remote: g.remote, branches: g.branches.filter(b => hitBranch(b.name)) }))
    .filter(g => g.branches.length > 0),
)
const filteredTags = computed(() => tags.value.filter(tg => hitBranch(tg.name)))
const noBranchMatch = computed(() =>
  isFiltering.value &&
  filteredLocalBranches.value.length === 0 &&
  filteredRemoteGroups.value.length === 0 &&
  filteredTags.value.length === 0,
)

async function fetchBranchesAndTags() {
  if (!projectStore.currentProjectId) return
  loading.value = true
  emit('loading', true)
  try {
    const [branchRes, tagRes]: [any, any] = await Promise.all([
      branchApi.list(projectStore.currentProjectId),
      projectApi.tags(projectStore.currentProjectId),
    ])
    branches.value = (branchRes.data || []).map((b: any) => ({
      name: b.name, current: b.isCurrent || false, isRemote: b.isRemote || false,
      isMerged: b.isMerged || false,
      isDetached: b.isDetached || false, detachedCommit: b.detachedCommit || '',
    }))
    tags.value = (tagRes.data || []).map((t: any) => ({ name: t.name }))
    mergePreviewSupported.value = branchRes?.mergePreviewSupported === true
    const current = branches.value.find(b => b.current)
    if (current && !props.selectedBranch) {
      emit('select', current.name)
    }
    if (current) {
      emit('current', { name: current.isDetached ? (current.detachedCommit || 'HEAD') : current.name, isDetached: !!current.isDetached })
    }
  } catch { /* 拦截器处理 */ }
  finally { loading.value = false; emit('loading', false); refreshEpoch.value++ }
}

function selectBranch(name: string) {
  emit('select', name)
}

/** 悬停预览的 git rev（P-20261003-274）：本地分支名与远程全名
 *  （remotes/<remote>/<branch>）git 均可直接作 rev 解析；分离头指针行的
 *  名字位是 "(HEAD)" 字面量不可作 rev，退回短 hash，无 hash 返回空串
 *  （BranchLogPopover 空 rev 不挂浮窗，slot 直出） */
function branchHoverRef(b: Branch): string {
  if (b.isDetached) return b.detachedCommit || ''
  return b.name
}

watch(() => projectStore.currentProjectId, () => void fetchBranchesAndTags(), { immediate: true })

// git 面板自动刷新（P-20261003-74）：终端跑 git 写类命令（branch/checkout/push…）
// 后去抖拉取，治「agent 改了分支用户切回看到旧列表」。本组件只挂监听复用既有
// fetch；检测与派发在 useTerminalSession（OSC 133 D 事件），与上方手动刷新链正交
useGitPanelAutoRefresh(() => fetchBranchesAndTags())

// confirmMergeToCurrent 一并暴露：合并确认弹层的组件级测试缝（弹层经
// naive-ui Provider teleport 到 body，从右键菜单驱动断言成本高）
defineExpose({ refresh: fetchBranchesAndTags, confirmMergeToCurrent })

// 右键菜单
const contextRef = ref('')
const contextIsTag = ref(false)
const contextX = ref(0)
const contextY = ref(0)
const showContext = ref(false)

function handleBranchContext(e: MouseEvent, name: string) {
  e.preventDefault()
  contextRef.value = name
  contextIsTag.value = false
  contextX.value = e.clientX
  contextY.value = e.clientY
  showContext.value = true
}

function handleTagContext(e: MouseEvent, name: string) {
  e.preventDefault()
  contextRef.value = name
  contextIsTag.value = true
  contextX.value = e.clientX
  contextY.value = e.clientY
  showContext.value = true
}

const contextOptions = computed(() => {
  const name = contextRef.value
  if (contextIsTag.value) {
    return [
      { label: t('git.ctxPushToRemote'), key: 'push-ref' },
      { label: t('git.ctxCopyName'), key: 'copy-name' },
      { label: t('git.ctxBranchFromTag'), key: 'branch-from' },
      { label: t('git.ctxDeleteTag'), key: 'delete-tag' },
    ]
  }
  const isCurrent = localBranches.value.some(b => b.name === name && b.current)
  // 重命名只对本地分支开放（远程跟踪引用不可本地改名）；当前分支也支持——
  // git branch -m 会同步更新 HEAD 符号引用
  const isLocal = localBranches.value.some(b => b.name === name)
  const opts: { label: string; key: string }[] = []
  if (!isCurrent) opts.push({ label: t('git.ctxCheckout'), key: 'checkout' })
  opts.push(
    { label: t('git.ctxBranchFrom'), key: 'branch-from' },
    { label: t('git.ctxMergeToCurrent'), key: 'merge' },
  )
  // 预演次钮（P-20261005-174）：「合并」既有入口旁的先看再合通道；本机 git
  // 版本位（列表顺带下发）不支持时整项隐藏
  if (mergePreviewSupported.value) opts.push({ label: t('git.ctxMergePreview'), key: 'merge-preview' })
  if (!isCurrent) opts.push({ label: t('git.ctxRebaseCurrentToHere'), key: 'rebase' })
  opts.push(
    { label: t('git.ctxPushToRemote'), key: 'push-ref' },
    { label: t('git.ctxCopyName'), key: 'copy-name' },
    { label: t('git.ctxSetUpstream'), key: 'set-upstream' },
  )
  if (isLocal) opts.push({ label: t('git.ctxRename'), key: 'rename' })
  opts.push({ label: t('common.delete'), key: 'delete' })
  return opts
})

// checkout 前脏工作区预警 + 检出链路（P-20261002-19/102）：与命令面板
// checkout:<name> 分发共用 useBranchCheckout（脏区 confirm 在此闭环），
// 检出成功后刷新本组件的分支/标签树
const { checkoutBranch } = useBranchCheckout()

// 当前分支名（合并方向重申与预演弹层的 base 标注共用）
const currentBranchName = computed(() => localBranches.value.find(b => b.current)?.name || 'HEAD')

// ============== 合并策略选择（P-20261007-18 squash merge） ==============
// 确认合并到当前分支（P-20261003-222 防误合护栏）：merge 直接改写当前分支、
// 误方向回退成本高，先弹确认重申合入方向「将 <source> 合入 <base>」——
// 与比较弹层方向标注同向。右键「合并」与预演弹层「直接去合并」共用此链，
// 确认语义不因入口不同而放水。
// P-20261007-18 增策略两选（默认合并保留源分支全部提交 / 压平合并
// --squash 单条汇总提交）与压平时的汇总消息输入（留空 = 服务端自动生成
// 「(源分支) N commits: 首末提交标题」）。自渲染按钮区沿
// confirmCommitGateFix 三选弹层先例：确认钮点击即关弹层再走请求，失败由
// 拦截器弹专属文案，冲突态经 conflictActivity 刷新横幅引导进冲突面板
const mergeStrategy = ref<'default' | 'squash'>('default')
const squashCommitMsg = ref('')

function confirmMergeToCurrent(source: string) {
  mergeStrategy.value = 'default'
  squashCommitMsg.value = ''
  const d = dialog.warning({
    title: t('git.mergeConfirmTitle'),
    content: () => h('div', { 'data-testid': 'merge-confirm-dialog', style: 'display:flex;flex-direction:column;gap:8px;padding-top:4px;' }, [
      h('div', {}, t('git.mergeConfirmContent', { source, base: currentBranchName.value })),
      h(NRadioGroup, {
        value: mergeStrategy.value,
        'onUpdate:value': (v: string) => { mergeStrategy.value = v as 'default' | 'squash' },
        size: 'small',
      }, () => [
        h(NRadio, { value: 'default', 'data-testid': 'merge-strategy-default' }, () => t('git.mergeStrategyDefault')),
        h(NRadio, { value: 'squash', 'data-testid': 'merge-strategy-squash' }, () => t('git.mergeStrategySquash')),
      ]),
      // 行内说明随选中策略切换：两种合并的差异一句话讲清
      h('div', { style: 'font-size:12px;color:var(--text-secondary);' },
        mergeStrategy.value === 'squash'
          ? t('git.mergeStrategySquashHint', { source })
          : t('git.mergeStrategyDefaultHint', { source })),
      // 汇总消息仅在压平合并时渲染（默认合并无提交消息语义）
      mergeStrategy.value === 'squash'
        ? h(NInput, {
            value: squashCommitMsg.value,
            'onUpdate:value': (v: string) => { squashCommitMsg.value = v },
            type: 'textarea',
            placeholder: t('git.mergeSquashMsgPlaceholder', { source }),
            size: 'small',
            'data-testid': 'merge-squash-msg',
          })
        : null,
    ]),
    action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;' }, [
      h(NButton, {
        size: 'small',
        'data-testid': 'merge-cancel',
        onClick: () => { d.destroy() },
      }, () => t('common.cancel')),
      h(NButton, {
        size: 'small',
        type: 'primary',
        'data-testid': 'merge-confirm',
        onClick: () => { d.destroy(); void performMerge(source) },
      }, () => t('git.mergeConfirmPositive')),
    ]),
  })
}

async function performMerge(source: string) {
  const squash = mergeStrategy.value === 'squash'
  try {
    await branchApi.merge(
      projectStore.currentProjectId,
      source,
      squash ? 'squash' : undefined,
      squash ? squashCommitMsg.value.trim() : undefined,
      { errorLabel: 'branch.mergeFailed' },
    )
    message.success(squash ? t('git.mergeSquashSuccess') : t('git.mergeSuccess'))
    fetchBranchesAndTags()
  }
  catch { /* 拦截器已弹专属文案 + 写 Console */ }
  // merge 失败最常见原因是冲突：成败都刷新冲突横幅，引导用户进入冲突面板
  emit('conflictActivity')
}

async function handleContextSelect(key: string) {
  showContext.value = false
  if (!projectStore.currentProjectId) return
  const name = contextRef.value
  switch (key) {
    case 'checkout':
      checkoutBranch(projectStore.currentProjectId!, name, () => fetchBranchesAndTags())
      break
    case 'merge':
      confirmMergeToCurrent(name)
      break
    case 'merge-preview':
      // 预演零副作用：直接开弹层，合并动作由弹层「直接去合并」回流确认链
      previewSource.value = name
      showMergePreview.value = true
      break
    case 'rebase':
      try { await branchApi.rebase(projectStore.currentProjectId, name, { errorLabel: 'branch.rebaseFailed' }); message.success(t('git.rebaseSuccess')); fetchBranchesAndTags() }
      catch { /* 拦截器已弹专属文案 + 写 Console */ }
      emit('conflictActivity')
      break
    case 'push-ref': {
      // 推送到远程（确认弹窗，远程名可改）：远程默认 origin 优先，其次首个远程
      pushRefRemote.value = props.remoteNames.includes('origin') ? 'origin'
        : (props.remoteNames[0] ?? 'origin')
      pushRefRemoteName.value = name
      showPushRefModal.value = true
      break
    }
    case 'copy-name': {
      const ok = await copyText(name)
      if (ok) message.success(t('common.copied'))
      else message.error(t('common.copyFailed'))
      break
    }
    case 'set-upstream': {
      upstreamBranch.value = name
      upstreamRemote.value = props.remoteNames.length > 0 ? props.remoteNames[0]! : 'origin'
      upstreamRemoteBranch.value = name
      showSetUpstreamModal.value = true
      break
    }
    case 'delete': {
      dialog.warning({
        title: t('git.deleteBranchTitle'),
        content: t('git.deleteBranchConfirm', { name: name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          try {
            await branchApi.delete(projectStore.currentProjectId!, name, false)
            message.success(t('git.branchDeleted', { name: name }))
            fetchBranchesAndTags()
          } catch (e: any) {
            dialog.error({
              title: t('git.deleteFailTitle'),
              content: t('git.forceDeleteConfirm', { message: e?.userMessage || e?.message || '' }),
              positiveText: t('git.branchForceDeleted'),
              negativeText: t('common.cancel'),
              onPositiveClick: async () => {
                try { await branchApi.delete(projectStore.currentProjectId!, name, true); message.success(t('git.branchForceDeleted')); fetchBranchesAndTags() }
                catch { /* 拦截器处理 */ }
              },
            })
          }
        },
      })
      break
    }
    case 'rename': {
      // 本地分支重命名（P-20261003-221）：git branch -m 相对「删除重建」的
      // 语义优势 = upstream 跟踪配置随分支迁移不丢；取消或未改名不打扰服务端
      const newName = await promptDialog({
        title: t('git.renameBranchTitle'),
        label: t('git.renameBranchLabel', { name }),
        defaultValue: name,
        placeholder: t('git.newBranchPlaceholder'),
        confirmText: t('common.rename'),
        validate: validateBranchName,
      })
      const trimmed = (newName || '').trim()
      if (!newName || trimmed === name) break
      try {
        await branchApi.rename(projectStore.currentProjectId, name, trimmed)
        message.success(t('git.branchRenamed', { old: name, name: trimmed }))
        // 选中位与被改名分支重合时随新名走（selectedBranch 宿主持有，回传 select）
        if (props.selectedBranch === name) emit('select', trimmed)
        fetchBranchesAndTags()
      } catch { /* 拦截器已弹专属文案 + 写 Console */ }
      break
    }
    case 'branch-from': {
      newBranchFromRef.value = name
      newBranchName.value = ''
      showCreateBranchModal.value = true
      break
    }
    case 'delete-tag':
      try { await tagApi.delete(projectStore.currentProjectId, name); message.success(t('git.tagDeleted', { name: name })); fetchBranchesAndTags() }
      catch { /* 拦截器处理 */ }
      break
  }
}

async function handleCreateBranch() {
  if (!projectStore.currentProjectId || !newBranchName.value) return
  try {
    await branchApi.create(projectStore.currentProjectId, newBranchName.value, true, newBranchFromRef.value)
    message.success(t('git.branchCreated', { name: newBranchName.value }))
    showCreateBranchModal.value = false
    fetchBranchesAndTags()
  } catch { /* 拦截器处理 */ }
}

// 获取指定 remote 下的远程分支列表（用于上游跟踪弹窗）
function getRemoteBranchesForUpstream(remote: string): string[] {
  const prefix = `remotes/${remote}/`
  return branches.value
    .filter(b => b.isRemote && b.name.startsWith(prefix))
    .map(b => b.name.slice(prefix.length))
}

async function handleSetUpstream() {
  if (!projectStore.currentProjectId || !upstreamBranch.value || !upstreamRemote.value || !upstreamRemoteBranch.value) return
  try {
    await branchApi.setUpstream(projectStore.currentProjectId, upstreamBranch.value, upstreamRemote.value, upstreamRemoteBranch.value)
    message.success(t('git.setUpstreamSuccess', { remoteBranch: upstreamRemoteBranch.value }))
    showSetUpstreamModal.value = false
    fetchBranchesAndTags()
  } catch { /* 拦截器处理 */ }
}

/** 推送到远程确认：分支 refspec local:remoteName；标签走 refs/tags 双前缀
 *  （`git push <remote> v1:newname` 对标签有歧义，必须显式 refs/tags/）。 */
async function handlePushRef() {
  const local = contextRef.value
  const remoteName = pushRefRemoteName.value.trim()
  if (!projectStore.currentProjectId || !local || !remoteName) return
  showPushRefModal.value = false
  const prefix = contextIsTag.value ? 'refs/tags/' : ''
  const localRef = prefix + local
  const remoteRef = prefix + remoteName
  const remoteBranch = remoteRef === localRef ? '' : remoteRef
  // 推送在飞记 gitOps store（P-20261005-211）：分支右键推送与快捷推送/顶栏推送
  // 同账可见——GitPanel 推送钮在此期间禁用，防慢仓 10s+ 内重复触发
  const gitOps = useGitOpsStore()
  const pid = projectStore.currentProjectId
  gitOps.begin(pid, 'push')
  try {
    // 拦截器解包后运行时值即响应体 { data, newBranch }（pull 回执 newCommits 同款 cast）
    const res = await remoteApi.push(projectStore.currentProjectId, pushRefRemote.value, localRef, undefined, undefined, undefined, undefined, remoteBranch, undefined, { errorLabel: 'push.fail' }) as unknown as { newBranch?: boolean } | undefined
    // 分支推送成功回执走 usePushPrToast（P-20261005-215）：首推新分支附「创建 PR」
    // 外链，明细文案保留（title 覆盖）；标签推送无 PR 语义，保持原文案零变化
    if (contextIsTag.value) {
      message.success(t('git.pushRefSuccess', { local, remote: pushRefRemote.value, name: remoteName }))
    } else {
      prToast.toastPushSuccess(res?.newBranch, { title: t('git.pushRefSuccess', { local, remote: pushRefRemote.value, name: remoteName }) })
    }
    fetchAllAheadBehind()
  } catch { /* 拦截器已弹专属文案 + 写 Console */ }
  finally { gitOps.end(pid, 'push') }
}
</script>

<template>
  <div
    v-if="loading"
    class="sidebar-loading"
  >
    <n-spin size="small" />
  </div>
  <div
    v-else
    class="branches-list"
  >
    <!-- 即时过滤：远程分支多时按子串定位目标分支（不分大小写，清空即恢复） -->
    <div class="branch-filter-row">
      <n-input
        v-model:value="branchFilter"
        size="tiny"
        clearable
        :placeholder="t('git.branchFilterPlaceholder')"
      >
        <template #prefix>
          <n-icon size="11">
            <SearchOutline />
          </n-icon>
        </template>
      </n-input>
    </div>

    <!-- 本地分支 -->
    <div
      v-if="!isFiltering || filteredLocalBranches.length > 0"
      class="branch-section"
    >
      <div
        class="section-header"
        @click="toggleSection('local')"
      >
        <n-icon size="12">
          <component :is="!isFiltering && isCollapsed('local') ? ChevronForwardOutline : ChevronDownOutline" />
        </n-icon>
        <span>{{ t('git.local') }}</span>
        <span class="section-count">{{ isFiltering ? filteredLocalBranches.length : localBranches.length }}</span>
      </div>
      <template v-if="isFiltering || !isCollapsed('local')">
        <!-- 行外包悬停提交预览浮窗（P-20261003-274）：hover 延迟弹该分支最近
             3 条提交，点击/右键链不经过浮窗（选中与切换语义保留） -->
        <branch-log-popover
          v-for="b in filteredLocalBranches"
          :key="b.name"
          :branch="branchHoverRef(b)"
          :epoch="refreshEpoch"
        >
          <div
            class="branch-item"
            :class="{ current: b.current, selected: selectedBranch === b.name }"
            :title="b.name"
            @click="selectBranch(b.name)"
            @contextmenu="handleBranchContext($event, b.name)"
          >
            <span
              v-if="b.current"
              class="branch-marker"
            >●</span>
            <span class="branch-name">{{ b.name }}</span>
            <!-- 已合并弱徽标（P-20261003-50）：仅本地非当前分支标（当前/未合并不标，
                 服务端 mergedBranchSet 已在数据源排除当前分支，这里守卫 isRemote 走不到）；
                 配套「清理已合并分支」向导见 GitBranchCleanupModal -->
            <span
              v-if="b.isMerged && !b.current"
              class="branch-merged-badge"
            >{{ t('git.branchCleanup.mergedBadge') }}</span>
          </div>
        </branch-log-popover>
      </template>
    </div>

    <!-- 本地分节之后的扩展位：宿主插入工作树等分节（语义上紧跟本地分支） -->
    <slot name="after-local" />

    <!-- 远程分支 -->
    <div
      v-for="group in filteredRemoteGroups"
      :key="group.remote"
      class="branch-section"
    >
      <div
        class="section-header"
        @click="toggleSection('remote-' + group.remote)"
      >
        <n-icon size="12">
          <component :is="!isFiltering && isCollapsed('remote-' + group.remote) ? ChevronForwardOutline : ChevronDownOutline" />
        </n-icon>
        <span>{{ group.remote }}</span>
        <span class="section-count">{{ group.branches.length }}</span>
      </div>
      <template v-if="isFiltering || !isCollapsed('remote-' + group.remote)">
        <!-- 远程行同款悬停预览：rev 传全名（remotes/<remote>/<branch>），git 直接可解析 -->
        <branch-log-popover
          v-for="b in group.branches"
          :key="b.name"
          :branch="branchHoverRef(b)"
          :epoch="refreshEpoch"
        >
          <div
            class="branch-item"
            :class="{ selected: selectedBranch === b.name }"
            :title="b.name"
            @click="selectBranch(b.name)"
            @contextmenu="handleBranchContext($event, b.name)"
          >
            <span class="branch-name remote">{{ b.displayName }}</span>
          </div>
        </branch-log-popover>
      </template>
    </div>

    <!-- 标签（空态保留分节入口，避免"无标签时分节凭空消失"） -->
    <div
      v-if="!isFiltering || filteredTags.length > 0"
      class="branch-section"
    >
      <div
        class="section-header"
        @click="toggleSection('tags')"
      >
        <n-icon size="12">
          <component :is="!isFiltering && isCollapsed('tags') ? ChevronForwardOutline : ChevronDownOutline" />
        </n-icon>
        <span>{{ t('git.tags') }}</span>
        <span class="section-count">{{ isFiltering ? filteredTags.length : tags.length }}</span>
      </div>
      <template v-if="isFiltering || !isCollapsed('tags')">
        <div
          v-if="!isFiltering && tags.length === 0"
          class="section-empty"
        >
          {{ t('git.noTags') }}
        </div>
        <div
          v-for="tg in filteredTags"
          :key="tg.name"
          class="branch-item tag-item"
          :class="{ selected: selectedBranch === tg.name }"
          @click="selectBranch(tg.name)"
          @contextmenu="handleTagContext($event, tg.name)"
        >
          <span class="tag-marker">🏷</span>
          <span class="branch-name">{{ tg.name }}</span>
        </div>
      </template>
    </div>

    <!-- 过滤无命中 -->
    <div
      v-if="noBranchMatch"
      class="branch-no-match"
    >
      {{ t('git.noBranchMatch') }}
    </div>
  </div>

  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="contextX"
    :y="contextY"
    :options="contextOptions"
    :show="showContext"
    @select="handleContextSelect"
    @clickoutside="showContext = false"
  />

  <!-- 创建分支 / 设置上游弹窗（纯 UI 组件） -->
  <GitCreateBranchModal
    :show="showCreateBranchModal"
    :branch-from-ref="newBranchFromRef"
    :new-branch-name="newBranchName"
    @update:new-branch-name="(v: string) => newBranchName = v"
    @close="showCreateBranchModal = false"
    @create="handleCreateBranch"
  />
  <GitUpstreamModal
    :show="showSetUpstreamModal"
    :upstream-branch="upstreamBranch"
    :upstream-remote="upstreamRemote"
    :upstream-remote-branch="upstreamRemoteBranch"
    :remote-names="remoteNames"
    :remote-branch-options="getRemoteBranchesForUpstream(upstreamRemote)"
    @update:upstream-remote="(v: string) => upstreamRemote = v"
    @update:upstream-remote-branch="(v: string) => upstreamRemoteBranch = v"
    @close="showSetUpstreamModal = false"
    @confirm="handleSetUpstream"
  />
  <GitPushRefModal
    :show="showPushRefModal"
    :local-name="contextRef"
    :is-tag="contextIsTag"
    :remote="pushRefRemote"
    :remote-name="pushRefRemoteName"
    :remote-names="remoteNames"
    @update:remote="(v: string) => pushRefRemote = v"
    @update:remote-name="(v: string) => pushRefRemoteName = v"
    @close="showPushRefModal = false"
    @confirm="handlePushRef"
  />
  <GitMergePreviewModal
    :show="showMergePreview"
    :project-id="projectStore.currentProjectId || ''"
    :source="previewSource"
    :base="currentBranchName"
    @update:show="showMergePreview = $event"
    @merge="confirmMergeToCurrent"
  />
</template>


<style scoped>
.sidebar-loading { padding: 24px; text-align: center; color: var(--text-muted); }
.branches-list { flex: 1; overflow-y: auto; }
/* 即时过滤输入行：粘性置顶，滚动长分支列表时搜索框不丢失 */
.branch-filter-row {
  padding: 6px var(--space-2);
  border-bottom: 1px solid color-mix(in srgb, var(--border-default) 20%, transparent);
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--bg-primary);
}
/* 可读性下限（P-20261019-3）：分区标题 12px/500 权重，元信息与行文本走
   --fs-meta-min。原先 0.82em 嵌套叠乘（标题内计数/按钮低至 8.5~9.6px）——
   改用 max(px 下限, em 期望值) 解嵌套收敛，层级交给字重与颜色 */
.branch-no-match { padding: 10px var(--space-2); font-size: max(var(--fs-meta-min, 11.5px), 0.82em); color: var(--text-muted); text-align: center; }
.branch-section { border-bottom: 1px solid color-mix(in srgb, var(--border-default) 20%, transparent); }
.section-header {
  padding: var(--space-1) var(--space-2); font-size: max(var(--fs-section-min, 12px), 0.92em); font-weight: var(--fw-medium); color: var(--text-secondary);
  background: var(--bg-panel); display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; user-select: none; line-height: var(--lh-meta, 1.45);
}
.section-header:hover { color: var(--text-primary); }
.section-count { margin-left: auto; font-size: max(var(--fs-meta-min, 11.5px), 0.8em); color: var(--text-muted); }
.section-empty { padding: var(--space-1) var(--space-2) 6px 20px; font-size: max(var(--fs-meta-min, 11.5px), 0.8em); color: var(--text-muted); }
.branch-item {
  padding: 2px var(--space-2) 2px 20px; display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; color: var(--text-primary); font-size: max(var(--fs-meta-min, 11.5px), 0.92em);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.branch-item:hover { background: var(--bg-hover); }
.branch-item.current { color: var(--accent-green); }
.branch-item.selected { background: var(--bg-active); }
.branch-marker { color: var(--accent-green); font-size: 0.7em; flex-shrink: 0; }
/* 已合并弱徽标：灰调弱存在感，不与当前分支的绿色 ● 抢视觉权重 */
.branch-merged-badge {
  margin-left: auto; flex-shrink: 0; padding: 0 var(--space-1);
  font-size: max(var(--fs-meta-min, 11.5px), 0.66em); line-height: var(--lh-meta, 1.45); border-radius: var(--radius-sm);
  color: var(--text-muted); border: 1px solid var(--border-default);
}
.branch-name { overflow: hidden; text-overflow: ellipsis; }
.branch-name.remote { color: var(--text-secondary); }
.tag-item { padding-left: 20px; }
.tag-marker { font-size: 0.75em; flex-shrink: 0; }

</style>
