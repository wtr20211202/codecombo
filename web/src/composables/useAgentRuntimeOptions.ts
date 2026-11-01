import { computed, h, ref } from 'vue'
import type { Ref, VNodeChild } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { terminalApi } from '@/api/client'
import { HELP_RUNTIME_ENTRY, runtimeSelectDisabled, shortVersionLabel } from '@/utils/runtimeAvailability'
import { safeStorage } from '@/utils/storage'
import { openHelpEntry } from '@/utils/openHelp'

/**
 * 新建会话对话框的运行时域状态（自 NewSessionDialog 按表单区拆分，纯搬运
 * 零逻辑改动）：运行时清单拉取（打开时 60s 节流 ensure 新鲜度）、选项组装
 * （auto/shell 恒可选 + 可用态徽标/禁选）、不可用安装引导判定、生效命令解析、
 * 上次选择运行时记忆（localStorage 单键）。
 */
export interface RuntimeItem {
  name: string
  /** 自定义智能体的展示名（内置运行时为空，展示回落 name） */
  displayName?: string
  available: boolean
  /** --version 首行（服务端探测缓存，空 = 探测失败/未取到；徽标只在这有值时渲染） */
  version?: string
  defaultCommand: string
  customCommand: string
}

// ── 记住上次选择的运行时（B1 收尾项）──
// localStorage 而非 uiState——管理页的 agentTerminal 持久化是读改写链，
// 对话框旁路写会互相覆盖。导出供对话框打开回填与草稿丢弃回退共用
const LAST_RUNTIME_KEY = 'sc.agentTerminal.lastRuntime'

export function loadLastRuntime(): string {
  // 裸读防御（读取侧存量渐进迁移口径）：读取异常按无记忆处理
  try { return localStorage.getItem(LAST_RUNTIME_KEY) || '' } catch { return '' }
}

export function saveLastRuntime(rt: string) {
  safeStorage.setItem(LAST_RUNTIME_KEY, rt)
}

export function useAgentRuntimeOptions(runtime: Ref<string>) {
  const { t } = useI18n()

  const runtimes = ref<RuntimeItem[]>([])

  const runtimeOptions = computed(() => [
    { label: t('agentTerminal.runtimeAuto'), value: 'auto' },
    { label: t('agentTerminal.runtimeShell'), value: 'shell' },
    // 可用态注入（P-20261004-85）：禁选判定镜像服务端创建预检（P-79）的豁免
    // 口径（utils/runtimeAvailability）——缺失且无豁免的项禁选（显式选择会被
    // 400 拒绝，事前不可点与提交后报错语义一致）；豁免项（per-runtime 自定义
    // 命令覆盖 / 路径形态包装脚本）保留「(不可用)」标注可选中——原样启动承诺，
    // db0cef05 的「配命令自救」路径由豁免链精确承接，探测失败不再死锁。
    // auto/shell 恒可选（回落语义保留在 auto 链，P-79 假设②同款边界）
    ...runtimes.value.map(r => ({
      label: runtimeLabel(r),
      value: r.name,
      disabled: runtimeSelectDisabled(r),
      rt: r,
    })),
  ])

  /** 运行时选项富标签（render-label，菜单与选中框共用——TopBar 项目切换
   *  renderProjectLabel 同款先例）：已装项附版本短徽标（完整首行进 title 悬停
   *  核对）；缺失项保留「(不可用)」标注；被禁选项 title 承载缺失说明与重探
   *  出路（naive-ui 禁用选项无 pointer-events:none，hover 可达——原生 title
   *  免组件开销，菜单是虚拟滚动容器挂 NTooltip 反而脆）。
   *  样式走内联（TopBar 同款）：VNode 由 naive-ui 菜单在其渲染上下文里挂载
   *  （portal 出组件树），scoped CSS 的 data-v 属性不会落到 h() 产出的节点上；
   *  颜色全走 CSS 变量（主题适配），class 名保留作测试定位锚点 */
  function renderRuntimeOptionLabel(option: { label: string; rt?: RuntimeItem }): VNodeChild {
    const r = option.rt
    if (!r) return option.label // auto/shell 纯文本
    const children: VNodeChild[] = [h('span', null, runtimeLabel(r))]
    if (r.available && r.version) {
      children.push(h('span', {
        class: 'nsd-rt-version',
        title: r.version,
        style: 'padding: 0 5px; border: 1px solid var(--border-subtle); border-radius: 3px; font-size: 11px; line-height: 1.5; color: var(--text-secondary)',
      }, shortVersionLabel(r.version)))
    }
    if (!r.available) {
      children.push(h('span', {
        class: 'nsd-rt-unavail',
        style: 'font-size: 11px; color: var(--text-secondary)',
      }, `(${t('agentTerminal.runtimeUnavailable')})`))
    }
    const tip = runtimeSelectDisabled(r) ? t('agentTerminal.runtimeMissingTip') : undefined
    return h('div', { class: 'nsd-rt-opt', title: tip, style: 'display: flex; align-items: center; gap: 6px' }, children)
  }

  /** 运行时展示名：自定义智能体用 displayName，其余回落注册名 */
  function runtimeLabel(r: RuntimeItem): string {
    return r.displayName || r.name
  }

  // ── 运行时不可用安装引导（P-20261003-296）──
  // 全新机器上 claude/codex/dsh 全部未安装时，核心功能对新用户不应是死胡同：
  // 全部不可用出提示卡（含安装指引锚点 + 纯终端出路），单项不可用在其命令
  // 描述区附检测说明与指引链接。指引锚定帮助中心 FAQ（HELP_RUNTIME_ENTRY）

  /** 检测到的运行时是否全部不可用。清单为空不算（拉取失败 ≠ 检测结论为空，
   *  此时保持安静由 auto/shell 兜底，不冒充「未检测到」误导） */
  const allRuntimesUnavailable = computed(() =>
    runtimes.value.length > 0 && runtimes.value.every(r => !r.available))

  /** 当前选中运行时的不可用标注（展示名；可用项 / auto / shell 为空串） */
  const selectedUnavailableLabel = computed(() => {
    const rt = runtimes.value.find(r => r.name === runtime.value)
    return rt && !rt.available ? runtimeLabel(rt) : ''
  })

  function showInstallGuide() {
    openHelpEntry(HELP_RUNTIME_ENTRY)
  }

  /** 当前运行时的生效命令：自定义覆盖 > 官方默认 */
  const effectiveCommand = computed(() => {
    const rt = runtimes.value.find(r => r.name === runtime.value)
    if (!rt) return ''
    return rt.customCommand || rt.defaultCommand
  })

  // ── 探测新鲜度（P-20261004-85 方案③）──
  // 数据沿 /api/agent-runtimes 既有通道；refresh=1 是 P-79 落的手动失效口
  // （userbin 解析 + 版本探测两层缓存先失效再重探）。对话框打开时 ensure 一次
  // 新鲜度：禁选把「过期缺失结论」的成本从提交后 400 报错放大为选择前不可点，
  // 陈旧探测必须前置纠偏（刚装好运行时就开对话框的场景应立即看到可选）。
  // 60s 节流对齐服务端版本探测缓存 TTL——节流窗内复开吃到同代探测结论（等价
  // 既有 TTL 行为），不逐次打开都起一轮 --version 子进程；刷新失败不记账，
  // 下次打开照旧 ensure（失败结论不该顶掉新鲜度义务）
  const RUNTIME_REFRESH_THROTTLE_MS = 60_000
  let lastRuntimeRefreshAt = 0

  async function loadRuntimes() {
    const refresh = Date.now() - lastRuntimeRefreshAt > RUNTIME_REFRESH_THROTTLE_MS
    try {
      const res = await terminalApi.listAgentRuntimes(refresh ? { params: { refresh: 1 } } : undefined)
      if (refresh) lastRuntimeRefreshAt = Date.now()
      runtimes.value = (res.data || []) as RuntimeItem[]
    } catch {
      runtimes.value = [] // 打开对话框时清单拉取失败：仍可用 auto/shell 创建
    }
  }

  // ── 重新检测（P-20261005-167）：不可用提示卡/单项说明行的就地重探——用户照
  // 指引装完运行时回到对话框不必重开刷新。恒带 refresh=1 绕开 60s 节流：
  // 节流只约束打开时的自动 ensure，手动点击是显式重探要求（设置·通用「运行时
  // 检测」同款语义），节流窗内吃缓存结论会让按钮形同虚设；成功记账时间戳
  // （重探即新鲜结论，复开不重复起子进程）。失败/空清单保留旧结论不置空：
  // 初载的静默兜底（auto/shell 仍可建）不适用于手动路径——把「不可用」卡片
  // 擦掉反而制造假绿；错误提示由拦截器统一 toast。检测到可用项（全可用/部分
  // 可用）→ 卡片/说明行经响应式自消，轻 toast 确认改善；仍全不可用保持安静
  // （卡片文案即结论，重复播报是噪音）。
  // 消费面在两处（壳的全不可用提示卡 + 高级区的单项说明行），经 props 下发
  // （loadShellCandidates 缓存归壳同款先例）
  const message = useMessage()
  const redetecting = ref(false)
  async function redetectRuntimes() {
    if (redetecting.value) return
    redetecting.value = true
    try {
      const res = await terminalApi.listAgentRuntimes({ params: { refresh: 1 } })
      const next = (res.data || []) as RuntimeItem[]
      if (next.length > 0) {
        runtimes.value = next
        lastRuntimeRefreshAt = Date.now()
        if (next.some(r => r.available)) message.success(t('agentTerminal.runtimeRedetected'))
      }
    } catch {
      // 保留旧清单（上方注），拦截器已 toast 服务端/网络原文
    } finally {
      redetecting.value = false
    }
  }

  return {
    runtimes,
    runtimeOptions,
    renderRuntimeOptionLabel,
    allRuntimesUnavailable,
    selectedUnavailableLabel,
    showInstallGuide,
    effectiveCommand,
    loadRuntimes,
    redetecting,
    redetectRuntimes,
  }
}
