import { ref } from 'vue'
import { useProjectStore } from '../stores/project'
import { useEditorAskAgent } from './useEditorAskAgent'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { fitListPrompt } from './useCommitAgentMsg'

/**
 * 变更日志弹层「交给智能体润色」（P-20261004-73）：ChangelogDraftModal 二阶段
 * 占位的兑现——把生成的 markdown 草稿一键交给新 agent 会话润色，免「复制→
 * 手动开会话→粘贴交代」。发起复用 ask 链统一入口 `launchAskSession`（P-28
 * 家族：busy 让位/git 状态摘要注入/统一组装器/结果提示/docked 打开，P-190
 * 冲突委派首例同款复用），本组合式只声明任务段落与装箱。
 *
 * - prompt = 润色指令头 + 草稿全文；草稿可达 500 条聚合（数十 KB），而
 *   launchArgs 服务端 500 字节上限注定只能注入头部——沿 P-138 清单装箱惯例
 *   `fitListPrompt` 保头整行截断（markdown 条目价值密度在头部：标题/区间标注
 *   /feat 分区在前），… 尾缀标注省略；指令头明示「被截断时按区间标注自行
 *   git log 补全」（会话 cwd=项目根，agent 可自行查仓，P-177 同语义）
 * - 装箱预算：launchAskSession 组装器扣掉 git 摘要后把 essential 份额传入
 *   fit——fitListPrompt 的 max 参数（P-138 惯例的预算参数化，既有调用方缺省
 *   500 零变化）
 * - 敏感场景提示确认（P-109 口径同 P-138/P-177）：草稿（提交主题聚合）疑似
 *   含凭据/令牌时先确认，文案复用 commit.agentMsg 既有键（同一语义不复制翻译）
 * - 结果在会话中产出，不回填弹层（人审复制）；已知限制同 useEditorAskAgent：
 *   纯终端 runtime 时 prompt 作为初始命令注入 shell、无运行时降级纯 shell
 *   会话（launched=false）——提示由链路给出
 */

/** prompt 组装所需的极小翻译面（纯函数可测；组合式内传 useI18n 的 t） */
export type ChangelogPolishTranslator = (key: string, params?: Record<string, unknown>) => string

/** 组装润色 prompt（纯函数）：指令头 + 草稿逐行（尾随空白剥除——草稿恒以
 *  单个 \n 收尾，split 出的空尾行不占预算），budget = 组装器分发的份额 */
export function buildChangelogPolishPrompt(
  markdown: string,
  t: ChangelogPolishTranslator,
  budget: number,
): string {
  return fitListPrompt(
    list => [t('git.changelog.polishPromptHead'), list].join('\n'),
    markdown.replace(/\s+$/, '').split('\n'),
    budget,
  )
}

export function useChangelogPolish() {
  const projectStore = useProjectStore()
  const { t } = useI18n()
  const { launchAskSession } = useEditorAskAgent()
  // 发起中标志：按钮 loading 态 + 防重复点击（P-138/P-177 同款；会话创建成功
  // 即交由 docked 管理页接管）
  const polishing = ref(false)

  /** 把草稿交给智能体润色：新建 agent 会话（cwd=项目根，prompt 经 launchArgs
   *  预填）并打开 docked 管理页激活。markdown 空串防御性不动作（调用方以
   *  草稿空态禁用按钮，此处仅防御） */
  async function polishChangelog(markdown: string): Promise<void> {
    if (!markdown || polishing.value) return
    const root = projectStore.currentProject?.path || ''
    if (!root) return
    // 敏感场景提示确认（P-109 口径同 useCommitAgentMsg，文案复用其既有键——
    // 同一语义不复制翻译）：草稿疑似含凭据/令牌时先确认，取消 = 不创建会话
    if (containsSensitiveValue(markdown)) {
      const ok = await confirmDialog({
        title: t('commit.agentMsg.sensitiveTitle'),
        content: t('commit.agentMsg.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return
    }
    polishing.value = true
    try {
      await launchAskSession(
        root,
        () => [{
          id: 'task',
          kind: 'essential',
          text: '',
          // 草稿保头整行装箱，份额由组装器按 git 摘要预留后分发（P-176 同式）
          fit: budget => buildChangelogPolishPrompt(markdown, t as unknown as ChangelogPolishTranslator, budget),
        }],
        undefined,
        t('git.changelog.polishSuccess'),
      )
    } finally {
      polishing.value = false
    }
  }

  return { polishChangelog, polishing }
}

export type ChangelogPolishState = ReturnType<typeof useChangelogPolish>
