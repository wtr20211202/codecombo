import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import { ref } from 'vue'
import i18n from '../i18n'
import { useProjectStore } from '../stores/project'
import { useAgentTerminal, type AgentTermSession } from './useAgentTerminal'
import { useAgentTaskTemplates } from './useAgentTaskTemplates'
import { useEditorNavHistory } from './useEditorNavHistory'
import { resolveAgentTaskTemplate } from '../utils/agentTaskTemplate'

/**
 * 命令面板「按模板新建会话」执行链（P-20261005-10）：P-16 任务模板的全局直达。
 *
 * template:<tid> 命令的两级语义：
 * - 占位符全解析 → 直达建会话并激活（跳过新建对话框——模板即已定配置；
 *   runtime/dir 不携带 = 服务端按设置默认解析，与对话框不动这两个字段同语义；
 *   paletteUsage 频率加权让高频模板在空查询置顶组自学习置顶）
 * - 存在未解析占位符（{file}/{branch}/{dir} 上下文缺失）→ 降级打开新建会话
 *   对话框并预填该模板——解析改在对话框上下文重做，「原样保留 + 缺失提示」
 *   由对话框既有面呈现（P-16 语义），不静默丢上下文
 *
 * 对话框宿主 AgentTerminalView 是惰性挂载（宿主 v-if），降级请求经模块级信号
 * 送达（useInstanceDispatch 同范式：openRequest 代数 + 模块级消费进度跨
 * remount 幂等）。本组合式在 useLayoutViews setup 期实例化（useAgentTaskTemplates
 * 内部 useI18n 须 setup 上下文），动作在命令面板分发回调（非 setup 上下文）中
 * 执行——t 走 i18n.global、message 由调用方注入（useClipRelay 同款论证）
 */

/** 待预填的模板 id（空串 = 无预选；消费即清，防残留意图污染后续手动打开） */
const pendingTemplateId = ref('')
/** 对话框打开请求代数：先于 View 挂载到达的请求经 immediate watch 补消费
 *  （导出为 watch 源；消费进度经 consumeTemplateDialogRequest 模块级推进） */
const dialogRequest = ref(0)
/** 已消费代数（模块级）：View 可随实例切换 remount，消费进度必须跨 remount
 *  存活——否则旧请求在新挂载树上被二次消费、对话框幽灵自开 */
let consumedDialogRequest = 0

/** 打开请求代数（对话框宿主 View 的 watch 源） */
export const templateDialogRequest = dialogRequest

/** 降级出口：拉起 docked 管理页并打开新建对话框、预选模板（tid 空串 = 只开对话框） */
export function requestTemplateDialog(templateId: string): void {
  pendingTemplateId.value = templateId
  dialogRequest.value++
  // docked 形态拉起管理页（挂载后 openRequest 立即被消费，无感衔接）
  void useAgentTerminal().open('docked')
}

/** 消费一次降级请求：无未消费请求返回 null；有则返回模板 id（空串 = 无预选） */
export function consumeTemplateDialogRequest(): string | null {
  if (dialogRequest.value <= consumedDialogRequest) return null
  consumedDialogRequest = dialogRequest.value
  const tid = pendingTemplateId.value
  pendingTemplateId.value = ''
  return tid
}

export function useAgentTemplateLaunch(message: MessageApiInjection) {
  const t = i18n.global.t
  const taskTemplates = useAgentTaskTemplates()
  // {file} 占位符的「当前激活文件」：navHistory 模块级信标（NewSessionDialog
  // templateCtx 同源，两处解析结果一致——直达链全解析才走，降级链交还对话框）
  const { activeFilePath } = useEditorNavHistory()

  /** 命令面板 template:<tid> 执行链（语义见文件头注） */
  async function runTemplateCommand(tid: string): Promise<void> {
    let tpl = taskTemplates.templates.value.find(x => x.id === tid)
    if (!tpl) {
      // 跨设备删除后的陈旧命令（面板注册与执行之间清单已变）：刷新一次再试
      await taskTemplates.load()
      tpl = taskTemplates.templates.value.find(x => x.id === tid)
    }
    if (!tpl) {
      // 模板确实不存在：退回通用「新建会话」对话框（不静默吞掉用户意图）
      requestTemplateDialog('')
      return
    }
    // 占位符上下文与对话框 templateCtx 同源同语义（工作目录缺省 = 项目根）
    const projectStore = useProjectStore()
    const resolved = resolveAgentTaskTemplate(tpl.prompt, {
      file: activeFilePath.value,
      branch: projectStore.currentProject?.currentBranch || '',
      dir: projectStore.currentProject?.path || '',
    })
    // 上下文缺失（未解析占位符）或解析为空正文：降级对话框预填该模板
    if (resolved.unresolved.length > 0 || !resolved.text.trim()) {
      requestTemplateDialog(tid)
      return
    }
    const at = useAgentTerminal()
    let info: AgentTermSession | null = null
    try {
      info = await at.create(undefined, { launchArgs: resolved.text.trim() })
      if (!info) message.error(t('agentTerminal.createFailed'))
    } catch {
      // HTTP 失败：响应拦截器已 toast 服务端原文（AppError 链），不再叠加通用
      // 文案；本链由面板 `void` 调用，必须就地吞掉 reject 防未处理拒约
    }
    if (!info) return
    // 激活：列表先对账再选中 + 展开 docked 管理页（fleet 批量发起同款收尾；
    // create 已置 activeId，refresh 供侧栏立即呈现新会话）。激活失败不掩盖
    // 创建成功（会话已建，拦截器已 toast），静默即可
    try {
      await at.refresh()
      at.activeId.value = info.id
      await at.open('docked')
    } catch { /* 同上：面板 void 调用不外抛 */ }
    message.success(t('commandPalette.cmdTemplateLaunched', { name: info.name }))
  }

  return { runTemplateCommand }
}
