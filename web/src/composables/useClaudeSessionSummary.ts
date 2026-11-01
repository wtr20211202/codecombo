import { computed, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import type { ClaudeSessionInfo } from '../api/domains/claude'
import { useThemeStore } from '../stores/theme'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useI18n } from './useI18n'
import { fitByBytes } from '../utils/promptFit'

/**
 * 回放页「AI 总结本会话」（P-20261003-215）：把 transcript 绝对路径装箱进
 * ask-agent prompt 发起新 claude 会话，agent 自读全量转写产出结构化摘要
 * （任务/关键改动/结论/遗留事项）——与导出（原文带走）/时间线内搜索（定位）/
 * 回放进度（位置）构成会话消化四件。
 *
 * - 路径取数据面：ClaudeSessionInfo.transcriptPath（服务端 root/dir/id 经
 *   filepath.Join 同源派生）。前端不自拼文件系统路径——目录编码是 claude 内部
 *   实现、存储根受 CC_CLAUDE_DIR 覆盖，~ 推导在覆盖形态下不成立；缺字段（旧
 *   版本对端）→ 调用方禁用入口，本组合式兜底拒绝
 * - 成本知情：用户显式点按触发（按钮 tip 注明 agent 全量读转写的 token 消耗），
 *   不做自动/定时触发
 * - 遮蔽提醒随指令走：agent 读的是原文，摘要不经前端无法程序遮蔽，故模板显式
 *   要求摘要不复述任何密钥/令牌/口令（P-207/P-108 同源遮蔽语义的 prompt 侧落地）
 * - 发起链复用接力（useClaudeRelay）同款：createAgent + dir=会话 cwd +
 *   fitByBytes 500 字节装箱（极端长路径下裁 path 尾段仍保 ≤500 字节）
 */
export function useClaudeSessionSummary() {
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useClaudeRelay 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 单飞守卫：同时只跑一个总结发起（按钮 loading 反馈取发起中） */
  const summarizingId = ref('')

  /** 发起总结：成功返回新会话 id（调用方激活会话并关弹层），
   *  放弃/失败返回 null（提示已就地给出） */
  async function summarize(s: ClaudeSessionInfo): Promise<string | null> {
    if (summarizingId.value) return null
    if (!s.transcriptPath) {
      message.error(t('claudeSessions.timeline.summary.noPath'))
      return null
    }
    summarizingId.value = s.id
    try {
      const prompt = fitByBytes(
        p => t('claudeSessions.timeline.summary.prompt', { path: p }),
        s.transcriptPath,
      )
      const info = await useTerminalSessionsStore().createAgent(
        t('claudeSessions.timeline.summary.name', { title: s.title.slice(0, 30) }),
        'claude',
        undefined,
        { dir: s.cwd, launchArgs: prompt },
      )
      if (!info) {
        message.error(t('claudeSessions.timeline.summary.fail'))
        return null
      }
      if (info.launched === false) {
        message.warning(t('claudeSessions.timeline.summary.noRuntime'))
      } else {
        message.success(t('claudeSessions.timeline.summary.ok', { title: s.title.slice(0, 30) }))
      }
      return info.id
    } finally {
      summarizingId.value = ''
    }
  }

  return { summarizingId, summarize }
}
