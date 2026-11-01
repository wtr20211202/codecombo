import { projectApi } from '../api/client'
import { envProfileApi } from '../api/domains/envprofile'
import { useProjectStore } from '../stores/project'
import { useSessionContextStore } from '../stores/sessionContext'
import { useGitStatusSummary } from './useGitStatusSummary'
import { useI18n } from './useI18n'
import {
  buildEnvSummaryLine,
  buildNotesSummaryLine,
  buildTodosSummaryLine,
  SESSION_CONTEXT_ASSEMBLY_ORDER,
  TODO_SUMMARY_MAX_ENTRIES,
  type SessionContextOption,
} from '../utils/sessionContextSummary'
import type { PromptSection } from '../utils/promptBuilder'

/**
 * 会话启动上下文装配面（P-20261006-47）：P-176 的 git 摘要组装器扩为「上下文
 * 装配器」——设置键 sessionContext 勾选的各选项由独立小组装函数取数拼行，输出
 * utils/promptBuilder 段落数组交统一组装器装箱（总预算 500 字节，弃段阶梯 =
 * 声明序逐项降级保 git，见 SESSION_CONTEXT_ASSEMBLY_ORDER）。
 *
 * 消费方 = useEditorAskAgent.launchAskSession（P-28/P-190/P-73 等 ask 发起族
 * 共用）与 NewSessionDialog（对话框按次覆选传 override）。数据面全部现成缓存
 * 或一次现查（projnotes / todos / env-profile 端点，git 沿 P-176），尽力而为
 * 绝不阻塞发起：任何取数失败该选项静默缺省。
 */
export function useSessionContextSummary() {
  // useI18n 依赖组件实例，须在 setup 期解析一次（useEditorAskAgent 同款纪律）
  const { t } = useI18n()
  const { buildCurrentSummary } = useGitStatusSummary()

  /** 项目笔记首段（projnotes 面板同源端点）：不可用/无笔记返回空串 */
  async function buildNotesSummary(): Promise<string> {
    const project = useProjectStore().currentProject
    if (!project) return ''
    try {
      const res = (await projectApi.projectNotes(project.id)) as { data?: { content?: string } }
      return buildNotesSummaryLine({ projectName: project.name, content: res.data?.content ?? '' }, t)
    } catch {
      return ''
    }
  }

  /** TODO 概要（TODO 面板同源端点）：计数 + 顶层条目；不可用/无待办返回空串 */
  async function buildTodosSummary(): Promise<string> {
    const project = useProjectStore().currentProject
    if (!project) return ''
    try {
      const res = (await projectApi.projectTodos(project.id)) as {
        data?: { path: string; items: { path: string; line: number }[] }[]
        total?: number
        truncated?: boolean
      }
      const groups = res.data ?? []
      const entries = groups.flatMap(g => g.items).slice(0, TODO_SUMMARY_MAX_ENTRIES)
      // total 缺失（旧服务端）回落本地求和（上限截断语义降级为可见数，诚实）
      const total = typeof res.total === 'number'
        ? res.total
        : groups.reduce((n, g) => n + g.items.length, 0)
      return buildTodosSummaryLine(
        {
          projectName: project.name,
          total,
          truncated: !!res.truncated,
          entries: entries.map(e => ({ path: e.path, line: e.line })),
        },
        t,
      )
    } catch {
      return ''
    }
  }

  /** 环境画像（GET /projects/:id/env-profile，P-20261007-14）：端口/哨兵/部署
   * 目标概要；源级降级键缺席按「不可知」跳过（不冒充 0），全空返回空串 */
  async function buildEnvSummary(): Promise<string> {
    const project = useProjectStore().currentProject
    if (!project) return ''
    try {
      const res = await envProfileApi.get(project.id)
      const data = res.data
      if (!data) return ''
      return buildEnvSummaryLine(
        {
          projectName: project.name,
          devPorts: data.devPorts.map(p => ({ port: p.port, label: p.label })),
          sentinelCount: data.sentinels === undefined ? undefined : data.sentinels.length,
          deployTargets: data.deployTargets === undefined ? undefined : data.deployTargets.map(h => h.name),
        },
        t,
      )
    } catch {
      return ''
    }
  }

  /** 单选项小组装（对话框按次覆选的增量预取用；git 沿 P-176 既有取数面） */
  async function buildSummary(option: SessionContextOption): Promise<string> {
    if (option === 'git') return buildCurrentSummary()
    if (option === 'notes') return buildNotesSummary()
    if (option === 'env') return buildEnvSummary()
    return buildTodosSummary()
  }

  /**
   * 读设置（override 提供时按次覆选）装配上下文段落数组。声明序 =
   * SESSION_CONTEXT_ASSEMBLY_ORDER（env→notes→todos→git）：统一组装器按声明序
   * 弃段，git 殿后 = 超限最后弃（提案「逐项降级保 git」），段 id 即选项 id
   * （dropped 诊断与单测断言用）。设置读取经 store ensureLoaded 兜一次首载。
   */
  async function buildContextSections(override?: readonly SessionContextOption[]): Promise<PromptSection[]> {
    let enabled = override
    if (!enabled) {
      const store = useSessionContextStore()
      await store.ensureLoaded()
      enabled = store.options
    }
    const lines = await Promise.all(SESSION_CONTEXT_ASSEMBLY_ORDER.map(async (o) => {
      return enabled.includes(o) ? await buildSummary(o) : ''
    }))
    const sections: PromptSection[] = []
    SESSION_CONTEXT_ASSEMBLY_ORDER.forEach((o, i) => {
      const text = lines[i]
      if (text) sections.push({ id: o, kind: 'atomic', text })
    })
    return sections
  }

  return { buildNotesSummary, buildTodosSummary, buildSummary, buildContextSections }
}
