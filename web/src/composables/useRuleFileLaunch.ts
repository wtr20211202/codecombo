import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import { useRouter } from 'vue-router'
import i18n from '../i18n'
import { useProjectStore } from '../stores/project'
import { useLocaleStore } from '../stores/locale'
import { PROJECT_RULE_FILES, type ProjectRuleFile } from '../utils/projectRuleTemplates'
import { useProjectRules } from './useProjectRules'
import { confirmDialog } from './useDialog'

/**
 * 命令面板「编辑规则文件」执行链（P-20261006-43）：edit-rule:<name> 命令族——
 * agent 规则文件（CLAUDE.md/AGENTS.md/.cursorrules，清单 projectRuleTemplates
 * 单一事实源）的 palette 一击直达，两级语义（P-20261003-181 面板行为同源）：
 * - 已存在（根清单探测，useProjectRules 既有链：1 请求 silent、缺失零 404）
 *   → /project?file= 文件深链进编辑器（consumeFileQuery 既有消费链负责开文件）
 * - 缺失 → 确认后从最小模板创建（createFile 的 409 语义天然防覆盖并发创建）
 *   并进编辑器；创建失败非 silent，拦截器已 toast，本链静默收场
 *
 * 本组合式在 useLayoutViews setup 期实例化（useRouter 须 setup 上下文），动作在
 * 命令面板分发回调（非 setup 上下文）中执行——t 走 i18n.global、message 由调用方
 * 注入（useAgentTemplateLaunch 同款论证）
 */

/** 分发入口的 id 载荷校验：清单外文件名（陈旧注册/手工构造）一律拒绝 */
export function isProjectRuleFile(name: string): name is ProjectRuleFile {
  return (PROJECT_RULE_FILES as readonly string[]).includes(name)
}

export function useRuleFileLaunch(message: MessageApiInjection) {
  const t = i18n.global.t
  const router = useRouter()
  const projectStore = useProjectStore()
  const localeStore = useLocaleStore()

  /** 文件深链直达编辑器（ProjectRulesManager.openInEditor 同参——Layout 消费链
   *  负责必要时切项目 + 打开 + 清 query） */
  function openInEditor(pid: string, name: string) {
    void router.push({ path: '/project', query: { file: name, project: pid } })
  }

  /** 命令面板 edit-rule:<name> 执行链（语义见文件头注） */
  async function runRuleFileCommand(name: string): Promise<void> {
    if (!isProjectRuleFile(name)) return
    const pid = projectStore.currentProjectId
    // 无当前项目：命令按条件注册（见 useQuickNav），此处纯防御
    if (!pid) return
    const rules = useProjectRules()
    // 每次执行现扫（根清单 1 请求，非面板打开时点预扫）——规则文件可能被
    // agent/他端随时创建，注册时的存在性结论会过期
    await rules.scan(pid)
    if (rules.statuses.value[name] === 'exists') {
      openInEditor(pid, name)
      return
    }
    // scan 失败按全缺失呈现（useProjectRules 语义）：确认后由 createFile 的
    // 真实错误拦住，与面板「从模板创建」同一防线
    const ok = await confirmDialog({
      title: t('commandPalette.ruleMissingTitle', { name }),
      content: t('commandPalette.ruleMissingConfirm', { name }),
      type: 'info',
    })
    if (!ok) return
    const r = await rules.createFromTemplate(pid, name, localeStore.currentLocale)
    if (r === 'failed') return // 非 silent 调用，拦截器已弹具体错误，不叠加 toast
    if (r === 'created') message.success(t('commandPalette.ruleCreatedOpened', { name }))
    else message.info(t('commandPalette.ruleCreateExists', { name }))
    openInEditor(pid, name)
  }

  return { runRuleFileCommand }
}
