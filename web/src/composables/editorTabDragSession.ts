import { ref } from 'vue'

/**
 * 编辑器 tab 跨组拖拽会话态（P-20261003-38，模块级单例）：
 * dragover 阶段浏览器保护模式只可读 dataTransfer.types、读不到数据（安全约束），
 * 「拖拽来自哪组」无法经 payload 判定——dragstart 时在此登记源组号（EditorGroupPane
 * 两个实例都写/读），dragend/drop 后清空。drop 阶段的最终裁决仍以
 * application/x-sc-editor-tab payload 为准（数据权威源），本态只做 dragover
 * 高亮与 dropEffect 门控。
 * 模块级而非 provide/inject：EditorGroupPane 全程 emit 上行、不反向注入宿主状态
 * （组件头注纪律）；浏览器同一时刻只有一次拖拽会话，单例态无并发歧义。
 */
export const draggingTabGroupId = ref<number | null>(null)
