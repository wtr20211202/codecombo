<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NDropdown, NIcon, NSpin, useMessage } from 'naive-ui'
import { ArchiveOutline, ChevronDownOutline, ChevronForwardOutline, DownloadOutline, RefreshOutline, SparklesOutline, TrashOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useChangesStore } from '../../stores/changes'
import type { FileStatus } from '../../stores/changes'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { patchApi } from '../../api/client'
import type { PatchScope } from '../../api/client'
import { useStashSection } from '../../composables/useStashSection'
import { useChangelists } from '../../composables/useChangelists'
import { useAgentMarks } from '../../composables/useAgentMarks'
import StashDiffModal from '../../components/git/StashDiffModal.vue'
import IndexLockBar from '../../components/git/IndexLockBar.vue'
import CommitActionArea from '../../components/git/CommitActionArea.vue'
import CommitFilterBar from '../../components/git/CommitFilterBar.vue'
import CommitChangeTree from '../../components/git/CommitChangeTree.vue'
import { useI18n } from '../../composables/useI18n'
import { promptDialog } from '../../composables/useDialog'
import { confirmSensitiveFiles } from '../../composables/useShareDialog'
import { useCommitActions } from '../../composables/useCommitActions'
import { usePrDescription } from '../../composables/usePrDescription'
import { useSuggestTests } from '../../composables/useSuggestTests'
import { useChangesetReview } from '../../composables/useChangesetReview'
import { useCommitSplitExecute } from '../../composables/useCommitSplitExecute'
import { useChangeTree } from '../../composables/useChangeTree'
import { useGitPanelAutoRefresh } from '../../composables/useGitPanelAutoRefresh'

// 变更面板组合根（P-20261003-143 拆分后）：页签编排/刷新/导出补丁/stash 页签
// 留在本体；提交操作区/过滤条/变更树三块委托给 components/git/ 下同名子组件，
// 对应逻辑在 useCommitActions / useChangeTree。两个 composable 必须由本组件
// setup 期调用——changes 页签内容在 v-if 下，子组件随页签切换卸载，状态若由
// 子组件自持会在 changes↔stash 往返后丢失（CC 草稿字段/折叠态/键盘光标等，
// 拆分前均挂在面板上）。

const message = useMessage()
const { t } = useI18n()
const projectStore = useProjectStore()
const changesStore = useChangesStore()

const emit = defineEmits<{
  (e: 'open-diff', file: { path: string; name: string; oldRef: string; newRef?: string }): void
}>()

const activeTab = ref<'changes' | 'stash'>('changes')
const selectedForCommit = ref<Set<string>>(new Set())

const allFiles = computed(() => changesStore.files)
// ============== 变更列表即时过滤（复刻 GitBranchesSection 的 branchFilter 模式） ==============
// 显示层过滤：按路径子串不分大小写即时定位目标文件，清空即恢复全量。
// 仅影响列表渲染——勾选集与 stage/unstage/提交计数仍按全量计算，被过滤
// 隐藏的已勾选文件保持勾选（防止过滤后批量操作误伤看不见的文件）
const changesFilter = ref('')
const isFiltering = computed(() => changesFilter.value.trim() !== '')
function hitFile(target: string): boolean {
  const q = changesFilter.value.trim().toLowerCase()
  return !q || target.toLowerCase().includes(q)
}
// ============== 会话归属标注与二态过滤（P-20261003-22） ==============
// 复用文件树同款 useAgentMarks（同 composable 同数据面，无新增后端依赖）：
// marks 按「会话 cwd = 项目根」聚合哪些文件是 agent 产出（归属边界沿用其
// 收紧语义——worktree 会话不计，tooltip 注明）。会话列表此前仅由终端宿主
// 拉取，面板直进项目页时 store 为空、marks 恒空——这里补一次引导拉取
//（loaded 幂等，终端宿主已拉过则不重复打）
const terminalSessionsStore = useTerminalSessionsStore()
if (!terminalSessionsStore.loaded) void terminalSessionsStore.refresh()
const { marks: agentMarks, stat: agentMarksStat } = useAgentMarks(() => projectStore.currentProject?.path || '')

// 「仅看 agent 改动 / 仅看人工改动」二态：按 marks 命中与否切分，与上方
// 路径过滤叠加（AND，各筛各的维度）。marks 全空（无归属数据可辨）时二态
// 不过滤——数据未达/无匹配会话时不得把列表清空成误导性空态
const agentScopeFilter = ref<'off' | 'agent' | 'human'>('off')
const isAgentScopeFiltering = computed(() => agentScopeFilter.value !== 'off')
const hasAnyAgentMarks = computed(() => agentMarks.value.size > 0)
function hitAgentScope(path: string): boolean {
  if (agentScopeFilter.value === 'off' || !hasAnyAgentMarks.value) return true
  return agentScopeFilter.value === 'agent' ? agentMarks.value.has(path) : !agentMarks.value.has(path)
}
// ============== 状态维度过滤 chips（P-20261003-136） ==============
// 四态单选（全部/未暂存/已暂存/冲突，再点激活项回落全部）：大批量变更中按
// 暂存状态聚焦——文本过滤只管路径子串、归属过滤只管会话归属，状态是过滤的
// 第三维，三者 AND 叠加各筛各的维度。口径：untracked 无「暂存」概念
//（服务端 staged=false）归入未暂存侧；冲突文件（服务端 porcelain v2 未合并
// 行，Status=Unmerged）恒 staged=false、被未暂存 chip 包含，单列 chip 供聚焦
//（行内状态字母 U 红橙色高亮，见 utils/git STATUS_*_MAP）
const statusScopeFilter = ref<'all' | 'unstaged' | 'staged' | 'conflict'>('all')
const isStatusScopeFiltering = computed(() => statusScopeFilter.value !== 'all')
const hasConflictFiles = computed(() => allFiles.value.some(f => f.status === 'Unmerged'))
function hitStatusScope(file: FileStatus): boolean {
  switch (statusScopeFilter.value) {
    case 'unstaged': return !file.staged
    case 'staged': return file.staged
    case 'conflict': return file.status === 'Unmerged'
    default: return true
  }
}
// ============== 变更列表（changelist）分区（P-20261007-19） ==============
// 分组维度过滤（第 4 维，与路径/归属/状态 AND 叠加）：「只看活跃组」把变更树
// 收敛到当前正在做的组——提交面随之收敛（勾选/提交计数仍按全量口径的解耦
// 约束不变，过滤只影响显示）。活跃组是服务端持久态，开关是显示层 opt-in
const cl = useChangelists({
  currentProjectId: () => projectStore.currentProjectId || '',
  currentChangedPaths: () => allFiles.value.map(f => f.path),
  onChanged: async () => {
    if (!projectStore.currentProjectId) return
    await Promise.all([
      changesStore.fetchStatus(projectStore.currentProjectId),
      fetchStashes(),
    ])
  },
  message,
  t,
  prompt: promptDialog,
})
const isChangelistScopeFiltering = computed(() => cl.filterByActive.value && !!cl.activeList.value)
// 活跃组文件集（Set 化：visibleFiles 每次重算对每个可见文件查命中，status
// 刷新 300ms 防抖热路径上 O(F×M) 的数组 includes 换 O(F) 的 Set has）
const activeListFiles = computed(() => new Set(cl.activeList.value?.files ?? []))
function hitChangelistScope(path: string): boolean {
  return activeListFiles.value.has(path)
}
// 模板用顶层绑定（setup 顶层 ref 才自动解包；cl.* 嵌套 Ref 在模板里要 .value）
const clLists = cl.lists
const clActiveList = cl.activeList
const clFilterOn = cl.filterByActive
const { createList, removeList, setActive, shelveList } = cl
const visibleFiles = computed(() => {
  let list = allFiles.value
  if (isFiltering.value) list = list.filter(f => hitFile(f.path))
  if (isAgentScopeFiltering.value) list = list.filter(f => hitAgentScope(f.path))
  if (isStatusScopeFiltering.value) list = list.filter(f => hitStatusScope(f))
  if (isChangelistScopeFiltering.value) list = list.filter(f => hitChangelistScope(f.path))
  return list
})

// 提交操作区（提交消息/CC/amend/连招/生成提交信息）与变更树（树构建/虚拟滚动/
// 键盘导航/右键菜单）逻辑面板；onOpenDiff 转发面板 open-diff 给宿主布局。
// agentMarks 同一实例传给提交操作区（P-20261005-172 生成提交信息归属行数据面）
const commitActions = useCommitActions({ selectedForCommit, allFiles, agentMarks })
// 「生成 PR 描述」（P-20261003-177）：marks 清单 + diffstat（上方 useAgentMarks
// 同一实例，零新增请求）+ 近期提交三数据面经 ask-agent 链路起草；逻辑自含
// usePrDescription（同 useCommitAgentMsg 范式），经 prop 交 CommitActionArea
const prDesc = usePrDescription({ marks: agentMarks, stat: agentMarksStat })
// 「建议补测试」（P-20261003-249）：与 PR 描述共用上方 useAgentMarks 同一实例
// （marks 清单 + diffstat，零新增请求），经 ask-agent 链路产出测试缺口建议；
// 逻辑自含 useSuggestTests（同 usePrDescription 范式），经 prop 交 CommitActionArea
const suggestTests = useSuggestTests({ marks: agentMarks, stat: agentMarksStat })

// 逐组执行（P-20261003-278）：拆分建议结构化方案的确认执行化，逻辑自含
// useCommitSplitExecute（读建议会话 scrollback 解析 + 确认弹层 + 服务端循环），
// 经 prop 交 CommitActionArea；与 useSuggestTests 同范式由面板 setup 期调用
//（页签往返不丢执行中状态）
const splitExec = useCommitSplitExecute()
// 「交给智能体审查变更集」（P-20261005-2）：全工作区变更集（非勾选集）发起
// agent 审查会话，逻辑自含 useChangesetReview；按钮在本体头部工具区（页签行，
// 导出补丁邻位——变更集级动作，不随 CommitActionArea 的提交口径走）。marks
// 同一实例传入（P-20261005-172 审查 prompt「优先审 agent 改动」归属行数据面）
const reviewAgent = useChangesetReview({ marks: agentMarks })
const changeTree = useChangeTree({
  files: visibleFiles,
  selectedForCommit,
  agentMarks,
  changesFilter,
  agentScopeFilter,
  statusScopeFilter,
  changelistFiltering: isChangelistScopeFiltering,
  changelistLists: cl.lists,
  onMoveToList: (file, list) => { void cl.moveFileTo(file, list) },
  onOpenDiff: (payload) => { emit('open-diff', payload) },
})

// Stash 区块逻辑抽至 useStashSection（列表/创建/pop/drop/应用到新分支）
const { stashes, stashLoading, fetchStashes, handleStashCreate, handleStashPop, handleStashDrop, handleStashApplyToBranch, bindProjectWatch } = useStashSection({
  currentProjectId: () => projectStore.currentProjectId || '',
  onChanged: async () => { await changesStore.fetchStatus(projectStore.currentProjectId!) },
  message,
  t,
  prompt: promptDialog,
})
// 进入/切换项目时拉取 stash 列表（此前接线缺失：带存量 stash 的项目首次
// 打开 stash 页签会误显「暂无 Stash」，需手动刷新才出现）
bindProjectWatch()

// 变更列表分区：setup 期首拉（分区在默认的 changes 页签上，等不到切换事件；
// stash 页签有 showStashTab 显式拉取故无此需要）+ 项目切换跟随重拉（过滤开关
// 重置在 composable 内）。展开态跟随内容：有列表自动展开（分区即入口，收着
// 等于没做），无列表收起只留标题行——每次加载（首拉/切项目）重算一次，
// 会话内手动开合在两次加载之间保持
const clExpanded = ref(false)
function syncClExpanded() {
  clExpanded.value = cl.lists.value.length > 0
}
if (projectStore.currentProjectId) void cl.fetch().then(syncClExpanded)
cl.bindProjectWatch(syncClExpanded)

// Stash 内容预览弹层（P-20261002-89）：apply/pop 前先看里面是什么。
// 目标 index 取自点击时的列表行（标题展示用），hash 是稳定寻址（P-20261003-264：
// 弹层内按 hash 拉取，列表移位不会预览到别的条目；旧服务端无 hash 时回退 index）
const showStashDiff = ref(false)
const stashDiffTarget = ref<{ index: number; message: string; hash?: string } | null>(null)
function openStashDiff(s: { index: number; message: string; hash?: string }) {
  stashDiffTarget.value = s
  showStashDiff.value = true
}

// 切到 stash 页签时刷新：面板挂载早于项目选择/外部（CLI 等）新建 stash，
// 沿用首次进入页签时的列表会展示陈旧空态
function showStashTab() {
  activeTab.value = 'stash'
  void fetchStashes()
}

// 刷新：重新拉取变更状态与 stash 列表
const refreshing = ref(false)
async function handleRefresh() {
  if (!projectStore.currentProjectId || refreshing.value) return
  refreshing.value = true
  try {
    await Promise.all([
      changesStore.fetchStatus(projectStore.currentProjectId),
      fetchStashes(),
    ])
  } finally { refreshing.value = false }
}

// git 面板自动刷新（P-20261003-74）：终端跑 git 写类命令（add/commit/stash…）后
// 去抖拉取——索引/引用类操作只动 .git（fsnotify 跳过），file.changed 不触发，
// 此前列表会停留在旧数据。复用上方 handleRefresh（自带 refreshing 在途守卫，
// 与自动去抖互为正交）；检测与派发在 useTerminalSession（OSC 133 D 事件）
useGitPanelAutoRefresh(() => handleRefresh())

// ============== 未提交变更导出补丁（P-20261003-72） ==============
// 三态下拉：工作区未暂存 / 暂存区 / 相对 HEAD 全部，服务端出 .patch 附件下载。
// P-20261004-56 起 worktree/head 两态追补 untracked 新文件段（agent 产出以
// 新文件居多，漏新文件的补丁搬运到收件侧现场残缺）——「可导出」按 tracked
// 或 untracked 任一非空判定（纯 untracked 现场按钮可点）；staged scope 语义
// 不变（暂存区本就无 untracked 概念），各下拉项再按各自 scope 独立禁用
const exportingPatch = ref(false)
const trackedChangedCount = computed(() =>
  changesStore.stagedFiles.length + changesStore.unstagedFiles.length,
)
const untrackedCount = computed(() => changesStore.untrackedFiles.length)
const patchScopeOptions = computed(() => [
  { label: t('changes.exportPatch.worktree'), key: 'worktree', disabled: changesStore.unstagedFiles.length === 0 && untrackedCount.value === 0 },
  { label: t('changes.exportPatch.staged'), key: 'staged', disabled: changesStore.stagedFiles.length === 0 },
  { label: t('changes.exportPatch.head'), key: 'head', disabled: trackedChangedCount.value === 0 && untrackedCount.value === 0 },
])
// 任一 scope 可导出即启用按钮（无可导出变更 = 三态全禁用）
const canExportPatch = computed(() => patchScopeOptions.value.some((o) => !o.disabled))
// 出域敏感闸确认框文案键（P-20261004-97）：confirmSensitiveFiles 的可换肤键组，
// 与分享/打包下载同族交互（警示型 confirm，取消即不动、零副作用）
const patchSensitiveKeys = {
  title: 'changes.exportPatch.sensitiveTitle',
  intro: 'changes.exportPatch.sensitiveIntro',
  more: 'changes.exportPatch.moreFiles',
  partial: 'changes.exportPatch.partialNote',
  confirm: 'changes.exportPatch.sensitiveConfirm',
}
async function handleExportPatch(key: string | number) {
  const pid = projectStore.currentProjectId
  if (!pid || exportingPatch.value) return
  exportingPatch.value = true
  try {
    let blob = await patchApi.downloadPatch(pid, key as PatchScope) as unknown as Blob
    // 出域敏感闸（P-20261004-97）：服务端命中敏感命名文件时拦回 JSON
    // {warnings}（不出附件）——按 blob.type 分流弹确认清单，确认后带
    // confirm=1 重放（terminal 导出 / dir-archive 同契约）。扫描无截断语义，
    // partial 恒 false；解析不出 warnings 按异常收场，绝不把 JSON 当补丁落盘
    if (blob.type.includes('json')) {
      const parsed = JSON.parse(await blob.text()) as { warnings?: string[] }
      if (!parsed?.warnings?.length) throw new Error('unexpected patch export response')
      if (!await confirmSensitiveFiles(parsed.warnings, false, patchSensitiveKeys)) return
      blob = await patchApi.downloadPatch(pid, key as PatchScope, true) as unknown as Blob
    }
    // 下载名客户端合成（<分支>-<日期>.patch，与服务端 Content-Disposition 同约定）；
    // 分支名折叠文件名不安全字符——含 / 的分支名会被浏览器当目录分隔把名拆级
    const branch = (projectStore.currentProject?.currentBranch || 'HEAD').replace(/[\\/:*?"<>|\s]+/g, '-')
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${branch}-${day}.patch`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    message.success(t('changes.exportPatch.success'))
  } catch { /* 拦截器处理 */ }
  finally { exportingPatch.value = false }
}
</script>

<template>
  <div
    class="commit-panel"
    data-testid="commit-panel"
  >
    <!-- index.lock 遗留锁修复条（P-20261002-150）：git 写命令报遗留锁时给出一键清理 -->
    <IndexLockBar />
    <!-- Tab 切换 -->
    <div class="cp-tabs">
      <button
        class="cp-tab"
        data-testid="cp-tab-changes"
        :class="{ active: activeTab === 'changes' }"
        @click="activeTab = 'changes'"
      >
        {{ t('commitPanel.changes') }}
      </button>
      <button
        class="cp-tab"
        data-testid="cp-tab-stash"
        :class="{ active: activeTab === 'stash' }"
        @click="showStashTab"
      >
        {{ t('commitPanel.stash') }}
      </button>
      <!-- 未提交变更导出补丁（P-20261003-72）：三态下拉，tracked/untracked
           均无（干净仓）或导出中时禁用；下拉项按各自 scope 独立禁用（staged
           不含 untracked 概念，纯 untracked 现场仅该项禁用） -->
      <n-dropdown
        trigger="click"
        :options="patchScopeOptions"
        @select="handleExportPatch"
      >
        <button
          class="cp-tab-action"
          data-testid="export-patch"
          :disabled="exportingPatch || !canExportPatch"
          :title="t('changes.exportPatch.label')"
        >
          <n-icon size="14">
            <DownloadOutline />
          </n-icon>
        </button>
      </n-dropdown>
      <!-- 交给智能体审查变更集（P-20261005-2）：提交决策前一键质检——工作区
           全部未提交变更（非勾选集）发起 agent 审查会话；变更非空可用（干净仓
           禁用）、发起中禁用防重复。同形制图标钮（导出补丁邻位的变更集级动作），
           文案进 title/aria-label（i18n commit.review.buttonTitle） -->
      <button
        class="cp-tab-action"
        data-testid="cp-ask-review"
        :disabled="!reviewAgent.canReview || reviewAgent.launching"
        :title="t('commit.review.buttonTitle')"
        :aria-label="t('commit.review.buttonTitle')"
        @click="reviewAgent.reviewChangeset"
      >
        <n-icon size="14">
          <SparklesOutline />
        </n-icon>
      </button>
      <button
        class="cp-tab-refresh"
        :class="{ rotating: refreshing }"
        :disabled="refreshing"
        :title="t('common.refresh')"
        @click="handleRefresh"
      >
        <n-icon size="14">
          <RefreshOutline />
        </n-icon>
      </button>
    </div>

    <!-- 变更 Tab -->
    <template v-if="activeTab === 'changes'">
      <!-- 提交信息与提交动作（子组件，逻辑在 useCommitActions）；prDesc =
           生成 PR 描述（P-20261003-177，逻辑在 usePrDescription）；
           suggestTests = 建议补测试（P-20261003-249，逻辑在 useSuggestTests）；
           splitExec = 逐组执行（P-20261003-278，逻辑在 useCommitSplitExecute） -->
      <CommitActionArea
        :area="commitActions"
        :pr-desc="prDesc"
        :suggest-tests="suggestTests"
        :split-exec="splitExec"
      />

      <!-- 文件列表 -->
      <!-- 即时过滤：大变更集（重命名/依赖升级波及数十文件）按路径子串定位；
           过滤态在头部显示 n/总数，清空恢复全量（子组件，逻辑在本体 filter 状态） -->
      <!-- 变更列表分区（P-20261007-19）：逻辑分组（活跃组高亮）/新建/删除/搁置；
           文件「移入列表」在变更树右键菜单。收起只留标题行保变更树空间 -->
      <div
        class="cp-cl-section"
        data-testid="cl-section"
      >
        <div class="cp-cl-head">
          <button
            class="cp-cl-toggle"
            data-testid="cl-toggle"
            @click="clExpanded = !clExpanded"
          >
            <n-icon size="11">
              <component :is="clExpanded ? ChevronDownOutline : ChevronForwardOutline" />
            </n-icon>
            {{ t('changes.changelist.section') }}
            <span class="cp-cl-head-count">{{ clLists.length }}</span>
          </button>
          <button
            class="cp-cl-new"
            data-testid="cl-new"
            :title="t('changes.changelist.newTitle')"
            @click="createList()"
          >
            + {{ t('changes.changelist.new') }}
          </button>
        </div>
        <div
          v-if="clExpanded"
          class="cp-cl-rows"
        >
          <div
            v-for="l in clLists"
            :key="(l.projectId || '') + '/' + l.name"
            class="cp-cl-row"
            :class="{ 'is-active': l.active }"
            data-testid="cl-row"
          >
            <button
              class="cp-cl-active-btn"
              data-testid="cl-set-active"
              :class="{ on: l.active }"
              :title="l.active ? t('changes.changelist.isActiveTitle', { name: l.name }) : t('changes.changelist.setActiveTitle', { name: l.name })"
              @click="setActive(l)"
            >
              ●
            </button>
            <span
              class="cp-cl-name"
              :title="t('changes.changelist.filesCountTitle', { n: l.files.length })"
              @click="setActive(l)"
            >{{ l.name }}</span>
            <span class="cp-cl-count">{{ l.files.length }}</span>
            <button
              class="cp-cl-act"
              data-testid="cl-shelve"
              :title="t('changes.changelist.shelveBtnTitle', { name: l.name })"
              @click="shelveList(l)"
            >
              <n-icon size="12">
                <ArchiveOutline />
              </n-icon>
            </button>
            <button
              class="cp-cl-act"
              data-testid="cl-delete"
              :title="t('changes.changelist.deleteTitle')"
              @click="removeList(l)"
            >
              <n-icon size="12">
                <TrashOutline />
              </n-icon>
            </button>
          </div>
        </div>
      </div>
      <CommitFilterBar
        v-if="allFiles.length > 0"
        v-model:filter="changesFilter"
        v-model:agent-scope="agentScopeFilter"
        v-model:status-scope="statusScopeFilter"
        v-model:changelist-scope="clFilterOn"
        :has-conflicts="hasConflictFiles"
        :has-active-list="!!clActiveList"
        :active-list-name="clActiveList?.name || ''"
        :visible-count="visibleFiles.length"
        :total-count="allFiles.length"
      />
      <!-- 过滤无命中（列表容器仍渲染，提示贴在过滤行下方；变更清零时让位给空态） -->
      <div
        v-if="allFiles.length > 0 && (isFiltering || isAgentScopeFiltering || isStatusScopeFiltering || isChangelistScopeFiltering) && visibleFiles.length === 0"
        class="cp-no-match"
      >
        {{ t('changes.filter.noMatch') }}
      </div>
      <!-- loading 分支仅在「初始加载且还没有数据」时接管：fetchStatus 每次后台
           刷新（WS file.changed / hunk 动作后的状态对流 / 自动刷新）都翻转
           loading，若按 loading 整体切到 spinner 会把 CommitChangeTree 连同
           行内嵌 diff（P-20261004-25）等子树反复卸载重挂——重挂即丢滚动位/
           重拉子组件数据（e2e changes-inline-diff 抓到的内嵌 diff 重复请求
           即此）。已有数据时刷新就地换内容，树保持挂载 -->
      <div
        v-if="changesStore.loading && allFiles.length === 0"
        class="cp-loading"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="allFiles.length === 0"
        class="cp-empty"
      >
        {{ t('commitPanel.noChanges') }}
      </div>
      <!-- 变更树（子组件，逻辑在 useChangeTree：虚拟滚动/键盘导航/右键菜单） -->
      <CommitChangeTree
        v-else
        :tree="changeTree.state"
        :list="changeTree.list"
      />
    </template>

    <!-- Stash Tab -->
    <template v-if="activeTab === 'stash'">
      <div class="cp-stash-toolbar">
        <n-button
          size="tiny"
          type="primary"
          @click="handleStashCreate"
        >
          {{ t('commitPanel.createStash') }}
        </n-button>
      </div>
      <div
        v-if="stashLoading"
        class="cp-loading"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="stashes.length === 0"
        class="cp-empty"
      >
        {{ t('commitPanel.noStash') }}
      </div>
      <div
        v-else
        class="cp-stash-list"
      >
        <div
          v-for="s in stashes"
          :key="s.index"
          class="cp-stash-item"
        >
          <div class="cp-stash-info">
            <!-- 搁置条目标识（P-20261007-19）：changelist 分区「搁置本组」产生的
                 stash 条目带 shelve: 前缀（服务端 ShelvePartial 统一加），这里渲染
                 徽标并剥前缀显示；恢复=本页「恢复」(pop)，与全量 stash 同一通道 -->
            <span
              v-if="s.message.startsWith('shelve:')"
              class="cp-cl-stash-badge"
              data-testid="cl-stash-badge"
              :title="t('changes.changelist.stashBadgeTitle')"
            >{{ t('changes.changelist.stashBadge') }}</span>
            <span class="cp-stash-msg">{{ s.message.replace(/^shelve:\s*/, '') }}</span>
          </div>
          <div class="cp-stash-actions">
            <n-button
              size="tiny"
              quaternary
              type="info"
              @click="openStashDiff(s)"
            >
              {{ t('stash.diff.view') }}
            </n-button>
            <n-button
              size="tiny"
              quaternary
              type="primary"
              @click="handleStashPop(s)"
            >
              {{ t('commitPanel.stashPop') }}
            </n-button>
            <!-- 应用到新分支（P-20261003-263 实验性应用）：title 携后果说明，悬停可发现 -->
            <n-button
              size="tiny"
              quaternary
              type="info"
              :title="t('commitPanel.stashApplyBranch')"
              @click="handleStashApplyToBranch(s)"
            >
              {{ t('commitPanel.stashApplyBranch') }}
            </n-button>
            <n-button
              size="tiny"
              quaternary
              type="error"
              @click="handleStashDrop(s)"
            >
              {{ t('commitPanel.stashDelete') }}
            </n-button>
          </div>
        </div>
      </div>
    </template>

    <!-- Stash 内容预览（只读，DiffViewer 渲染） -->
    <StashDiffModal
      v-model:show="showStashDiff"
      :project-id="projectStore.currentProjectId || ''"
      :index="stashDiffTarget?.index ?? 0"
      :hash="stashDiffTarget?.hash"
      :message="stashDiffTarget?.message ?? ''"
    />
  </div>
</template>

<style scoped src="./commit-panel.css"></style>
