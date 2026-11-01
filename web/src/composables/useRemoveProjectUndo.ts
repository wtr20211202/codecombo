// 项目移除撤销 toast（P-20261002-47）：移除=解除登记（后端删注册 + 级联清理，
// 磁盘文件保留），语义温和但确认后无撤销——照 VS Code 删除文件 / Gmail 撤销发送
// 惯例给一段后悔药窗口：「已移除 {name}」+ [撤销] 按钮，超时自动消失。
// 点击撤销用闭包暂存的 {name, path} 走既有 addProject 原路恢复（重新登记产生
// 新 ID——uiState/终端历史按旧 projectId 关联的部分不随迁，文案已注明文件无恙）。
// 首页（useHomeProjects）与项目页（RemoveConfirmModal）两个移除入口共用；
// message 实例由调用方传入（首页走 provider，项目页弹窗内走 discrete API）
import { h } from 'vue'
import type { MessageApi, MessageReactive } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import i18n from '../i18n'
import { OPS_PROJECTS_CHANGED } from '../utils/opsEvents'

/** 撤销窗口时长（ms）：温和破坏性操作惯例取 5~8s 档（hover 悬停仍可保活） */
const REMOVE_UNDO_WINDOW_MS = 6000

/** 移除成功后弹撤销提示：Naive message 无内建 action 槽，用 render 整体接管
 * 消息体（图标+内容）自绘文案与按钮，撤销按钮以 data-testid 供 e2e 定位 */
export function notifyProjectRemoved(message: MessageApi, removed: { name: string; path: string }): void {
  const t = i18n.global.t
  let settled = false // 撤销幂等闸：destroy 后按钮随之消失，防抖只是双保险
  let toast: MessageReactive | null = null
  toast = message.info('', {
    duration: REMOVE_UNDO_WINDOW_MS,
    keepAliveOnHover: true,
    render: () =>
      h('div', { style: 'display:flex;align-items:center;gap:14px;' }, [
        h('span', null, t('project.undo.removed', { name: removed.name })),
        h('span', {
          style: 'cursor:pointer;font-weight:600;color:var(--accent-blue);user-select:none;white-space:nowrap;',
          role: 'button',
          'data-testid': 'project-undo-action',
          onClick: () => {
            if (settled) return
            settled = true
            toast?.destroy()
            void restoreRemovedProject(removed)
          },
        }, t('project.undo.action')),
      ]),
  })
}

/** 撤销：按原 name/path 重新登记。成功后主动 fetchProjects 对账一次——
 * 移除时宿主（Layout @removed）触发的列表刷新可能晚到并把刚恢复的条目
 * 覆盖回旧快照；再广播 OPS_PROJECTS_CHANGED 让首页联动重拉 ahead/behind。
 * 失败（路径已被删/重复登记等）由拦截器弹专属错误，此处不叠 toast */
async function restoreRemovedProject(removed: { name: string; path: string }): Promise<void> {
  const projectStore = useProjectStore()
  try {
    await projectStore.addProject(removed.name, removed.path)
    await projectStore.fetchProjects()
    window.dispatchEvent(new Event(OPS_PROJECTS_CHANGED))
  } catch { /* 拦截器处理 */ }
}
