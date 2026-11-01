import { computed, onScopeDispose, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { compareExperimentApi } from '../api/domains/compare'
import type { CompareExperiment, CompareExperimentDetail, CompareFileRow } from '../api/domains/compare'
import { claudeApi } from '../api/domains/claude'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { OPS_EXPERIMENT_CHANGED } from '../utils/opsEvents'
import type { ExperimentChangedDetail } from '../utils/opsEvents'

/**
 * 对比实验（P-20261003-46）：双 agent 同题竞写——输入 prompt + 选两个 runtime，
 * 服务端 LaunchAgentSession 双开竞写，完成链回执齐备后进对比视图（产出并集
 * 逐文件三分类 + 基线 vs 侧产出 diff + 采用标注）。
 *
 * - 状态为模块级单例（useCrossReview 同范式）：入口（命令面板 / agent 管理页
 *   头部）与唯一弹层实例共享同一份开合事实；openCompareExperiment 是免组合式
 *   实例的模块级动作
 * - 弹层打开期间的状态对账双通道：experiment.changed 广播事件即时重拉
 *   （P-20261004-33，useAgentChain 同款直通分发监听）+ 5s 轮询降级保留
 *   （WS 断线窗口期兜底，事件不可回放）
 * - token 用量（token 维度已合入）：claude 侧捕获到底层会话 id 后按
 *   claude/sessions 索引列表（stat 级对账，未变更文件零内容读）对账展示，
 *   其他 runtime 无用量事实源不谎报
 */

/** 侧状态（纯函数可测）：done/failed/error:<msg> = 终结；其余（含空回执）
 *  一律等待——会话已消亡但无回执也显示等待（诚实降级，与完成链口径一致） */
export type CompareSideState = 'waiting' | 'done' | 'failed' | 'error'

export function sideState(result: string | undefined): CompareSideState {
  if (result === 'done') return 'done'
  if (result === 'failed') return 'failed'
  if (result && result.startsWith('error')) return 'error'
  return 'waiting'
}

/** 表单默认 runtime 对（纯函数可测）：前两个可用且互异的一等运行时；不足两个
 *  回落 auto 交服务端选型（auto/auto 组合由服务端拒绝，表单提交前拦截） */
export function defaultRuntimesPair(
  options: { name: string; available: boolean }[],
): { a: string; b: string } {
  const usable = options.filter(o => o.available && o.name !== 'shell' && o.name !== 'auto')
  if (usable.length >= 2) return { a: usable[0]!.name, b: usable[1]!.name }
  if (usable.length === 1) return { a: usable[0]!.name, b: 'auto' }
  return { a: 'auto', b: 'auto' }
}

/** token 用量展示格式（纯函数可测）：千位缩写，无数据返回空串 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/** 落盘行动计划（纯函数可测，P-20261004-72）：三分类 → mode=apply 动作计数。
 *  与服务端 planApplyRows 同构同词汇（保留/回滚/删除/无操作），前端只用于
 *  确认弹窗预告与结果对照，权威执行在服务端 */
export interface ApplyPlanCounts {
  /** 采用侧独有：保留不动 */
  kept: number
  /** 另一侧独有 tracked：逆向回滚（分目录形态） */
  rolledBack: number
  /** 另一侧独有 untracked：删除（字节已备份） */
  deleted: number
  /** 双方 + 同目录他侧独有：无操作注记 */
  noop: number
}

export function applyPlanCounts(
  files: CompareFileRow[],
  side: 'a' | 'b',
  sameDir: boolean,
): ApplyPlanCounts {
  const out: ApplyPlanCounts = { kept: 0, rolledBack: 0, deleted: 0, noop: 0 }
  for (const f of files) {
    const inAdopted = side === 'a' ? f.inA : f.inB
    const inOther = side === 'a' ? f.inB : f.inA
    const otherStatus = side === 'a' ? f.statusB : f.statusA
    if (inAdopted && inOther) out.noop++
    else if (inAdopted) out.kept++
    else if (inOther && sameDir) out.noop++
    else if (inOther && otherStatus === '?') out.deleted++
    else out.rolledBack++
  }
  return out
}

/** 双侧是否同目录（纯函数可测）：分目录竞写（dirA/dirB worktree）才有
 *  另一侧独有的回滚/删除动作，同目录形态 apply 只做标注级收尾 */
export function isSameDirExperiment(exp: CompareExperiment): boolean {
  return (exp.a.dir || '') === (exp.b.dir || '')
}

// 模块级单例状态（useCrossReview 同范式）
const show = ref(false)
const selectedId = ref('')

/** 入口动作（免组合式实例，模块级导出）：命令面板 / agent 管理页头部直接调用 */
export function openCompareExperiment(experimentId?: string): void {
  if (experimentId) selectedId.value = experimentId
  show.value = true
}

export function useCompareExperiment() {
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useCrossReview 同范式）：本组合式在组件 setup 期调用一次
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  const experiments = ref<CompareExperiment[]>([])
  const detail = ref<CompareExperimentDetail | null>(null)
  const detailLoading = ref(false)
  const launching = ref(false)

  async function refreshList(): Promise<void> {
    try {
      const res = (await compareExperimentApi.list()) as unknown as { data?: CompareExperiment[] }
      experiments.value = res?.data || []
      // 选中项被删/不存在时回落最新一条
      if (selectedId.value && !experiments.value.some(e => e.id === selectedId.value)) {
        selectedId.value = ''
      }
      if (!selectedId.value && experiments.value.length > 0) {
        selectedId.value = experiments.value[0]!.id
      }
    } catch { /* 列表失败保留现状（弹层仍有表单可用） */ }
  }

  async function loadDetail(id: string): Promise<void> {
    detailLoading.value = true
    try {
      const res = (await compareExperimentApi.get(id)) as unknown as { data?: CompareExperimentDetail }
      detail.value = res?.data || null
    } catch {
      detail.value = null // 404/失败：详情区自备引导文案
    } finally {
      detailLoading.value = false
    }
  }

  function select(id: string): void {
    selectedId.value = id
    void loadDetail(id)
  }

  /** 发起双开：敏感值确认（P-109 口径同 useCommitAgentMsg）→ 服务端双开。
   *  双侧运行时允许相同（同 runtime 两版挑好）；仅 prompt 必填。
   *  返回是否成功（调用方据此收表单/给反馈） */
  async function launch(payload: {
    prompt: string
    dir?: string
    runtimeA: string
    runtimeB: string
  }): Promise<boolean> {
    if (launching.value) return false
    if (!payload.prompt.trim()) {
      message.warning(t('experiment.promptRequired'))
      return false
    }
    if (containsSensitiveValue(payload.prompt)) {
      const ok = await confirmDialog({
        title: t('experiment.sensitiveTitle'),
        content: t('experiment.sensitiveBody'),
        type: 'warning',
      })
      if (!ok) return false
    }
    launching.value = true
    try {
      const res = (await compareExperimentApi.create(payload)) as unknown as { data?: CompareExperiment }
      if (!res?.data?.id) {
        message.error(t('experiment.launchFailed'))
        return false
      }
      message.success(t('experiment.launched'))
      selectedId.value = res.data.id
      await refreshList()
      void loadDetail(res.data.id)
      return true
    } catch {
      message.error(t('experiment.launchFailed'))
      return false
    } finally {
      launching.value = false
    }
  }

  async function adopt(id: string, side: 'a' | 'b' | ''): Promise<void> {
    try {
      await compareExperimentApi.adopt(id, side)
      await Promise.all([refreshList(), loadDetail(id)])
    } catch {
      message.error(t('experiment.opFailed'))
    }
  }

  /** 采用落盘二阶段（P-20261004-72）：确认弹窗预告动作面（回滚/删除列明，
   *  备份强制前置交代可恢复）→ mode=apply。返回是否成功（调用方据此刷新） */
  async function applyAdoption(id: string, side: 'a' | 'b'): Promise<boolean> {
    const exp = detail.value?.experiment
    if (!exp || exp.id !== id) return false
    const counts = applyPlanCounts(detail.value?.files || [], side, isSameDirExperiment(exp))
    const destructive = counts.rolledBack + counts.deleted
    const ok = await confirmDialog({
      title: t('experiment.applyConfirmTitle', { side: side.toUpperCase() }),
      content: t('experiment.applyConfirmBody', {
        kept: counts.kept,
        roll: counts.rolledBack,
        del: counts.deleted,
        noop: counts.noop,
      }),
      type: destructive > 0 ? 'warning' : 'info',
    })
    if (!ok) return false
    try {
      const res = (await compareExperimentApi.applyAdoption(id, side)) as unknown as {
        data?: { applied?: { kept: number; rolledBack: number; deleted: number; noop: number } }
      }
      const applied = res?.data?.applied
      if (applied) {
        message.success(t('experiment.applyDone', {
          kept: applied.kept, roll: applied.rolledBack, del: applied.deleted,
        }))
      }
      await Promise.all([refreshList(), loadDetail(id)])
      return true
    } catch {
      // 失败提示由 http 拦截器统一出（KNOWN_ERROR_I18N 具体映射：标注后手改/
      // 未结算各有专条）——此处静默返回 false 即可，再 toast 会双份
      return false
    }
  }

  async function removeExperiment(id: string): Promise<void> {
    try {
      await compareExperimentApi.remove(id)
      if (selectedId.value === id) selectedId.value = ''
      detail.value = null
      await refreshList()
    } catch {
      message.error(t('experiment.opFailed'))
    }
  }

  /** claude 侧 token 用量对账（index 列表 stat 级，非 claude/无 id 返回空映射） */
  async function fetchClaudeUsage(agentSessionIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const wanted = agentSessionIds.filter(Boolean)
    if (wanted.length === 0) return out
    try {
      const res = (await claudeApi.sessions({ limit: 200 })) as unknown as {
        data?: { sessions?: { id: string; usage?: { totalTokens?: number } }[] }
      }
      for (const s of res?.data?.sessions || []) {
        if (wanted.includes(s.id) && typeof s.usage?.totalTokens === 'number') {
          out.set(s.id, s.usage.totalTokens)
        }
      }
    } catch { /* 无 ~/.claude / 对账失败：不展示用量（无数据 ≠ 零消耗） */ }
    return out
  }

  // 弹层打开期间轮询对账（running 实验完成链回执到达后徽标即时翻转）；
  // 关闭即停，无全局常驻
  let pollTimer: ReturnType<typeof setInterval> | null = null
  function watchWhileOpen(): void {
    pollTimer = setInterval(() => {
      if (!show.value || document.hidden) return
      if (detail.value && detail.value.experiment.status === 'running') {
        void loadDetail(detail.value.experiment.id)
      } else if (experiments.value.some(e => e.status === 'running')) {
        void refreshList()
      }
    }, 5000)
  }
  watchWhileOpen()

  // experiment.changed 直通分发（服务端广播，P-20261004-33）：回执落位即对账
  // ——事件 id 命中当前详情且本地仍 running 时重拉详情，列表含 running 行或
  // 事件实验不在列表时重拉列表；幂等（已 ready 的迟到事件落空，零请求）。
  // 事件是通知非快照，对账读权威 GET 面（queue.changed「收到即刷」同语义）。
  // 监听随组合式实例生命周期挂卸（面板宿主 setup 期调用本组合式）
  const onExperimentChanged = (ev: Event): void => {
    if (!show.value) return
    const id = (ev as CustomEvent<ExperimentChangedDetail>).detail?.id || ''
    if (detail.value && detail.value.experiment.id === id && detail.value.experiment.status === 'running') {
      void loadDetail(id)
    }
    if (experiments.value.some(e => e.status === 'running' || e.id === id)) {
      void refreshList()
    }
  }
  window.addEventListener(OPS_EXPERIMENT_CHANGED, onExperimentChanged)
  onScopeDispose(() => {
    if (pollTimer) clearInterval(pollTimer)
    window.removeEventListener(OPS_EXPERIMENT_CHANGED, onExperimentChanged)
  })

  return {
    show, selectedId,
    experiments, detail, detailLoading, launching,
    refreshList, loadDetail, select, launch, adopt, applyAdoption, removeExperiment, fetchClaudeUsage,
    t,
  }
}
