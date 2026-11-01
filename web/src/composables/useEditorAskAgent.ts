import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useSessionContextSummary } from './useSessionContextSummary'
import { useI18n } from './useI18n'
import { byteLength, fitByBytes, LAUNCH_ARGS_MAX_BYTES } from '../utils/promptFit'
import { assembleLaunchPrompt, type PromptSection } from '../utils/promptBuilder'
import { diagnosticOriginText } from '../utils/editorProblems'

/**
 * 编辑器「就此文件询问智能体」（P-20261001-28）：把编辑器上下文（项目相对
 * 路径 + 光标行号）拼成 prompt 经 launchArgs 预填，一键新建 agent 会话并打开
 * docked 管理页激活。复用 createAgentTerminal 既有链路：runtime 取设置默认
 * （空 = 设置默认/按可用性），dir = 项目根（会话 cwd）。
 *
 * - prompt 路径用项目相对路径（cwd=项目根可直接引用；反斜杠归一为 /，
 *   跨平台一致），不带绝对路径/本机形态
 * - launchArgs 服务端按 UTF-8 字节计上限 500（len 超限直接 400）：超限从路径
 *   头部裁剪（保文件名段），以 … 前缀标注省略——装箱算法走 utils/promptFit
 *   fitByBytes 单一事实源（P-20261004-6 收敛）
 * - 「询问智能体选中代码」（P-20261002-122）：askAgentAboutSelection 把选中
 *   代码注入 prompt（路径+行号头部定位，代码超限从尾部裁剪），入口在编辑器
 *   右键菜单（Monaco precondition=editorHasSelection，无选区菜单项隐藏），
 *   复用同一发起链路
 * - 「询问智能体此输出」（P-20261003-7）：askAgentAboutTerminalOutput 把终端
 *   选中文本注入 prompt（终端输出询问头定位，选区超限从尾部裁剪——报错现场
 *   首行在头部），入口在项目终端 pane 右键菜单（无选区置灰），复用同一发起
 *   链路与 runtime 语义（runtime 空 = 设置默认/按可用性）
 * - 「交给 agent 修」（P-20261003-150）：askAgentToFixFailedCommand 把终端最近
 *   失败命令（OSC 133 D 帧记账，terminalCommandMarks）+ 输出尾部注入 prompt，
 *   入口在项目终端 pane 右键菜单（无失败记录置灰），复用同一发起链路与 runtime
 *   语义
 * - 「diff 行级追问此改动」（P-20261003-208）：askAgentAboutDiffChange 把
 *   diff 视图右键行（文件+行号+所在 hunk 摘要）注入 prompt，入口在 diff 标签
 *   （DiffEditor）两侧子编辑器右键菜单，复用同一发起链路
 * - 「询问智能体此行来历」（P-20261004-40）：askAgentAboutBlameLine 把 blame
 *   注解右键行（路径+行号+行内容+blame 元数据：短 hash/作者/日期/提交摘要）
 *   注入 prompt，入口在 blame 徽标右键菜单（useEditorBlame 只上抛数据，发起
 *   走本组合式），复用同一发起链路
 * - 「在此目录新建 agent 会话」（P-20261003-55）：askAgentInDirectory 把文件树
 *   右键目标目录作为会话 cwd（目录项取自身、文件项取父目录，monorepo/多包
 *   场景 agent 探索范围与心智聚焦），prompt 相对 cwd 表述不写绝对路径；同一
 *   发起链路与 runtime 语义
 * - 「问智能体：解释此错误」（P-20261006-2）：askAgentAboutDiagnostic 把诊断
 *   结构化载荷（消息全文+错误码+文件:行:列+来源）注入 prompt，入口在编辑器
 *   诊断 code action（marker hover lightbulb 同源的 quickfix 面）与问题面板
 *   条目按钮，复用同一发起链路
 * - 「子目录会话定位前言」（P-20261003-102）：askAgentInDirectory 的子目录
 *   会话（rel 非空）在任务行后附一行「项目根/当前工作目录（相对位置）」——
 *   cwd=子目录的 agent 看不到项目根，跨目录任务迷路；根目录会话不附（零
 *   变化）。前言落任务行**之后**而非提案字面的首行前置：服务端
 *   promptSessionName 以 launchArgs 首行派生会话名，前置会让子目录会话列表
 *   全变「项目根：…」（P-176 git 摘要同款定案，理据见 utils/gitStatusSummary
 *   头注）；极端深路径挤爆配额时前言整段放弃保任务原文（git 摘要同尽力而为语义）
 * - 「会话启动上下文注入」（P-176 git 摘要 → P-20261006-47 扩面配置化）：
 *   launchAskSession 统一在 prompt 尾部追加当前项目的「工作台背景资料」——
 *   git 状态一行（分支/未提交变更数/最近提交主题）为 P-176 既有，笔记首段/
 *   TODO 概要为 P-47 扩面，环境画像为 P-20261007-14 扩面，由设置键
 *   sessionContext 多选（useSessionContextSummary 读 store 装配段落数组）。
 *   摘要占用字节从 500 配额扣除后主任务按剩余份额收敛，总额恒 ≤500；超限按
 *   声明序（env→notes→todos→git）逐项降级保 git
 * - 前言统一组装器（P-20261003-184）：三案（定位/接力/git 摘要）的拼接顺序/
 *   配额分配/截断优先级收编进 utils/promptBuilder assembleLaunchPrompt——
 *   本组合式只声明段落数组（声明顺序 = 装配顺序 = 弃段顺序：定位先于 git
 *   摘要让位，与 P-176「摘要预留配额」既有定案同序），不再自持手工配额算术
 * - 已知限制（任务书记为 MVP 边界）：设置默认运行时为纯终端（shell）时
 *   prompt 会作为初始命令注入 shell；环境探测不到任何智能体运行时时服务端
 *   降级纯 shell 会话（launched=false）——两者均以提示告知，prompt 不保证
 *   进入智能体
 */

/** 选区版 prompt 拼装：header（路径+行号定位）保头部，超限时从代码尾部裁剪
 *  （头部定位信息不能丢，… 尾缀标注省略）。估裁方向与 utils/promptFit
 *  fitByBytes 相反——代码价值在开头（选中起点），故批量估裁用 ceil 保头、
 *  再逐字符微调。路径定位头装箱统一走 fitByBytes（P-20261004-6 收敛）；保头
 *  是选区/终端输出域语义，保留本地实现，字节度量走同一事实源。
 *  max 参数（P-20261003-176）：发起链扣除 git 状态摘要后传入的剩余配额 */
function fitSelectionPrompt(header: string, code: string, max = LAUNCH_ARGS_MAX_BYTES): string {
  const full = header + code
  if (byteLength(full) <= max) return full
  const ellipsis = '…'
  const over = byteLength(full) - max
  let c = code.slice(0, Math.max(0, code.length - Math.ceil(over / 4)))
  while (c.length > 0 && byteLength(header + c + ellipsis) > max) {
    c = c.slice(0, -1)
  }
  return header + c + ellipsis
}

/** 诊断「问智能体：解释此错误」的结构化载荷（P-20261006-2）：编辑器 code
 *  action 与问题面板条目两入口共用。code/source 为可编程引用的原始码值
 *  （agent 拿到可查语义），缺省字段 = 该诊断未声明 */
export interface DiagnosticAskPayload {
  path: string
  line: number
  col: number
  message: string
  code?: string
  source?: string
}

export function useEditorAskAgent() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 上下文装配面（P-20261006-47，P-176 git 摘要的扩面）：必须在 setup 期解析
  // 一次——useI18n 依赖组件实例，放进 launchAskSession（事件回调运行时）会直接
  // 抛错，链路整体哑火
  const { buildContextSections } = useSessionContextSummary()
  // 离散 message（useOpenFiles 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 就此文件询问智能体：新建 agent 会话（cwd=项目根，prompt 经 launchArgs
   *  预填）并打开 docked 管理页激活（Claude 会话恢复同款链路：create 置
   *  activeId → open('docked')）。line 提供时 prompt 聚焦该行（编辑器光标
   *  位置，仅在该文件正是编辑器当前显示文件时由调用方传入） */
  async function askAgentAboutFile(path: string, line?: number): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !path) return
    const rel = path.replace(/\\/g, '/')
    await launchAskSession(
      root,
      () => [{
        id: 'task',
        kind: 'essential',
        text: '',
        // 路径超配额从头部裁剪（保文件名段），… 前缀标注省略——份额由组装器
        // 按前言预留后分发（git 摘要在场 = 500 - 摘要字节 - 换行，P-176 同式）
        fit: budget => fitByBytes(
          p => (line ? t('editor.ask.promptAtLine', { path: p, line }) : t('editor.ask.prompt', { path: p })),
          rel,
          budget,
        ),
      }],
      rel,
    )
  }

  /** 就选中代码询问智能体（P-20261002-122）：prompt = 路径+行号头部定位 +
   *  选中代码全文。超配额时两段式裁剪——先按整文件询问同款裁路径（保定位
   *  头部），再从代码尾部裁（选中起点在头部，价值密度高）。code 空串
   *  直接不动作（调用方已由 Monaco precondition 隐藏入口，此处仅防御） */
  async function askAgentAboutSelection(
    path: string,
    code: string,
    startLine: number,
    endLine: number,
  ): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !path || !code) return
    const rel = path.replace(/\\/g, '/')
    await launchAskSession(root, () => [{
      id: 'task',
      kind: 'essential',
      text: '',
      fit: (budget) => {
        const header = fitByBytes(
          p => (startLine === endLine
            ? t('editor.ask.promptSelectionAtLine', { path: p, line: startLine })
            : t('editor.ask.promptSelection', { path: p, start: startLine, end: endLine })),
          rel,
          budget,
        )
        const prompt0 = fitSelectionPrompt(header + '\n', code.replace(/\s+$/, ''), budget)
        // 极端超长路径下 header 可能已贴近配额（fitByBytes 只保证 header 本身
        // ≤budget）：代码连 … 都塞不下时退化为纯定位头部（同整文件询问口径）
        return byteLength(prompt0) > budget ? header : prompt0
      },
    }], rel)
  }

  /** diff 视图行级追问「追问此改动」（P-20261003-208）：prompt = 文件+行号
   *  定位头 + 所在 hunk 摘要（diff hunk 头 + 两侧变更行样本，DiffEditor 侧
   *  从 getLineChanges/双 model 构造）。头保位（fitByBytes），摘要保头裁尾
   *  （fitSelectionPrompt 同口径——点击行邻近的变更行在摘要头部，价值密度
   *  高）；摘要空（无变更块可定位）退化纯定位头（同整文件询问口径，必
   *  ≤500）。path 为项目相对路径（diff 伪键解析产物，正斜杠归一兜底） */
  async function askAgentAboutDiffChange(path: string, line: number, hunkSummary: string): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !path || !line) return
    const rel = path.replace(/\\/g, '/')
    await launchAskSession(root, () => [{
      id: 'task',
      kind: 'essential',
      text: '',
      fit: (budget) => {
        const header = fitByBytes(p => t('diff.ask.prompt', { path: p, line }), rel, budget)
        const prompt0 = hunkSummary ? fitSelectionPrompt(header + '\n', hunkSummary, budget) : header
        // 极端超长路径下 prompt0 可能已贴配额（P-122 同口径：摘要连 … 都塞不下
        // 时退化为纯定位头部，locale 文案必在配额内）
        return byteLength(prompt0) > budget ? header : prompt0
      },
    }], rel)
  }

  /** blame 行「询问智能体此行来历」（P-20261004-40）：prompt = 定位问句头（路径+
   *  行号）+ blame 信息行（短 hash/作者/日期/提交摘要）+ 行内容。三段按价值序
   *  分档装箱（头 > blame 行 > 行内容）：① 头经 fitByBytes 保名恒 ≤配额；②
   *  blame 行是本入口独有载荷（行内容 agent 开文件即得，考古元数据不然）优先于
   *  行内容、吃剩余配额一半——摘要可保头裁剪（约定式提交的类型/范围前缀在
   *  头部，字节度量同源 promptFit），作者/日期/短 hash 恒定在场；③ 行内容保头裁尾
   *  （fitSelectionPrompt 同式）。hash/行号缺失防御性不动作；行内容允许空串
   *  （空行注解照样可问——「为什么这里留白」也是来历问题，不产空行伪影） */
  async function askAgentAboutBlameLine(info: {
    path: string
    line: number
    content: string
    hash: string
    author: string
    /** 注入文本同形态的本地日期（YYYY-MM-DD）：绝对日期对 agent 可稳定引用，
     *  不随阅读时点衰减（相对时间会） */
    date: string
    summary: string
  }): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !info.path || !info.line || !info.hash) return
    const rel = info.path.replace(/\\/g, '/')
    await launchAskSession(root, () => [{
      id: 'task',
      kind: 'essential',
      text: '',
      fit: (budget) => {
        const header = fitByBytes(p => t('blame.ask.prompt', { path: p, line: info.line }), rel, budget)
        const rest = budget - byteLength(header) - 1
        // 极端超长路径下 header 贴满配额（P-122 同口径）：退化纯定位头
        if (rest <= 0) return header
        const blameShare = Math.ceil(rest / 2)
        let blameLine: string
        if (info.summary) {
          // 摘要保头裁剪（约定式提交的类型/范围前缀在头部，fitByBytes 的保尾
          // 语义在此方向相反）——fitSelectionPrompt 空 header 即纯保头裁剪器，
          // 模板定段以空摘要先渲染成前缀
          const prefix = t('blame.ask.line', { hash: info.hash, author: info.author, date: info.date, summary: '' })
          blameLine = fitSelectionPrompt(prefix, info.summary, blameShare)
        } else {
          blameLine = t('blame.ask.lineNoSummary', { hash: info.hash, author: info.author, date: info.date })
        }
        // 固定段（极端长的作者名等）自身超份额：blame 行整行让位（行内容吃剩余）
        // ——元数据可由 agent 会话内自行 git blame 补，定位头+行内容不丢
        let text = header
        let contentBudget = rest
        if (byteLength(blameLine) <= blameShare) {
          text += '\n' + blameLine
          contentBudget = rest - byteLength(blameLine) - 1
        }
        // 行内容保头裁尾；连省略号都放不下时不产裸 … 伪影行（极端长路径退化形态）
        if (info.content && contentBudget > byteLength('…')) {
          text += '\n' + fitSelectionPrompt('', info.content, contentBudget)
        }
        return text
      },
    }], rel)
  }

  /** 诊断「问智能体：解释此错误」（P-20261006-2）：prompt = 诊断定位问句头
   *  （路径+行:列+来源/错误码）+ 错误消息全文。装箱两段式（P-122 同口径）：
   *  头部 fitByBytes 保名，错误消息保头裁尾（首行是主消息，链式详情在尾可让位）；
   *  塞不下退化纯定位头部。来源/错误码渲染式与 Monaco hover 同款（diagnosticOriginText），
   *  全缺省走无来源模板不产悬空括号；来源取 marker.source 优先 owner 兜底
   *  （diagnosticSourceOf，调用方归一后传入）。消息空串防御性不动作 */
  async function askAgentAboutDiagnostic(info: DiagnosticAskPayload): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !info.path || !info.line || !info.message) return
    const rel = info.path.replace(/\\/g, '/')
    await launchAskSession(root, () => [{
      id: 'task',
      kind: 'essential',
      text: '',
      fit: (budget) => {
        const origin = diagnosticOriginText(info.source, info.code)
        const header = fitByBytes(
          (p) => (origin
            ? t('editor.ask.promptDiagnostic', { path: p, line: info.line, col: info.col || 1, origin })
            : t('editor.ask.promptDiagnosticPlain', { path: p, line: info.line, col: info.col || 1 })),
          rel,
          budget,
        )
        const prompt0 = fitSelectionPrompt(header + '\n', info.message, budget)
        // 极端超长路径下 header 可能已贴配额（P-122 同口径）：消息连 … 都塞不下
        // 时退化为纯定位头部（locale 文案必在配额内）
        return byteLength(prompt0) > budget ? header : prompt0
      },
    }], rel, t('editor.ask.successDiagnostic'))
  }

  /** 终端选中文本「询问智能体此输出」（P-20261003-7）：prompt = 终端输出询问
   *  头 + 选中文本全文。P-122 选区版同款两段式裁剪——询问头保位，选区从尾部
   *  裁（报错现场首行/堆栈头在选区起点，价值密度高）；选区尾随空白（xterm 行
   *  定宽补空格、拖选跨出行尾）先剥。text 空串直接不动作（调用方菜单项无选区
   *  置灰，此处仅防御）。成功提示不带路径（终端选区无文件定位语义） */
  async function askAgentAboutTerminalOutput(text: string): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !text) return
    await launchAskSession(root, () => [{
      id: 'task',
      kind: 'essential',
      text: '',
      fit: (budget) => {
        const header = t('terminal.ask.promptHeader')
        const prompt0 = fitSelectionPrompt(header + '\n', text.replace(/\s+$/, ''), budget)
        // 极端超长询问头下 prompt0 可能已贴配额（同 P-122 口径：代码连 … 都塞不下
        // 时退化为纯询问头，locale 文案必 ≤budget）
        return byteLength(prompt0) > budget ? header : prompt0
      },
    }])
  }

  /** 目录右键「在此目录新建 agent 会话」（P-20261003-55）：monorepo/多包项目
   *  在目标目录起会话（cwd=目标目录），agent 探索范围与心智聚焦。relDir 为
   *  项目相对目录路径（目录项=自身、文件项=父目录、空串=项目根）：dir 拼装
   *  跟随项目根原生分隔符形态（copy-abs 同款惯例，服务端拿到的是可用路径），
   *  prompt 相对 cwd 表述（P-28 惯例，不写绝对路径/本机形态）。
   *  定位前言（P-20261003-102）：rel 非空（子目录会话）时在任务行后附一行
   *  「项目根/当前工作目录（相对 rel）」——cwd=子目录的 agent 不知道项目根
   *  与整体结构，跨目录任务迷路；绝对路径是本行的目的（agent 同机可直接
   *  引用），不属 P-28 「prompt 不写绝对路径」的约束面（该惯例管任务对文件
   *  的指称，本行管空间定位）。根目录会话不附（零变化）。
   *  marks 归属边界（既有收紧语义保持）：cwd≠项目根的会话不入文件树 agent
   *  打点（useAgentMarks 仅匹配根目录会话），产出由 docked 管理页产出侧板覆盖 */
  async function askAgentInDirectory(relDir: string): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root) return
    const base = root.replace(/[\\/]+$/, '')
    const rel = relDir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const sep = base.includes('\\') ? '\\' : '/'
    const dir = rel ? base + sep + rel.replace(/\//g, sep) : base
    await launchAskSession(
      dir,
      () => {
        // 段落声明顺序 = 装配顺序 = 弃段顺序（组装器定案）：任务首行（会话名
        // 派生语义）、定位前言次之（P-102，先于 git 摘要让位）、git 摘要由
        // launchAskSession 声明在末位（尾部，配额最优先保留）
        const sections: PromptSection[] = [{ id: 'task', kind: 'essential', text: t('agentTerminal.dirAsk.prompt') }]
        if (rel) {
          // 前言落任务行之后（非首行前置）：promptSessionName 以 launchArgs 首行
          // 派生会话名，前置会让子目录会话列表全变「项目根：…」（P-176 同款定案，
          // 见 utils/gitStatusSummary 头注）。原子定型整行：挤爆配额整段放弃保
          // 任务原文（组装器按份额判定，不再手工量字节）
          sections.push({
            id: 'locate',
            kind: 'atomic',
            text: t('agentTerminal.dirAsk.locate', { root: base, dir, rel }),
          })
        }
        return sections
      },
      undefined,
      t('agentTerminal.dirAsk.success', { dir: rel || t('terminal.locate.dirProjectRoot') }),
    )
  }

  /** 终端失败命令「交给 agent 修」（P-20261003-150）：prompt = 失败询问头（含
   *  命令与退出码）+ 失败输出尾部，经同一发起链路新起 agent 会话。装箱两段式
   *  （P-122 同口径，方向按内容价值定）：① 头部经 fitByBytes 必 ≤配额（命令
   *  超长时保尾裁剪——fitByBytes 单一事实源的方向语义，… 前缀标注省略）；
   *  ② 输出经 fitByBytes 保尾装箱（报错汇总在尾部，与 P-7 选区保头相反——
   *  npm/编译类失败的关键 ERROR 块在输出末尾）；塞不下退化纯头部（整体仍
   *  ≤配额，最终超限由服务端 400 兜底）。output 空串（命令无输出即失败）直接
   *  用头部；command 空串防御性不动作（调用方以失败记录置灰菜单项） */
  async function askAgentToFixFailedCommand(command: string, output: string, exitCode: number): Promise<void> {
    const root = projectStore.currentProject?.path || ''
    if (!root || !command) return
    await launchAskSession(root, () => [{
      id: 'task',
      kind: 'essential',
      text: '',
      fit: (budget) => {
        const header = fitByBytes(
          (c) => t('terminal.fix.promptHeader', { command: c, exit: exitCode }),
          command,
          budget,
        )
        if (!output) return header
        const withOutput = fitByBytes((out) => `${header}\n${out}`, output, budget)
        return byteLength(withOutput) > budget ? header : withOutput
      },
    }], undefined, t('terminal.fix.success'))
  }

  /** 发起链路（P-28 既有语义原样复用）：busy 让位 → 任务段落与上下文段落
   *  （P-20261006-47 读 sessionContext 设置装配，git 摘要沿 P-176 尽力而为）
   *  并行取（互不依赖）→ 统一组装器装配 launchArgs（P-20261003-184：主任务
   *  保底、前言按声明顺序弃、500 字节配额分配与截断）→ create（dir=项目根，
   *  prompt 经 launchArgs 预填）→ 结果提示（失败/降级纯 shell）→ 打开 docked
   *  管理页激活。上下文段落声明在任务段落**之后**、装配序
   *  env→notes→todos→git（git 殿后 = 配额最优先保留、弃段最后弃；展示恒在
   *  prompt 尾部）：服务端 promptSessionName 以 launchArgs 首行派生会话名，前置
   *  会让会话列表全变「git 状态：…」——顺序定案与理据见 utils/gitStatusSummary
   *  头注。rel 提供时成功提示带路径（编辑器入口），缺省用终端入口的无路径成功
   *  文案；successMsg 显式提供时优先（目录会话入口的带目录成功文案，P-55）。
   *  导出给同族发起入口复用（P-20261005-190 冲突委派首例）：busy 让位/上下文
   *  注入/装配器/结果提示/docked 打开全链一致，调用方只声明任务段落 */
  async function launchAskSession(
    root: string,
    buildSections: () => PromptSection[] | Promise<PromptSection[]>,
    rel?: string,
    successMsg?: string,
  ): Promise<void> {
    const agentTerminal = useAgentTerminal()
    if (agentTerminal.busy.value) return
    const [sections, ctxSections] = await Promise.all([buildSections(), buildContextSections()])
    const { text } = assembleLaunchPrompt([...sections, ...ctxSections])
    const info = await agentTerminal.create(undefined, { dir: root, launchArgs: text })
    if (!info) {
      message.error(t('editor.ask.failed'))
      return
    }
    if (!info.launched) {
      message.warning(t('editor.ask.degraded'))
    } else {
      message.success(successMsg || (rel ? t('editor.ask.success', { path: rel }) : t('terminal.ask.success')))
    }
    await agentTerminal.open('docked')
  }

  return { askAgentAboutFile, askAgentAboutSelection, askAgentAboutTerminalOutput, askAgentAboutDiffChange, askAgentAboutBlameLine, askAgentAboutDiagnostic, askAgentToFixFailedCommand, askAgentInDirectory, launchAskSession }
}
