<script setup lang="ts">
/**
 * 新建智能体会话对话框（终端会话管理处的主入口，供多入口复用）：
 *   - 运行时：auto / claude / codex / dsh / 纯终端（shell 一等选项）
 *   - 会话名：留空 = 服务端命名（槽位继承用户最近的命名 / 双语序号名）
 *   - 工作目录：留空 = 用户主目录；worktree 场景由入口预填
 *   - 启动命令：随运行时联动预填官方默认，可改；勾选「存为该运行时默认」
 *     后写 settings.agentLaunchCommands（per-runtime 覆盖，服务端即时生效）
 *   - 任务模板（P-20261002-16）：选中即按当前上下文替换占位符（{file}=激活
 *     文件 / {branch}=当前分支 / {dir}=会话工作目录 / {selection}=编辑器选中
 *     代码 P-20261005-149，打开时刻快照+截断注记）填入任务指令，创建时经
 *     launchArgs 通道注入（服务端 500 字节上限，前端同口径预检）
 *   - 本次上下文（P-176 git 摘要 → P-20261006-47 配置面）：折叠「本次上下文」
 *     区按次临时覆选（默认取设置 sessionContext、单次可调不改持久值）——git
 *     状态沿用既有「附带 git 状态」勾选语义（有任务指令时默认开、指令+上下文
 *     超 500 字节按声明序弃前言保指令原文并就地提示），另增项目笔记首段/TODO
 *     概要/环境画像（P-20261007-14）三路工作台背景资料；装配经
 *     utils/promptBuilder 统一组装器（P-20261003-184，声明序
 *     env→notes→todos→git = 逐项降级保 git）
 *   - 目标实例（P-20261004-101 联邦派发）：本机缺省 / 各注册实例（可用态
 *     徽标）——选从实例时经 POST /api/instances/:id/dispatch 转发创建（对端
 *     kind=agent），成功反馈 + 通知中心入账（点击跳该实例）；对端按其对端
 *     设置启动运行时，本地「存为默认/自定义命令」两档不适用（隐藏防误配）
 *   - 运行时可用态（P-20261004-85）：已装项带版本短徽标、缺失项灰化禁选 +
 *     tooltip——禁选判定镜像服务端创建预检（P-20261003-79）的豁免口径
 *     （utils/runtimeAvailability，前端徽标是体验层非正确性层，预检兜底不变）
 *   - 未提交草稿保留（P-20261004-89）：name/runtime/任务指令防抖 1s 存
 *     localStorage（sc.newSession.draft 单键），取消/误关不丢，重开恢复 +
 *     顶部弱提示可丢弃；创建成功即清。恢复让位于入口预填与显式选模板
 *     （P-20261002-16 仲裁），mask-closable 关闭（长表单防误触）
 *   - 关闭确认（P-20261006-6）：任务指令非空（或模板已选）时 Esc/取消先出
 *     「保持/放弃」确认层（事前拦截，P-89 是事后恢复，双保险）——保持回对
 *     话框，放弃清暂存后关；空表单/创建在途直关零打扰，提交路径不经确认
 *   - 打开聚焦（P-20261004-92）：打开即聚焦主输入（键盘流第一步）——任务指令
 *     textarea 在场（草稿恢复/预填/模板）聚焦它，否则聚焦恒在场的会话名输入；
 *     纯聚焦不改值，与草稿恢复提示无仲裁冲突
 *   - @ 文件引用补全（P-20261005-196）：任务指令 textarea 敲 @ 弹项目文件补
 *     全浮层（Cursor 式提顿），选中以「@相对路径 」入文（Claude CLI 原生引用
 *     语义）；触发/过滤/插入在 useAtFileCompletion，接线就近 NewSessionPrompt
 *     Section（textarea 所在区，见彼处）
 * 入口只需 v-model:show + @created，可通过 props 预填字段。
 *
 * 表单区拆分（热点瘦身第三批，纯搬运零逻辑改动）：任务指令域状态收口
 * useNewSessionPromptState（模板/草稿/本次上下文/组装），运行时域收口
 * useAgentRuntimeOptions，目标实例域收口 useTargetInstanceDispatch；任务指令
 * 表单区 = NewSessionPromptSection，高级/条件区（shell 覆盖/自定义命令/tmux
 * 接管）= NewSessionAdvancedSections。本壳持有提交链（submit/dispatch 分流）、
 * 关闭确认（P-20261006-6）、打开复位编排（show watch，指令域复位段收口在
 * resetForOpen）与主字段（运行时/名称/目录/目标实例）；打开聚焦的 textarea
 * ref 经 PromptSection expose 上提（P-92 拆分适配）。
 */
import { nextTick, ref, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NForm, NFormItem, NInput, NModal, NSelect, useDialog, useMessage } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'
import { settingsApi, terminalApi } from '@/api/client'
import type { ShellCandidate } from '@/api/client'
import { useAgentTerminal } from '@/composables/useAgentTerminal'
import { useInstanceStore } from '@/stores/instance'
import { useAgentRuntimeOptions, loadLastRuntime, saveLastRuntime } from '@/composables/useAgentRuntimeOptions'
import { useNewSessionPromptState } from '@/composables/useNewSessionPromptState'
import { useTargetInstanceDispatch } from '@/composables/useTargetInstanceDispatch'
import NewSessionPromptSection from './NewSessionPromptSection.vue'
import NewSessionAdvancedSections from './NewSessionAdvancedSections.vue'

const props = defineProps<{
  show: boolean
  /** 入口预填：工作目录（worktree/项目根场景） */
  prefillDir?: string
  /** 入口预填：运行时（如 Claude 会话恢复固定 claude） */
  prefillRuntime?: string
  /** 入口预填：目标实例（fleet 总览「在此实例新建会话」，空 = 本机） */
  prefillInstanceId?: string
  /** 入口预填：任务指令（重新发起场景 P-20261003-146，取源会话 meta 的
   *  initialPrompt 原文；视为用户已手改内容——不随模板联动被覆盖） */
  prefillPrompt?: string
  /** 入口预填：任务模板（P-20261005-10 命令面板直达的降级出口——模板占位符
   *  存在上下文缺失时经此预选，解析与「原样保留+提示」交对话框既有面呈现） */
  prefillTemplateId?: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'created', session: { id: string; name: string; runtime: string }): void
}>()

const message = useMessage()
const dialog = useDialog()
const { t } = useI18n()
const agentTerminal = useAgentTerminal()
const instanceStore = useInstanceStore()

const busy = ref(false)
const runtime = ref<string>('auto')
const name = ref('')
const dir = ref('')

// ============== 运行时域（useAgentRuntimeOptions） ==============
const {
  runtimes,
  runtimeOptions,
  renderRuntimeOptionLabel,
  allRuntimesUnavailable,
  showInstallGuide,
  loadRuntimes,
  redetecting,
  redetectRuntimes,
} = useAgentRuntimeOptions(runtime)

// ============== 任务指令域（useNewSessionPromptState：模板/草稿/本次上下文/组装） ==============
const promptState = useNewSessionPromptState({
  name,
  runtime,
  dir,
  isShow: () => props.show,
  fallbackRuntime: () => loadLastRuntime() || 'auto',
})
const {
  templateId,
  promptText,
  promptTouched,
  templateOptions,
  unresolvedPlaceholders,
  unresolvedLabel,
  selectionUnresolved,
  promptBytes,
  promptOverLimit,
  draftRestored,
  loadDraft,
  scheduleDraftSave,
  clearDraft,
  discardDraft,
  onTemplateChange,
  onPromptInput,
  ctxSelected,
  contextExpanded,
  contextScopeOk,
  onCtxToggle,
  promptAssembly,
  contextDropped,
  contextDroppedNames,
  resetForOpen,
} = promptState

// ============== 目标实例域（useTargetInstanceDispatch，P-20261004-101） ==============
const {
  LOCAL_INSTANCE,
  targetInstance,
  dispatching,
  targetInstanceOptions,
  dispatchRemote,
} = useTargetInstanceDispatch({
  name,
  runtime,
  dir,
  launchArgsText: () => promptAssembly.value.text,
  clearDraft,
  close: () => emit('update:show', false),
})

// ── 自定义命令/存为默认/shell 覆盖：v-model 源（表单区在 NewSessionAdvancedSections）──
const launchCommand = ref('')
const saveAsDefault = ref(false)
const shellOverride = ref('')

// shell 候选缓存：存活期 = 对话框组件实例（复开不重复请求——运行时环境不变），
// 由高级区子组件展开折叠区时经回调惰性拉取
const shellCandidates = ref<ShellCandidate[]>([])
const shellDefaultLabel = ref('')
let shellCandidatesLoaded = false

async function loadShellCandidates() {
  if (shellCandidatesLoaded) return
  shellCandidatesLoaded = true
  try {
    const res = await terminalApi.listShellCandidates() as unknown as { data?: { candidates?: ShellCandidate[]; defaultShell?: string } }
    shellCandidates.value = res.data?.candidates || []
    shellDefaultLabel.value = res.data?.defaultShell || ''
  } catch {
    // 拉取失败：下拉只剩「跟随设置」档，创建链不受影响
  }
}

// ============== 关闭确认（P-20261006-6，Esc 误触双保险） ==============
// P-89 草稿是「事后」防线（关了还能恢复），本守卫是「事前」防线（有未发送
// 内容先拦下确认，VS Code 关未保存文件同款惯例）——两道语义互补。确认阈值
// 只数任务指令/模板：指令常数百字重打成本高；纯会话名重打成本低，保持
// Esc 即关零打扰（P-89 草稿仍在兜底）
function hasUnsentInput(): boolean {
  return promptText.value.trim() !== '' || templateId.value !== ''
}

/** 重入门：Esc 与取消钮可快速连触 requestClose，防叠出多个确认弹层；
 *  onAfterLeave 是所有离开路径（保持/放弃/Esc/遮罩）的汇合复位点 */
let closeConfirmVisible = false

/** 确认后正常关（保持 = 关确认层留在对话框；放弃 = 清暂存再关）。
 *  「放弃清暂存」走 clearDraft（含撤销在途防抖）：用户显式决定不要了，
 *  重开不再恢复、不再亮恢复提示——与 P-89 暂存共存的兑现面 */
function requestClose() {
  if (busy.value || !hasUnsentInput()) {
    emit('update:show', false)
    return
  }
  if (closeConfirmVisible) return
  closeConfirmVisible = true
  dialog.warning({
    title: t('agentTerminal.closeConfirm.title'),
    content: t('agentTerminal.closeConfirm.body'),
    positiveText: t('agentTerminal.closeConfirm.discard'),
    negativeText: t('agentTerminal.closeConfirm.keep'),
    onPositiveClick: () => {
      clearDraft()
      emit('update:show', false)
    },
    onAfterLeave: () => { closeConfirmVisible = false },
  })
}

/** n-modal 的关闭事件统一过守卫（SettingsModal.onShowChange 同款先例）：
 *  Esc 走这里；遮罩 P-89 起已 mask-closable=false 不会产生关闭事件。
 *  busy（创建在途）放行直关——提交路径自己拥有关闭时机，确认层不应在
 *  「正在创建」的语义上再问「放弃这次输入」；失败时对话框本就不关 */
function onShowChange(v: boolean) {
  if (v || busy.value || !hasUnsentInput()) {
    emit('update:show', v)
    return
  }
  requestClose()
}

// ============== 打开聚焦（P-20261004-92 键盘流第一步） ==============
// 打开即聚焦主输入，键盘用户不必先点一下才能打字。主输入裁决（表单主次注记）：
// 任务指令 textarea 是 agent 会话的核心输入（launchArgs 主文本域），但它
// v-if=templateId||promptText 条件渲染——打开时已在场（草稿恢复/重新发起
// prefillPrompt/模板预填三路）则聚焦它，键盘流直接延续进行中内容；否则聚焦
// 恒在场的会话名输入（全新打开的唯一文本框）。聚焦动作本身不改值，不触发
// 草稿落键/模板联动，与 P-89 恢复提示无仲裁冲突（提示条只由创建成功/丢弃/
// 显式选模板收起）。模板异步预填（prefillTemplateId 经 taskTemplates.load()
// 落选）此刻 textarea 尚未渲染，聚焦回落会话名，可接受。
// naive-ui n-modal 自带 focus-trap autoFocus 会先聚焦第一个可聚焦元素
// （运行时下拉/恢复提示丢弃钮，键入会被下拉 typeahead 吃掉）——本聚焦在其
// onMounted 同帧之后执行（nextTick 续体），最终落点以这里为准；
// CommandPalette/ShortcutsHelp 开面板聚焦同款惯例。
// 拆分适配：会话名输入在本壳模板，textarea 在 NewSessionPromptSection——经
// ref expose 上提 NInput 实例（条件镜像指令区 v-if，两者同真假，聚焦段必挂）
const nameInputRef = ref<InstanceType<typeof NInput> | null>(null)
const promptSectionRef = ref<InstanceType<typeof NewSessionPromptSection> | null>(null)

// immediate：fleet 派发入口（P-20261004-101）在宿主 View 挂载链里直接以
// show=true 首挂本组件——非 immediate 的 show watch 对初始值不触发，预填
// （目标实例等）会全部丢失。挂载即 show=false 的常规路径 immediate 首跑
// 被下方守卫短路，与既有行为零差异
watch(() => props.show, async (v) => {
  if (!v) return
  saveAsDefault.value = false
  // 草稿恢复（P-20261004-89）：优先级 = 入口预填指令 > 草稿——prefillPrompt
  // （重新发起/复盘问询等）是用户当下明确意图，且表单按预填场景整装重来，
  // 陈旧草稿混入反而张冠李戴。prompt 恢复恒伴随 templateId=''（空态），
  // 显式选模板走 templateId watch 覆盖（P-20261002-16 仲裁：模板插入不被
  // 草稿顶回），因此复位归零需一次性豁免联动（armSkipTemplateReset）
  // 预填仲裁（P-89 修正条款，后落地方兑现）：显式模板选择=用户当下明确意图，
  // 优先于草稿恢复——模板预填在场时草稿不加载（横幅不亮、prompt 留空等模板正文）
  const draft = (props.prefillPrompt || props.prefillTemplateId) ? null : loadDraft()
  if (templateId.value !== '') promptState.armSkipTemplateReset()
  name.value = draft?.name || ''
  dir.value = props.prefillDir || ''
  runtime.value = props.prefillRuntime || draft?.runtime || loadLastRuntime() || 'auto'
  // 目标实例：入口预填（fleet 行动）优先，缺省本机；顺带刷新实例清单与
  // 可用态徽标（TTL 内零请求，silent 失败保持旧态不阻塞打开）
  targetInstance.value = props.prefillInstanceId || LOCAL_INSTANCE
  void instanceStore.ensureInstancesFresh()
  // 任务模板态复位 + 清单刷新（管理面改动即时反映到下拉）。
  // 重新发起预填（P-20261003-146）：prefillPrompt 直填指令并标 touched——
  // 预填是「用户内容」语义，不随后续上下文联动被模板替换清掉
  templateId.value = ''
  promptText.value = props.prefillPrompt || draft?.prompt || ''
  promptTouched.value = !!(props.prefillPrompt || draft?.prompt)
  draftRestored.value = !!draft
  // {selection} 选区快照 + 本次上下文复位（P-20261006-47，原 show watch 的
  // 复位段搬运收口）：快照重取/勾选镜像复位/摘要清空/在途取数标志清/
  // 设置档 load 细化全在指令域 composable（resetForOpen）——复位触发其补取
  // watch 打开即预取，提交时零等待
  resetForOpen()
  // 模板预填（P-20261005-10 命令面板直达的降级出口）：清单就绪后再置选中——
  // templateId watcher 需要 templates 表在手才能解析正文，load 在途时置选中
  // 会落空清空；load 本身仍无条件执行（管理面改动即时反映到下拉的既有语义），
  // 预填选择只挂在它的 then 上（与指令预填互斥，两者不叠加；用户已手选则让位）
  void promptState.ensureTemplatesLoaded().then(() => {
    if (props.show && props.prefillTemplateId && templateId.value === ''
      && !props.prefillPrompt && !promptTouched.value) {
      templateId.value = props.prefillTemplateId
    }
  })
  // shell 覆盖复位为「跟随设置」（高级区折叠展开等 UI 态在子组件内自持，
  // 复开随内容重建复位 = 默认关不可达，P-213 同款）
  shellOverride.value = ''
  void loadRuntimes()
  // 打开聚焦（P-20261004-92）：nextTick 等 n-modal 内容挂载（focus-trap
  // autoFocus 的同帧首聚焦先行），聚焦落点按此刻表单形态定夺（条件镜像
  // 指令区 v-if，textarea 实例经 PromptSection expose 上提，见上方注记）。
  // await 之前的同步段已含全部状态复位——skipNextTemplateReset 的消费时序
  // （templateId watch 补跑）不受续体延后影响
  await nextTick()
  ;(templateId.value || promptText.value ? promptSectionRef.value?.promptInputRef : nameInputRef.value)?.focus()
}, { immediate: true })

async function submit() {
  if (busy.value) return
  // 任务指令超服务端 launchArgs 500 字节上限：前端同口径预检拒绝（AgentCronSettings
  // 同款预检，服务端 400 兜底），不静默截断用户可见文本
  if (promptOverLimit.value) {
    message.warning(t('agentTerminal.taskTemplate.promptTooLong'))
    return
  }
  busy.value = true
  try {
    // 联邦派发路径（P-20261004-101）：转发创建到从实例，本端不接管会话
    //（会话本体在对端；反馈 = 就地 toast + 通知中心入账，点击通知跳该实例）
    if (dispatching.value) {
      await dispatchRemote()
      return
    }
    // 「存为该运行时默认」：先写设置（覆盖命令生效），再创建会话
    if (saveAsDefault.value && runtime.value !== 'auto' && runtime.value !== 'shell') {
      try {
        const cur = await settingsApi.get()
        const map = { ...((cur.data as Record<string, unknown>)?.agentLaunchCommands as Record<string, string> | undefined) }
        map[runtime.value] = launchCommand.value.trim()
        await settingsApi.update({ agentLaunchCommands: map })
        // 本地清单同步，避免重复打开时看到旧值
        const rt = runtimes.value.find(r => r.name === runtime.value)
        if (rt) rt.customCommand = launchCommand.value.trim()
      } catch {
        message.warning(t('agentTerminal.saveDefaultFailed'))
      }
    }
    const info = await agentTerminal.create(runtime.value, {
      dir: dir.value.trim() || undefined,
      name: name.value.trim() || undefined,
      // 会话级 shell 覆盖（P-20261004-57）：仅纯终端形态携带；「跟随设置」
      // 档不带字段，保持既有请求形状（未选 = 服务端按设置/平台缺省解析）
      ...(runtime.value === 'shell' && shellOverride.value && !shellOverride.value.startsWith('__unavailable__:')
        ? { shell: shellOverride.value }
        : {}),
      // 任务指令经 launchArgs 注入（运行时命令后追加，服务端按 500 字节校验）；
      // 空串不携带，保持既有请求形状（useAgentTerminal.create 同款条件展开）。
      // 本次上下文（P-176 → P-20261006-47）：组装器（P-20261003-184）保指令恒
      // 首行、上下文摘要按声明序追加在其后；超 500 字节按序弃前言保指令原文
      // （不静默截断用户文本，UI 已就地提示 dropped）
      ...(promptText.value.trim()
        ? {
            launchArgs: promptAssembly.value.text,
          }
        : {}),
    })
    if (!info) {
      message.error(t('agentTerminal.createFailed'))
      return
    }
    saveLastRuntime(runtime.value)
    clearDraft() // 创建成功即清草稿（P-20261004-89）：已提交无保留意义
    emit('created', { id: info.id, name: info.name, runtime: info.runtime || runtime.value })
    emit('update:show', false)
  } finally {
    busy.value = false
  }
}

/** tmux 接管成功（高级区上抛）：通知宿主选中并关弹层（接管即创建） */
function onTakeoverCreated(session: { id: string; name: string; runtime: string }) {
  emit('created', session)
  emit('update:show', false)
}
</script>

<template>
  <!-- mask 误触防护（P-20261004-89）：长表单 mask-closable=false——数百字任务
       指令误点遮罩即整表单蒸发的代价不可接受；关闭语义（P-20261006-6）= 有
       未发送内容（指令/模板）时 Esc/取消钮先出确认层「保持/放弃」，确认层
       在最顶（focus-trap 栈只应最顶层的 Esc），放弃才清暂存关闭；空表单直
       关零打扰，草稿兜底不变（P-89） -->
  <n-modal
    :show="show"
    preset="card"
    :title="t('agentTerminal.newDialogTitle')"
    style="width: var(--modal-w-md); max-width: 94vw"
    :mask-closable="false"
    @update:show="onShowChange"
  >
    <!-- 草稿恢复弱提示（P-20261004-89）：DraftRecoveryBar 同族视觉语，恢复
         上次未提交的会话名/运行时/任务指令，可一键丢弃 -->
    <div
      v-if="draftRestored"
      class="nsd-draft-bar"
      data-testid="agent-draft-restored"
    >
      <span>{{ t('agentTerminal.draft.restored') }}</span>
      <button
        type="button"
        class="nsd-draft-discard"
        data-testid="agent-draft-discard"
        @click="discardDraft"
      >
        {{ t('agentTerminal.draft.discard') }}
      </button>
    </div>
    <!-- 全部不可用提示卡（P-20261003-296）：新用户死胡同 → 出路（指引 + shell） -->
    <div
      v-if="allRuntimesUnavailable"
      class="nsd-runtime-guide"
      data-testid="agent-runtime-guide"
    >
      <div class="nsd-runtime-guide-title">
        {{ t('agentTerminal.runtimeNoneTitle') }}
      </div>
      <div>{{ t('agentTerminal.runtimeNoneBody') }}</div>
      <div>
        {{ t('agentTerminal.runtimeShellFallback') }}
        <button
          type="button"
          class="nsd-runtime-guide-link"
          data-testid="agent-runtime-guide-link"
          @click="showInstallGuide"
        >{{ t('agentTerminal.runtimeInstallGuide') }}</button>
        <!-- 重新检测（P-20261005-167）：装完原地重探，闭环最后一钮；loading 态
             禁点防重复起探测子进程 -->
        <button
          type="button"
          class="nsd-runtime-guide-link nsd-runtime-redetect"
          data-testid="agent-runtime-guide-redetect"
          :disabled="redetecting"
          @click="redetectRuntimes"
        >{{ redetecting ? t('agentTerminal.runtimeRedetecting') : t('agentTerminal.runtimeRedetect') }}</button>
      </div>
    </div>
    <n-form
      label-placement="left"
      label-width="auto"
      size="small"
    >
      <!-- 目标实例（P-20261004-101 联邦派发）：本机缺省/各注册实例，可用态
           徽标注入（离线/无效项禁用即反馈） -->
      <n-form-item
        v-if="targetInstanceOptions.length > 1"
        :label="t('agentTerminal.targetInstance.field')"
      >
        <n-select
          v-model:value="targetInstance"
          :options="targetInstanceOptions"
          data-testid="agent-target-instance"
        />
      </n-form-item>
      <n-form-item :label="t('agentTerminal.fieldRuntime')">
        <n-select
          v-model:value="runtime"
          :options="runtimeOptions"
          :render-label="renderRuntimeOptionLabel"
          data-testid="agent-runtime-select"
          @update:value="scheduleDraftSave"
        />
      </n-form-item>
      <n-form-item :label="t('agentTerminal.fieldName')">
        <n-input
          ref="nameInputRef"
          v-model:value="name"
          :placeholder="t('agentTerminal.fieldNamePlaceholder')"
          clearable
          @update:value="scheduleDraftSave"
        />
      </n-form-item>
      <n-form-item :label="t('agentTerminal.fieldDir')">
        <n-input
          v-model:value="dir"
          :placeholder="t('agentTerminal.fieldDirPlaceholder')"
          clearable
        />
      </n-form-item>
      <!-- 任务指令表单区（模板/指令/@ 补全/本次上下文）：状态在
           useNewSessionPromptState，textarea ref 经 expose 上提（P-92） -->
      <NewSessionPromptSection
        ref="promptSectionRef"
        v-model:template-id="templateId"
        v-model:prompt="promptText"
        :template-options="templateOptions"
        :unresolved-placeholders="unresolvedPlaceholders"
        :unresolved-label="unresolvedLabel"
        :selection-unresolved="selectionUnresolved"
        :prompt-bytes="promptBytes"
        :prompt-over-limit="promptOverLimit"
        :ctx-selected="ctxSelected"
        v-model:context-expanded="contextExpanded"
        :context-scope-ok="contextScopeOk"
        :context-dropped="contextDropped"
        :context-dropped-names="contextDroppedNames"
        @template-change="onTemplateChange"
        @prompt-input="onPromptInput"
        @ctx-toggle="onCtxToggle"
      />
      <!-- 高级/条件区（shell 覆盖/自定义命令/tmux 接管）：UI 态自持随复开重建；
           运行时重探（P-20261005-167）状态在运行时域，经 props 下发同款先例 -->
      <NewSessionAdvancedSections
        v-model:launch-command="launchCommand"
        v-model:save-default="saveAsDefault"
        v-model:shell-override="shellOverride"
        :runtime="runtime"
        :runtimes="runtimes"
        :dispatching="dispatching"
        :shell-candidates="shellCandidates"
        :shell-default-label="shellDefaultLabel"
        :load-shell-candidates="loadShellCandidates"
        :redetecting="redetecting"
        :redetect-runtimes="redetectRuntimes"
        @created="onTakeoverCreated"
      />
    </n-form>
    <template #footer>
      <div class="nsd-footer">
        <n-button
          size="small"
          quaternary
          @click="requestClose"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="busy"
          @click="submit"
        >
          {{ t('agentTerminal.createNow') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
/* 运行时不可用提示卡：帮助中心 .help-agent-tip 同族（border-subtle + bg-elevated 信息卡） */
.nsd-runtime-guide {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.nsd-runtime-guide-title {
  color: var(--text-primary);
  font-weight: 600;
}
.nsd-runtime-guide-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent-blue);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.nsd-runtime-guide-link:hover { text-decoration: underline; }
/* 重新检测小钮（P-20261005-167）：与指引链接同族链式小钮，邻位隔开；禁用
   （探测在途）降透明度给载入反馈 */
.nsd-runtime-redetect { margin-left: 10px; }
.nsd-runtime-redetect:disabled { cursor: default; opacity: 0.6; }
/* 草稿恢复弱提示（P-20261004-89）：DraftRecoveryBar 同族视觉语（弱文本 +
   细边框丢弃小钮），颜色全走主题变量 */
.nsd-draft-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  padding: 5px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 12px;
}
.nsd-draft-discard {
  padding: 1px 10px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.nsd-draft-discard:hover {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}
.nsd-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
