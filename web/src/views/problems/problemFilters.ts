// 问题面板过滤态（P-20261005-171）——模块级单例，会话内保持
//
// 为什么不住在 ProblemsPanel 组件里：面板在 BottomPanel 是 v-else-if 条件
// 挂载（BottomPanel.vue），面板显隐/切 tab 即卸载，组件内 ref 一卸即失——
// 任务口径「过滤态会话内保持（面板显隐不重置）」要求状态与组件生命周期
// 解耦。模块级 ref 与 panels/registry.ts 的 railTopManualOrder 同款先例。
//
// 为什么不进 useEditorProblems：那是数据面（aggregate 单例），StatusBar
// 徽标与面板共用——过滤只答「找哪个」，混进去会诱使消费方把全量口径
// 写坏；也不落 uiState（任务口径止步会话内，写盘态留给持久化诉求出现时）。
import { ref } from 'vue'
import type { ProblemSeverityScope } from '../../utils/editorProblems'

/** 文本过滤词（message/path 子串，大小写不敏感；空/纯空白 = 不过滤） */
const filterText = ref('')

/** 严重级二态 chip 作用域：null = 全部；两 chip 互斥，再点激活项回落 null */
const severityScope = ref<ProblemSeverityScope>(null)

/** 面板挂载/卸载间共享同一份过滤态；外部经返回的 ref 读写（不导出裸变量
 *  防替换丢响应性） */
export function useProblemFilters() {
  return { filterText, severityScope }
}
