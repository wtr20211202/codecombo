import { computed, inject, reactive, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { logApi, commitApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useGitOpsStore } from '../stores/gitOps'
import type { FileStatus } from '../stores/changes'
import { useI18n } from './useI18n'
import { useCommitAgentMsg } from './useCommitAgentMsg'
import type { CommitMsgFileEntry } from './useCommitAgentMsg'
import type { AgentMark } from './useAgentMarks'
import { useCommitSplitSuggest } from './useCommitSplitSuggest'
import { usePushFlow } from './usePushFlow'
import { usePushPrToast } from './usePushPrToast'
import { useAgentFix } from './useAgentFix'
import { confirmCommitGateFix } from './useDialog'
import { validateCommitMsg, COMMIT_MSG_MAX_LEN } from '../utils/commitMsgRules'
import type { CommitMsgViolation } from '../utils/commitMsgRules'

/**
 * 变更面板「提交操作区」的全部逻辑（自 CommitPanel.vue 拆出，P-20261003-143）：
 * 提交消息（store 草稿）/ Conventional Commit 工具栏 / 修补上次提交（amend）/
 * 提交消息历史 / 生成提交信息 / 拆分建议 / 提交落库 / 「提交并推送」连招 /
 * 全选与暂存全部 / Ctrl+Enter 快捷提交。
 *
 * 由面板宿主（CommitPanel）在 setup 期调用一次——状态挂在面板实例上而非
 * CommitActionArea 子组件上：changes 页签内容在 v-if 下，切 stash 页签会卸载
 * 子组件，CC 字段/amend 勾选等若由子组件自持会在往返后丢 draft（拆分前不丢）。
 * 返回 reactive 面板：CommitActionArea 模板内的读写经代理解包，v-model 写入
 * 直接路由回这里的 ref/computed（commitMessage 即 store 草稿）。
 */
export function useCommitActions(options: {
  /** 提交勾选集（面板级状态：变更树勾选框与提交范围同源） */
  selectedForCommit: Ref<Set<string>>
  /** 面板全量变更（performCommit 校验暂存集、生成消息清单同口径） */
  allFiles: Ref<FileStatus[]>
  /** agent marks 归属面（P-20261005-172，面板宿主 useAgentMarks 同一实例传入）：
   *  生成提交信息 prompt 附「其中 N 个文件来自 agent 会话改动」一行先验；
   *  缺省 = 无归属行（既有调用方零变化） */
  agentMarks?: { value: Map<string, AgentMark> }
}) {
  const { selectedForCommit, allFiles } = options
  const message = useMessage()
  const { t } = useI18n()
  const projectStore = useProjectStore()
  const changesStore = useChangesStore()
  // commit/stage 在飞记账（P-20261005-211）：按钮 loading + 去重闸收口 store，
  // 跨入口（本面板/快捷键/其他面板的 git 按钮）共享可见
  const gitOps = useGitOpsStore()

  // commitMessage 从 store 取，跨面板位置切换时保留草稿
  const commitMessage = computed({
    get: () => changesStore.commitMessage,
    set: (v: string) => { changesStore.commitMessage = v },
  })

  // 提交消息历史（后端 /log/recent-messages，最近 20 条主题行）：一键回填消息框。
  // 历史下拉仅在确有历史时显示（空历史隐藏入口，避免空下拉）
  const recentMsgs = ref<string[]>([])
  async function loadRecentMessages(): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    try {
      const res = await logApi.getRecentMessages(pid) as unknown as { data?: string[] }
      recentMsgs.value = (res?.data as string[]) || []
    } catch {
      recentMsgs.value = []
    }
  }
  const recentMsgOptions = computed(() =>
    recentMsgs.value.map((m, i) => ({
      label: m.length > 60 ? m.slice(0, 60) + '…' : m,
      key: String(i),
    })),
  )
  function applyRecentMessage(key: string | number): void {
    const msg = recentMsgs.value[Number(key)]
    if (msg !== undefined) commitMessage.value = msg
  }

  // 修补上次提交（amend）：一次性标志，不持久化——改写历史类操作不跨会话记住
  const amendLastCommit = ref(false)
  // 勾选 amend 时的草稿备份：取消勾选时还原（回填的 HEAD 消息不该留在输入框）
  let preAmendDraft = ''
  async function onAmendToggle(checked: boolean) {
    if (!checked) {
      commitMessage.value = preAmendDraft
      return
    }
    preAmendDraft = commitMessage.value
    if (!projectStore.currentProjectId) { amendLastCommit.value = false; return }
    try {
      // 回填 HEAD 完整消息（%B 含多行 body）。空仓库（P-20261003-300 起 /log 对
      // 零提交返回 200 空列表 + emptyRepo 标志，不再 500）：无 HEAD 可修补 →
      // 回弹 + 本地化警告（原 500 catch 分支的同等反馈，语义随 API 修正迁移）
      const res = await logApi.getLog(projectStore.currentProjectId, { limit: 1 })
      const headBody = res.data?.[0]?.body
      if (!headBody) {
        amendLastCommit.value = false
        message.warning(t('commitPanel.amendNoHead'))
        return
      }
      commitMessage.value = headBody
    } catch {
      amendLastCommit.value = false
      message.warning(t('commitPanel.amendNoHead'))
    }
  }

  // Conventional Commit 类型与作用域
  const ccTypes = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const
  const selectedCcType = ref('')
  const ccScope = ref('')
  const includeBreaking = ref(false)
  const ccFooter = ref('')
  const showCcAdvanced = ref(false)

  function applyCcType(type: string) {
    // 切换或取消
    if (selectedCcType.value === type) {
      selectedCcType.value = ''
    } else {
      selectedCcType.value = type
    }
    syncCcToMessage()
  }

  // 解析当前 commitMessage，回填 Conventional 字段（首次输入或粘贴时）
  function parseCcFromMessage() {
    const m = commitMessage.value.match(/^(\w+)(\(([^)]+)\))?(!)?:\s*(.*)$/)
    if (m) {
      selectedCcType.value = (ccTypes as readonly string[]).includes(m[1]!) ? m[1]! : ''
      ccScope.value = m[3] || ''
      includeBreaking.value = m[4] === '!'
    }
  }

  // 将 Conventional 字段拼到消息前面（保留消息主体）
  function syncCcToMessage() {
    const current = commitMessage.value
    // 剥离已有的 CC 前缀
    const stripped = current.replace(/^(\w+)(\([^)]+\))?(!)?:\s*/, '')
    const parts: string[] = []
    if (selectedCcType.value) {
      let prefix = selectedCcType.value
      if (ccScope.value.trim()) prefix += `(${ccScope.value.trim()})`
      if (includeBreaking.value) prefix += '!'
      parts.push(prefix + ':')
    }
    parts.push(stripped || '')
    commitMessage.value = parts.join(' ').trim()
  }

  function appendFooter() {
    if (!ccFooter.value.trim()) return
    const footer = ccFooter.value.trim()
    const current = commitMessage.value
    if (current.includes(footer)) return
    commitMessage.value = current + (current.endsWith('\n') ? '' : '\n') + '\n' + footer
    ccFooter.value = ''
  }

  watch(commitMessage, () => {
    // 用户手动输入时尝试回填字段（避免循环：仅在无 type 时回填）
    if (!selectedCcType.value) parseCcFromMessage()
  })

  const stagedCount = computed(() => allFiles.value.filter(f => f.staged).length)
  const unstagedCount = computed(() => allFiles.value.filter(f => !f.staged).length)
  const allSelected = computed(() => {
    const staged = allFiles.value.filter(f => f.staged)
    return staged.length > 0 && staged.every(f => selectedForCommit.value.has(f.path))
  })
  const commitCount = computed(() => {
    const sel = selectedForCommit.value.size
    return sel > 0 ? sel : stagedCount.value
  })

  function toggleSelectAll() {
    const staged = allFiles.value.filter(f => f.staged)
    if (allSelected.value) {
      selectedForCommit.value.clear()
    } else {
      for (const f of staged) selectedForCommit.value.add(f.path)
    }
  }

  // 「生成提交信息」（P-20261002-138）：暂存清单经 createAgentTerminal 链路发起
  // agent 会话起草（结果在会话中产出，不自动回填提交框——人审复制）。清单 = 提交
  // 所涉文件：勾选子集优先（与 handleCommit 的 filesParam 同口径），未勾选 =
  // 全部暂存
  const { generateCommitMsg, launching: agentMsgLaunching } = useCommitAgentMsg()
  const commitMsgTargets = computed<CommitMsgFileEntry[]>(() => {
    const staged = allFiles.value.filter(f => f.staged)
    const picked = staged.filter(f => selectedForCommit.value.has(f.path))
    return (picked.length > 0 ? picked : staged).map(f => ({ path: f.path, status: f.status, oldPath: f.oldPath }))
  })
  async function handleGenerateCommitMsg() {
    // 点击时读 marks 现值（面板宿主传入同一 useAgentMarks 实例，PR 描述/补测试同源）
    await generateCommitMsg(commitMsgTargets.value, options.agentMarks?.value)
  }

  // 「拆分建议」（P-20261003-186）：与生成提交信息同口径的暂存清单（勾选子集
  // 优先，未勾选 = 全部暂存），发起 agent 会话产出「分组方案」（组名/文件清单/
  // commit 主题）——输出纯建议，逐组 stage/commit 由人工执行（安全边界）
  const { suggestCommitSplit, launching: splitSuggestLaunching } = useCommitSplitSuggest()
  async function handleSuggestCommitSplit() {
    await suggestCommitSplit(commitMsgTargets.value)
  }

  async function handleStageAll() {
    const pid = projectStore.currentProjectId
    if (!pid) return
    const paths = allFiles.value.filter(f => !f.staged).map(f => f.path)
    if (paths.length === 0) return
    // 去重闸（P-20261005-211）：暂存已在飞行中再触发静默拦下（按钮 disabled 为
    // 主闸，此处兜底连点/编程触发），不叠加 stage 请求
    if (!gitOps.tryBegin(pid, 'stage')) { message.warning(t('git.opsBusyToast')); return }
    try { await changesStore.stageFiles(pid, paths) }
    catch { /* 拦截器处理 */ }
    finally { gitOps.end(pid, 'stage') }
  }

  // 切项目落闸：commitMessage 草稿跨项目共享，amend 自动回填会放大
  // 「A 项目 HEAD 信息被带进 B 项目」的风险——切换时落闸并还原勾选前草稿；
  // 未勾选时不介入，保持既有的跨项目草稿语义
  watch(() => projectStore.currentProjectId, () => {
    if (!amendLastCommit.value) return
    amendLastCommit.value = false
    commitMessage.value = preAmendDraft
  })

  // ============== commit.template 模板预填（P-20261003-172） ==============
  // git config commit.template 是提交模板惯例（团队规范载体）：git commit 命令行
  // 自动把模板文件预填进编辑器，本产品 -m 直提不读模板，规范在产品里丢失。
  // 面板挂载与切项目时拉一次模板内容，仅**空态**写入——用户草稿/最近消息回填/
  // amend 回填优先，绝不覆盖既有输入（与空态判定字面同义：非空即跳过）；
  // 未配置/读取失败服务端统一返回空串，静默跳过零提示（模板缺失是常态）
  async function loadCommitTemplate(): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    try {
      const res = await commitApi.getTemplate(pid) as unknown as { data?: { template?: string } }
      const template = res?.data?.template || ''
      // 竞态防陈旧：await 期间切了项目，旧项目的模板不写进新项目的框
      if (!template || projectStore.currentProjectId !== pid) return
      if (commitMessage.value.trim()) return
      commitMessage.value = template
    } catch { /* 模板尽力而为，失败静默 */ }
  }
  // immediate 覆盖面板挂载（项目页进入时项目已选定），此后随切项目跟随拉取
  watch(() => projectStore.currentProjectId, (pid) => {
    if (pid) void loadCommitTemplate()
  }, { immediate: true })

  // ============== 提交信息门禁（P-20261003-273） ==============
  // scripts/check-commit-msg.cjs（P-20261002-92 门禁）规则的客户端预检：提交
  // 前核验标题行 <type>(<scope>)?: <标题>，违规弹「失败原因 + 交给智能体修」
  // 弹层（失败原因结构化进 prompt 经 launchArgs 预填，agent 改写合规信息，
  // 人审后回填提交框重试）；「仍要提交」为显式旁路——非规范项目的一键豁免，
  // 保证通用 git 客户端不被本仓惯例硬阻断。
  const { handToAgent } = useAgentFix()
  function gateReasonLine(v: CommitMsgViolation): string {
    switch (v.rule) {
      case 'format': return t('commit.gateFix.ruleFormat')
      case 'type': return t('commit.gateFix.ruleType', { type: v.type ?? '' })
      case 'scope': return t('commit.gateFix.ruleScope')
      case 'subject': return t('commit.gateFix.ruleSubject')
      case 'length': return t('commit.gateFix.ruleLength', { len: v.len ?? 0, max: v.max ?? COMMIT_MSG_MAX_LEN })
    }
  }
  /** 门禁预检：返回是否放行落库。agent/取消两出口都中止本轮提交（草稿保留
   *  在提交框，合规信息回填后重试即过闸） */
  async function commitMsgGatePass(): Promise<boolean> {
    const violations = validateCommitMsg(commitMessage.value)
    if (violations.length === 0) return true
    const reasons = violations.map(gateReasonLine)
    const outcome = await confirmCommitGateFix({
      title: t('commit.gateFix.title'),
      reasons,
      hint: t('commit.gateFix.hint'),
      agentText: t('commit.gateFix.agentAction'),
      anywayText: t('commit.gateFix.commitAnyway'),
    })
    if (outcome === 'agent') {
      await handToAgent({ kind: 'commitMsg', message: commitMessage.value, reasons })
    }
    return outcome === 'anyway'
  }

  // 提交段（主按钮与「提交并推送」连招共用）：校验 + 落库 + 成功清理，返回是否
  // 落库成功——连招据此决定是否衔接推送（提交失败绝不触发推送）。
  // 去重闸（P-20261005-211）：commit 在飞（含门禁弹层等待）再触发直接拒绝——
  // 主按钮 disabled 为 UI 主闸，此处拦 Ctrl+Enter/连点等绕过面，防重复提交请求
  async function performCommit(): Promise<boolean> {
    const pid = projectStore.currentProjectId
    if (!pid) return false
    if (!gitOps.tryBegin(pid, 'commit')) { message.warning(t('git.opsBusyToast')); return false }
    try {
      if (!commitMessage.value.trim()) { message.warning(t('commitPanel.commitMsgRequired')); return false }
      const staged = allFiles.value.filter(f => f.staged)
      if (staged.length === 0) { message.warning(t('commitPanel.noStagedFiles')); return false }
      if (!await commitMsgGatePass()) return false
      try {
        const filesParam = selectedForCommit.value.size > 0 ? Array.from(selectedForCommit.value) : undefined
        await changesStore.commit(pid, commitMessage.value, filesParam, amendLastCommit.value)
        message.success(t('commitPanel.commitSuccess'))
        // amend 一次性：提交成功即落闸，防误触二次改写历史
        amendLastCommit.value = false
        commitMessage.value = ''
        selectedForCommit.value.clear()
        return true
      } catch { return false /* 拦截器处理 */ }
    } finally { gitOps.end(pid, 'commit') }
  }

  // 提交
  async function handleCommit() {
    await performCommit()
  }

  // ============== 「提交并推送」连招（P-20261003-84） ==============
  // JetBrains「Commit and Push」同款下拉副选项：提交落库成功后自动衔接既有推送流
  // （usePushFlow：P-10 落后预检三态弹层 + 直推）。behind 读共享 aheadBehindMap
  // （Layout useLayoutBridge provide，GitPanel 徽标同源 5s TTL）；「先去拉取」主操作
  // 接共享拉取流（TopBar 同一 handlePull），拉取后推送交用户重试（与快捷推送同语义，
  // 不自动续推——预检弹层语义即「先处理落后」）。推送失败不回滚提交：silent 吃掉
  // 拦截器通用 toast，以「已提交，推送失败：<原因>」呈现部分成功（不静默重试，
  // 原因走 KNOWN_ERROR_I18N 具体映射，错误面板留痕不受 silent 影响）
  const comboBusy = ref(false)
  const sharedAheadBehind = inject<Ref<Record<string, { ahead: number; behind: number }>>>('sharedAheadBehindMap', ref({}))
  const sharedHandlePull = inject<() => Promise<void>>('sharedHandlePull', async () => {})
  const fetchAllAheadBehind = inject<() => Promise<void>>('sharedFetchAllAheadBehind', async () => {})
  // 签名含 category/action/actionPayload（与 GitPanel 同款宽签名）：部分成功留痕
  // 通知（P-20261004-142）要带 panel:git 直达动作，provide 侧（useLayoutBridge）
  // 本就透传全字段，这里只是让类型面如实
  const pushNotification = inject<(n: { type: 'success' | 'warning' | 'error' | 'info'; title: string; body?: string; category?: string; action?: string; actionPayload?: string }) => void>('pushNotification')
  const { precheckBehind, pushCurrentBranch } = usePushFlow()
  // 成功回执统一走 usePushPrToast（P-20261005-215）：首推新分支时 toast 附「创建 PR」外链
  const pushPrToast = usePushPrToast()

  // 提交/暂存按钮的进行中反馈（P-20261005-211）：busy 即时禁用防重复触发，
  // spinner 过 150ms 阈值才亮（本地毫秒级完成不抖动）——模板经 reactive 代理消费
  const commitBusy = computed(() => {
    const pid = projectStore.currentProjectId
    return !!pid && gitOps.isBusy(pid, 'commit')
  })
  const commitSpinner = computed(() => {
    const pid = projectStore.currentProjectId
    return !!pid && gitOps.spinnerOn(pid, 'commit')
  })
  const stageBusy = computed(() => {
    const pid = projectStore.currentProjectId
    return !!pid && gitOps.isBusy(pid, 'stage')
  })
  const stageSpinner = computed(() => {
    const pid = projectStore.currentProjectId
    return !!pid && gitOps.spinnerOn(pid, 'stage')
  })

  // 主按钮与下拉副选项共用的禁用态：无消息/无待提交目标时不可用，连招/提交在飞整体落闸
  const commitActionDisabled = computed(() => !commitMessage.value.trim() || commitCount.value === 0 || comboBusy.value || commitBusy.value)

  const commitExtraOptions = computed(() => [
    { label: t('git.commitPush.option'), key: 'commit-push', disabled: comboBusy.value },
  ])

  function handleCommitExtra(key: string | number) {
    if (key !== 'commit-push') return
    void handleCommitAndPush()
  }

  async function handleCommitAndPush() {
    if (comboBusy.value) return
    const pid = projectStore.currentProjectId
    if (!pid) return
    comboBusy.value = true
    try {
      if (!await performCommit()) return
      const flow = await precheckBehind(() => sharedAheadBehind.value[pid]?.behind ?? 0)
      if (flow === 'pull-first') {
        await sharedHandlePull()
        // 拉取改变 ahead/behind：立即刷新共享徽标——预检吃同一份值，不刷新会把
        // 紧接着的重试推送再拦一次（GitPanel handleQuickPull 同款对齐）
        fetchAllAheadBehind()
        return
      }
      if (flow === 'dismissed') return // 关层不推不拉：提交已落库，推送留待重试
      const outcome = await pushCurrentBranch('silent')
      if (outcome.action === 'pushed') {
        // 成功回执统一走 usePushPrToast（P-20261005-215）：首推新分支附「创建 PR」外链
        pushPrToast.toastPushSuccess(outcome.newBranch)
        pushNotification?.({ type: 'success', title: t('notification.pushDone'), body: projectStore.currentProject?.currentBranch || '' })
        fetchAllAheadBehind()
      } else {
        // 部分成功：提交已在本地，失败原因如实带出（时长放宽保证可见）
        message.warning(t('git.commitPush.partialFail', { reason: outcome.reason }), { duration: 6000 })
        // 失败事实入通知中心持久留痕（P-20261004-142）：推送是耗时网络操作，
        // 离屏后 6 秒 toast 即逝，「本地已提交/远端未到」的状态差不可见——与
        // GitPanel 直推失败入账（toast+通知中心双通道）补齐对称。Action 直达
        // git 面板（ahead/behind 徽标与重推入口所在；pull 摘要通知 panel:changes
        // P-31 同款惯例，git 域带动作通知标 category git 同款）
        pushNotification?.({
          type: 'error',
          category: 'git',
          title: t('notification.pushPartialFail'),
          body: outcome.reason,
          action: 'panel',
          actionPayload: 'git',
        })
      }
    } finally {
      comboBusy.value = false
    }
  }

  // 提交消息输入框：Ctrl/Cmd+Enter 快速提交
  function onCommitInputKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (commitMessage.value.trim() && commitCount.value > 0) handleCommit()
    }
  }

  return reactive({
    // 模板直接消费的状态面（子组件经 reactive 代理读写，v-model 路由回上方 ref/computed）
    commitMessage,
    recentMsgOptions,
    applyRecentMessage,
    loadRecentMessages,
    amendLastCommit,
    onAmendToggle,
    ccTypes,
    selectedCcType,
    applyCcType,
    ccScope,
    includeBreaking,
    ccFooter,
    showCcAdvanced,
    syncCcToMessage,
    appendFooter,
    stagedCount,
    unstagedCount,
    allSelected,
    toggleSelectAll,
    agentMsgLaunching,
    handleGenerateCommitMsg,
    splitSuggestLaunching,
    handleSuggestCommitSplit,
    handleStageAll,
    handleCommit,
    commitActionDisabled,
    commitBusy,
    commitSpinner,
    stageBusy,
    stageSpinner,
    commitCount,
    commitExtraOptions,
    handleCommitExtra,
    onCommitInputKeydown,
  })
}

export type CommitActionsState = ReturnType<typeof useCommitActions>
