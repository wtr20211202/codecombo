import { computed, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal } from './useAgentTerminal'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { fitListPrompt, stagedFileLine } from './useCommitAgentMsg'
import type { CommitMsgFileEntry, CommitMsgTranslator } from './useCommitAgentMsg'

/**
 * 变更面板「拆分建议」（P-20261003-186，P-138 家族第三件）：暂存变更混多主题
 * （前端 + 修复 + 配置一锅烩）时，一键新建 agent 会话产出「分组方案」——每组
 * 组名 / 文件清单 / 建议 commit 主题，人工按方案逐组 stage/commit。
 *
 * - 发起链路与 useCommitAgentMsg（P-138）同范式：createAgentTerminal（runtime
 *   取设置默认，dir = 项目根）+ 打开 docked 管理页；清单口径同 P-138（调用方
 *   传 commitMsgTargets：勾选子集优先，未勾选 = 全部暂存）
 * - 输出纯建议是安全边界：模板显式「勿执行 git add/commit 等写操作」——分组
 *   方案的落地（逐组暂存与提交）完全由人工执行，本功能不做任何自动执行
 * - 500 字节配额沿 P-138：装箱复用 fitListPrompt（清单价值在头部，整行粒度
 *   保头截断 + … 尾缀）；diffstat 与 diff 内容不经 launchArgs 携带（配额装不
 *   下），模板指示 agent 在会话内（cwd=项目根）自行 git diff 查看全量变更再
 *   分组，清单仅作种子并如实标注「可能截断」
 * - 敏感场景确认 / busy 让位 / 降级与失败提示：P-138 同款语义
 */

/** 组装拆分建议 prompt（纯函数）：固定头（指令 + 结构化输出格式 + 清单标题）+
 *  暂存清单行。P-20261003-278 起输出结构化：分组方案以一个 ```json 代码块给出
 *  （groups[].name/files/subject）——「逐组执行」据此解析（useCommitSplitSuggest
 *  同目录的 useCommitSplitExecute）；格式行放在清单标题之前，装箱截断只丢清单行 */
export function buildSplitSuggestPrompt(files: CommitMsgFileEntry[], t: CommitMsgTranslator): string {
  return fitListPrompt(
    list => [t('commit.splitSuggest.promptHead'), t('commit.splitSuggest.promptFormat'), t('commit.splitSuggest.promptListHead'), list].join('\n'),
    files.map(stagedFileLine),
  )
}

/** 组装完整拆分建议 prompt（未装箱；超限降级时作为任务文件全文，P-20261006-44）。
 *  清单整体装得下时与 buildSplitSuggestPrompt 逐字节相等 */
export function buildSplitSuggestPromptFull(files: CommitMsgFileEntry[], t: CommitMsgTranslator): string {
  return [t('commit.splitSuggest.promptHead'), t('commit.splitSuggest.promptFormat'), t('commit.splitSuggest.promptListHead'), files.map(stagedFileLine).join('\n')].join('\n')
}

/** 最近一次拆分建议会话 id（模块级跨组合式共享，P-20261003-278）：useCommitSplitExecute
 *  据此定位建议产出的会话读 scrollback 解析分组方案。仅内存锚点——刷新即失，
 *  「逐组执行」入口随消失（再点一次「拆分建议」即恢复），无落盘格式/协议面 */
export const lastSplitSuggestSessionId = ref('')

export function useCommitSplitSuggest() {
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
  // 发起中标志：按钮 loading 态 + 防重复点击（会话创建成功即交由 docked 管理页接管）
  const launching = ref(false)

  /** 拆分建议：新建 agent 会话（cwd=项目根，prompt 经 launchArgs 预填）并打开
   *  docked 管理页激活。产出为分组建议（在会话中呈现），不自动执行任何 git 写操作。
   *  清单超 500 字节走任务文件降级（P-20261006-44）：全量清单落 .sc-task.md，
   *  「清单可能截断」绕行消失；写失败退回装箱截断 */
  async function suggestCommitSplit(files: CommitMsgFileEntry[]): Promise<void> {
    if (launching.value) return
    const root = projectStore.currentProject?.path || ''
    const pid = projectStore.currentProjectId
    if (!root || !pid || files.length === 0) return
    const tt = t as unknown as CommitMsgTranslator
    // 全文优先：敏感判定与超限降级都以未装箱全文为面（P-20261006-44 修正案）
    const full = buildSplitSuggestPromptFull(files, tt)
    // 敏感场景提示确认（P-109 口径，P-138 同款）：路径疑似含凭据/令牌时先确认，
    // 取消 = 不创建会话
    if (containsSensitiveValue(full)) {
      const ok = await confirmDialog({
        title: t('commit.splitSuggest.sensitiveTitle'),
        content: t('commit.splitSuggest.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return
    }
    launching.value = true
    try {
      const agentTerminal = useAgentTerminal()
      if (agentTerminal.busy.value) return
      // 超限降级：全文写项目根 .sc-task.md + 短引用指令（写失败退回装箱截断）
      const plan = await resolveTaskLaunchArgs(pid, full, buildSplitSuggestPrompt(files, tt))
      const info = await agentTerminal.create(undefined, { dir: root, launchArgs: plan.launchArgs })
      if (!info) {
        message.error(t('commit.splitSuggest.failed'))
        return
      }
      // 记录会话锚点：「逐组执行」（P-20261003-278）的取数入口——解析失败/会话
      // 已销毁等后续分支由执行组合式就地反馈
      lastSplitSuggestSessionId.value = info.id
      if (plan.taskFile) message.info(t('agent.taskFile.fallbackNote'))
      else if (plan.degraded) message.warning(t('agent.taskFile.fallbackWriteFailed'))
      if (!info.launched) {
        message.warning(t('commit.splitSuggest.degraded'))
      } else {
        message.success(t('commit.splitSuggest.success'))
      }
      await agentTerminal.open('docked')
    } finally {
      launching.value = false
    }
  }

  return { suggestCommitSplit, launching }
}
