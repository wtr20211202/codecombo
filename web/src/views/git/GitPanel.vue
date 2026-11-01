<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, inject, h, type Ref } from 'vue'
import { NIcon, NButton } from 'naive-ui'
import { CloudDownloadOutline, CloudUploadOutline, ArrowDownCircleOutline, RefreshOutline, GitBranchOutline, BuildOutline, DocumentTextOutline, TrashOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useChangesStore } from '../../stores/changes'
import { useGitFailHintStore, isGitFailHintFresh } from '../../stores/gitFailHint'
import { useGitOpsStore, type GitOpType } from '../../stores/gitOps'
import { remoteApi, conflictApi, rebaseApi, projectApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { useLayoutLockStore } from '../../stores/layoutLock'
import { usePushFlow } from '../../composables/usePushFlow'
import { usePushPrToast } from '../../composables/usePushPrToast'
import { confirmDialog } from '../../composables/useDialog'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useGitPanelFocusRefresh } from '../../composables/useGitPanelFocusRefresh'
import { OPS_FILES_EXTERNAL_CHANGE } from '../../utils/opsEvents'
import { pullResultSummary, isConflictPullError } from '../../utils/pullResult'
import { safeStorage } from '../../utils/storage'
import { useMessage } from 'naive-ui'
import CommitsPanel from './CommitsPanel.vue'
import ConflictView from '../conflict/ConflictView.vue'
import GitBranchesSection from '../../components/git/GitBranchesSection.vue'
import GitRemotesSection from '../../components/git/GitRemotesSection.vue'
import GitWorktreesSection from '../../components/git/GitWorktreesSection.vue'
import GitManageModal from '../../components/git/GitManageModal.vue'
import GitBranchCleanupModal from '../../components/git/GitBranchCleanupModal.vue'
import GitignoreTemplateModal from '../../components/git/GitignoreTemplateModal.vue'
import ChangelogDraftModal from '../../components/git/ChangelogDraftModal.vue'

const emit = defineEmits<{
  (e: 'open-file', file: { path: string; name: string }): void
  (e: 'open-diff', file: { path: string; name: string; oldRef: string; newRef: string }): void
}>()

const props = defineProps<{
  ahead?: number
  behind?: number
}>()

const message = useMessage()
const projectStore = useProjectStore()
const { t } = useI18n()
// 注入全局 ahead 刷新函数：push 成功后刷新所有项目的 ahead/behind（TopBar 项目下拉/BranchCapsule 用）
const fetchAllAheadBehind = inject<() => Promise<void>>('sharedFetchAllAheadBehind', async () => {})

// 侧边栏状态
const showSidebar = ref(true)
const sidebarWidth = ref(180)

// 侧栏宽度拖拽调整（150~360px，会话内有效）
function startSidebarResize(e: MouseEvent) {
  // 布局锁定（P-20261003-180）：拖拽类交互统一短路，点击/键盘不受影响
  if (useLayoutLockStore().interceptDrag(e)) return
  e.preventDefault()
  const startX = e.clientX
  const startWidth = sidebarWidth.value
  function onMove(ev: MouseEvent) {
    sidebarWidth.value = Math.max(150, Math.min(360, startWidth + (ev.clientX - startX)))
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
}

// 仓库管理弹窗（子模块 / GPG / LFS / Hooks）
const showManageModal = ref(false)

// 清理已合并分支向导（P-20261003-50）：数据链路自含，收 cleaned 刷新分支树
const showBranchCleanup = ref(false)

// 变更日志草稿弹层（P-20261003-27）：tag..HEAD 分组聚合，纯前端零 Go；
// 弹层自含数据链路，宿主只负责开合
const showChangelogModal = ref(false)

// 冲突状态：merge/rebase/cherry-pick 产生冲突时主内容区顶部显示横幅，点击就地切换到冲突面板
const conflictCount = ref(0)
const showConflictPanel = ref(false)
// 进行中的有序 git 操作（conflicts 接口顺带返回 rebase/merge/cherry-pick/""）：
// 冲突全解后 rebase-merge/MERGE_HEAD 仍在 → 显示「继续变基/完成合并」操作条收尾，
// 补齐冲突解决链最后一米（此前用户只能去终端手打 git rebase --continue）
const gitOperation = ref<'' | 'rebase' | 'merge' | 'cherry-pick'>('')

// 面板状态机时序兜底：挂载/切项目的首次拉取可能早于服务端该项目仓库状态
// 就绪（冷缓存空响应/报错）→ 计 0 且此后无任何触发源（headless 无 window
// focus），横幅 >24s 不出现。每次项目进入允许一次短延重试（有界，不多刷）
let conflictRetryTimer: ReturnType<typeof setTimeout> | null = null
let conflictRetryUsed = false

function clearConflictRetry() {
  if (conflictRetryTimer) { clearTimeout(conflictRetryTimer); conflictRetryTimer = null }
}

function scheduleConflictRetry() {
  if (conflictRetryUsed) return
  conflictRetryUsed = true
  conflictRetryTimer = setTimeout(() => { conflictRetryTimer = null; void fetchConflictCount() }, 1500)
}

async function fetchConflictCount() {
  clearConflictRetry()
  if (!projectStore.currentProjectId) { conflictCount.value = 0; gitOperation.value = ''; return }
  try {
    const res: any = await conflictApi.list(projectStore.currentProjectId)
    const items = res.data || []
    conflictCount.value = items.length
    gitOperation.value = typeof res.inProgress === 'string' ? res.inProgress : ''
    if (conflictCount.value === 0) {
      showConflictPanel.value = false
      scheduleConflictRetry()
    }
  } catch {
    conflictCount.value = 0
    gitOperation.value = ''
    scheduleConflictRetry()
  }
}

// ============== .gitignore 创建建议（P-20261002-76） ==============
// 项目根无 .gitignore 且 status 含未跟踪路径时，主内容区顶部弱提示条引导按模板
// 创建（GitHub Desktop 对无 ignore 仓库的忽略建议同款事前预防，防构建产物误入
// 版本库乃至被误提交）。三重门控缺一不显示；「不再提示」走 safeStorage 按项目
// 永久记忆。存在性探测用 file-policy（一次 stat；404=缺失，其余错误不误报）；
// 未跟踪数复用全局 changes store（bootstrap/切项目/WS file.changed 已保持新鲜，
// 服务端另有 3s TTL 缓存，不新增扫描开销）。
const changesStore = useChangesStore()
const GITIGNORE_DISMISS_PREFIX = 'sc.gitignoreSuggest.dismissed.'
const gitignoreMissing = ref(false)
const gitignoreDismissed = ref(false)
const showGitignoreModal = ref(false)

async function probeGitignore() {
  const id = projectStore.currentProjectId
  if (!id) { gitignoreMissing.value = false; return }
  try {
    await projectApi.filePolicy(id, '.gitignore', { silent: true })
    gitignoreMissing.value = false // 存在（含空文件）：用户已有明确意图，不打扰
  } catch (e) {
    // 仅 404 视为缺失；网络/服务端瞬时错误保持原状，避免误报
    gitignoreMissing.value = (e as { status?: number } | null)?.status === 404
  }
}

function refreshGitignoreState() {
  const id = projectStore.currentProjectId
  gitignoreDismissed.value = !id || safeStorage.getItem(GITIGNORE_DISMISS_PREFIX + id) === '1'
  void probeGitignore()
}

function dismissGitignoreSuggest() {
  const id = projectStore.currentProjectId
  if (id) safeStorage.setItem(GITIGNORE_DISMISS_PREFIX + id, '1')
  gitignoreDismissed.value = true
}

const untrackedCount = computed(() => changesStore.untrackedFiles.length)
const showGitignoreHint = computed(() =>
  gitignoreMissing.value && !gitignoreDismissed.value && untrackedCount.value > 0,
)

// 选中分支 / 折叠状态：宿主持有（Layout 的 uiState 恢复直接写入本组件 expose 的同一份）
const selectedBranch = ref('')
const collapsedSections = ref<Set<string>>(new Set())
function toggleSection(key: string) {
  if (collapsedSections.value.has(key)) collapsedSections.value.delete(key)
  else collapsedSections.value.add(key)
}

// 分支/远程数据由分节组件自治拉取；此处仅持有「当前分支」卡片所需信息
const currentBranch = ref<{ name: string; isDetached: boolean }>({ name: '', isDetached: false })
const remoteNames = ref<string[]>([])
const branchesRef = ref<InstanceType<typeof GitBranchesSection> | null>(null)

// 远程名列表：初始加载/切项目时主动拉取（设置上游/推送弹窗的远程下拉依赖），
// 之后远程增删由 RemotesSection 的 changed 事件覆盖更新
async function fetchRemoteNames() {
  if (!projectStore.currentProjectId) { remoteNames.value = []; return }
  try {
    const res: any = await remoteApi.list(projectStore.currentProjectId)
    remoteNames.value = (res.data || []).map((r: any) => r.name)
  } catch { /* silent */ }
}
watch(() => projectStore.currentProjectId, () => void fetchRemoteNames(), { immediate: true })

// 当前分支信息（用于顶部卡片）
const currentBranchInfo = computed(() => ({
  name: currentBranch.value.name || 'HEAD',
  isDetached: currentBranch.value.isDetached,
  ahead: props.ahead || 0,
  behind: props.behind || 0,
}))
// 状态行仅在需要提示时显示（detached / 有 ahead/behind），干净分支时不占额外空间
const showStatusRow = computed(() =>
  currentBranchInfo.value.isDetached
  || currentBranchInfo.value.ahead > 0
  || currentBranchInfo.value.behind > 0,
)

// 同步操作：fetch / pull / push——in-flight 记账收口 gitOps store（P-20261005-211，
// per 项目 per 操作类型跨入口共享：顶栏拉取流/分支右键推送/提交连招的飞行中状态
// 同样反映到本面板按钮），快操作 150ms 内不亮 spinner 不抖动
const gitOps = useGitOpsStore()
// 家族闸沿既有语义：任一同步族操作在飞，三钮同禁（非全局锁——commit/stage 等
// 其他面板操作不受影响）
const syncFamilyBusy = computed(() => {
  const pid = projectStore.currentProjectId
  return !!pid && (gitOps.isBusy(pid, 'fetch') || gitOps.isBusy(pid, 'pull') || gitOps.isBusy(pid, 'push'))
})
function opSpinning(op: GitOpType) {
  const pid = projectStore.currentProjectId
  return !!pid && gitOps.spinnerOn(pid, op)
}
const pushNotification = inject<(n: { type: 'success' | 'warning' | 'error' | 'info'; title: string; body?: string; category?: string; action?: string; actionPayload?: string }) => void>('pushNotification')

async function handleQuickFetch() {
  const pid = projectStore.currentProjectId
  if (!pid || syncFamilyBusy.value) return
  gitOps.begin(pid, 'fetch')
  try {
    await remoteApi.fetch(pid, undefined, { errorLabel: 'fetch.fail' })
    message.success(t('layout.fetchSuccess'))
    // fetch 触发频繁，不再写入通知中心；仅 Toast 提示即可
    branchesRef.value?.refresh()
  } catch (e: any) {
    pushNotification?.({ type: 'error', title: t('layout.fetchFail'), body: e?.userMessage })
  }
  finally { gitOps.end(pid, 'fetch') }
}
async function handleQuickPull() {
  const pid = projectStore.currentProjectId
  if (!pid || syncFamilyBusy.value) return
  gitOps.begin(pid, 'pull')
  try {
    // 拦截器解包后运行时值即响应体 { data, newCommits }（useBranchCheckout 同款 cast）
    const res = await remoteApi.pull(projectStore.currentProjectId, undefined, undefined, { errorLabel: 'pull.fail' }) as unknown as { data?: string; newCommits?: number }
    // 结果摘要三档（P-20261003-202，共享分档 utils/pullResult）：N>0 带计数 toast +
    // 通知入账（Action 跳变更面板）；N=0 「已最新」轻提示不入通知中心；
    // 无法计量（旧服务端/空仓）维持既有 branch 名回执不回退
    const n = res?.newCommits
    const summary = pullResultSummary(n)
    if (summary.level === 'info') message.info(t(summary.key))
    else if (summary.params) message.success(t(summary.key, summary.params))
    else message.success(t(summary.key))
    if (n !== undefined && n > 0) {
      pushNotification?.({
        type: 'success',
        title: t('notification.pullDone'),
        body: `${currentBranchInfo.value.name} · ${t('notification.pullCommits', { n })}`,
        category: 'git',
        action: 'panel',
        actionPayload: 'changes',
      })
    } else if (n === undefined || n < 0) {
      pushNotification?.({ type: 'success', title: t('notification.pullDone'), body: currentBranchInfo.value.name })
    }
    branchesRef.value?.refresh()
    // 拉取改变 ahead/behind：立即刷新共享徽标数据——推送预检（confirmPushBehind）
    // 吃同一份值，不刷新会拿旧 behind>0 把紧接着的推送再拦一次
    fetchAllAheadBehind()
    // pull 成功路同样收账（P-20261004-44）：终端侧解决冲突后经任意链路完成合并
    // 的仓库，横幅/操作条在此对齐，不等窗口聚焦/切页时机
    fetchConflictCount()
  } catch (e: any) {
    // 冲突 pull 恰走 catch（git 退出非零 → 服务端 409）：失败路同样收账，
    // 冲突横幅即时亮起——此前滞藏到窗口聚焦/重进面板才出现
    fetchConflictCount()
    pushNotification?.({ type: 'error', title: t('layout.pullFail'), body: e?.userMessage })
    if (isConflictPullError(e)) {
      // 冲突形态失败 → 错误 toast 带「解决冲突」动作直达 ConflictView（按钮形制
      // 同 http.ts 拦截器 toast）；时长放宽给「发现横幅前的快捷入口」留点击窗口
      message.error(() => h('div', { style: 'display: flex; align-items: center; gap: 12px;' }, [
        h('span', null, t('git.pullConflictToast')),
        h(NButton, { size: 'tiny', quaternary: true, onClick: () => { void openConflictFromToast() } }, () => t('git.conflictOpen')),
      ]), { duration: 10000 })
    }
  }
  finally { gitOps.end(pid, 'pull') }
}

// toast 动作 → 冲突面板：显式重拉一次计数再亮面板（面板 v-if 双条件 count>0），
// 防动作先于上方收账完成时点了没反应（竞态下 count 未落地则本次不亮，横幅会兜底）
async function openConflictFromToast() {
  await fetchConflictCount()
  if (conflictCount.value > 0) showConflictPanel.value = true
}

// git 失败恢复直达（P-20261005-194）：拦截器动作 toast「解决冲突」按钮经
// gitFailHint store 送达（git tab 未开时由 useLayoutShell 先开 tab 带起本面板），
// 本面板挂载即消费——重拉冲突计数后就地展开冲突视图（openConflictFromToast
// 同语义收口，P-44 快捷入口之外的统一观测点）。只消费 conflict 类请求；
// pull 归 useLayoutShell，分工不重复清位
const gitFailHintStore = useGitFailHintStore()
watch(() => gitFailHintStore.pending, (req) => {
  if (!req || req.kind !== 'conflict') return
  gitFailHintStore.consume()
  if (isGitFailHintFresh(req)) void openConflictFromToast()
}, { immediate: true })

// ============== 推送前落后预检（P-20261003-10）+ 直推 ==============
// 预检三态弹层与直推执行段已抽至 usePushFlow 共享（P-20261003-84「提交并推送」
// 连招同源复用，预检语义零分叉）；本组件只保留回执面：主操作接本页拉取流，
// 成功 toast + 通知中心 + 分支/徽标刷新，失败交拦截器通用文案（通知中心留痕）。
// 在飞闸在 pushCurrentBranch 内部记 gitOps store（P-20261005-211）：只罩推送
// 请求段（预检弹层自身模态挡操作，且不能误拦拉取流），顶栏/连招推送同账可见
const { precheckBehind, pushCurrentBranch } = usePushFlow()
// 成功回执统一走 usePushPrToast（P-20261005-215）：首推新分支时 toast 附「创建 PR」外链
const { toastPushSuccess } = usePushPrToast()

async function handleQuickPush() {
  if (!projectStore.currentProjectId || syncFamilyBusy.value) return
  const flow = await precheckBehind(() => props.behind ?? 0)
  if (flow === 'pull-first') { await handleQuickPull(); return } // 主操作：先去拉取
  if (flow === 'dismissed') return // 关闭弹层：不推不拉
  const outcome = await pushCurrentBranch()
  if (outcome.action === 'failed') {
    pushNotification?.({ type: 'error', title: t('layout.pushFail'), body: outcome.reason })
    return
  }
  toastPushSuccess(outcome.newBranch)
  pushNotification?.({ type: 'success', title: t('notification.pushDone'), body: currentBranchInfo.value.name })
  branchesRef.value?.refresh()
  fetchAllAheadBehind()
}

// 远程增删后刷新分支集合（远程分支跟随 remote 变化）
function onRemotesChanged(names: string[]) {
  remoteNames.value = names
  branchesRef.value?.refresh()
}

// ============== 冲突全解后的操作条（继续/中止变基、完成合并） ==============
// 操作条只在「变基/合并进行中 且 冲突数=0」时出现；cherry-pick 无对应端点不给出入口
const opBarMode = computed(() =>
  gitOperation.value === 'rebase' || gitOperation.value === 'merge' ? gitOperation.value : '',
)
const rebaseActing = ref<'' | 'continue' | 'abort'>('')

// 变基收尾动作后的统一对齐：重拉冲突/操作状态（continue 可能停在下一段冲突 →
// 横幅重现；完成则操作条消失），并刷新分支/提交列表（rebase 改写了提交历史）；
// 工作区文件被 rebase 重写，广播外部变更让打开中的编辑器标签重读
async function settleAfterOpAction() {
  await Promise.all([
    fetchConflictCount(),
    branchesRef.value?.refresh(),
    commitsRef.value?.refresh(),
  ])
  window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
}

async function handleRebaseContinue() {
  if (!projectStore.currentProjectId || rebaseActing.value) return
  rebaseActing.value = 'continue'
  try {
    await rebaseApi.continue(projectStore.currentProjectId)
    message.success(t('rebase.rebaseContinued'))
  } catch {
    // 常见失败态：又停在下一段冲突 / 暂存区无变更——拦截器已弹后端原文，
    // 此处不重复提示，finally 的重拉会把横幅/操作条对齐到最新仓库状态
  } finally {
    rebaseActing.value = ''
    await settleAfterOpAction()
  }
}

async function handleRebaseAbort() {
  if (!projectStore.currentProjectId || rebaseActing.value) return
  // 中止丢弃变基进度并回退工作区，破坏性动作须确认
  const ok = await confirmDialog({
    title: t('git.rebaseAbortTitle'),
    content: t('git.rebaseAbortConfirm'),
    type: 'warning',
    confirmText: t('git.abortRebase'),
  })
  if (!ok) return
  rebaseActing.value = 'abort'
  try {
    await rebaseApi.abort(projectStore.currentProjectId)
    message.success(t('rebase.rebaseAborted'))
  } catch { /* 拦截器处理 */ }
  finally {
    rebaseActing.value = ''
    await settleAfterOpAction()
  }
}

// ============== 分支/标签刷新（含远程） ==============
// 用户诉求：远程新增分支/tag 后列表看不到——先 fetch（--prune --tags，后端固定携带）
// 拉取远端 refs，再刷新分支/标签列表与提交面板的分支下拉
const commitsRef = ref<InstanceType<typeof CommitsPanel> | null>(null)
const refreshingRefs = ref(false)
async function handleRefreshRefs() {
  const pid = projectStore.currentProjectId
  if (!pid || refreshingRefs.value) return
  // fetch 段同记 gitOps store（P-20261005-211）：与快捷 fetch/顶栏 fetch 同账
  // 去重——已在飞行中再点击静默忽略，不叠加网络请求
  if (!gitOps.tryBegin(pid, 'fetch')) return
  refreshingRefs.value = true
  try {
    await remoteApi.fetch(pid, undefined, { errorLabel: 'fetch.fail' })
    message.success(t('layout.fetchSuccess'))
    await Promise.all([
      branchesRef.value?.refresh(),
      commitsRef.value?.refresh(),
    ])
  } catch (e: any) {
    // fetch 失败（离线/凭据失效）时本地列表仍然刷新一次，保底展示当前仓库状态
    pushNotification?.({ type: 'error', title: t('layout.fetchFail'), body: e?.userMessage })
    await Promise.all([
      branchesRef.value?.refresh(),
      commitsRef.value?.refresh(),
    ])
  } finally {
    refreshingRefs.value = false
    gitOps.end(pid, 'fetch')
    // 手动链完成了一次同等数据拉取：对齐 focus/视图切回的节流窗口（P-20261004-39）
    focusRefresh.markRefreshed()
  }
}

// ============== 挂载期外部变更感知（P-20261004-39） ==============
// 挂载持续期间仓库可被产品 API 之外的手段修改（agent 会话在另一视图跑 git、外部
// IDE 双开、终端 CLI），面板零感知——branch.changed/file.changed 只覆盖经产品 API
// 的操作，sc:git-panel-autorefresh 三感知链只覆盖本产品终端会话；bottomTab 切走再
// 切回由 BottomPanel v-if 重挂载天然重取，盲区恰在挂载持续期间。三个轻量前端触发
// 汇入 >10s 节流静默重取（分支/提交/冲突状态，服务端零改动）：
// ① window focus + visibilitychange(visible)——外部 IDE 双开与切走回来的全场景；
// ② 主区编辑器视图切回 + 编辑器活跃 tab 变化——主区各视图 v-show 保活，本组件
//    全程挂载零感知视图翻转；agent 会话（docked/float/mini）/远程控制台/分享/dsh
//    是模块级单例可直接订阅，活跃文件 tab 经 useLayoutBridge 注入共享实例路径
//    （useOpenFiles per-call 单例，生产调用点唯一在 useLayoutShell，不得自建实例）；
// ③ 底部面板关闭再重开——BottomPanel 根是 v-show，隐藏不卸载，重开无重挂重取。
async function silentRefreshRefs() {
  if (!projectStore.currentProjectId || refreshingRefs.value) return
  refreshingRefs.value = true
  try {
    await Promise.all([
      branchesRef.value?.refresh(),
      commitsRef.value?.refresh(),
      fetchConflictCount(),
    ])
  } finally {
    refreshingRefs.value = false
  }
}
const focusRefresh = useGitPanelFocusRefresh(silentRefreshRefs)

// ② 主区呈现键：任一互斥视图翻转或活跃 tab 变化即用户可见的「看什么」切换。
// 只在切回编辑器面（editor: 前缀）时重取——切走不刷，防快速往返（<10s）把节流
// 窗口打新，回来看不到 agent 刚落盘的变更（恰是本提案的目标场景）
const sharedActiveEditorPath = inject<Ref<string>>('sharedActiveEditorPath', ref(''))
const { visible: agentVisible, mode: agentMode } = useAgentTerminal()
const layout = usePanelLayout()
const editorPresentKey = computed(() => {
  if (agentVisible.value) return `agent:${agentMode.value}`
  if (layout.showRemoteConsole.value) return 'remote-console'
  if (layout.showShareManager.value) return 'share-manager'
  if (layout.showDshConsole.value) return 'dsh-console'
  return `editor:${sharedActiveEditorPath.value}`
})
watch(editorPresentKey, (nv) => {
  if (!nv.startsWith('editor:')) return
  focusRefresh.maybeRefresh()
})

// ③ 底部面板重开（v-show false→true）：与 focus 共用同一节流链静默刷新
watch(() => layout.showBottomPanel.value, (nv, ov) => {
  if (nv && !ov) focusRefresh.maybeRefresh()
})

// ① 窗口聚焦/转回可见刷新（97299fec 同款韧性模式 + P-20261004-39）：冲突计数在
// 挂载/切项目时机上与 Layout bootstrap 的异步恢复链存在竞态（恢复链改写
// projectId 同值时 watch 不触发），聚焦重拉让任何瞬态陈旧在用户回到窗口时自愈；
// 分支/提交列表走上方节流静默重取（冲突计数高频轻量不设节流，维持既有行为）
function onWindowFocusOrVisible() {
  // visibilitychange 对 hidden/visible 双向触发：只在转回可见时走重取链
  if (document.visibilityState !== 'visible') return
  fetchConflictCount()
  refreshGitignoreState()
  focusRefresh.maybeRefresh()
}
onMounted(() => {
  window.addEventListener('focus', onWindowFocusOrVisible)
  document.addEventListener('visibilitychange', onWindowFocusOrVisible)
  conflictRetryUsed = false
  fetchConflictCount()
  refreshGitignoreState()
  // 挂载链自会首拉（子面板 immediate + 本函数冲突计数）：节流窗口自此刻起算
  focusRefresh.markRefreshed()
})
onBeforeUnmount(() => {
  window.removeEventListener('focus', onWindowFocusOrVisible)
  document.removeEventListener('visibilitychange', onWindowFocusOrVisible)
  clearConflictRetry()
})
watch(() => projectStore.currentProjectId, () => { conflictRetryUsed = false; fetchConflictCount(); showConflictPanel.value = false; refreshGitignoreState(); focusRefresh.markRefreshed() })

defineExpose({ collapsedSections, selectedBranch })
</script>

<template>
  <div class="git-panel">
    <!-- 分支侧边栏（宽度可拖拽调整，会话内有效） -->
    <div
      v-if="showSidebar"
      class="git-sidebar"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <div class="sidebar-header">
        <span>{{ t('git.branches') }}</span>
        <div style="display: flex; align-items: center; gap: 2px">
          <button
            class="sidebar-toggle"
            :title="t('git.refreshBranches')"
            :disabled="refreshingRefs"
            @click="handleRefreshRefs"
          >
            <n-icon
              size="13"
              data-icon-action="common.refresh"
              :class="{ 'is-spinning': refreshingRefs }"
            >
              <RefreshOutline />
            </n-icon>
          </button>
          <button
            class="sidebar-toggle"
            :title="t('git.branchCleanup.title')"
            data-testid="branch-cleanup-open"
            @click="showBranchCleanup = true"
          >
            <n-icon size="13">
              <TrashOutline />
            </n-icon>
          </button>
          <button
            class="sidebar-toggle"
            :title="t('git.changelog.title')"
            data-testid="changelog-open"
            @click="showChangelogModal = true"
          >
            <n-icon size="13">
              <DocumentTextOutline />
            </n-icon>
          </button>
          <button
            class="sidebar-toggle"
            :title="t('manage.title')"
            @click="showManageModal = true"
          >
            <n-icon size="13">
              <BuildOutline />
            </n-icon>
          </button>
          <button
            class="sidebar-toggle"
            :title="t('git.collapseSidebar')"
            @click="showSidebar = false"
          >
            ◀
          </button>
        </div>
      </div>

      <!-- 当前分支卡片（紧凑：主行始终显示，状态行仅在有变更/detached 时出现） -->
      <div class="current-branch-card">
        <div class="cbc-row">
          <n-icon
            size="13"
            class="cbc-icon"
          >
            <GitBranchOutline />
          </n-icon>
          <span
            class="cbc-name"
            :title="currentBranchInfo.isDetached ? t('git.detachedHeadTitle') : currentBranchInfo.name"
          >{{ currentBranchInfo.name }}</span>
          <div class="cbc-actions">
            <button
              class="cbc-btn"
              :title="t('layout.fetch')"
              :disabled="syncFamilyBusy"
              @click="handleQuickFetch"
            >
              <n-icon
                size="12"
                data-icon-action="git.fetch"
                :class="{ 'is-spinning': opSpinning('fetch') }"
              >
                <CloudDownloadOutline />
              </n-icon>
            </button>
            <button
              class="cbc-btn"
              :title="t('layout.pull')"
              :disabled="syncFamilyBusy"
              @click="handleQuickPull"
            >
              <n-icon
                size="12"
                data-icon-action="git.pull"
                :class="{ 'is-spinning': opSpinning('pull') }"
              >
                <ArrowDownCircleOutline />
              </n-icon>
            </button>
            <button
              class="cbc-btn"
              :title="t('layout.push')"
              :disabled="syncFamilyBusy"
              @click="handleQuickPush"
            >
              <n-icon
                size="12"
                data-icon-action="git.push"
                :class="{ 'is-spinning': opSpinning('push') }"
              >
                <CloudUploadOutline />
              </n-icon>
            </button>
          </div>
        </div>
        <div
          v-if="showStatusRow"
          class="cbc-stats"
        >
          <span
            v-if="currentBranchInfo.isDetached"
            class="cbc-detached"
          >{{ t('git.detached') }}</span>
          <template v-else>
            <span
              v-if="currentBranchInfo.ahead > 0"
              class="cbc-ahead"
              :title="t('git.aheadTooltip')"
            >
              <n-icon size="11"><CloudUploadOutline /></n-icon> {{ currentBranchInfo.ahead }}
            </span>
            <span
              v-if="currentBranchInfo.behind > 0"
              class="cbc-behind"
              :title="t('git.behindTooltip')"
            >
              <n-icon size="11"><CloudDownloadOutline /></n-icon> {{ currentBranchInfo.behind }}
            </span>
          </template>
        </div>
      </div>

      <div class="sidebar-list">
        <!-- 分支/标签（数据与右键动作自治，选中分支上抛宿主）；
             工作树经插槽紧随本地分节之后，其余分节（远程分组/标签）顺延 -->
        <GitBranchesSection
          ref="branchesRef"
          :selected-branch="selectedBranch"
          :collapsed-sections="collapsedSections"
          :remote-names="remoteNames"
          @select="(name: string) => selectedBranch = name"
          @toggle-section="toggleSection"
          @conflict-activity="fetchConflictCount"
        >
          <template #after-local>
            <!-- Worktrees（数据与弹窗/右键自治） -->
            <GitWorktreesSection />
          </template>
        </GitBranchesSection>

        <!-- Remotes（增删后回传名字并联动分支刷新） -->
        <GitRemotesSection @changed="(names: string[]) => onRemotesChanged(names)" />
      </div>
    </div>

    <!-- 侧栏宽度拖拽条 -->
    <div
      v-if="showSidebar"
      class="git-sidebar-resizer"
      @mousedown="startSidebarResize"
    />

    <!-- 主内容区 -->
    <div class="git-main">
      <div
        v-if="!showSidebar"
        class="main-header-bar"
      >
        <button
          class="sidebar-toggle"
          :title="t('git.showBranches')"
          @click="showSidebar = true"
        >
          ▶
        </button>
        <button
          class="sidebar-toggle"
          :title="t('manage.title')"
          style="margin-left: 4px"
          @click="showManageModal = true"
        >
          <n-icon size="13">
            <BuildOutline />
          </n-icon>
        </button>
        <button
          class="sidebar-toggle"
          :title="t('git.changelog.title')"
          data-testid="changelog-open"
          @click="showChangelogModal = true"
        >
          <n-icon size="13">
            <DocumentTextOutline />
          </n-icon>
        </button>
      </div>
      <!-- 冲突横幅：merge/rebase 产生冲突时提示，点击就地切换到冲突面板。
           不再点击时重拉 count：瞬时 0（status 竞态）会触发自动收起把刚打开
           的面板立刻关上；面板数据由 ConflictView 自行拉取 -->
      <button
        v-if="conflictCount > 0"
        class="conflict-banner"
        :class="{ active: showConflictPanel }"
        @click="showConflictPanel = !showConflictPanel"
      >
        <span class="conflict-badge">{{ conflictCount }}</span>
        <span>{{ t('git.conflictBanner', { count: conflictCount }) }}</span>
        <span class="conflict-action">{{ showConflictPanel ? t('git.conflictBackCommits') : t('git.conflictOpen') }}</span>
      </button>
      <!-- 冲突全解后的收尾操作条：变基/合并仍在进行（rebase-merge/MERGE_HEAD 残留）
           且冲突数=0 时出现——继续/中止变基，或提示走既有提交流程完成合并。
           置于 ConflictView/CommitsPanel 的 v-if/v-else 链之前：两者互斥条件互补
           （操作条 count=0，冲突面板 count>0），不会同时出现 -->
      <div
        v-if="conflictCount === 0 && opBarMode"
        class="git-op-bar"
      >
        <span class="op-hint">{{ opBarMode === 'rebase' ? t('git.rebaseOpBarHint') : t('git.mergeOpBarHint') }}</span>
        <template v-if="opBarMode === 'rebase'">
          <button
            class="op-btn primary"
            :disabled="!!rebaseActing"
            @click="handleRebaseContinue"
          >
            {{ t('git.continueRebase') }}
          </button>
          <button
            class="op-btn danger"
            :disabled="!!rebaseActing"
            @click="handleRebaseAbort"
          >
            {{ t('git.abortRebase') }}
          </button>
        </template>
      </div>
      <!-- .gitignore 创建建议条：项目根无 .gitignore 且有未跟踪路径时的弱提示
           （与冲突横幅同位同族、蓝色系 = 建议而非告急），按模板创建 / 不再提示 -->
      <div
        v-if="showGitignoreHint"
        class="gitignore-hint-bar"
        data-testid="gitignore-hint-bar"
      >
        <span class="gitignore-hint-text">{{ t('git.ignoreSuggest.hint', { count: untrackedCount }) }}</span>
        <button
          class="op-btn primary"
          data-testid="gitignore-hint-create"
          @click="showGitignoreModal = true"
        >
          {{ t('git.ignoreSuggest.create') }}
        </button>
        <button
          class="op-btn"
          data-testid="gitignore-hint-dismiss"
          @click="dismissGitignoreSuggest"
        >
          {{ t('git.ignoreSuggest.dismiss') }}
        </button>
      </div>
      <ConflictView
        v-if="showConflictPanel && conflictCount > 0"
        @all-resolved="fetchConflictCount"
      />
      <CommitsPanel
        v-else
        ref="commitsRef"
        :selected-branch="selectedBranch"
        @open-diff="(f: any) => emit('open-diff', f)"
      />
    </div>

    <!-- 仓库管理（子模块 / GPG / LFS / Hooks） -->
    <GitManageModal v-model:show="showManageModal" />
    <!-- 清理已合并分支向导：自含数据链路，清理后刷新分支树 -->
    <GitBranchCleanupModal
      v-model:show="showBranchCleanup"
      @cleaned="branchesRef?.refresh()"
    />
    <!-- 变更日志草稿弹层（tag..HEAD 分组聚合，数据链路自含） -->
    <ChangelogDraftModal v-model:show="showChangelogModal" />
    <!-- .gitignore 模板创建弹层（created 后 missing 复位，提示条随之消失） -->
    <GitignoreTemplateModal
      v-model:show="showGitignoreModal"
      @created="gitignoreMissing = false"
    />
  </div>
</template>

<style scoped>
.git-panel { height: 100%; display: flex; }
.git-sidebar {
  width: 180px; flex-shrink: 0; border-right: 1px solid var(--border-default);
  display: flex; flex-direction: column; background: var(--bg-primary);
}
/* git 侧栏宽度把手：命中区 8px + 常显竖向握把纹（与全局把手同设计语言） */
.git-sidebar-resizer {
  width: 8px; flex-shrink: 0; cursor: col-resize;
  background: transparent; transition: background var(--motion-base);
  position: relative;
}
.git-sidebar-resizer::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0; left: 50%;
  width: 2px; transform: translateX(-50%);
  border-radius: 1px;
  background: var(--border-default);
  opacity: 0.6;
  transition: background var(--motion-base), opacity var(--motion-base);
}
.git-sidebar-resizer:hover {
  background: color-mix(in srgb, var(--accent-blue) 14%, transparent);
}
.git-sidebar-resizer:hover::after {
  background: var(--accent-blue); opacity: 1;
}
.sidebar-header {
  height: 28px; padding: 0 var(--space-2); background: var(--bg-panel); border-bottom: 1px solid var(--border-default);
  display: flex; align-items: center; justify-content: space-between;
  font-size: max(var(--fs-section-min, 12px), 0.85em); font-weight: var(--fw-medium); color: var(--text-secondary); flex-shrink: 0;
}
.sidebar-toggle {
  border: none; background: transparent; color: var(--text-secondary); cursor: pointer;
  padding: 2px var(--space-1); border-radius: var(--radius-sm); font-size: max(var(--fs-meta-min, 11.5px), 0.8em);
}
.sidebar-toggle:hover { background: var(--border-default); color: var(--text-primary); }
.sidebar-toggle:disabled { opacity: 0.5; cursor: not-allowed; }
/* 刷新中图标旋转（分支/标签刷新按钮 + 快捷 fetch/pull/push 进行中反馈，P-20261005-211） */
.is-spinning { animation: git-ref-spin 0.9s linear infinite; }
@keyframes git-ref-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* 冲突横幅：merge/rebase 产生冲突时在主内容区顶部提示，点击切换冲突面板/提交面板 */
.conflict-banner {
  display: flex; align-items: center; gap: var(--space-2); width: 100%;
  padding: 5px 10px; border: none; cursor: pointer;
  background: color-mix(in srgb, var(--accent-red) 12%, var(--bg-panel));
  border-bottom: 1px solid var(--border-default);
  color: var(--text-body); font-size: max(var(--fs-meta-min, 11.5px), 0.88em); text-align: left;
}
.conflict-banner:hover { background: color-mix(in srgb, var(--accent-red) 20%, var(--bg-panel)); }
.conflict-banner.active { background: color-mix(in srgb, var(--accent-red) 24%, var(--bg-panel)); }
.conflict-badge {
  background: var(--accent-red); color: var(--text-on-accent); border-radius: var(--radius-lg);
  min-width: 18px; height: 18px; line-height: 18px; text-align: center;
  font-size: max(var(--fs-meta-min, 11.5px), 0.85em); font-weight: var(--fw-semibold); flex-shrink: 0; padding: 0 var(--space-1);
}
.conflict-action { margin-left: auto; color: var(--text-dim); font-size: max(var(--fs-meta-min, 11.5px), 0.9em); flex-shrink: 0; }

/* 冲突全解后的收尾操作条：与冲突横幅同位同级（绿色系 = 收尾而非告急） */
.git-op-bar {
  display: flex; align-items: center; gap: var(--space-2); width: 100%;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--accent-green) 10%, var(--bg-panel));
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.op-hint { font-size: max(var(--fs-meta-min, 11.5px), 0.85em); color: var(--text-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.op-btn {
  border: 1px solid var(--border-default); border-radius: var(--radius-sm); cursor: pointer;
  padding: 2px 10px; font-size: max(var(--fs-meta-min, 11.5px), 0.82em); background: var(--bg-surface);
  color: var(--text-secondary); flex-shrink: 0; transition: all var(--motion-base);
}
.op-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.op-btn.primary { border-color: var(--accent-green); color: var(--accent-green); }
.op-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-green) 16%, var(--bg-surface)); }
.op-btn.danger:hover:not(:disabled) { border-color: var(--accent-red); color: var(--accent-red); }

/* .gitignore 创建建议条：与冲突横幅/收尾操作条同位同族（非阻塞弱提示，蓝色系），
   按钮复用 op-btn 形制（primary 在此条域内为品牌蓝而非绿色，局部覆盖） */
.gitignore-hint-bar {
  display: flex; align-items: center; gap: var(--space-2); width: 100%;
  padding: 5px 10px;
  background: color-mix(in srgb, var(--accent-blue) 10%, var(--bg-panel));
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.gitignore-hint-text {
  font-size: max(var(--fs-meta-min, 11.5px), 0.85em); color: var(--text-body); flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gitignore-hint-bar .op-btn.primary { border-color: var(--accent-blue); color: var(--accent-blue); }
.gitignore-hint-bar .op-btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent-blue) 16%, var(--bg-surface)); }

/* 当前分支卡片（紧凑：主行 + 可选状态行） */
.current-branch-card {
  padding: 5px var(--space-2);
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(180deg, var(--brand-accent-soft) 0%, transparent 100%);
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex-shrink: 0;
}
.cbc-row { display: flex; align-items: center; gap: 5px; }
.cbc-icon { color: var(--brand-accent); flex-shrink: 0; }
.cbc-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.cbc-stats {
  display: flex;
  gap: var(--space-2);
  font-size: var(--fs-meta-min, 11.5px);
  font-family: var(--font-mono);
  padding-left: 18px;
}
.cbc-ahead { color: var(--accent-green); display: inline-flex; align-items: center; gap: 3px; }
.cbc-behind { color: var(--accent-orange); display: inline-flex; align-items: center; gap: 3px; }
.cbc-detached { color: var(--accent-yellow-warm); font-style: italic; }
.cbc-actions { display: flex; gap: 3px; margin-left: auto; flex-shrink: 0; }
.cbc-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  width: 22px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--motion-base);
  padding: 0;
}
.cbc-btn:hover:not(:disabled) {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}
.cbc-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.sidebar-list { flex: 1; overflow-y: auto; }
.git-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main-header-bar {
  height: 24px; padding: 0 var(--space-1); background: var(--bg-panel); border-bottom: 1px solid var(--border-default);
  display: flex; align-items: center; flex-shrink: 0;
}
</style>
