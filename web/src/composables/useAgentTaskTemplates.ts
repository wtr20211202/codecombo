import { ref } from 'vue'
import { useI18n } from './useI18n'
import { useUIStateStore } from '../stores/uiState'
import {
  FACTORY_TEMPLATE_IDS,
  validateAgentTaskTemplate,
  type AgentTaskTemplate,
} from '../utils/agentTaskTemplate'

/**
 * 智能体任务模板（P-20261002-16）：出厂预置 + 用户定制表的统一读改面，
 * 新建会话对话框（模板下拉）与设置页管理区块共用同一份模块级单例。
 *
 * 存储与物化语义（提案「模板存储 settings 域」在「无 Go 改动」约束下的落地：
 * uiState 命名空间服务端持久、跨浏览器，与 bookmarks/snapshots 同模式）：
 * - 未定制（uiState 无记录）：展示 i18n 实时派生的出厂预置——不落盘，语言切换
 *   后预置文案跟随 locale，无「播种语言凝固」问题
 * - 任一改动（增/改/删/排序）先物化（当前列表 = 预置或已有定制，深拷贝）再
 *   变更并整体落盘——此后预置不再参与派生，用户删光 = 定制为空表（不复活）
 */

/** 模块级单例（useRecentFiles 同范式）：对话框与管理区块共享同一份状态，
 *  管理面改动即时反映到打开中的对话框下拉 */
const templates = ref<AgentTaskTemplate[]>([])
const customized = ref(false)
const loaded = ref(false)
let loadSeq = 0

/** 出厂预置（提案 ④：审查/测试/提交信息/解释文件 4 个通用模板，可删可改）。
 *  i18n 实时派生（非组件上下文拿不到 setup 的 t，经 useI18n 在调用方 setup 期
 *  取用）——prompt 占位符 {file}/{branch}/{dir} 原样存于模板正文 */
export function factoryTaskTemplates(t: (k: string) => string): AgentTaskTemplate[] {
  return FACTORY_TEMPLATE_IDS.map(id => ({
    id,
    name: t(`settings.agentTaskTemplates.factory.${id}.name`),
    prompt: t(`settings.agentTaskTemplates.factory.${id}.prompt`),
  }))
}

export function useAgentTaskTemplates() {
  const { t } = useI18n()
  const uiState = useUIStateStore()

  /** 拉取（对话框打开 / 管理区块挂载时调用）：定制表 > 出厂预置（虚置）。
   *  loadSeq 防乱序回写（快速开关两个宿主并发 load，慢响应不得覆盖新状态） */
  async function load(): Promise<void> {
    const seq = ++loadSeq
    try {
      const items = await uiState.getAgentTaskTemplates()
      if (seq !== loadSeq) return
      customized.value = items !== null
      templates.value = items ?? factoryTaskTemplates(t)
    } catch {
      if (seq !== loadSeq) return
      customized.value = false
      templates.value = factoryTaskTemplates(t)
    } finally {
      if (seq === loadSeq) loaded.value = true
    }
  }

  /** 物化：未定制时把当前视图（预置）深拷贝为定制表（调用方随后原地变更） */
  function materialize(): AgentTaskTemplate[] {
    if (customized.value) return templates.value
    customized.value = true
    templates.value = templates.value.map(x => ({ ...x }))
    return templates.value
  }

  /** 变更统一收口：落盘失败静默（内存已生效，重开设置页/对话框 load 兜底） */
  async function persist(): Promise<void> {
    try {
      await uiState.saveAgentTaskTemplates(templates.value.map(x => ({ ...x })))
    } catch { /* silent：内存为准 */ }
  }

  /** 新铸模板 id（add/import 共用；时间戳+随机段防同毫秒碰撞） */
  function newTemplateId(): string {
    return `tpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function addTemplate(name: string, prompt: string): Promise<void> {
    const list = materialize()
    list.push({ id: newTemplateId(), name: name.trim(), prompt: prompt.trim() })
    await persist()
  }

  async function updateTemplate(id: string, name: string, prompt: string): Promise<void> {
    const list = materialize()
    const it = list.find(x => x.id === id)
    if (!it) return
    it.name = name.trim()
    it.prompt = prompt.trim()
    await persist()
  }

  async function removeTemplate(id: string): Promise<void> {
    const list = materialize()
    const idx = list.findIndex(x => x.id === id)
    if (idx === -1) return
    list.splice(idx, 1)
    await persist()
  }

  /** 排序（上移/下移一步）：物化后相邻交换，越界 no-op */
  async function moveTemplate(id: string, dir: -1 | 1): Promise<void> {
    const list = materialize()
    const idx = list.findIndex(x => x.id === id)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= list.length) return
    const [it] = list.splice(idx, 1)
    list.splice(to, 0, it!)
    await persist()
  }

  /** 保存校验（透传纯函数校验码，使用面映射 i18n） */
  function validate(name: string, prompt: string): string {
    return validateAgentTaskTemplate(name, prompt)
  }

  /** 导入合并（P-20261005-209）：整批一次物化 + 一次落盘——逐条 add/update
   *  会 N 次全量写 uiState（每写都重拉合并基底），批量收口成单次写。
   *  creates 新铸 id 追加；updates 按 targetId 原位覆盖（同名冲突的本地项），
   *  目标已消失（预览期间被删）则静默跳过 */
  async function importTemplates(
    creates: Array<{ name: string; prompt: string }>,
    updates: Array<{ targetId: string; item: { name: string; prompt: string } }>,
  ): Promise<void> {
    if (creates.length === 0 && updates.length === 0) return
    const list = materialize()
    for (const u of updates) {
      const it = list.find(x => x.id === u.targetId)
      if (!it) continue
      it.name = u.item.name
      it.prompt = u.item.prompt
    }
    for (const c of creates) list.push({ id: newTemplateId(), name: c.name, prompt: c.prompt })
    await persist()
  }

  return {
    templates, customized, loaded,
    load, addTemplate, updateTemplate, removeTemplate, moveTemplate, validate, importTemplates,
  }
}
