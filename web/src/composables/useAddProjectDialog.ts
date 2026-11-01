import { ref, computed, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { credentialApi, sshKeyApi, type SshKey, CLONE_DEST_EXISTS_RE, CLONE_URL_INVALID_RE } from '../api/client'
import { AppError } from '../api/error-types'
import { isValidCloneUrl, looksLikeGitUrl } from '../utils/cloneUrl'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'
import { useCloneProgress, type CloneStatus, type CloneResult } from './useCloneProgress'
import { useCloneBranchPrefetch } from './useCloneBranchPrefetch'
import { serverPathSep } from './useServerPathSep'
import { loadClonePrefs, saveClonePrefs } from '../utils/clonePrefs'
import { useCloneUrlHistory } from './useCloneUrlHistory'

export type AddMode = 'local' | 'clone'

export function useAddProjectDialog(onAdded: () => void) {
  const message = useMessage()
  const { t } = useI18n()
  const projectStore = useProjectStore()

  const show = ref(false)
  const addMode = ref<AddMode>('local')

  // 本地路径模式（browse/联想由模板内 PathInput 自包含承担）
  const newProjectName = ref('')
  const newProjectPath = ref('')
  const nameManuallyEdited = ref(false)

  // 克隆模式
  const cloneUrl = ref('')
  const cloneDir = ref('')
  const cloneBranch = ref('')
  const cloneDepth = ref(0)
  const cloneName = ref('')
  const cloneNameManuallyEdited = ref(false)
  // clone skip/autoSet 业务标志（browse/联想由模板内 PathInput 承担）
  const cloneDirAutoSet = ref(false)
  let skipNextCloneDirWatch = false
  const cloneMissingCredHost = ref('')
  const cloneSshKeys = ref<SshKey[]>([])
  const cloneSelectedSshKey = ref('')

  const isSshUrl = computed(() => /^(git@|ssh:\/\/)/i.test(cloneUrl.value.trim()))
  // URL 形态即时校验（P-20261003-70）：与 CloneModal 同规则（utils/cloneUrl.ts，
  // 服务端 precheckCloneURL 同规则 400 双保险），打字瞬间行内红提示不阻断输入；
  // 校验发送值（trim 后），与 handleCloneProject 实际提交的 URL 一致
  const cloneUrlInvalid = computed(() =>
    !!cloneUrl.value.trim() && !isValidCloneUrl(cloneUrl.value.trim()))
  const sshKeyOptions = computed(() =>
    cloneSshKeys.value.map(k => ({
      label: `${k.name} (${k.fingerprint?.slice(0, 25)}…)`,
      value: k.id,
    })),
  )

  // 克隆前分支预取（P-20261003-93）：「拉取分支」→ 分支下拉可选；失败行内
  // 提示不阻断克隆。SSH 地址带对话框选定密钥（与克隆同一 sshKeyId 语义）
  const {
    branches: cloneBranches,
    branchOptions,
    loadingBranches,
    branchErrorKey,
    fetchBranches,
    resetBranches,
  } = useCloneBranchPrefetch()

  function fetchCloneBranches() {
    return fetchBranches(
      cloneUrl.value,
      isSshUrl.value && cloneSelectedSshKey.value ? cloneSelectedSshKey.value : undefined,
    )
  }

  // URL 编辑即丢弃旧列表/旧提示——列表只对拉取时的 URL 成立
  watch(cloneUrl, () => {
    resetBranches()
  })

  const {
    status: cloneStatus,
    lines: cloneLines,
    progress: cloneProgress,
    result: cloneResult,
    startClone,
    cancelClone,
    reset: resetCloneProgress,
  } = useCloneProgress()

  const addPositiveText = computed(() => {
    if (addMode.value === 'clone' && cloneStatus.value === 'running') {
      return t('home.clone.cloning')
    }
    return t('home.addProject')
  })

  const positiveButtonProps = computed(() => {
    if (addMode.value === 'clone' && cloneStatus.value === 'running') {
      return { loading: true, disabled: true }
    }
    return {}
  })

  function pathSep(): string {
    // 按服务端 OS 取分隔符（远程部署时浏览器是 Windows、服务是 Linux）
    return serverPathSep()
  }

  // 名称推断：路径变化时按末段推断项目名（除非用户手动编辑过）
  watch(newProjectPath, val => {
    if (!nameManuallyEdited.value && val) {
      const parts = val.replace(/\\/g, '/').split('/').filter(Boolean)
      const inferred = parts[parts.length - 1]
      if (inferred) newProjectName.value = inferred
    }
  })

  async function handleAddProject() {
    if (!newProjectPath.value) {
      message.warning(t('home.warningPath'))
      return false
    }
    if (!newProjectName.value) {
      const parts = newProjectPath.value.replace(/\\/g, '/').split('/')
      newProjectName.value = parts[parts.length - 1] || 'project'
    }
    try {
      await projectStore.addProject(newProjectName.value, newProjectPath.value)
      message.success(t('home.successAdd'))
      show.value = false
      onAdded()
      return true
    } catch {
      message.error(t('home.failAdd'))
      return false
    }
  }

  // clone 目录 skip：PathInput 选中目录前由模板 @select 调用，置 skip 以避免清 cloneDirAutoSet
  function markCloneDirSelect() {
    skipNextCloneDirWatch = true
  }

  watch(cloneDir, () => {
    if (skipNextCloneDirWatch) {
      skipNextCloneDirWatch = false
    } else {
      cloneDirAutoSet.value = false
    }
  })

  function onCloneUrlBlur() {
    urlHistoryFocused.value = false
    if (cloneNameManuallyEdited.value) {
      checkCloneCredential()
      checkCloneSshKey()
      return
    }
    const url = cloneUrl.value.trim()
    if (!url) {
      cloneMissingCredHost.value = ''
      cloneSshKeys.value = []
      cloneSelectedSshKey.value = ''
      return
    }
    const cleaned = url.replace(/\.git$/, '')
    const parts = cleaned.split(/[/:]/)
    const name = parts[parts.length - 1]
    if (name) {
      const oldName = cloneName.value
      cloneName.value = name
      const dir = cloneDir.value.trim()
      if (dir && !cloneDirAutoSet.value) {
        const sep = pathSep()
        const clean = oldName ? dir.replace(new RegExp((sep === '\\' ? '\\\\' : sep) + oldName + '$'), '') : dir.replace(/[\\/]$/, '')
        skipNextCloneDirWatch = true
        cloneDir.value = clean.replace(/[\\/]$/, '') + sep + name
        cloneDirAutoSet.value = true
      }
    }
    checkCloneCredential()
    checkCloneSshKey()
  }

  async function checkCloneCredential() {
    cloneMissingCredHost.value = ''
    const url = cloneUrl.value.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) return
    try {
      const m = url.match(/^https?:\/\/([^/]+)/i)
      if (!m || !m[1]) return
      const host = m[1].toLowerCase()
      const res: any = await credentialApi.list()
      const list: any[] = res.data || []
      const found = list.some((c) => c.host?.toLowerCase() === host)
      if (!found) cloneMissingCredHost.value = host
    } catch { /* silent */ }
  }

  async function checkCloneSshKey() {
    cloneSshKeys.value = []
    cloneSelectedSshKey.value = ''
    const url = cloneUrl.value.trim()
    if (!url) return
    if (!/^(git@|ssh:\/\/)/i.test(url)) return
    try {
      const res: any = await sshKeyApi.list()
      cloneSshKeys.value = res.data || []
      // 上次选择记忆（P-20261003-241）：上次选定的密钥仍在清单 → 优先用它
      // （多仓连续克隆同密钥不再重选，记忆压过 host 自动匹配）；密钥已被删 →
      // 对账失效，回落既有默认链（host 匹配 → 通用密钥 → 空），陈旧 id 不复活
      const remembered = loadClonePrefs().sshKeyId
      const host = extractSshHost(url)
      const matched = cloneSshKeys.value.find(k => k.host?.toLowerCase() === host)
      const generic = cloneSshKeys.value.find(k => !k.host)
      if (remembered && cloneSshKeys.value.some(k => k.id === remembered)) {
        cloneSelectedSshKey.value = remembered
      } else if (matched) {
        cloneSelectedSshKey.value = matched.id
      } else if (generic) {
        cloneSelectedSshKey.value = generic.id
      }
    } catch { /* silent */ }
  }

  function extractSshHost(url: string): string {
    const atIdx = url.indexOf('@')
    if (atIdx >= 0) {
      const rest = url.substring(atIdx + 1)
      const colIdx = rest.indexOf(':')
      if (colIdx >= 0) return rest.substring(0, colIdx).toLowerCase()
    }
    const m = url.match(/^ssh:\/\/([^/]+)/i)
    if (m && m[1]) return m[1].toLowerCase()
    return ''
  }

  // ============== 克隆 URL 历史下拉（P-20261003-251） ==============
  // 换目录/重试再克隆同仓库：URL 输入框聚焦出最近克隆 URL，点选回填并走失焦
  // 同一条推断链（名称/目录推断 + 凭据/SSH 预检）。ProjectSearch 查询历史同族：
  // 聚焦态 + 收起态分离（点选后本轮聚焦内不再自动弹出，@click 同 handler——
  // 已聚焦时 focus 事件不再触发，仅靠 @focus 收不回来）。记录发生在
  // handleCloneProject 提交时（搜索「发起时记录」同惯例），此处只管展示与回填
  const { history: cloneUrlHistory, filterByPrefix: filterCloneUrlPrefix, clearHistory: clearCloneUrlHistory, recordUrl: recordCloneUrl } = useCloneUrlHistory()
  const urlHistoryFocused = ref(false)
  const urlHistoryDismissed = ref(false)
  const urlHistoryVisible = computed(() =>
    urlHistoryFocused.value && !urlHistoryDismissed.value && cloneUrlHistory.value.length > 0,
  )
  const urlHistoryItems = computed(() => filterCloneUrlPrefix(cloneUrl.value))
  // 前缀过滤全空时保留下拉给空态提示（「无匹配」也是反馈，静默消失像坏了）
  const urlHistoryAllFilteredOut = computed(() =>
    urlHistoryVisible.value && cloneUrl.value.trim() !== '' && urlHistoryItems.value.length === 0,
  )
  function onCloneUrlFocus() {
    urlHistoryFocused.value = true
    urlHistoryDismissed.value = false
  }
  function closeUrlHistory() {
    urlHistoryDismissed.value = true
  }
  function onClearUrlHistory() {
    clearCloneUrlHistory()
    closeUrlHistory()
  }
  // 回填选中：与手动输入后失焦同一条推断链（onCloneUrlBlur 幂等，回填即就绪可提交）
  function applyUrlHistory(url: string) {
    cloneUrl.value = url
    onCloneUrlBlur()
    closeUrlHistory()
  }

  function resetCloneForm() {
    cloneUrl.value = ''
    cloneDir.value = ''
    cloneBranch.value = ''
    // 上次选择记忆（P-20261003-241）：深度恢复持久化值（0=完整克隆同默认）；
    // SSH 密钥依赖密钥清单（URL 失焦异步加载），在 checkCloneSshKey 里恢复
    cloneDepth.value = loadClonePrefs().depth
    cloneName.value = ''
    cloneNameManuallyEdited.value = false
    cloneDirAutoSet.value = false
    skipNextCloneDirWatch = false
    cloneMissingCredHost.value = ''
    cloneSshKeys.value = []
    cloneSelectedSshKey.value = ''
    // 历史下拉态随表单复位（v-if 移除不触发 blur，须显式清）
    urlHistoryFocused.value = false
    urlHistoryDismissed.value = false
    resetBranches()
    resetCloneProgress()
  }

  // 上次选择记忆写回（P-20261003-241）：密钥/深度变更即写持久层（同 notify-filter
  // 原 rationale——写发生于状态变更时，弹窗开闭不参与）。置空的场景（表单重置/
  // 非 SSH URL 清下拉）是派生清除态而非用户「取消记忆」的意图，不覆盖持久值；
  // 失效密钥 id 由 checkCloneSshKey 读侧对账回落，不会从持久层复活。自动匹配
  // 选中同样入账：它就是本次实际提交的密钥，语义即「上次用的」
  watch([cloneSelectedSshKey, cloneDepth], ([key, depth]) => {
    const prev = loadClonePrefs()
    saveClonePrefs({
      sshKeyId: key || prev.sshKeyId,
      depth: typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 ? depth : prev.depth,
    })
  })

  function onCloneDone(s: CloneStatus, r: CloneResult | null) {
    if (s === 'success') {
      message.success(t('home.clone.success'))
      show.value = false
      resetCloneForm()
      addMode.value = 'local'
      projectStore.fetchProjects()
      onAdded()
    } else if (s === 'failed') {
      message.error(r?.error || t('home.clone.fail'))
      resetCloneProgress()
    } else if (s === 'canceled') {
      message.info(t('home.clone.canceled'))
      resetCloneProgress()
    }
  }

  watch(cloneStatus, (s) => {
    onCloneDone(s, cloneResult.value)
  })

  function handleCloneProject() {
    if (cloneStatus.value === 'running') return false
    if (!cloneUrl.value.trim() || !cloneDir.value.trim()) {
      message.warning(t('home.clone.warning'))
      return false
    }
    // URL 形态不合法：行内红提示已即现（cloneUrlInvalid），不发请求
    if (cloneUrlInvalid.value) return false
    // 克隆 URL 历史（P-20261003-251）：提交即记录（搜索「发起时记录」同惯例，
    // 失败重试恰是动机之一；命中服务端预检 400 不回收——目标已存在正是换目录
    // 再克隆的场景，URL 依然有效）；含凭据 URL 由 recordUrl 内部跳过
    recordCloneUrl(cloneUrl.value.trim())
    startClone({
      url: cloneUrl.value.trim(),
      dir: cloneDir.value.trim(),
      branch: cloneBranch.value.trim() || undefined,
      depth: cloneDepth.value > 0 ? cloneDepth.value : undefined,
      name: cloneName.value.trim() || undefined,
      // SSH 地址时用户选定的密钥 id；服务端按 id 精确取钥匙
      sshKeyId: isSshUrl.value && cloneSelectedSshKey.value ? cloneSelectedSshKey.value : undefined,
    }, onCloneDone).catch((e) => {
      // 服务端预检 400：目录预检（P-20261003-26）/ URL 形态预检（P-20261003-70）
      // 均未走 silent，拦截器已按 KNOWN_ERROR 映射弹过对应行内文案同源提示，
      // 此处静默防叠双 toast；其余失败维持原「克隆失败」兜底
      if (!(e instanceof AppError && (CLONE_DEST_EXISTS_RE.test(e.rawMessage) || CLONE_URL_INVALID_RE.test(e.rawMessage)))) {
        message.error(t('home.clone.fail'))
      }
      resetCloneProgress()
    })
    return false
  }

  async function handleCancelClone() {
    await cancelClone()
  }

  function handleAddPositiveClick() {
    if (addMode.value === 'clone') return handleCloneProject()
    return handleAddProject()
  }

  // ============== 克隆建议（P-20261003-170） ==============
  // 本地 tab 粘贴事件里检测到远程 URL 形态（looksLikeGitUrl，锚定协议前缀
  // 防误报——本地路径不触发）时行内提示一键切到克隆 tab 并预填；可忽略不
  // 强制，下次粘贴重新提示（每次粘贴都是一次新信号）。不 preventDefault，
  // 粘贴照常落入输入框——忽略建议后用户手里仍是完整内容
  const cloneSuggestVisible = ref(false)
  let cloneSuggestUrl = ''
  let cloneSuggestTarget: 'path' | 'name' = 'path'

  function onLocalPaste(e: Event, target: 'path' | 'name') {
    // 剪贴板数据仅 ClipboardEvent 携带（组件透传的落点可能是原生 Event），
    // 无 clipboardData 的合成事件按无内容处理
    const data = 'clipboardData' in e ? (e as ClipboardEvent).clipboardData : null
    const text = data?.getData('text') || ''
    if (!looksLikeGitUrl(text)) return
    cloneSuggestUrl = text.trim()
    cloneSuggestTarget = target
    cloneSuggestVisible.value = true
  }

  function acceptCloneSuggest() {
    if (!cloneSuggestUrl) return
    addMode.value = 'clone'
    cloneUrl.value = cloneSuggestUrl
    // 与手动粘贴+失焦同一条推断链：名称推断 + 凭据/SSH 密钥预检
    onCloneUrlBlur()
    // 来源输入框整格恰为本次粘贴内容时清掉（清除范围=粘贴带入的内容，
    // 与用户原有输入混排时不清防误删）；路径清掉后名称若仅是推断产物一并回收
    if (cloneSuggestTarget === 'path') {
      if (newProjectPath.value.trim() === cloneSuggestUrl) {
        newProjectPath.value = ''
        if (!nameManuallyEdited.value) newProjectName.value = ''
      }
    } else if (newProjectName.value.trim() === cloneSuggestUrl) {
      newProjectName.value = ''
      nameManuallyEdited.value = false
    }
    dismissCloneSuggest()
  }

  function dismissCloneSuggest() {
    cloneSuggestVisible.value = false
  }

  function openAddModal() {
    show.value = true
    addMode.value = 'local'
    newProjectName.value = ''
    newProjectPath.value = ''
    nameManuallyEdited.value = false
    resetCloneForm()
    dismissCloneSuggest()
    cloneSuggestUrl = ''
  }

  // ============== 克隆对话框内联 SSH 密钥管理 ==============
  // 首次使用没有项目时进不了安全设置：SSH 地址克隆缺钥匙时直接在对话框内
  // 生成/导入并取公钥，消除「先有项目才能配钥匙」的死锁
  const sshKeyGenerating = ref(false)
  const sshKeyImporting = ref(false)
  const sshKeyImportPem = ref('')
  const sshKeyPubView = ref('')

  async function generateCloneKey() {
    if (sshKeyGenerating.value) return
    sshKeyGenerating.value = true
    try {
      const host = extractSshHost(cloneUrl.value.trim()) || 'key'
      const res: any = await sshKeyApi.generate({ name: `sc-clone-${host}-${Date.now() % 10000}`, algo: 'ed25519' })
      const newId = res?.data?.id || ''
      await checkCloneSshKey()
      if (newId) cloneSelectedSshKey.value = newId
      const pub: any = await sshKeyApi.getPub(newId)
      sshKeyPubView.value = String(pub?.pubKey || '').trim()
      message.success(t('home.clone.sshKeyGenerated'))
    } catch (e: any) {
      message.error(e?.userMessage || e?.message || t('home.clone.sshKeyManageFailed'))
    } finally {
      sshKeyGenerating.value = false
    }
  }

  async function importCloneKey() {
    const pem = sshKeyImportPem.value.trim()
    if (!pem || sshKeyGenerating.value) return
    sshKeyGenerating.value = true
    try {
      const host = extractSshHost(cloneUrl.value.trim()) || 'key'
      const res: any = await sshKeyApi.import({ name: `sc-clone-${host}-${Date.now() % 10000}`, privateKey: pem })
      const newId = res?.data?.id || ''
      await checkCloneSshKey()
      if (newId) cloneSelectedSshKey.value = newId
      sshKeyImportPem.value = ''
      sshKeyImporting.value = false
      message.success(t('home.clone.sshKeyGenerated'))
    } catch (e: any) {
      message.error(e?.userMessage || e?.message || t('home.clone.sshKeyManageFailed'))
    } finally {
      sshKeyGenerating.value = false
    }
  }

  async function copyClonePub() {
    const { copyText } = await import('../utils/clipboard')
    const ok = await copyText(sshKeyPubView.value)
    if (ok) message.success(t('home.clone.sshKeyCopied'))
    else message.error(t('common.copyFailed'))
  }

  return {
    show,
    addMode,
    newProjectName,
    newProjectPath,
    nameManuallyEdited,
    cloneDirAutoSet,
    cloneUrl,
    cloneDir,
    cloneBranch,
    cloneDepth,
    cloneName,
    cloneNameManuallyEdited,
    cloneMissingCredHost,
    cloneUrlInvalid,
    cloneSuggestVisible,
    onLocalPaste,
    acceptCloneSuggest,
    dismissCloneSuggest,
    urlHistoryVisible,
    urlHistoryItems,
    urlHistoryAllFilteredOut,
    onCloneUrlFocus,
    onClearUrlHistory,
    applyUrlHistory,
    cloneSshKeys,
    cloneSelectedSshKey,
    isSshUrl,
    sshKeyOptions,
    cloneBranches,
    branchOptions,
    loadingBranches,
    branchErrorKey,
    fetchCloneBranches,
    sshKeyGenerating,
    sshKeyImporting,
    sshKeyImportPem,
    sshKeyPubView,
    generateCloneKey,
    importCloneKey,
    copyClonePub,
    cloneStatus,
    cloneLines,
    cloneProgress,
    addPositiveText,
    positiveButtonProps,
    markCloneDirSelect,
    onCloneUrlBlur,
    handleCancelClone,
    handleAddPositiveClick,
    openAddModal,
  }
}
