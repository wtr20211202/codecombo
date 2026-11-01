<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed, h } from 'vue'
import { useVirtualList } from '@vueuse/core'
import { NButton, NDatePicker, NIcon, NInput, NSkeleton, NSpin, NDropdown, NPopover, NSelect, useMessage } from 'naive-ui'
import { CopyOutline, SearchOutline, GitBranchOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { logApi, advancedApi, branchApi, tagApi, compareApi, commitApi, worktreeApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { useCommitCompare } from '../../composables/useCommitCompare'
import { useCommitFilters } from '../../composables/useCommitFilters'
import { useCommitDiffTree } from '../../composables/useCommitDiffTree'
import { useCommitPopover, type Commit } from '../../composables/useCommitPopover'
import { getStatusColor, getStatusLabel, formatDate, formatDateTime } from '../../utils/git'
import { copyText } from '../../utils/clipboard'
import { histWorktreeSiblingPath, normalizeWorktreePathKey } from '../../utils/histWorktree'
import { usePanelLayout } from '../../composables/usePanelLayout'
import type { DiffFile } from '../../utils/diffTree'
import BranchGraph from '../../components/git/BranchGraph.vue'
import CommitDiffFiles from '../../components/git/CommitDiffFiles.vue'
import RebaseEditorModal from '../../components/git/RebaseEditorModal.vue'
import NewSessionDialog from '../../components/agent/NewSessionDialog.vue'
import { useBranchSelection } from '../../composables/useBranchSelection'
import { useCommitLocate } from '../../composables/useCommitLocate'
import { confirmDialog, promptDialog } from '../../composables/useDialog'
import { OPS_FILES_EXTERNAL_CHANGE, OPS_WORKTREES_CHANGED } from '../../utils/opsEvents'
const emit = defineEmits<{
  (e: 'open-diff', file: { path: string; name: string; oldRef: string; newRef: string }): void
}>()

const props = defineProps<{
  selectedBranch?: string
}>()

const message = useMessage()
const projectStore = useProjectStore()
const { t } = useI18n()

const commits = ref<Commit[]>([])
const loading = ref(false)
const searchQuery = ref('')
// 空仓引导（P-20261003-300）：fetchLog 响应的 emptyRepo 标志——git init 后
// 零提交的正常状态，服务端 IsNoCommitsError 判定，渲染引导空态而非错误
const emptyRepo = ref(false)
const selectedHashes = ref<Set<string>>(new Set())
// 展开查看完整提交信息的 commit hash 集合
const expandedCommits = ref<Set<string>>(new Set())

function hasBody(commit: Commit): boolean {
  // body 存在且与首行 subject 不完全相同（即存在多行内容）
  return !!commit.body && commit.body.trim().length > 0 && commit.body.includes('\n')
}

function toggleExpand(hash: string) {
  if (expandedCommits.value.has(hash)) expandedCommits.value.delete(hash)
  else expandedCommits.value.add(hash)
}

// 提交悬浮层状态与交互抽至 useCommitPopover（悬停延迟/移入保持/复制）
const popover = useCommitPopover({ onCopied: () => message.success(t('commits.msgCopied')) })
const { popCommit, popX, popY, openCommitPop, schedulePopHide, cancelPopHide, copyFullMessage } = popover

// 分支/tag 选择逻辑抽至 useBranchSelection（下拉选项构建 + 外部选中联动）
const { branchOptions, internalBranch, branchLoading, fetchBranchesAndTags, handleBranchChange } = useBranchSelection({
  currentProjectId: () => projectStore.currentProjectId || '',
  fetchLog,
  selectedBranch: () => props.selectedBranch || '',
})

// Diff 文件树（拉取/合并去重/目录树构建展平）抽至 useCommitDiffTree
const diffTreeApi = useCommitDiffTree({
  projectId: () => projectStore.currentProjectId || '',
  selectedHashes,
})
const { diffFiles, diffLoading, flatDiffTree, expandedDiffDirs, toggleDiffDir, loadForHashes } = diffTreeApi
// 每页条数与分页状态：skip 递增滚动加载，避免 limit:100 静默截断大仓库历史
const PAGE_SIZE = 100
const hasMore = ref(false)
const loadingMore = ref(false)

// 查询过滤（自 LogView 迁移）抽至 useCommitFilters：作者/时间范围/目录历史
const commitFilters = useCommitFilters({
  projectId: () => projectStore.currentProjectId || '',
  loading,
  onCommits: (rows) => {
    commits.value = rows.map(mapCommitRow)
    hasMore.value = false
  },
  refresh: fetchLog,
})
const { authorFilter, dateRange, dirPath, dirActive, filterParams, searchDirLog, clearDirLog } = commitFilters
// 是否有生效中的过滤条件（区分「无提交」与「无匹配提交」空态文案）
const hasFilterActive = computed(() =>
  !!authorFilter.value.trim() || !!dateRange.value || !!searchQuery.value.trim())

// 空仓引导 CTA：切侧栏到变更面板创建第一个提交。无条件打开语义（区别于
// 活动栏 changes 按钮的 toggle——已开再点会关），最大化面板覆盖侧栏时先
// 还原（usePanelLayout「点啥显示啥」通用前置）
const { sideView, showSidePanel, bottomPanelMaximized, terminalMaximized, restoreFromMaximized } = usePanelLayout()
function goToChangesPanel() {
  if (bottomPanelMaximized.value || terminalMaximized.value) restoreFromMaximized()
  sideView.value = 'changes'
  showSidePanel.value = true
}

function mapCommitRow(c: any) {
  return {
    hash: c.hash || c.sha,
    shortHash: (c.hash || c.sha).substring(0, 8),
    message: c.message?.split('\n')[0] || '',
    body: c.body || '',
    author: c.author || '',
    email: c.email || '',
    date: c.date || c.authorDate || '',
    refs: Array.isArray(c.refs) ? c.refs : [],
    parents: Array.isArray(c.parents) ? c.parents : [],
  }
}

// 提交拓扑图（BranchGraph）：行高必须与 .commit-item 固行高一致才能对齐
const GRAPH_ROW_H = 40

// 提交列表虚拟滚动（P1-11）：万级提交仓库 loadMore 追加后 v-for 全量渲染
// 会拖垮每次追加/过滤的 DOM 重建；行高恒定 40px 适合窗口化。
// 拓扑图 SVG（上限 600 行）移入画布绝对定位层，窗口行经 wrapperProps 平移对齐
const { list: visibleCommits, containerProps: baseContainerProps, wrapperProps: listWrapperProps, scrollTo: scrollListTo } =
  useVirtualList(commits, { itemHeight: GRAPH_ROW_H, overscan: 10 })

// vueuse 的 onScroll（从容器 ref 自读 scrollTop，0 参）与无限加载的
// onListScroll（需要事件对象）合并；v-bind 后跟 @scroll 会覆盖前者
const listContainerProps = computed(() => ({
  ref: baseContainerProps.ref,
  onScroll: (e: Event) => {
    baseContainerProps.onScroll()
    onListScroll(e)
  },
}))

const totalListHeight = computed(() =>
  commits.value.length * GRAPH_ROW_H + (hasMore.value ? 40 : 0))

// fetchLog 请求序号守卫：作者过滤等慢查询（--author 需全仓库扫描）与快速
// 清空重查并发时，慢响应晚到会把新结果覆盖回旧值（症状：清空过滤后列表
// 恒为 0 条）。序号不符的响应一律丢弃
let fetchLogSeq = 0

async function fetchLog() {
  const seq = ++fetchLogSeq
  if (!projectStore.currentProjectId) return
  loading.value = true
  try {
    const params: any = { limit: PAGE_SIZE, skip: 0, ...filterParams() }
    if (internalBranch.value) params.branch = internalBranch.value
    const res: any = await logApi.getLog(projectStore.currentProjectId, params)
    if (seq !== fetchLogSeq) return // 迟到的响应：已有更新的查询，丢弃
    commits.value = (res.data || []).map(mapCommitRow)
    emptyRepo.value = !!res.emptyRepo
    hasMore.value = commits.value.length >= PAGE_SIZE
  } catch { /* 拦截器处理 */ }
  finally { loading.value = false }
}

/** 滚动到底追加下一页；不足一页说明已到尽头，停止加载 */
async function loadMore() {
  if (!projectStore.currentProjectId || loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const params: any = { limit: PAGE_SIZE, skip: commits.value.length, ...filterParams() }
    if (internalBranch.value) params.branch = internalBranch.value
    const res: any = await logApi.getLog(projectStore.currentProjectId, params)
    commits.value = commits.value.concat((res.data || []).map(mapCommitRow))
    hasMore.value = commits.value.length >= PAGE_SIZE && (res.data || []).length >= PAGE_SIZE
  } catch { /* 拦截器处理 */ }
  finally { loadingMore.value = false }
}

/** 列表滚动到底（距底 60px 内）自动加载下一页 */
function onListScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) void loadMore()
}

async function searchCommits() {
  if (!projectStore.currentProjectId) return
  if (!searchQuery.value.trim()) { fetchLog(); return }
  loading.value = true
  try {
    const res: any = await logApi.search(projectStore.currentProjectId, searchQuery.value)
    // 搜索接口（--grep 全分支）不支持作者/时间参数，按当前过滤条件本地二次过滤
    const fp = filterParams()
    let rows = (res.data || [])
    if (fp.author) rows = rows.filter((c: any) => (c.author || '').toLowerCase().includes(String(fp.author).toLowerCase()))
    if (fp.since) rows = rows.filter((c: any) => new Date(c.date) >= new Date(String(fp.since)))
    if (fp.until) rows = rows.filter((c: any) => new Date(c.date) <= new Date(`${String(fp.until)}T23:59:59`))
    commits.value = rows.map(mapCommitRow)
  } catch { /* 拦截器处理 */ }
  finally { loading.value = false }
}

// ============== 提交定位（blame 点击提交 id → 滚动选中） ==============
// 意图经 useCommitLocate 模块级单例跨组件传递：请求方开面板，本组件挂载/
// 列表就绪后消费。面板打开时本组件可能尚未挂载或列表仍在途——hold 本地
// 暂存，watch([loading, commits]) 在数据就绪后重试
const { pendingHash: pendingLocateHash, consumeCommitLocate } = useCommitLocate()
const locateHold = ref('')
const locateFlashHash = ref('')
let locateFlashTimer: ReturnType<typeof setTimeout> | null = null

function queueLocate(frag: string) {
  locateHold.value = frag
  void tryApplyLocate()
}
watch(pendingLocateHash, (v) => { if (v) queueLocate(consumeCommitLocate()) })
watch([loading, commits], () => { if (locateHold.value) void tryApplyLocate() })

async function tryApplyLocate() {
  const frag = locateHold.value
  if (!frag || loading.value || commits.value.length === 0 || !projectStore.currentProjectId) return
  locateHold.value = ''
  let idx = commits.value.findIndex(c => c.hash.toLowerCase().startsWith(frag))
  if (idx < 0) {
    // 已加载页没有（目标提交较旧）：按 hash 片段搜索加载后再定位。
    // 同步搜索框显示当前列表语义（列表整体被搜索结果替换）
    try {
      searchQuery.value = frag
      const res: any = await logApi.search(projectStore.currentProjectId, frag)
      commits.value = (res.data || []).map(mapCommitRow)
      hasMore.value = false
      idx = commits.value.findIndex(c => c.hash.toLowerCase().startsWith(frag))
    } catch { /* 拦截器处理 */ }
  }
  const hit = idx >= 0 ? commits.value[idx] : null
  if (!hit) return
  selectedHashes.value.clear()
  selectedHashes.value.add(hit.hash)
  await loadForHashes()
  scrollListTo(idx)
  locateFlashHash.value = hit.hash
  if (locateFlashTimer) clearTimeout(locateFlashTimer)
  locateFlashTimer = setTimeout(() => { locateFlashHash.value = '' }, 2500)
}

async function toggleSelect(hash: string, e: MouseEvent) {
  if (e.ctrlKey || e.metaKey) {
    if (selectedHashes.value.has(hash)) selectedHashes.value.delete(hash)
    else selectedHashes.value.add(hash)
  } else {
    selectedHashes.value.clear()
    selectedHashes.value.add(hash)
  }
  await loadForHashes()
}

// 选中集的 diff 区间端点（列表序 = 时间序从新到旧）：单选时二者同值。
// 一次遍历同时取首末命中
const selectedRangeHashes = computed(() => {
  let newest = '', oldest = ''
  for (const c of commits.value) {
    if (selectedHashes.value.has(c.hash)) {
      if (!newest) newest = c.hash
      oldest = c.hash
    }
  }
  return { newest, oldest }
})
const selectedOldestHash = computed(() => selectedRangeHashes.value.oldest)
const selectedNewestHash = computed(() => selectedRangeHashes.value.newest)

// 右键菜单
const contextHash = ref('')
const contextX = ref(0)
const contextY = ref(0)
const showContext = ref(false)

function handleContextMenu(e: MouseEvent, hash: string) {
  e.preventDefault()
  contextHash.value = hash
  contextX.value = e.clientX
  contextY.value = e.clientY
  showContext.value = true
}

const contextOptions = computed(() => [
  { label: t('commits.ctxReword'), key: 'reword' },
  { label: t('commits.ctxRebaseFrom'), key: 'rebase-edit' },
  { label: t('commits.ctxCherryPick'), key: 'cherry-pick' },
  { label: t('commits.ctxRevert'), key: 'revert' },
  { label: t('commits.ctxBranchFrom'), key: 'branch' },
  { label: t('commits.ctxTag'), key: 'tag' },
  { label: t('commits.ctxCompareWithHead'), key: 'compare' },
  { label: t('commits.ctxHistWorktree'), key: 'hist-worktree' },
  { label: t('commits.ctxCopyHash'), key: 'copy-hash' },
  { label: t('commits.ctxCopyMsg'), key: 'copy-msg' },
  { label: t('commits.ctxReset'), key: 'reset' },
])

// 交互式 rebase 编辑器（「整理自此提交起」）：组件暴露 open(commit)，区间与
// 基准由服务端换算（该提交的父；根提交自动落全历史区间）
const rebaseEditorRef = ref<InstanceType<typeof RebaseEditorModal> | null>(null)

function openRebaseEditor() {
  const target = commits.value.find(c => c.hash === contextHash.value)
  if (!target) return
  // 合并提交在区间内会被服务端拒绝（普通 rebase 丢 merge 结构），入口就地拦截
  if (target.parents.length > 1) {
    message.warning(t('commits.rebaseMergeUnsupported'))
    return
  }
  void rebaseEditorRef.value?.open(target.hash)
}

// ============== 历史检视 worktree（P-20261005-179） ==============
// 「在提交 X 的代码态跑一下」的零风险第三条路（detached checkout / reset 之外）：
// worktree add <path> <hash> 经既有 POST /worktrees ref 通道透传（裸 hash git
// 原生接受），在仓库兄弟目录惯例位开出 HEAD 分离、不建分支的定点工作区——
// 主检出/分支零扰动，与分支检出共用的脏区预警链不触发。成功 toast 带「在新
// 终端打开」（该目录起会话跑代码/测试，检视的下一动作）；管理区经
// OPS_WORKTREES_CHANGED 即时刷新出可清理条目（用完即删走既有删除链）
const histWorktreeBusy = ref(false)
const showHistAgentDialog = ref(false)
const histAgentDialogDir = ref('')

async function createHistWorktree() {
  const pid = projectStore.currentProjectId
  const projPath = projectStore.currentProject?.path
  const target = commits.value.find(c => c.hash === contextHash.value)
  if (!pid || !projPath || !target || histWorktreeBusy.value) return
  const wtPath = histWorktreeSiblingPath(projPath, target.shortHash)
  histWorktreeBusy.value = true
  try {
    // 残留复用：同名 worktree 已登记（上次检视未删）→ 不重复创建直接复用——
    // git 对已占用路径的报错文案对「复用」语义是误导；列表拉取失败不阻断
    // 创建（重复路径由 git 层报错兜底）
    let reused = false
    try {
      const list = await worktreeApi.list(pid) as unknown as { data?: { path?: string }[] }
      reused = (list?.data || [])
        .some(w => normalizeWorktreePathKey(w.path || '') === normalizeWorktreePathKey(wtPath))
    } catch { /* 尽力而为预检 */ }
    if (!reused) {
      await worktreeApi.add(pid, { path: wtPath, ref: contextHash.value })
      window.dispatchEvent(new CustomEvent(OPS_WORKTREES_CHANGED))
    }
    message.success(() => h('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
      h('span', null, reused ? t('commits.histWorktreeReused') : t('commits.histWorktreeCreated', { path: wtPath })),
      h(NButton, {
        size: 'tiny',
        type: 'primary',
        secondary: true,
        style: 'flex-shrink:0',
        onClick: () => {
          histAgentDialogDir.value = wtPath
          showHistAgentDialog.value = true
        },
      }, () => t('commits.histWorktreeOpenTerminal')),
    ]), {
      duration: 8000,
      closable: true,
      // 内容传函数（ContentType 的 VNodeChild 形态）而非 options.render——后者
      // 会整体替换 .n-message 容器只剩 wrapper，success 配色/图标/关闭钮全丢；
      // 内联样式因 message 挂 body 传送门，scoped 样式不可达
    })
  } catch { /* 拦截器处理 */ }
  finally { histWorktreeBusy.value = false }
}

// 与 HEAD 对比状态抽至 useCommitCompare（文件列表 + 选中文件 diff 跳转）
const compareApi2 = {
  listFiles: (pid: string, hash: string) => compareApi.listFiles(pid, hash, 'HEAD'),
};
const compare = useCommitCompare(() => projectStore.currentProjectId || '', () => contextHash.value, compareApi2.listFiles)
const { compareBaseHash, compareFiles, compareLoading } = compare
function handleCompareWithHead() { compare.open() }
function handleCompareFileClick(file: DiffFile) {
  emit('open-diff', { path: file.path, name: file.name || file.path.split('/').pop() || file.path, oldRef: compareBaseHash.value, newRef: 'HEAD' })
}
function closeCompare() { compare.close() }
async function handleContextSelect(key: string) {
  showContext.value = false
  if (!projectStore.currentProjectId) return
  switch (key) {
    case 'cherry-pick':
      try { await advancedApi.cherryPick(projectStore.currentProjectId, contextHash.value); message.success(t('commits.cherryPickSuccess')); fetchLog(); window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE)) }
      catch { /* 拦截器处理 */ }
      break
    case 'revert':
      try { await advancedApi.revert(projectStore.currentProjectId, contextHash.value); message.success(t('commits.revertSuccess')); fetchLog(); window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE)) }
      catch { /* 拦截器处理 */ }
      break
    case 'branch': {
      const name = await promptDialog({
        title: t('commits.ctxBranchFrom'),
        label: t('commits.newBranchPrompt'),
        placeholder: t('branchesPanel.branchNamePlaceholder'),
      })
      if (name) { try { await branchApi.create(projectStore.currentProjectId, name); message.success(t('commits.branchCreated', { name: name })) } catch { /* 拦截器处理 */ } }
      break
    }
    case 'tag': {
      const tagName = await promptDialog({
        title: t('commits.ctxTag'),
        label: t('commits.tagNamePrompt'),
      })
      if (tagName) {
        try {
await tagApi.create(projectStore.currentProjectId, { name: tagName, commit: contextHash.value })
          message.success(t('commits.tagCreated', { name: tagName }))
        } catch { /* 拦截器处理 */ }
      }
      break
    }
    case 'compare':
      handleCompareWithHead()
      break
    case 'hist-worktree':
      void createHistWorktree()
      break
    case 'copy-hash':
      copyText(contextHash.value).then(ok => {
        if (ok) message.success(t('commits.hashCopied'))
        else message.error(t('common.copyFailed'))
      })
      break
    case 'copy-msg': {
      const c = commits.value.find(c => c.hash === contextHash.value)
      if (c) {
        copyText(c.message).then(ok => {
          if (ok) message.success(t('commits.msgCopied'))
          else message.error(t('common.copyFailed'))
        })
      }
      break
    }
    case 'reword': {
      // 修改提交信息：未推送（HEAD=amend，更早=rebase reword）直接改；
      // 已推送（存在于远程分支）= 重写公开历史，强警告列出受影响分支 +
      // 明确需要 force-with-lease 推送，用户显式确认后才携带 confirmPushed 重试
      const target = commits.value.find(c => c.hash === contextHash.value)
      const newMsg = await promptDialog({
        title: t('commits.rewordTitle'),
        label: t('commits.rewordPrompt'),
        defaultValue: target?.message || '',
        validate: (v) => (v.trim() ? null : t('commits.rewordEmpty')),
      })
      if (!newMsg || !projectStore.currentProjectId) break
      if (newMsg.trim() === target?.message?.trim()) break
      try {
        const pushedRes: any = await commitApi.getCommitPushed(projectStore.currentProjectId, contextHash.value)
        let confirmPushed = false
        if (pushedRes?.data?.pushed) {
          const branches = (pushedRes.data.remoteBranches || []).join('、')
          const confirmed = await confirmDialog({
            type: 'warning',
            title: t('commits.rewordPushedTitle'),
            content: t('commits.rewordPushedWarning', { branches }),
            confirmText: t('commits.rewordForceConfirm'),
            cancelText: t('common.cancel'),
          })
          if (!confirmed) break
          confirmPushed = true
        }
        await commitApi.rewordMessage(projectStore.currentProjectId, contextHash.value, newMsg, confirmPushed)
        window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
        message.success(t('commits.rewordSuccess'))
        fetchLog()
      } catch { /* 拦截器处理 */ }
      break
    }
    case 'reset': {
      const soft = await confirmDialog({
        type: 'warning',
        title: t('commits.ctxReset'),
        content: t('commits.resetConfirm'),
        confirmText: t('commits.resetSoft'),
        cancelText: t('commits.resetMixed'),
      })
      try { await advancedApi.reset(projectStore.currentProjectId, soft ? 'soft' : 'mixed', contextHash.value); message.success(t('commits.resetDone')); fetchLog(); window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE)) }
      catch { /* 拦截器处理 */ }
      break
    }
    case 'rebase-edit':
      openRebaseEditor()
      break
  }
}

// 先拉分支列表（internalBranch 归一为当前分支）再拉提交——挂载时 internalBranch
// 可能是空或其他项目的残留值，直接用会 git log 500
onMounted(async () => {
  // blame 点击的定位意图可能在挂载前已发出：先消费挂起片段（列表就绪后应用）
  if (pendingLocateHash.value) queueLocate(consumeCommitLocate())
  await fetchBranchesAndTags()
  fetchLog()
})
watch(() => projectStore.currentProjectId, async () => {
  await fetchBranchesAndTags()
  fetchLog()
})

// 宿主（GitPanel 侧栏刷新按钮）联动：远程新增分支/tag 后同步刷新本面板的
// 分支/tag 下拉选项与提交列表
defineExpose({
  refresh: async () => {
    await fetchBranchesAndTags()
    fetchLog()
  },
})
onBeforeUnmount(() => {
  if (locateFlashTimer) clearTimeout(locateFlashTimer)
})
</script>

<template>
  <div class="commits-panel">
    <!-- 分支选择 + 搜索 -->
    <div class="commits-toolbar">
      <n-select
        v-model:value="internalBranch"
        :options="branchOptions"
        size="small"
        style="width: 200px; flex-shrink: 0"
        :placeholder="t('commits.selectBranchTag')"
        :loading="branchLoading"
        filterable
        @update:value="handleBranchChange"
      />
      <n-input
        v-model:value="searchQuery"
        :placeholder="t('commits.searchCommits')"
        size="small"
        clearable
        style="flex: 1; min-width: 140px"
        @keyup.enter="searchCommits"
      >
        <template #prefix>
          <n-icon size="14">
            <SearchOutline />
          </n-icon>
        </template>
      </n-input>
      <n-input
        v-model:value="authorFilter"
        :placeholder="t('log.filterAuthor')"
        size="small"
        clearable
        style="width: 130px; flex-shrink: 0"
        @keyup.enter="fetchLog"
        @clear="fetchLog"
      />
      <n-date-picker
        v-model:value="dateRange"
        type="daterange"
        size="small"
        clearable
        :start-placeholder="t('commits.dateRange')"
        style="width: 250px; flex-shrink: 0"
        @update:value="fetchLog"
      />
      <div class="cp-toolbar-divider" />
      <n-input
        v-model:value="dirPath"
        :placeholder="t('log.dirHistoryPlaceholder')"
        size="small"
        clearable
        style="width: 150px; flex-shrink: 0"
        @keyup.enter="searchDirLog"
        @clear="clearDirLog"
      />
      <n-button
        size="small"
        :type="dirActive ? 'primary' : 'default'"
        @click="dirActive ? clearDirLog() : searchDirLog()"
      >
        {{ t('log.dirHistory') }}
      </n-button>
    </div>

    <div class="commits-body">
      <!-- 提交列表 -->
      <div class="commits-left">
        <div
          v-if="loading"
          class="commits-skeleton"
        >
          <div
            v-for="i in 8"
            :key="i"
            class="commits-skeleton-row"
          >
            <n-skeleton
              circle
              width="10px"
              height="10px"
            />
            <n-skeleton
              text
              width="72px"
              size="small"
            />
            <n-skeleton
              text
              :width="['46%', '62%', '38%', '55%', '50%', '42%', '58%', '44%'][i - 1]"
              size="small"
            />
            <n-skeleton
              text
              width="88px"
              size="small"
              style="margin-left: auto"
            />
          </div>
        </div>
        <div
          v-else
          v-bind="listContainerProps"
          class="commits-list"
        >
          <!-- 空态：空仓引导（服务端 emptyRepo 标志）/ 无提交 / 过滤或目录过滤无匹配 -->
          <div
            v-if="commits.length === 0"
            class="commits-loading"
            :data-testid="emptyRepo ? 'commits-empty-repo-guide' : undefined"
          >
            <template v-if="emptyRepo">
              <n-icon
                size="22"
                class="empty-guide-icon"
              ><GitBranchOutline /></n-icon>
              <div class="empty-guide-title">
                {{ t('log.emptyRepoTitle') }}
              </div>
              <div class="empty-guide-desc">
                {{ t('log.emptyRepoDesc') }}
              </div>
              <n-button
                size="small"
                type="primary"
                class="empty-guide-action"
                data-testid="empty-repo-go-changes"
                @click="goToChangesPanel"
              >
                {{ t('log.emptyRepoAction') }}
              </n-button>
            </template>
            <template v-else>
              {{ dirActive ? t('log.noDirCommits') : (hasFilterActive ? t('commits.noMatch') : t('log.noCommits')) }}
            </template>
          </div>
          <!-- 画布撑出总滚动高度：拓扑图绝对定位铺满全列表（≤600 行），行层窗口化平移对齐 -->
          <div
            v-else
            class="commits-canvas"
            :style="{ height: totalListHeight + 'px' }"
          >
            <div class="commits-graph-rows">
              <BranchGraph
                :commits="commits"
                :row-height="GRAPH_ROW_H"
              />
              <div
                v-bind="listWrapperProps"
                class="commits-rows"
              >
                <div
                  v-for="{ data: commit } in visibleCommits"
                  :key="commit.hash"
                  class="commit-item"
                  :style="{ height: GRAPH_ROW_H + 'px' }"
                  :class="{ selected: selectedHashes.has(commit.hash), expanded: expandedCommits.has(commit.hash), 'locate-flash': locateFlashHash === commit.hash }"
                  @click="toggleSelect(commit.hash, $event)"
                  @contextmenu="handleContextMenu($event, commit.hash)"
                >
                  <div class="commit-msg-row">
                    <span
                      class="commit-msg"
                      :class="{ 'has-body': hasBody(commit) }"
                      @mouseenter="openCommitPop(commit, $event)"
                      @mouseleave="schedulePopHide"
                      @click.stop="hasBody(commit) && toggleExpand(commit.hash)"
                    >{{ commit.message }}</span>
                    <span
                      v-if="hasBody(commit)"
                      class="commit-expand"
                      :title="t('commits.toggleFullMessage')"
                      @click.stop="toggleExpand(commit.hash)"
                    >{{ expandedCommits.has(commit.hash) ? '▾' : '▸' }}</span>
                    <span
                      v-if="commit.refs.length"
                      class="commit-refs"
                      :title="commit.refs.join(' ')"
                    >{{ commit.refs.join(' ') }}</span>
                  </div>
                  <div class="commit-meta">
                    <span
                      class="commit-meta-author"
                      :title="commit.email ? `${commit.author} <${commit.email}>` : commit.author"
                    >{{ commit.author }}</span>
                    <span
                      v-if="commit.email"
                      class="commit-meta-email"
                      :title="commit.email"
                    >&lt;{{ commit.email }}&gt;</span>
                    <span class="commit-meta-date">{{ formatDate(commit.date) }}</span>
                    <span class="commit-hash">{{ commit.shortHash }}</span>
                  </div>
                  <!-- 展开的完整提交信息：绝对定位浮层，不改变行高（保证拓扑图对齐）；阻断点击冒泡避免误改选中集 -->
                  <div
                    v-if="expandedCommits.has(commit.hash) && commit.body"
                    class="commit-body"
                    @click.stop
                    @dblclick.stop
                    @contextmenu.stop
                  >
                    {{ commit.body }}
                  </div>
                </div>
              </div>
            </div>
            <!-- 加载更多：滚动到底自动加载（skip 递增）；画布底部固定行 -->
            <div
              v-if="hasMore && commits.length > 0"
              class="commits-load-more commits-load-more-abs"
              @click="loadMore"
            >
              <n-spin
                v-if="loadingMore"
                size="small"
              />
              <span v-else>{{ t('commits.loadMore') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- diff 文件树（右键菜单组件抽至 CommitDiffFiles：编辑器打开/文件历史/区间 diff 等） -->
      <CommitDiffFiles
        v-if="selectedHashes.size > 0 && !compareBaseHash"
        :project-id="projectStore.currentProjectId || ''"
        :rows="flatDiffTree"
        :loading="diffLoading"
        :file-count="diffFiles.length"
        :selected-count="selectedHashes.size"
        :oldest-hash="selectedOldestHash"
        :newest-hash="selectedNewestHash"
        :expanded-dirs="expandedDiffDirs"
        @open-diff="emit('open-diff', $event)"
        @toggle-dir="toggleDiffDir"
      />

      <!-- 与 HEAD 对比 -->
      <div
        v-if="compareBaseHash"
        class="commits-right"
      >
        <div class="diff-header">
          <span class="diff-title">{{ compareBaseHash.substring(0, 8) }}..HEAD ({{ compareFiles.length }})</span>
          <span
            class="diff-close"
            @click="closeCompare"
          >&times;</span>
        </div>
        <div
          v-if="compareLoading"
          class="diff-loading"
        >
          <n-spin size="small" />
        </div>
        <div
          v-else
          class="diff-tree"
        >
          <div
            v-for="file in compareFiles"
            :key="file.path"
            class="diff-node"
            style="padding-left: 8px"
            @click="handleCompareFileClick(file)"
          >
            <span class="diff-icon">📄</span>
            <span
              class="diff-name"
              :title="file.path"
            >{{ file.name || file.path }}</span>
            <span
              v-if="file.status"
              class="diff-status"
              :style="{ color: getStatusColor(file.status) }"
              :title="file.status"
            >{{ getStatusLabel(file.status) }}</span>
          </div>
          <div
            v-if="compareFiles.length === 0 && !compareLoading"
            class="diff-empty"
          >
            {{ t('commits.noChangedFiles') }}
          </div>
        </div>
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

    <!-- 交互式 rebase 编辑器（整理自此提交起）：成功后重拉历史（工作区广播由弹层内派发） -->
    <RebaseEditorModal
      ref="rebaseEditorRef"
      @rebased="fetchLog()"
    />

    <!-- 历史检视 toast「在新终端打开」：预填检视工作区目录起会话（跑代码/测试） -->
    <NewSessionDialog
      v-model:show="showHistAgentDialog"
      :prefill-dir="histAgentDialogDir"
    />

    <!-- 提交信息悬浮层：可移入选中/复制 + 完整时间（相对时间之外的完整查看处） -->
    <NPopover
      trigger="manual"
      placement="bottom-start"
      :show="!!popCommit"
      :x="popX"
      :y="popY"
      :show-arrow="false"
      :delay="0"
      raw
    >
      <div
        v-if="popCommit"
        class="commit-pop"
        @mouseenter="cancelPopHide"
        @mouseleave="schedulePopHide"
      >
        <div class="commit-pop-msg">
          {{ popCommit.body || popCommit.message }}
        </div>
        <div class="commit-pop-meta">
          <span
            class="commit-pop-author"
            :title="popCommit.author"
          >{{ popCommit.author }}</span>
          <span
            v-if="popCommit.email"
            class="commit-pop-email"
            :title="popCommit.email"
          >&lt;{{ popCommit.email }}&gt;</span>
          <span
            class="commit-pop-time"
            :title="t('commits.fullTime')"
          >{{ formatDateTime(popCommit.date) }}</span>
          <span class="commit-pop-hash">{{ popCommit.shortHash }}</span>
          <button
            class="commit-pop-copy"
            :title="t('commits.copyFullMessage')"
            @click="copyFullMessage"
          >
            <n-icon size="12">
              <CopyOutline />
            </n-icon>
          </button>
        </div>
      </div>
    </NPopover>
  </div>
</template>

<style scoped src="./commits-panel.css"></style>
