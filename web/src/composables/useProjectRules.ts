import { ref } from 'vue'
import { projectApi } from '../api/client'
import { PROJECT_RULE_FILES, ruleFileTemplate } from '../utils/projectRuleTemplates'

/**
 * 项目规则文件扫描与模板创建（P-20261003-181）：
 * 已知规则文件名（清单见 projectRuleTemplates）经文件树根清单一次拉取做
 * 存在性判定——存在即列（深链进编辑器编辑），缺失可从最小模板创建
 * （createFile，已存在 409 语义天然防覆盖并发创建的文件，不用 writeFile 直写）。
 * 判定走根清单而非逐文件 filePolicy：缺失文件的 file-policy 404 即使 silent
 * 也会被浏览器记一条「Failed to load resource」控制台错误，打穿核心流程
 * 零错误扫描（console-hygiene）；file-tree 清单探测零 404，且 3 探测合并为
 * 1 请求。扫描按需触发（挂载/切项目/手动刷新），无轮询无 N+1 面。
 */

/** 单个规则文件的存在性状态 */
export type RuleFileStatus = 'checking' | 'exists' | 'missing'

/** createFromTemplate 结果：created=已落盘 / exists=已被并发创建（409）/ failed=其余失败（拦截器已 toast） */
export type RuleCreateResult = 'created' | 'exists' | 'failed'

/** 从 axios 错误里取 HTTP 状态码（unknown + 守卫，业务面禁止 any） */
function axiosStatus(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null || !('response' in e)) return undefined
  const status = (e as { response?: { status?: unknown } }).response?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * per-call 组合式（唯一消费方 ProjectRulesManager）：statuses 是「文件名 → 状态」
 * 响应式表；seq 序号防过期扫描回写（切项目/连点刷新时旧请求晚到不覆盖新状态）。
 */
export function useProjectRules() {
  const statuses = ref<Record<string, RuleFileStatus>>({})
  const scanning = ref(false)
  let seq = 0

  /** 扫描指定项目根下的已知规则文件存在性（根清单成员判定，缺失不产生 404） */
  async function scan(projectId: string): Promise<void> {
    if (!projectId) return
    const cur = ++seq
    scanning.value = true
    statuses.value = Object.fromEntries(PROJECT_RULE_FILES.map(f => [f, 'checking']))
    try {
      // silent：失效路径项目的 500 是预期结果，不弹拦截器全局错误；
      // any 面与 FileTreeView fetchFiles 同款（fileTree 响应仓内无共享类型）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同 FileTreeView.vue fetchFiles：any 面收在本地立即收窄
      const res: any = await projectApi.fileTree(projectId, undefined, { silent: true })
      const entries = (res?.data || []) as { name?: string; path?: string; isDir?: boolean }[]
      const present = new Set(
        entries
          .filter(e => !e.isDir)
          .map(e => e.name || (e.path || '').split('/').pop() || ''),
      )
      if (cur === seq) {
        for (const f of PROJECT_RULE_FILES) statuses.value[f] = present.has(f) ? 'exists' : 'missing'
      }
    } catch {
      // 清单不可达（网络/失效路径）按全缺失呈现：按钮点了会被 createFile 的
      // 真实错误拦住，比把失败藏进「未知态」更可行动；「重新扫描」可重试
      if (cur === seq) {
        for (const f of PROJECT_RULE_FILES) statuses.value[f] = 'missing'
      }
    }
    if (cur === seq) scanning.value = false
  }

  /**
   * 从最小模板创建规则文件；locale 决定模板语言（跟随界面）。
   * 409（扫描后、创建前被 agent/他人创建）按 exists 收场不报错。
   */
  async function createFromTemplate(projectId: string, name: string, locale: string): Promise<RuleCreateResult> {
    const content = ruleFileTemplate(name, locale)
    if (!projectId || !content) return 'failed'
    try {
      await projectApi.createFile(projectId, name, content)
      statuses.value[name] = 'exists'
      return 'created'
    } catch (e) {
      if (axiosStatus(e) === 409) {
        statuses.value[name] = 'exists'
        return 'exists'
      }
      return 'failed' // 非 silent 调用，拦截器已弹具体错误
    }
  }

  return { statuses, scanning, scan, createFromTemplate }
}
