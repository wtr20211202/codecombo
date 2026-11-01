import { computed, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { fitListPrompt } from './useCommitAgentMsg'
import { terminalApi } from '../api/domains/terminal'

/**
 * 跨智能体审查链（P-20261003-6）：把某会话的产出交另一 runtime 审查——写/
 * 审查分工。入口（会话行右键 / 产出面板操作区）选源会话 → 弹层选目标 runtime
 * → 组装 prompt（审查指令 + 产出清单）经 createAgentTerminal 既有链路发起
 * （同 useEditorAskAgent / useCommitAgentMsg 范式：launchArgs 预填 + 打开
 * docked 管理页激活）。
 *
 * - 目标 runtime 默认值 = 非源 runtime 的设置默认值：服务端「设置默认」即
 *   auto（按可用性挑首个，SelectProviderByName），故取清单中首个可用且 ≠ 源
 *   runtime 的项，无则回落 auto 交服务端选型
 * - 审查会话 cwd = 源会话目录：审查者可直接核查该目录的 diff——这也是 ②「产出
 *   回流」的归属机制：主树会话（cwd=项目根）的审查产出经 useAgentMarks 既有链
 *   自动收敛进文件树标记（runtimes 聚合）；worktree 会话按既有边界不入主树
 *   marks（diff 路径相对其自身仓库根，映射主树是错误归属），产出由其产出面板覆盖
 * - prompt 产出清单同口径（isMainTreeSession）：主树会话按主树相对路径表述，
 *   worktree 会话按会话目录相对路径表述，不伪称主树；清单经 fitListPrompt
 *   （useCommitAgentMsg 既有装箱）收进 launchArgs 500 字节上限
 * - 已知限制同 useEditorAskAgent：目标为纯终端/无可用智能体运行时时服务端降级
 *   纯 shell 会话（launched=false），prompt 以提示告知不保证进入智能体
 */

/** 审查源会话信息（systemSessions 形状子集，纯函数不依赖 store） */
export interface CrossReviewSource {
  id: string
  name: string
  runtime: string
  /** 会话工作目录（审查会话 cwd 与主树归属判定用） */
  dir?: string
}

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type CrossReviewTranslator = (key: string, params?: Record<string, unknown>) => string

/** 主树归属判定（useAgentMarks 既有边界同口径）：会话 cwd 归一化（反斜杠→/
 *  +去尾斜杠）后等于当前项目根才算主树会话；空目录/无当前项目不算 */
export function isMainTreeSession(sessionDir: string | undefined, projectRoot: string): boolean {
  const norm = (p: string | undefined) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const dir = norm(sessionDir)
  const root = norm(projectRoot)
  return !!dir && !!root && dir === root
}

/** 默认目标 runtime（纯函数）：首个可用且 ≠ 源 runtime 的项；源 runtime 未知
 *  （''/auto）时不排除；无命中回落 auto（服务端按可用性选型）。options 为
 *  listAgentRuntimes 清单（已滤 shell/auto，agent 一等运行时才有审查能力） */
export function defaultCrossReviewTarget(
  options: { name: string; available: boolean }[],
  sourceRuntime: string,
): string {
  const src = sourceRuntime === 'auto' ? '' : sourceRuntime
  const hit = options.find(o => o.available && o.name !== src)
  return hit?.name || 'auto'
}

/** 组装审查 prompt（纯函数）：审查指令（含源会话名）+ 产出清单。清单行
 *  `M path`（activity name-status 短状态原样）；主树会话清单头按主树口径、
 *  worktree/未知目录按会话目录口径（既有边界，不伪称主树）。无产出时给引导
 *  语——审查会话 cwd=源会话目录，可自行核查工作区改动 */
export function buildCrossReviewPrompt(opts: {
  name: string
  files: { status: string; path: string }[]
  inMainTree: boolean
  t: CrossReviewTranslator
}): string {
  const head = opts.t('review.cross.promptHead', { name: opts.name })
  if (opts.files.length === 0) {
    return [head, opts.t('review.cross.promptNoOutput')].join('\n')
  }
  return fitListPrompt(
    list => [
      head,
      opts.t(opts.inMainTree ? 'review.cross.promptListHeadMain' : 'review.cross.promptListHeadDir'),
      list,
    ].join('\n'),
    opts.files.map(f => `${f.status} ${f.path}`),
  )
}

// 模块级单例状态（useAgentTerminal 同范式）：入口（产出面板/会话行宿主）与
// docked View 挂载的唯一弹层实例共享同一份源会话事实
const source = ref<CrossReviewSource | null>(null)
const show = ref(false)

/** 入口动作（免组合式实例，模块级导出）：会话行宿主 / 产出面板操作区直接调用
 *  打开弹层。面板随开合挂卸，走本函数可免在 setup 期反复建组合式实例——
 *  message 通道（createDiscreteApi）只属于弹层所在的 useCrossReview() 调用方 */
export function openCrossReview(s: CrossReviewSource): void {
  source.value = s
  show.value = true
}

export function useCrossReview() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useCommitAgentMsg 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })
  // 发起中标志：弹层确认按钮 loading + 防重复提交
  const launching = ref(false)

  /** 关闭弹层并清源（成功发起与取消共用） */
  function close(): void {
    show.value = false
    source.value = null
  }

  /** 发起交叉审查：现取产出清单（防弹层滞留期间产出漂移；404/失败=无清单，
   *  silent 不惊扰全局错误 toast）→ 组装 prompt → createAgentTerminal 链路
   *  发起（审查会话 cwd=源会话目录）→ 打开 docked 管理页激活 */
  async function launch(targetRuntime: string): Promise<void> {
    const src = source.value
    if (launching.value || !src) return
    let files: { status: string; path: string }[] = []
    try {
      const res = await terminalApi.activity(src.id, { silent: true }) as { data?: { files?: { status: string; path: string }[] } }
      files = res?.data?.files || []
    } catch { /* 无元数据/已结束：按无清单发起，审查会话自行核查工作区 */ }
    const root = projectStore.currentProject?.path || ''
    const dir = src.dir || root
    if (!dir) {
      message.error(t('review.cross.launchFailed'))
      return
    }
    const prompt = buildCrossReviewPrompt({
      name: src.name,
      files,
      inMainTree: isMainTreeSession(src.dir, root),
      t: t as unknown as CrossReviewTranslator,
    })
    // 清单疑似含敏感值（凭据/令牌形态的路径）时先确认（P-109 口径同
    // useCommitAgentMsg），取消 = 不创建会话
    if (containsSensitiveValue(prompt)) {
      const ok = await confirmDialog({
        title: t('review.cross.sensitiveTitle'),
        content: t('review.cross.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return
    }
    launching.value = true
    try {
      const agentTerminal = useAgentTerminal()
      if (agentTerminal.busy.value) return
      const info = await agentTerminal.create(
        targetRuntime === 'auto' ? undefined : targetRuntime,
        { dir, launchArgs: prompt },
      )
      if (!info) {
        message.error(t('review.cross.launchFailed'))
        return
      }
      if (!info.launched) {
        message.warning(t('review.cross.degraded'))
      } else {
        message.success(t('review.cross.launched'))
      }
      await agentTerminal.open('docked')
      close()
    } finally {
      launching.value = false
    }
  }

  return { source, show, launching, openCrossReview, close, launch }
}
