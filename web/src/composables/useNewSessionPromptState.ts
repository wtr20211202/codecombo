import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import { useI18n } from '@/composables/useI18n'
import { useAgentTaskTemplates } from '@/composables/useAgentTaskTemplates'
import { useEditorNavHistory } from '@/composables/useEditorNavHistory'
import { useSessionContextSummary } from '@/composables/useSessionContextSummary'
import { useSessionContextStore } from '@/stores/sessionContext'
import { useProjectStore } from '@/stores/project'
import { resolveAgentTaskTemplate, truncateSelectionForTemplate, AGENT_TASK_PROMPT_MAX_BYTES } from '@/utils/agentTaskTemplate'
import { SESSION_CONTEXT_ALL, SESSION_CONTEXT_ASSEMBLY_ORDER, type SessionContextOption } from '@/utils/sessionContextSummary'
import { byteLength } from '@/utils/promptFit'
import { assembleLaunchPrompt } from '@/utils/promptBuilder'
import { safeStorage } from '@/utils/storage'

/**
 * 新建会话对话框的任务指令域状态（自 NewSessionDialog 按表单区拆分，纯搬运
 * 零逻辑改动）。紧耦合的关注点聚合一处（共享 promptText/promptTouched）：
 *   - 任务模板（P-20261002-16）：选中即按上下文替换占位符（{file}/{branch}/{dir}/
 *     {selection} P-20261005-149）填入任务指令；上下文变化联动重替换，用户手改
 *     不覆盖
 *   - 未提交草稿保留（P-20261004-89）：name/runtime/任务指令防抖 1s 存
 *     localStorage 单键，创建成功即清、重开恢复
 *   - 本次上下文（P-176 git 摘要 → P-20261006-47 配置面）：设置键按次临时覆选
 *     + 各选项摘要预取 + 生效范围判定，任务指令 + 上下文经 utils/promptBuilder
 *     统一组装（P-20261003-184，超 500 字节按声明序弃前言保指令原文）
 */
export interface NewSessionPromptStateCtx {
  /** 会话名（草稿持久化字段） */
  name: Ref<string>
  /** 运行时（草稿持久化字段） */
  runtime: Ref<string>
  /** 工作目录（模板 {dir} 占位符上下文 + 上下文生效范围判定） */
  dir: Ref<string>
  /** 对话框是否打开（慢速取数守卫：过期结果不回写） */
  isShow: () => boolean
  /** 丢弃草稿时运行时的回退值（上次选择运行时 → auto，调用方给取值函数） */
  fallbackRuntime: () => string
}

export interface NewSessionPromptState {
  // ── 任务模板（P-20261002-16）──
  templateId: Ref<string>
  promptText: Ref<string>
  promptTouched: Ref<boolean>
  templateOptions: ComputedRef<{ label: string; value: string }[]>
  /** 指令里仍以字面保留的已知占位符（上下文缺失），UI 提示「原样保留」 */
  unresolvedPlaceholders: ComputedRef<string[]>
  /** 提示文案的占位符名单在 script 侧拼装——模板插值里写 `{${n}}` 的 `}}` 会被
   *  vue 当 mustache 闭合提前截断（vue/no-parsing-error 实测） */
  unresolvedLabel: ComputedRef<string>
  /** {selection} 在未解占位符之列（P-20261005-149）：UI 追加「无选区」专属提示 */
  selectionUnresolved: ComputedRef<boolean>
  promptBytes: ComputedRef<number>
  promptOverLimit: ComputedRef<boolean>
  /** 打开复位的一次性联动豁免：show watch 里把 templateId 归零会异步触发
   *  templateId watch 的清选分支（清空 promptText + promptTouched），把刚回填
   *  的草稿/入口预填指令抹掉——Vue 调度器按创建序补跑 watch，本 watch 在 show
   *  watch 体结束后才执行（实测复现）。只在复位真会改变值时武装，消费即复位，
   *  用户正常选模板/清选不受影响 */
  armSkipTemplateReset: () => void
  /** 模板清单刷新（管理面改动即时反映到下拉）；prefillTemplateId 预填挂其 then */
  ensureTemplatesLoaded: () => Promise<unknown>
  // ── 草稿（P-20261004-89）──
  /** 打开回填了草稿时为真：驱动顶部弱提示（创建成功/丢弃/显式选模板即收） */
  draftRestored: Ref<boolean>
  /** 读草稿（打开时的仲裁源：入口预填在场时不恢复草稿——裁决在调用方 show watch） */
  loadDraft: () => SessionDraft | null
  /** 用户输入触发的防抖存草稿：1s 后取字段终值落键；作事件 handler 时入参忽略 */
  scheduleDraftSave: () => void
  /** 创建成功/显式丢弃：清存储并撤销在途防抖（否则清空后被在途定时器复活） */
  clearDraft: () => void
  /** 弱提示的丢弃键：清存储并把恢复进来的字段退回空态（提示条随之消失） */
  discardDraft: () => void
  /** 显式选模板（含清选）：用户当下意图优先于已恢复草稿（P-20261002-16 仲裁
   *  的落地点）——收恢复提示，草稿按模板插入后的表单终值重写（防抖读终值） */
  onTemplateChange: () => void
  /** 指令输入：标手改 + 防抖存草稿 */
  onPromptInput: () => void
  // ── 本次上下文（P-176 git 摘要 → P-20261006-47 配置面）──
  /** 各选项按次覆选态（默认取设置；勾选是唯一写者 onCtxToggle，单向流） */
  ctxSelected: Record<SessionContextOption, boolean>
  /** 折叠「本次上下文」区展开态（打开复位为展开） */
  contextExpanded: Ref<string[]>
  /** 上下文生效条件：会话目录在当前项目语义内（worktree 等项目外目录不给） */
  contextScopeOk: ComputedRef<boolean>
  /** 勾选切换（checked 的唯一写者）：置用户手改标 + 写覆选态 */
  onCtxToggle: (option: SessionContextOption, checked: boolean) => void
  // ── 组装（P-20261003-184 promptBuilder）──
  /** 任务指令 + 上下文摘要统一组装：指令 = 主任务保底段，上下文 = 定型前言
   *  （声明序 env→notes→todos→git，超 500 字节按序整段弃——dropped 驱动 UI 就地
   *  提示）。服务端 promptSessionName 按首行派生会话名，组装器保主任务恒首行。
   *  指令本身超限时 promptOverLimit 预检已拦截（组装器不截用户文本） */
  promptAssembly: ComputedRef<{ text: string; dropped: string[] }>
  /** 空间不足被弃的选项 id 列表（就地提示列被弃项） */
  contextDropped: ComputedRef<string[]>
  /** 被弃项的本地化名单（逗号连接，UI 直显） */
  contextDroppedNames: ComputedRef<string>
  /** 打开复位（原 show watch 的上下文/选区段，搬运收口）：{selection} 选区快照
   *  重取 + 上下文勾选/摘要/取数标志复位 + 设置档细化 */
  resetForOpen: () => void
}

/** 草稿形状（localStorage 单键 sc.newSession.draft） */
export interface SessionDraft {
  name: string
  runtime: string
  prompt: string
}

const DRAFT_KEY = 'sc.newSession.draft'
const DRAFT_SAVE_DEBOUNCE_MS = 1000

const CTX_LABEL_KEYS: Record<SessionContextOption, string> = {
  git: 'agentTerminal.sessionContext.labelGit',
  notes: 'agentTerminal.sessionContext.labelNotes',
  todos: 'agentTerminal.sessionContext.labelTodos',
  env: 'agentTerminal.sessionContext.labelEnv',
}

export function useNewSessionPromptState(ctx: NewSessionPromptStateCtx): NewSessionPromptState {
  const { t } = useI18n()
  const projectStore = useProjectStore()
  const taskTemplates = useAgentTaskTemplates()
  // {file} 占位符的「当前激活文件」：navHistory 模块级信标（shell 实例级的
  // useOpenFiles 深层组件拿不到，见 useEditorNavHistory 头注的同款论证）
  const navHistory = useEditorNavHistory()

  // ============== 任务模板（P-20261002-16） ==============
  const templateId = ref('')
  const promptText = ref('')
  /** 用户是否手动改过任务指令（上下文变化时未改过才重新联动替换） */
  const promptTouched = ref(false)
  let skipNextTemplateReset = false

  // {selection} 占位符的选区快照（P-20261005-149）：navHistory.activeSelection
  // 信标在打开时刻取值存此处（resetForOpen）——对话框在场期间的编辑器选区变化
  // 不回灌（打开后再去编辑器选区 = 打开时刻的旧值，快照语义的时序边界如实
  // 注记），复开重新快照
  const selectionSnapshot = ref('')

  /** 占位符上下文：dir 用对话框工作目录（留空 = 项目根，与提交链 cwd 语义
   *  对齐；提案「{dir}=项目根」按会话实际 cwd 取值的假设见提交注记）。
   *  selection（P-20261005-149）= 打开时刻的编辑器选区快照，截断保头 200 rune
   *  + 注记（注记文案 i18n 在此传入，纯函数保持无 i18n 依赖）；无选区 = 空串
   *  → 占位符走既有「未解析原样保留+提示」，提示面区分无选区（selectionEmptyHint） */
  const templateCtx = computed(() => ({
    file: navHistory.activeFilePath.value,
    branch: projectStore.currentProject?.currentBranch || '',
    dir: ctx.dir.value.trim() || projectStore.currentProject?.path || '',
    selection: truncateSelectionForTemplate(
      selectionSnapshot.value,
      t('agentTerminal.taskTemplate.selectionTruncated'),
    ),
  }))

  const templateOptions = computed(() => [
    { label: t('agentTerminal.taskTemplate.optionNone'), value: '' },
    ...taskTemplates.templates.value.map(x => ({ label: x.name, value: x.id })),
  ])

  function applyTemplate(prompt: string) {
    promptText.value = resolveAgentTaskTemplate(prompt, templateCtx.value).text
  }

  // 选中模板：占位符替换后填入任务指令；清选（含打开重置）清空指令
  watch(templateId, (id) => {
    if (skipNextTemplateReset) {
      skipNextTemplateReset = false
      return
    }
    const tpl = taskTemplates.templates.value.find(x => x.id === id)
    if (!tpl) {
      promptText.value = ''
      promptTouched.value = false
      return
    }
    applyTemplate(tpl.prompt)
    promptTouched.value = false
  })

  // 上下文变化（改目录等）联动重替换——用户已手改则不覆盖（commandTouched 同款语义）
  watch(templateCtx, () => {
    if (promptTouched.value) return
    const tpl = taskTemplates.templates.value.find(x => x.id === templateId.value)
    if (tpl) applyTemplate(tpl.prompt)
  })

  /** 指令里仍以字面保留的已知占位符（上下文缺失），UI 提示「原样保留」 */
  const unresolvedPlaceholders = computed(() =>
    resolveAgentTaskTemplate(promptText.value, {}).unresolved)

  const unresolvedLabel = computed(() =>
    unresolvedPlaceholders.value.map(n => `{${n}}`).join(' '))

  /** {selection} 在未解析之列（P-20261005-149）：通用缺失提示之外追加「无选区」
   *  专属提示——缺失原因可辨（选区为空）且给得出路（选中后重开对话框） */
  const selectionUnresolved = computed(() => unresolvedPlaceholders.value.includes('selection'))

  const promptBytes = computed(() => byteLength(promptText.value))
  const promptOverLimit = computed(() => promptBytes.value > AGENT_TASK_PROMPT_MAX_BYTES)

  // ============== 未提交草稿保留（P-20261004-89） ==============
  // name/runtime/任务指令是会话创建的核心输入（指令常数百字），误关/取消即整
  // 表单蒸发是高频挫败——字段防抖 1s 存 localStorage 单键（编辑器文件草稿恢复
  // 链的表单版）。创建成功即清（已提交无保留意义），取消/误关保留，重开恢复 +
  // 顶部弱提示（DraftRecoveryBar 家族视觉语）。与任务模板的仲裁见 show watch
  // 恢复段：草稿只在没有更明确用户意图（入口预填指令/显式选模板）时回填。
  // 保存只挂用户输入事件（@input/@update:value）——打开复位/模板联动/恢复回填
  // 等程序性写入不落键，防「开一次对话框把草稿顶成空值」；防抖回调不守
  // ctx.isShow（输入后 1s 内关闭正是要保的场景），「创建成功即清」靠 clearDraft
  // 撤销在途定时器保证不被复活

  function loadDraft(): SessionDraft | null {
    try {
      const raw = safeStorage.getItem(DRAFT_KEY)
      if (!raw) return null
      const d = JSON.parse(raw) as Partial<SessionDraft>
      const draft: SessionDraft = {
        name: typeof d?.name === 'string' ? d.name : '',
        runtime: typeof d?.runtime === 'string' ? d.runtime : '',
        prompt: typeof d?.prompt === 'string' ? d.prompt : '',
      }
      // 全空等价无草稿（残留空键不复活恢复提示）
      return draft.name || draft.runtime || draft.prompt ? draft : null
    } catch {
      return null // 损坏/畸形草稿按无草稿处理（重开不报错）
    }
  }

  /** 重开回填了草稿时为真：驱动顶部弱提示（创建成功/丢弃/显式选模板即收） */
  const draftRestored = ref(false)

  let draftSaveTimer: ReturnType<typeof setTimeout> | undefined

  /** 用户输入触发的防抖存草稿：1s 后取字段终值落键（模板联动替换在 watch 里
   *  完成，到时已落定）；作直接事件 handler 时入参忽略 */
  function scheduleDraftSave() {
    if (draftSaveTimer !== undefined) clearTimeout(draftSaveTimer)
    draftSaveTimer = setTimeout(() => {
      draftSaveTimer = undefined
      safeStorage.setItem(DRAFT_KEY, JSON.stringify({
        name: ctx.name.value,
        runtime: ctx.runtime.value,
        prompt: promptText.value,
      }))
    }, DRAFT_SAVE_DEBOUNCE_MS)
  }

  /** 创建成功/显式丢弃：清存储并撤销在途防抖（否则清空后被在途定时器复活） */
  function clearDraft() {
    if (draftSaveTimer !== undefined) {
      clearTimeout(draftSaveTimer)
      draftSaveTimer = undefined
    }
    safeStorage.removeItem(DRAFT_KEY)
    draftRestored.value = false
  }

  /** 弱提示的丢弃键：清存储并把恢复进来的字段退回空态（提示条随之消失） */
  function discardDraft() {
    clearDraft()
    ctx.name.value = ''
    promptText.value = ''
    promptTouched.value = false
    ctx.runtime.value = ctx.fallbackRuntime()
  }

  /** 显式选模板（含清选）：用户当下意图优先于已恢复草稿（P-20261002-16 仲裁
   *  的落地点）——收恢复提示，草稿按模板插入后的表单终值重写（防抖读终值） */
  function onTemplateChange() {
    draftRestored.value = false
    scheduleDraftSave()
  }

  function onPromptInput() {
    promptTouched.value = true
    scheduleDraftSave()
  }

  // ============== 本次上下文（P-176 git 摘要 → P-20261006-47 配置面） ==============
  // 设置键 sessionContext（多选 git/notes/todos/env）的对话框按次临时覆选：默认取
  // 设置、单次可调——只影响本次创建，不改设置持久值。各选项独立小组装（git 沿
  // P-176 取数面，笔记/TODO/环境画像由 useSessionContextSummary 现查面板同源端点，
  // 尽力而为绝不阻塞创建）；装配走统一组装器（P-184），装配序 env→notes→todos→git
  // = 超限弃段阶梯（逐项降级保 git，SESSION_CONTEXT_ASSEMBLY_ORDER）
  const { buildSummary } = useSessionContextSummary()
  const sessionContextStore = useSessionContextStore()
  const ctxSelected = reactive<Record<SessionContextOption, boolean>>({ git: true, notes: false, todos: false, env: false })
  /** 各选项摘要行（预取，空 = 数据不可用或未取——该选项不注入） */
  const ctxSummaries = reactive<Record<SessionContextOption, string>>({ git: '', notes: '', todos: '', env: '' })
  /** 在途取数去重（目录逐键触发的补取 watch 与勾选联动共用单飞语义） */
  const ctxFetching: Record<SessionContextOption, boolean> = { git: false, notes: false, todos: false, env: false }
  /** 折叠「本次上下文」区展开态：默认展开——折叠是收纳不是隐藏（新选项可发现性，
   *  P-176 裸勾选的既定可见面也在此延续） */
  const contextExpanded = ref<string[]>(['ctx'])
  /** 用户手动勾选过（load 返回后不让设置默认覆盖用户当下意图——P-89 恢复仲裁同哲学） */
  let ctxTouched = false
  /** 慢速取数守卫：返回时对话框可能已关闭/重开，过期结果不回写 */
  let summaryReqSeq = 0

  async function refreshContextSummary(option: SessionContextOption) {
    if (ctxFetching[option]) return
    ctxFetching[option] = true
    const seq = ++summaryReqSeq
    try {
      const s = await buildSummary(option)
      if (seq === summaryReqSeq && ctx.isShow()) ctxSummaries[option] = s
    } finally {
      ctxFetching[option] = false
    }
  }

  /** 勾选是 checked 的唯一写者（:checked + @update:checked 单向流，免 v-model
   *  双写者次序依赖）；取数统一由下方 watch 驱动（勾选/目录变更共用一条补取路径） */
  function onCtxToggle(option: SessionContextOption, checked: boolean) {
    ctxTouched = true
    ctxSelected[option] = checked
  }

  /** 生效条件齐备（目录在项目内 + 勾选）而摘要未取时补取——覆盖三类时序：打开
   *  即预取（提交时零等待）、worktree 预填目录后改正（P-176 既有「打开即取」的
   *  覆选场景化延续）、先勾选后填目录。目录逐键触发由 ctxFetching 单飞去重。
   *  **nextTick 延迟是正确性前提不是优化**：本 watch（setup 期先建）在打开 tick
   *  先于 show watch 的同步复位段执行——立即取数会读到复位前状态，发出的请求
   *  被复位段 seq++ 判为过期丢弃且无重触发（复开且摘要已在场时 watch 短路，
   *  复位清空后无人补发，摘要恒空）。延迟一拍恒落在复位完成后读终态 */
  watch([ctx.dir, ctxSelected, () => ctx.isShow()], () => {
    void nextTick(() => {
      if (!ctx.isShow() || !contextScopeOk.value) return
      SESSION_CONTEXT_ALL.forEach((o) => {
        if (ctxSelected[o] && !ctxSummaries[o]) void refreshContextSummary(o)
      })
    })
  })

  /** 从 store 镜像复位勾选档（打开复位与 load 细化共用；store 未加载 = 默认 git） */
  function applyCtxDefaults() {
    ctxSelected.git = sessionContextStore.options.includes('git')
    ctxSelected.notes = sessionContextStore.options.includes('notes')
    ctxSelected.todos = sessionContextStore.options.includes('todos')
    ctxSelected.env = sessionContextStore.options.includes('env')
  }

  /** 会话目录是否落在当前项目内（前缀包含判定，分隔符/尾斜杠/大小写归一——
   *  大小写折叠在大小写敏感文件系统最坏是把摘要多附给一个同形路径，无害）。
   *  为什么需要：worktree 入口（GitWorktreesSection）会预填项目外的 worktree
   *  路径——上下文描述的是项目主树的分支/笔记/待办，对 worktree 会话是错误
   *  上下文，宁可不附也不给错的。目录留空 = 主目录会话，摘要自带项目名作归属
   *  标注，与模板 {dir} 占位符「留空回落项目根」的既有语义一致（templateCtx） */
  function dirWithinProject(dir: string): boolean {
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const root = norm(projectStore.currentProject?.path || '')
    if (!root) return false
    const d = norm(dir)
    return !d || d === root || d.startsWith(`${root}/`)
  }

  /** 上下文生效条件：会话目录在当前项目语义内 */
  const contextScopeOk = computed(() => dirWithinProject(ctx.dir.value))

  /** 任务指令 + 上下文摘要统一组装（P-20261003-184 promptBuilder）：指令 = 主任务
   *  保底段（定型文本，不截断用户可见内容），上下文 = 定型前言（声明序
   *  env→notes→todos→git，超 500 字节按序整段弃——dropped 驱动 UI 就地提示）。
   *  服务端 promptSessionName 按首行派生会话名，组装器保主任务恒首行。指令本身
   *  超限时 promptOverLimit 预检已拦截（组装器不截用户文本）。**归属护栏在装配层**：
   *  worktree 等项目外目录即使勾选在场（勾选区隐藏但默认勾选态留存）也不注入
   *  ——旧版 gitSummaryActive 的 scope 门槛语义（P-176 定案：宁可不附不给错的） */
  const promptAssembly = computed(() => assembleLaunchPrompt([
    { id: 'task', kind: 'essential', text: promptText.value.trim() },
    ...SESSION_CONTEXT_ASSEMBLY_ORDER
      .filter(o => contextScopeOk.value && ctxSelected[o] && ctxSummaries[o])
      .map(o => ({ id: o, kind: 'atomic' as const, text: ctxSummaries[o] })),
  ]))

  /** 空间不足：指令 + 上下文超 500 字节 → 组装器按声明序弃前言保指令原文（不
   *  静默截断用户文本），dropped 驱动就地提示列被弃项 */
  const contextDropped = computed(() => promptAssembly.value.dropped)

  const contextDroppedNames = computed(() =>
    contextDropped.value
      .filter((id): id is SessionContextOption => id in CTX_LABEL_KEYS)
      .map(id => t(CTX_LABEL_KEYS[id]))
      .join(', '))

  /** 打开复位（原 show watch 的上下文/选区段）：{selection} 快照重取（同步段，
   *  此后编辑器选区变化不回灌——见 selectionSnapshot 声明处注记）；上下文同步
   *  先按 store 镜像复位（store 未加载时 = 默认 git 档，现状形态；复位触发补取
   *  watch 打开即预取，提交时零等待），load() 现拉设置后细化默认——对话框打开
   *  本就是多请求低频路径，多一次 GET 换「他端/agent 刚改档」的即时正确
   *  （settings.changed 广播在途时也拿到新值）。ctxTouched 守卫防覆盖用户在
   *  load 返回前已做的手动勾选（先到先得，P-89 恢复仲裁同哲学）；seq 自增使
   *  上一轮在途预取过期（复开不回写陈旧摘要）；在途取数标志一并清：上一轮
   *  会话的在途请求其响应已被 seq++ 判过期，不清标志会挡住本轮补取 watch
   *  重新发取（复开即空摘要的另一半） */
  function resetForOpen() {
    selectionSnapshot.value = navHistory.activeSelection.value
    summaryReqSeq++
    ctxTouched = false
    applyCtxDefaults()
    ctxSummaries.git = ''
    ctxSummaries.notes = ''
    ctxSummaries.todos = ''
    ctxSummaries.env = ''
    ctxFetching.git = false
    ctxFetching.notes = false
    ctxFetching.todos = false
    ctxFetching.env = false
    contextExpanded.value = ['ctx']
    void sessionContextStore.load().then(() => {
      if (!ctx.isShow() || ctxTouched) return
      applyCtxDefaults()
    })
  }

  /** 模板清单刷新（打开时无条件执行：管理面改动即时反映到下拉） */
  function ensureTemplatesLoaded(): Promise<unknown> {
    return taskTemplates.load()
  }

  function armSkipTemplateReset() {
    skipNextTemplateReset = true
  }

  return {
    templateId,
    promptText,
    promptTouched,
    templateOptions,
    unresolvedPlaceholders,
    unresolvedLabel,
    selectionUnresolved,
    promptBytes,
    promptOverLimit,
    armSkipTemplateReset,
    ensureTemplatesLoaded,
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
  }
}
