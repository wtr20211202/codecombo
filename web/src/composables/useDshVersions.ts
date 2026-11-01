import { computed, ref, watch } from 'vue'
import { isNewerVersion, isPrereleaseVersion } from '../utils/version'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { settingsApi } from '../api/client'
import { confirmDialog } from './useDialog'
import { useI18n } from './useI18n'

/**
 * dsh 版本检查 / 升级三步走 / 回退 / changelog（P-20261001-20 从 DshConsoleView 拆出）。
 *
 * - 纯状态与逻辑搬运：徽标（工具栏常驻标签）与升级面板（DshVersionsModal）共享
 *   同一份状态实例；宿主以 reload 注入 iframe 重载（升级/回退成功后接管新进程）
 * - 升级三步走：记录回退点 → npm 安装 → 重启加载新版；重启失败提供回退
 * - 回退入口常驻（P-20261010-2）：config 有回退点即常驻可回退（升级流程成功
 *   但新版功能性损坏时也有逃生通道，不再只在 failed 态呈现）；回退点语义 =
 *   最近一次升级前版本，保留至下次升级覆盖
 * - 预发布分档（P-20261010-2）：检查更新/可升级列表默认只取稳定版（semver
 *   prerelease 过滤，alpha 不再被当「最新」推荐）；「显示预发布版本」为会话态
 *   开关，当前已在预发布通道时如实提示但不自动降级（用户自决）
 */
export interface DshVersionInfo {
  version: string
  date: string
}

export interface DshChangelogEntry {
  version: string
  name: string
  body: string
  publishedAt: string
  url: string
}

export function useDshVersions(options: { reload: () => Promise<void> }) {
  const { t } = useI18n()

  const showVersions = ref(false)
  const verLoading = ref(false)
  const currentVersion = ref('')
  const latestVersion = ref('')
  const allVersions = ref<DshVersionInfo[]>([])
  const selectedVersion = ref('')
  const upState = ref<'idle' | 'preparing' | 'installing' | 'restarting' | 'success' | 'failed'>('idle')
  const upError = ref('')
  const rollbackVersion = ref('')
  const canRollback = ref(false)
  const rollingBack = ref(false)

  /** 常驻回退入口（P-20261010-2）：config 有回退点即成立；已在该版本上
   *  （回退成功后 / 升级前重复检查）时无「回退」语义，行隐藏——失败态的
   *  醒目回退块不受此控（逃生场景宁可重复呈现） */
  const showRollbackRow = computed(() =>
    canRollback.value && !!rollbackVersion.value && rollbackVersion.value !== currentVersion.value)

  /** 「显示预发布版本」开关：会话态（不持久化）——稳定版用户默认不见 alpha，
   *  主动打开才在列表里看到预发布版本 */
  const showPrerelease = ref(false)

  /** 当前版本自身在预发布通道（如实提示，不自动降级） */
  const currentIsPrerelease = computed(() => isPrereleaseVersion(currentVersion.value))

  /** 注册表里最新的稳定版（双信息文案「已是预发布最新（稳定版：Y）」的 Y） */
  const latestStableVersion = computed(() => {
    const asc = allVersions.value.slice().reverse()
    return asc.find(v => !isPrereleaseVersion(v.version))?.version || ''
  })

  // 比当前版本新的列表（新→旧）；当前版本未知（独立安装且无法探测）时全列出。
  // 预发布默认滤除（P-20261010-2）：检查更新推荐面只取稳定版，alpha 不再被
  // 当「最新」推荐；开关打开才参与
  const newerVersions = computed(() => {
    const asc = allVersions.value.slice().reverse()
    const stable = showPrerelease.value ? asc : asc.filter(v => !isPrereleaseVersion(v.version))
    if (!currentVersion.value) return stable
    return stable.filter(v => isNewerVersion(v.version, currentVersion.value))
  })
  const upgradeBadge = computed(() => newerVersions.value[0]?.version || '')

  // 开关切换后选中项可能已被滤出列表：复位到可见列表首项，避免升级按钮
  // 指向一个不可见的版本
  watch(showPrerelease, () => {
    if (selectedVersion.value && !newerVersions.value.some(v => v.version === selectedVersion.value)) {
      selectedVersion.value = newerVersions.value[0]?.version || ''
    }
  })

  /** 头部常驻版本入口：有新版本提示可升级，否则展示当前版本（未识别显示 v?）——
   *  面板唯一入口就是这个标签，只在新版本时才出现会让已最新/检查失败时无处可点 */
  const headerVersionLabel = computed(() => {
    if (upgradeBadge.value) return `↑ v${upgradeBadge.value}`
    return currentVersion.value ? `v${currentVersion.value}` : 'v?'
  })

  /** 版本列表时间：直接显示到秒（YYYY-MM-DD HH:mm:ss） */
  function fmtVersionTime(iso: string): { short: string; full: string } {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return { short: iso, full: iso }
    const p = (n: number) => String(n).padStart(2, '0')
    const full = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    return { short: full, full }
  }

  // ============== 版本 changelog（GitHub releases） ==============
  const changelogEntries = ref<DshChangelogEntry[]>([])
  const changelogLoading = ref(false)
  const changelogUnavailable = ref(false)
  const changelogExpanded = ref(false)

  function changelogOf(version: string): DshChangelogEntry | undefined {
    return changelogEntries.value.find(c => c.version === version)
      ?? changelogEntries.value.find(c => isNewerVersion(version, c.version) === false && version === c.version)
  }

  /** changelog 简要：strip 常见 markdown 标记后的前两行（列表内直接可读） */
  function changelogBrief(body: string): string {
    if (!body.trim()) return ''
    const div = document.createElement('div')
    div.innerHTML = renderChangelog(body)
    const text = (div.textContent || '').replace(/\s+/g, ' ').trim()
    return text.length > 150 ? text.slice(0, 150) + '…' : text
  }

  /** changelog markdown → 消毒后的 HTML（GitHub release notes 含 html 标签，
   *  与 MonacoEditor 的 markdown 预览同一条 marked+DOMPurify 管线） */
  function renderChangelog(body: string): string {
    const html = marked.parse(body || '', { async: false }) as string
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] })
  }

  /** changelog 内的页内锚链接（中/英文小节切换）拦截：preventDefault 防止
   *  hash 写进 SPA 地址栏，改为在 changelog 滚动容器内平滑滚动到目标小节 */
  function onChangelogClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (!href.startsWith('#')) return
    const container = e.currentTarget as HTMLElement
    const target = container.querySelector('[id="' + href.slice(1) + '"]')
    if (!target) {
      e.preventDefault()
      return
    }
    e.preventDefault()
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function fetchChangelog() {
    if (changelogLoading.value || changelogEntries.value.length) return
    changelogLoading.value = true
    try {
      const res = await settingsApi.dshChangelog() as unknown as {
        data?: DshChangelogEntry[]
      }
      changelogEntries.value = res?.data || []
      changelogUnavailable.value = changelogEntries.value.length === 0
    } catch {
      changelogUnavailable.value = true
    } finally {
      changelogLoading.value = false
    }
  }

  watch(selectedVersion, (v) => { if (v) { changelogExpanded.value = false; void fetchChangelog() } })

  const upgradeActionText = computed(() => {
    if (upState.value === 'preparing') return t('dshConsole.upStepPrepare')
    if (upState.value === 'installing') return t('dshConsole.upStepInstall')
    if (upState.value === 'restarting') return t('dshConsole.upStepRestart')
    return t('dshConsole.upgradeTo', { version: selectedVersion.value })
  })

  async function openVersions() {
    showVersions.value = true
    if (allVersions.value.length === 0) void checkVersions()
  }

  async function checkVersions() {
    verLoading.value = true
    upError.value = ''
    try {
      const res = (await settingsApi.dshVersions()) as unknown as {
        data?: { current?: string; latest?: string; versions?: DshVersionInfo[]; rollbackVersion?: string }
      }
      const d = res?.data || {}
      currentVersion.value = d.current || ''
      latestVersion.value = (d.latest || '').replace(/^v/, '')
      allVersions.value = d.versions || []
      // 回退点随检查刷新（P-20261010-2）：服务端 config 的最近一次升级前版本，
      // 页面刷新/换会话后常驻回退入口仍成立，不依赖本轮升级流程的记忆
      rollbackVersion.value = d.rollbackVersion || ''
      canRollback.value = !!rollbackVersion.value
      // 最新版默认选中（新→旧列表首项）
      selectedVersion.value = newerVersions.value[0]?.version || ''
    } catch (e: unknown) {
      upError.value = (e as { userMessage?: string })?.userMessage || t('dshConsole.versionCheckFailed')
    } finally {
      verLoading.value = false
    }
  }

  /** 升级三步走：记录回退点 → npm 安装 → 重启加载新版；重启失败提供回退。
   *  状态机：in-flight（preparing/installing/restarting）期间禁用按钮；
   *  failed/idle 均可重试，success 复位并刷新版本数据，面板不会卡死 */
  const upInFlight = computed(() =>
    upState.value === 'preparing' || upState.value === 'installing' || upState.value === 'restarting')

  async function startUpgrade() {
    const v = selectedVersion.value
    if (!v || upInFlight.value) return
    upError.value = ''
    try {
      upState.value = 'preparing'
      const prep = (await settingsApi.dshUpgradePrepare(v)) as unknown as {
        data?: { rollbackVersion?: string; canRollback?: boolean }
      }
      rollbackVersion.value = prep?.data?.rollbackVersion || ''
      canRollback.value = !!prep?.data?.canRollback

      upState.value = 'installing'
      // npm 失败时后端仍返回 200 + ok:false——必须检查，否则旧版本重启成功
      // 会被误报为「升级完成」
      const ins = (await settingsApi.dshUpgradeInstall(v)) as unknown as {
        data?: { ok?: boolean; output?: string }
      }
      if (!ins?.data?.ok) {
        upState.value = 'failed'
        upError.value = t('dshConsole.upInstallFailed', { output: (ins?.data?.output || '').slice(-300) })
        return
      }

      upState.value = 'restarting'
      const rs = (await settingsApi.dshUpgradeRestart()) as unknown as { data?: { ok?: boolean } }
      if (rs?.data?.ok) {
        upState.value = 'idle'
        await options.reload()
        await checkVersions() // 刷新当前版本与可升级列表（角标随真实状态消隐）
      } else {
        upState.value = 'failed'
        upError.value = t('dshConsole.upRestartFailedHint')
      }
    } catch (e: unknown) {
      upState.value = 'failed'
      upError.value = (e as { userMessage?: string })?.userMessage || String(e)
    }
  }

  /** 回退到升级前版本（升级后起不来时的逃生通道） */
  async function doRollback() {
    if (rollingBack.value) return
    rollingBack.value = true
    try {
      const rs = (await settingsApi.dshRollback()) as unknown as { data?: { ok?: boolean; version?: string } }
      if (rs?.data?.ok) {
        upState.value = 'idle'
        upError.value = ''
        currentVersion.value = rs.data.version || currentVersion.value
        await options.reload()
      }
    } catch (e: unknown) {
      upError.value = (e as { userMessage?: string })?.userMessage || String(e)
    } finally {
      rollingBack.value = false
    }
  }

  /** 常驻回退入口（P-20261010-2）：npm 重装回退点版本 + 重启 dsh 是重操作，
   *  先确认再执行（升级失败态的醒目回退块沿用直接 doRollback 不变） */
  async function requestRollback() {
    if (rollingBack.value || !rollbackVersion.value) return
    const ok = await confirmDialog({
      title: t('dshConsole.rollbackConfirmTitle'),
      content: t('dshConsole.rollbackConfirmBody', { version: rollbackVersion.value }),
      type: 'warning',
    })
    if (ok) await doRollback()
  }

  return {
    showVersions, verLoading, currentVersion, latestVersion, allVersions, selectedVersion,
    upState, upError, rollbackVersion, canRollback, rollingBack,
    showRollbackRow, showPrerelease, currentIsPrerelease, latestStableVersion,
    newerVersions, upgradeBadge, headerVersionLabel, upgradeActionText, upInFlight,
    changelogEntries, changelogLoading, changelogUnavailable, changelogExpanded,
    openVersions, checkVersions, startUpgrade, doRollback, requestRollback,
    changelogOf, changelogBrief, renderChangelog, onChangelogClick, fmtVersionTime,
  }
}

/** useDshVersions 返回的完整 API（供渲染层组件以单 prop 承接整份状态） */
export type DshVersionsApi = ReturnType<typeof useDshVersions>
