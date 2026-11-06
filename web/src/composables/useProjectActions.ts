import { ref, computed, watch, h } from 'vue'
import { shouldShowToast } from '../utils/toastDedupe'
import { createDiscreteApi } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { registerBeforeSwitchHook } from '../stores/instance'
import { useGitOpsStore } from '../stores/gitOps'
import { copyText } from '../utils/clipboard'
import { pullResultSummary } from '../utils/pullResult'
import { useNotificationStore } from '../stores/notification'
import { useThemeStore } from '../stores/theme'
import { remoteApi, browseApi, settingsApi, updateApi } from '../api/client'
import { fetchAheadBehindMap } from '../utils/aheadBehind'
import { confirmDialog } from './useDialog'
import { useI18n } from './useI18n'
import { usePushPrToast } from './usePushPrToast'
import { serverPathSep } from './useServerPathSep'
import type { OpenFile } from './useOpenFiles'

import {
  DuplicateOutline,
  TrashOutline,
  OpenOutline,
} from '@vicons/ionicons5'

/** 项目操作——Git 同步、克隆、PR、删除、更新检查——从 Layout.vue 提取 */
export function useProjectActions(openFilesRef?: () => OpenFile[]) {
  const projectStore = useProjectStore()
  const notificationStore = useNotificationStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()

  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  // push 成功回执 + 「创建 PR」外链（P-20261005-215）：传本组合式的离散 message
  // 实例与其余提示同源
  const pushPrToast = usePushPrToast(message)

  // --- 实例切换前确认钩子 ---
  if (openFilesRef) {
    registerBeforeSwitchHook(async () => {
      const unsaved = openFilesRef().filter(f => f.content !== f.originalContent)
      if (unsaved.length > 0) {
        return await confirmDialog({
          type: 'warning',
          title: t('layout.unsavedCloseTitle'),
          content: t('layout.unsavedCloseAllConfirm', { n: String(unsaved.length) }),
        })
      }
      return true
    })
  }

  // --- 添加项目 ---
  const showAddModal = ref(false)
  const newProjectName = ref('')
  const newProjectPath = ref('')
  const nameManuallyEdited = ref(false)

  // 目录浏览
  const browseDirs = ref<{ name: string; path: string }[]>([])
  const browseCurrent = ref('')
  const browseLoading = ref(false)

  // 路径联想
  const suggestions = ref<{ name: string; path: string }[]>([])
  const showSuggestions = ref(false)
  const selectedIdx = ref(-1)
  let suggestTimer: ReturnType<typeof setTimeout> | null = null
  let suggestGen = 0 // 竞态控制：丢弃过时的异步响应

  // 从路径自动推断项目名
  watch(newProjectPath, (val) => {
    if (val && !nameManuallyEdited.value) {
      const parts = val.replace(/\\/g, '/').split('/').filter(Boolean)
      const inferred = parts[parts.length - 1]
      if (inferred) newProjectName.value = inferred
    }
  })

  // 打开添加项目弹窗时初始化
  watch(showAddModal, (val) => {
    if (val) {
      newProjectName.value = ''
      newProjectPath.value = ''
      nameManuallyEdited.value = false
      suggestions.value = []
      showSuggestions.value = false
      browseDirs.value = []
      browseCurrent.value = ''
    }
  })

  async function browseDirectory(path?: string) {
    browseLoading.value = true
    try {
      const res = await browseApi.list(path) as { data?: Array<{ name: string; path: string }>; current?: string }
      browseDirs.value = res.data || []
      browseCurrent.value = res.current || ''
      if (path && !newProjectPath.value) {
        newProjectPath.value = path
      }
    } catch {
      // 忽略错误
    } finally {
      browseLoading.value = false
    }
  }

  function selectBrowseDir(dir: { name: string; path: string }) {
    newProjectPath.value = dir.path
    if (!nameManuallyEdited.value && dir.name !== '..') {
      newProjectName.value = dir.name
    }
    browseDirectory(dir.path)
  }

  // 路径联想
  function parsePathSegments(input: string): { parent: string; prefix: string } | null {
    const normalized = input.replace(/\\/g, '/')
    if (normalized.length < 2) return null
    const lastSep = normalized.lastIndexOf('/')
    if (lastSep < 0) return null
    return {
      parent: normalized.substring(0, lastSep) || '/',
      prefix: normalized.substring(lastSep + 1).toLowerCase(),
    }
  }

  async function fetchSuggestions() {
    const gen = ++suggestGen
    const input = newProjectPath.value
    if (!input || input.length < 2) {
      suggestions.value = []
      showSuggestions.value = false
      return
    }
    const normalized = input.replace(/\\/g, '/')
    if (/^[A-Za-z]:\/?$/.test(normalized)) {
      try {
        const res = await browseApi.list(normalized.replace(/\/$/, ''))
        if (gen !== suggestGen) return // 过时响应，丢弃
        suggestions.value = (res.data || []).filter((d: { name: string; path: string }) => d.name !== '..')
        showSuggestions.value = suggestions.value.length > 0
        selectedIdx.value = -1
      } catch {
        if (gen !== suggestGen) return
        suggestions.value = []
        showSuggestions.value = false
      }
      return
    }
    const parsed = parsePathSegments(input)
    if (!parsed) { suggestions.value = []; showSuggestions.value = false; return }
    try {
      const res = await browseApi.list(parsed.parent)
      if (gen !== suggestGen) return // 过时响应，丢弃
      const dirs: { name: string; path: string }[] = res.data || []
      suggestions.value = dirs
        .filter(d => d.name !== '..')
        .filter(d => !parsed.prefix || d.name.toLowerCase().includes(parsed.prefix))
      showSuggestions.value = suggestions.value.length > 0
      selectedIdx.value = -1
    } catch {
      if (gen !== suggestGen) return
      suggestions.value = []
      showSuggestions.value = false
    }
  }

  function onPathInput(val: string) {
    newProjectPath.value = val
    browseDirs.value = []
    browseCurrent.value = ''
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(fetchSuggestions, 250)
  }

  function selectSuggestion(item: { name: string; path: string }) {
    // 分隔符按服务端 OS（Windows 服务端为 \）——与 usePathBrowse 同源，
    // 避免 Windows 后端存进 D:\foo\bar/ 混合分隔符
    newProjectPath.value = item.path + serverPathSep()
    showSuggestions.value = false
    suggestions.value = []
    if (!nameManuallyEdited.value) {
      const parts = item.path.replace(/\\/g, '/').split('/').filter(Boolean)
      newProjectName.value = parts[parts.length - 1] || item.name
    }
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(fetchSuggestions, 100)
  }

  function handleInputKeydown(e: KeyboardEvent) {
    if (!showSuggestions.value || suggestions.value.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIdx.value = Math.min(selectedIdx.value + 1, suggestions.value.length - 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIdx.value = Math.max(selectedIdx.value - 1, -1)
    } else if (e.key === 'Enter' && selectedIdx.value >= 0) {
      e.preventDefault()
      selectSuggestion(suggestions.value[selectedIdx.value]!)
    } else if (e.key === 'Escape') {
      showSuggestions.value = false
    }
  }

  function blurSuggestions() {
    setTimeout(() => { showSuggestions.value = false }, 150)
  }

  async function handleAddProject(): Promise<boolean> {
    if (!newProjectPath.value) {
      message.warning(t('layout.warningPath'))
      return false
    }
    if (!newProjectName.value) {
      const parts = newProjectPath.value.replace(/\\/g, '/').split('/').filter(Boolean)
      newProjectName.value = parts[parts.length - 1] || 'project'
    }
    try {
      await projectStore.addProject(newProjectName.value, newProjectPath.value)
      message.success(t('layout.successAdd'))
      showAddModal.value = false
      newProjectName.value = ''
      newProjectPath.value = ''
      suggestions.value = []
      showSuggestions.value = false
      browseDirs.value = []
      fetchAllAheadBehind()
      return true
    } catch {
      return false
    }
  }

  // --- 克隆 ---
  // 表单/提交/进度在 CloneModal 自包含（进度走 useCloneProgress）；此处只持开关。
  // 此前这里留有一份漂移的克隆实现（与 CloneModal 重复且无人调用），已删
  const showCloneModal = ref(false)

  // --- 设置弹窗 ---
  const showSettingsModal = ref(false)
  function openSettings() {
    showSettingsModal.value = true
  }

  // --- Remote 操作 ---
  const remoteLoading = ref(false)
  // fetch/pull/push 在飞同记 gitOps store（P-20261005-211）：顶栏入口的飞行中
  // 状态对 GitPanel 快捷按钮等同族入口可见，去重先拦不叠加网络请求
  const gitOps = useGitOpsStore()
  const aheadBehindMap = ref<Record<string, { ahead: number; behind: number }>>({})

  const currentAheadBehind = computed(() =>
    aheadBehindMap.value[projectStore.currentProjectId || ''] || { ahead: 0, behind: 0 },
  )

  const projectSelectOptions = computed(() =>
    projectStore.projects.map((p) => {
      const ab = aheadBehindMap.value[p.id] || { ahead: 0, behind: 0 }
      return {
        label: p.name,
        value: p.id,
        branch: p.currentBranch || t('toolbar.noBranch'),
        ahead: ab.ahead,
        behind: ab.behind,
        valid: p.valid,
      }
    }),
  )

  async function fetchAllAheadBehind() {
    // 批量接口一次拉全项目（旧版本对端 404 时自动退回逐项目扇出，见 utils/aheadBehind）；
    // 冻结项目在 fetchAheadBehindMap 内跳过（P-20261003-9，与首页同款）
    aheadBehindMap.value = await fetchAheadBehindMap(projectStore.projects)
  }

  async function handleFetch() {
    const pid = projectStore.currentProjectId
    if (!pid || !gitOps.tryBegin(pid, 'fetch')) return
    remoteLoading.value = true
    try {
      await remoteApi.fetch(pid, undefined, { errorLabel: 'fetch.fail' })
      message.success(t('layout.fetchSuccess'))
    } catch {
      // 拦截器已弹专属文案 + 写 Console
    } finally {
      remoteLoading.value = false
      gitOps.end(pid, 'fetch')
    }
  }

  async function handlePull() {
    const pid = projectStore.currentProjectId
    if (!pid || !gitOps.tryBegin(pid, 'pull')) return
    remoteLoading.value = true
    try {
      // 拦截器解包后运行时值即响应体 { data, newCommits }（useBranchCheckout 同款 cast）
      const res = await remoteApi.pull(pid, undefined, undefined, { errorLabel: 'pull.fail' }) as unknown as { data?: string; newCommits?: number }
      // 结果摘要三档（P-20261003-202，共享分档 utils/pullResult）：
      // N>0 成功 toast 带计数 + 通知中心入账（Action 跳变更面板，P-31 惯例）；
      // N=0 「已最新」轻提示不入通知中心；无法计量（旧服务端/空仓）维持原样
      const summary = pullResultSummary(res?.newCommits)
      if (summary.level === 'info') message.info(t(summary.key))
      else if (summary.params) message.success(t(summary.key, summary.params))
      else message.success(t(summary.key))
      if (res?.newCommits !== undefined && res.newCommits > 0) {
        void notificationStore.add({
          type: 'success',
          category: 'git',
          title: t('notification.pullDone'),
          body: t('notification.pullCommits', { n: res.newCommits }),
          projectId: projectStore.currentProjectId || undefined,
          projectName: projectStore.currentProject?.name,
          action: 'panel',
          actionPayload: 'changes',
        })
      }
      await projectStore.fetchProjects()
    } catch {
      // 拦截器已弹专属文案 + 写 Console
    } finally {
      remoteLoading.value = false
      gitOps.end(pid, 'pull')
    }
  }

  // --- Push 对话框 ---
  const showPushModal = ref(false)
  const pushForce = ref(false)
  const pushForceWithLease = ref(false)
  const pushTags = ref(false)
  const pushFollowTags = ref(false)
  const pushRemoteBranch = ref('')
  const pushSetUpstream = ref(false)
  const pushIsNewBranch = ref(false)
  const pushCheckingRemote = ref(false)

  async function checkRemoteBranchExists(branch: string) {
    if (!projectStore.currentProjectId || !branch) return
    pushCheckingRemote.value = true
    try {
      // 后台探测远程分支是否存在：失败仅写 Console，不打扰用户（UI 自动降级）
      const res = await remoteApi.checkBranchExists(projectStore.currentProjectId, 'origin', branch, { silent: true })
      const exists = res.data === true
      pushIsNewBranch.value = !exists
      if (!exists) pushSetUpstream.value = true
    } catch {
      pushIsNewBranch.value = false
    } finally {
      pushCheckingRemote.value = false
    }
  }

  function openPushDialog() {
    pushForce.value = false
    pushForceWithLease.value = false
    pushTags.value = false
    pushFollowTags.value = false
    pushSetUpstream.value = false
    pushIsNewBranch.value = false
    const branch = projectStore.currentProject?.currentBranch || ''
    pushRemoteBranch.value = branch
    showPushModal.value = true
    checkRemoteBranchExists(branch)
  }

  async function handlePush() {
    const pid = projectStore.currentProjectId
    if (!pid || !gitOps.tryBegin(pid, 'push')) return
    remoteLoading.value = true
    try {
      // 拦截器解包后运行时值即响应体 { data, newBranch }（pull 回执 newCommits 同款 cast）
      const res = await remoteApi.push(
        pid,
        'origin',
        projectStore.currentProject?.currentBranch,
        pushForce.value,
        pushForceWithLease.value,
        pushTags.value,
        pushFollowTags.value,
        pushRemoteBranch.value !== projectStore.currentProject?.currentBranch ? pushRemoteBranch.value : undefined,
        pushSetUpstream.value,
        { errorLabel: 'push.fail' },
      ) as unknown as { newBranch?: boolean } | undefined
      // 成功回执统一走 usePushPrToast（P-20261005-215）：首推新分支附「创建 PR」外链
      pushPrToast.toastPushSuccess(res?.newBranch)
      showPushModal.value = false
      fetchAllAheadBehind()
    } catch {
      // 拦截器已弹专属文案 + 写 Console
    } finally {
      remoteLoading.value = false
      gitOps.end(pid, 'push')
    }
  }

  async function handleSync() {
    await handlePull()
    await handlePush()
  }

  // --- PR ---
  // 打开链收口至 usePushPrToast.openCreatePr（P-20261005-215）：与推送成功 toast
  // 的「创建 PR」按钮同一实现（原就地副本迁出，行为不变）
  async function handleCreatePr() {
    await pushPrToast.openCreatePr(projectStore.currentProjectId || '')
  }

  // --- 移除项目 ---
  const showRemoveProjectConfirm = ref(false)

  function openRemoveProjectConfirm() {
    if (!projectStore.currentProjectId) return
    showRemoveProjectConfirm.value = true
  }

  async function handleRemoveProject() {
    if (!projectStore.currentProjectId) return
    try {
      await projectStore.removeProject(projectStore.currentProjectId)
      message.success(t('layout.successRemove'))
    } catch { /* 拦截器处理 */ }
  }

  // --- 复制远程地址 ---
  async function copyRemoteUrl() {
    const url = projectStore.currentProject?.remoteURL
    if (!url) return
    if (await copyText(url)) {
      message.success(t('statusbar.copyRemote'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }

  // --- 更多操作下拉菜单 ---
  const moreActionsOptions = computed(() => [
    { label: t('toolbar.clone'), key: 'clone', icon: () => h('i', { class: 'n-icon' }, [h(DuplicateOutline)]) },
    { label: t('layout.createPr'), key: 'pr', icon: () => h('i', { class: 'n-icon' }, [h(OpenOutline)]) },
    { type: 'divider' as const, key: 'd1' },
    { label: t('layout.removeProject'), key: 'remove', icon: () => h('i', { class: 'n-icon' }, [h(TrashOutline)]) },
  ])

  function handleMoreAction(key: string) {
    if (key === 'clone') showCloneModal.value = true
    else if (key === 'pr') handleCreatePr()
    else if (key === 'remove') openRemoveProjectConfirm()
  }

  // --- 版本与更新 ---
  const buildInfo = ref<{ version: string; commit: string; buildTime: string; goVersion: string; platform: string } | null>(null)
  const showVersionModal = ref(false)

  // 更新分发源：本机作为中心时，跨平台子实例从该 GitHub Release 地址缓存转发
  // 二进制（同平台子实例直接用本机自身二进制，无需配置）
  const updateSourceUrl = ref('')
  const updateSourceSaving = ref(false)

  async function fetchBuildInfo() {
    try {
      // 后台启动请求：失败仅写 Console，不打扰用户
      const res = await settingsApi.get({ silent: true })
      buildInfo.value = {
        version: res.data?.version || 'dev',
        commit: res.data?.commit || 'none',
        buildTime: res.data?.buildTime || 'unknown',
        goVersion: res.data?.goVersion || '',
        platform: res.data?.platform || '',
      }
      updateSourceUrl.value = (res.data as { updateURL?: string } | undefined)?.updateURL || ''
    } catch { /* silent */ }
  }

  async function saveUpdateSource() {
    const v = updateSourceUrl.value.trim()
    if (v && !/^https?:\/\//.test(v)) {
      message.error(t('update.sourceUrlInvalid'))
      return
    }
    updateSourceSaving.value = true
    try {
      await settingsApi.update({ updateURL: v })
      message.success(t('update.sourceUrlSaved'))
    } catch { /* 拦截器处理 */ } finally {
      updateSourceSaving.value = false
    }
  }

  async function copyCommitId() {
    if (buildInfo.value?.commit) {
      if (await copyText(buildInfo.value.commit)) {
        message.success(t('settings.copied'))
      } else {
        message.error(t('common.copyFailed'))
      }
    }
  }

  interface UpdateCheckResult {
    currentVersion: string
    latestVersion?: string
    hasUpdate: boolean
    changelog?: string
    downloadUrl?: string
    fileSize?: number
    // 检查失败分类（P-20261106 beta.2 误报实锚）：后端不再吞错，前端据标志诚实呈现
    channelEmpty?: boolean
    sourceMissing?: boolean
    checkError?: string
  }

  interface UpdateStatusResult {
    status: string
    progress: number
    total: number
    version: string
    error?: string
    result?: string
    resultError?: string
  }

  const updateInfo = ref<UpdateCheckResult | null>(null)
  const updateStatus = ref<UpdateStatusResult | null>(null)
  const showUpdateModal = ref(false)
  const updatePolling = ref(false)

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  async function checkUpdate() {
    try {
      const res = await updateApi.check()
      updateInfo.value = res.data || res
      const info = updateInfo.value
      if (info?.hasUpdate || (info?.latestVersion && info.latestVersion !== info.currentVersion)) {
        notificationStore.add({
          type: 'info',
          category: 'system',
          title: t('notification.event.updateAvailable'),
          body: info.latestVersion ? `v${info.latestVersion}` : undefined,
        })
      } else if (info?.channelEmpty) {
        // stable 通道无正式版（正式通道恒排预发布），提示避免误读为"已是最新"
        if (shouldShowToast('update.channelEmptyHint')) {
          message.info(t('update.channelEmptyHint'))
        }
      } else if (info?.sourceMissing) {
        // 自更新源已内置官方仓库；真缺源仅剩「配置的非法分发源被拒」一途
        if (shouldShowToast('update.sourceMissingHint')) {
          message.warning(t('update.sourceMissingHint'))
        }
      } else if (info?.checkError) {
        // 其余检查失败如实呈现，不再吞成「未配置源」
        if (shouldShowToast('update.checkFailedHint')) {
          message.warning(t('update.checkFailedHint', { reason: info.checkError }))
        }
      }
    } catch {
      updateInfo.value = null
    }
  }

  function pollUpdateStatus() {
    let interval = 2000
    const maxInterval = 30000
    const terminalStatuses = ['success', 'failed', 'rolled_back']

    async function poll() {
      if (!updatePolling.value) return
      try {
        // 轮询请求：失败仅写 Console，不打扰用户
        const res = await updateApi.status({ silent: true })
        updateStatus.value = res.data || res
        const status: string = updateStatus.value?.status || updateStatus.value?.result || ''
        if (terminalStatuses.includes(status)) {
          updatePolling.value = false
          if (status === 'success') {
            message.success(t('update.success'))
            notificationStore.add({
              type: 'success',
              category: 'system',
              title: t('notification.event.updateCompleted'),
            })
          } else if (status === 'rolled_back') {
            message.warning(t('update.rolledBack'))
            notificationStore.add({
              type: 'warning',
              category: 'system',
              title: t('notification.event.updateFailed'),
              body: t('update.rolledBack'),
            })
          } else {
            message.error(t('update.failed'))
            notificationStore.add({
              type: 'error',
              category: 'system',
              title: t('notification.event.updateFailed'),
            })
          }
          return
        }
        interval = 2000
      } catch {
        interval = Math.min(interval * 2, maxInterval)
      }
      setTimeout(poll, interval)
    }

    poll()
  }

  async function startUpdate() {
    try {
      await updateApi.apply()
      message.success(t('update.updateStarted'))
      updatePolling.value = true
      pollUpdateStatus()
    } catch { /* 拦截器处理 */ }
  }

  return {
    // 添加项目
    showAddModal,
    newProjectName,
    newProjectPath,
    nameManuallyEdited,
    browseDirs,
    browseCurrent,
    browseLoading,
    suggestions,
    showSuggestions,
    selectedIdx,
    browseDirectory,
    selectBrowseDir,
    parsePathSegments,
    onPathInput,
    selectSuggestion,
    handleInputKeydown,
    blurSuggestions,
    handleAddProject,
    // 克隆
    showCloneModal,
    // 设置
    showSettingsModal,
    openSettings,
    // Remote
    remoteLoading,
    aheadBehindMap,
    currentAheadBehind,
    projectSelectOptions,
    fetchAllAheadBehind,
    handleFetch,
    handlePull,
    // Push
    showPushModal,
    pushForce,
    pushForceWithLease,
    pushTags,
    pushFollowTags,
    pushRemoteBranch,
    pushSetUpstream,
    pushIsNewBranch,
    pushCheckingRemote,
    openPushDialog,
    checkRemoteBranchExists,
    handlePush,
    handleSync,
    // PR
    handleCreatePr,
    // 移除项目
    showRemoveProjectConfirm,
    openRemoveProjectConfirm,
    handleRemoveProject,
    // 复制远程地址
    copyRemoteUrl,
    // 更多操作
    moreActionsOptions,
    handleMoreAction,
    // 版本与更新
    buildInfo,
    showVersionModal,
    fetchBuildInfo,
    copyCommitId,
    updateInfo,
    updateStatus,
    showUpdateModal,
    updatePolling,
    formatBytes,
    checkUpdate,
    startUpdate,
    updateSourceUrl,
    updateSourceSaving,
    saveUpdateSource,
  }
}
