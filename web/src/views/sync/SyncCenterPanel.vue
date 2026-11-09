<script setup lang="ts">
// 同步中心面板（P-20261023-1 方案③）：实例对选择器 + 常驻方向指示器 + 项目
// 卡片多选（上下文勾选 chips）+ plan 预览（冲突批量三键裁决）+ 大按钮「拉取/
// 推送」（文案永远带方向词）+ 进度体系（总进度条 百分比/字节/速率/剩余时间 +
// 单元状态机 + 结果卡汇总）+ 定时同步清单 + 红线灰显。操作流二审增强：
// 配置记忆（uistate）+「重跑上次」一键 + 离线目标标灰。
import { computed, h, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  ArrowDownOutline, ArrowUpOutline, CloudDownloadOutline, CloudUploadOutline,
  RefreshOutline, TimeOutline, WarningOutline, CheckmarkCircleOutline,
  CloseCircleOutline,
} from '@vicons/ionicons5'
import { NButton, NCheckbox, NIcon, NInput, NSpin, NTooltip, useDialog, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { syncApi, syncCredApi } from '../../api/domains/sync'
import type { SyncCredStaged, SyncCron, SyncJobSnapshot, SyncPairingStatus, SyncPlan, SyncPlanRow, SyncUnitProgress } from '../../api/domains/sync'
import { instanceFetch } from '../../api/instanceFetch'
import { useInstanceStore } from '../../stores/instance'
import { useProjectStore } from '../../stores/project'
import { useUIStateStore } from '../../stores/uiState'
import { OPS_SYNC_PROGRESS } from '../../utils/opsEvents'
import { copyText } from '../../utils/clipboard'
import { formatBytes } from '../../utils/bytes'

// 对话框内联表单的统一输入样式（useSyncDeliver 同款内联风格；主题变量取色）
const DIALOG_INPUT_STYLE = 'padding:4px 6px;border:1px solid var(--border-default);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);'

const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const instanceStore = useInstanceStore()
const projectStore = useProjectStore()
const uiState = useUIStateStore()

// ── 方向（常驻指示器 + 文案方向词双保险）──
const direction = ref<'pull' | 'push'>('push')
// ── 对端选择（push 多选；pull 取首台）──
const selectedPeerIds = ref<string[]>([])
// ── 项目选择与上下文勾选 ──
const selectedProjectKeys = ref<string[]>([])
// 上下文默认集：原默认 ['notes']（只带笔记）随 P-20261108-3 笔记单元退役改为
// 定时任务（同为小 JSON 单元）——服务端 contexts 空 = 全部上下文（含可达数百 MB
// 的会话单元），默认必须是非空的轻量集
const DEFAULT_SYNC_CONTEXTS = ['crons']
// 退役上下文 kind（笔记单元不再随实例同步）：uiState 记忆里的旧值读入即剔除
const RETIRED_SYNC_CONTEXTS = new Set(['notes', 'notes-multi'])
/** 上下文集归一：剔除退役 kind；剔除后为空（旧记忆只勾了笔记）回落默认集——
 *  不能让空集被服务端解读成「全部上下文」 */
function sanitizeContexts(list: string[] | undefined): string[] {
  if (!list?.length) return [...DEFAULT_SYNC_CONTEXTS]
  const kept = list.filter(k => !RETIRED_SYNC_CONTEXTS.has(k))
  return kept.length ? kept : [...DEFAULT_SYNC_CONTEXTS]
}
const selectedContexts = ref<string[]>([...DEFAULT_SYNC_CONTEXTS])
const includeIgnored = ref(false)
const includeGit = ref(false)
// 手动携密同步（P-20261024-3）：开关缺省关；勾选即确认对话框 + 服务端核对
const includeCredentials = ref(false)
const pairingRows = ref<SyncPairingStatus[]>([])
const stagedRows = ref<SyncCredStaged[]>([])
const projectSearch = ref('')

// ── 数据面 ──
const loading = ref(false)
const planning = ref(false)
const plan = ref<SyncPlan | null>(null)
const job = ref<SyncJobSnapshot | null>(null)
const executing = ref(false)
const lastResult = ref<SyncJobSnapshot | null>(null)
const cronSectionOpen = ref(false)

const remoteInstances = computed(() =>
  instanceStore.instances.filter(i => !i.isLocal && i.status !== 'invalid'),
)

// 方向指示器文案：按钮永远带方向词（方案③防拉推搞反的双保险文案侧）
const directionLabel = computed(() =>
  direction.value === 'pull' ? t('sync.directionPull') : t('sync.directionPush'),
)
const mainButtonLabel = computed(() => {
  if (direction.value === 'pull') {
    const peer = peerNameOf(selectedPeerIds.value[0])
    return t('sync.pullButton', { peer })
  }
  return t('sync.pushButton', { count: selectedPeerIds.value.length })
})

function peerNameOf(id?: string): string {
  if (!id) return t('sync.noPeer')
  return instanceStore.instances.find(i => i.id === id)?.name ?? id
}

// ── 手动携密同步状态（配对/核对/暂存/上次携密）──
async function loadCredState() {
  try {
    const [pairingRes, stagedRes] = await Promise.all([
      syncCredApi.pairingStatus(),
      syncCredApi.staged(),
    ])
    pairingRows.value = pairingRes.data ?? []
    stagedRows.value = stagedRes.data ?? []
  } catch { /* 携密面读失败静默——非核心数据面 */ }
}
function pairingOf(id: string): SyncPairingStatus | undefined {
  return pairingRows.value.find(r => r.instanceId === id)
}
// 对端「携密就绪」= 已配对 + 本端已完成首次指纹核对（服务端 credGuard 同口径）
function credReadyOf(id: string): boolean {
  const r = pairingOf(id)
  return !!r && r.paired && r.certVerified
}
function credBadgeOf(id: string): string {
  const r = pairingOf(id)
  if (!r || !r.paired) return t('sync.credUnpaired')
  return r.certVerified ? t('sync.credVerified') : t('sync.credPaired')
}

function togglePeer(id: string) {
  const cur = new Set(selectedPeerIds.value)
  if (cur.has(id)) cur.delete(id)
  else {
    if (direction.value === 'pull') cur.clear() // pull 单对端语义
    cur.add(id)
  }
  selectedPeerIds.value = [...cur]
}

// ── 项目清单（本端项目 × 账本「上次同步/落后标记」）──
interface ProjectCard {
  key: string
  projectId: string
  name: string
  path: string
  gitRepo: boolean
  lastSyncedAt?: string
  lastDirection?: string
  behind: boolean // 对端指纹较新（上次方向=push 后本端又变）粗标：有账本且距今小于项目 mtime 检测不可行——以账本时间+方向呈现
}

const projectCards = ref<ProjectCard[]>([])
const ledgerMap = ref<Map<string, { syncedAt: string; direction: string }>>(new Map())

async function loadProjects() {
  loading.value = true
  try {
    await projectStore.fetchProjects({ silent: true })
    const [manifestRes, ledgerRes] = await Promise.all([
      syncApi.manifest(),
      syncApi.ledger().catch(() => ({ data: [] })),
    ])
    const entries = manifestRes.data?.units ?? []
    // 账本按项目聚合（project 单元基线即项目级「上次同步」）
    ledgerMap.value = new Map()
    for (const e of ledgerRes.data ?? []) {
      if (e.unitKey.startsWith('project:')) {
        ledgerMap.value.set(e.unitKey, { syncedAt: e.syncedAt, direction: e.direction })
      }
    }
    projectCards.value = entries
      .filter(u => u.kind === 'project' && u.exists)
      .map(u => {
        const base = u.key.slice('project:'.length)
        const rec = ledgerMap.value.get(u.key)
        const proj = projectStore.projects.find(p => basename(p.path) === base)
        return {
          key: u.key,
          projectId: proj?.id ?? '',
          name: u.name,
          path: u.path ?? '',
          gitRepo: !!u.gitRepo,
          lastSyncedAt: rec?.syncedAt,
          lastDirection: rec?.direction,
          behind: false,
        }
      })
    if (selectedProjectKeys.value.length === 0) {
      selectedProjectKeys.value = projectCards.value.map(p => p.key)
    }
    const filtered = projectCards.value.filter(p => selectedProjectKeys.value.includes(p.key))
    if (filtered.length > 0) {
      selectedProjectKeys.value = filtered.map(p => p.key)
    }
  } catch {
    message.error(t('sync.loadFailed'))
  } finally {
    loading.value = false
  }
}

function basename(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = Math.max(n.lastIndexOf('/'), 0)
  return i > 0 ? n.slice(i + 1) : n
}

const visibleProjects = computed(() => {
  const q = projectSearch.value.trim().toLowerCase()
  if (!q) return projectCards.value
  return projectCards.value.filter(p => p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
})

const allSelected = computed(() =>
  visibleProjects.value.length > 0 && visibleProjects.value.every(p => selectedProjectKeys.value.includes(p.key)),
)
function toggleAll() {
  if (allSelected.value) {
    selectedProjectKeys.value = selectedProjectKeys.value.filter(k => !visibleProjects.value.some(p => p.key === k))
  } else {
    const keys = new Set([...selectedProjectKeys.value, ...visibleProjects.value.map(p => p.key)])
    selectedProjectKeys.value = [...keys]
  }
}

// 上下文 chips（红线项不在词表——凭据/令牌永不同步，UI 说明区灰显注记；笔记
// notes/notes-multi 单元随 P-20261108-3 单库化退役，不再提供勾选）
const contextChips = computed(() => [
  { kind: 'sessions', label: t('sync.ctxSessions') },
  { kind: 'crons', label: t('sync.ctxCrons') },
])
const globalChips = computed(() => [
  { kind: 'snippets', label: t('sync.ctxSnippets') },
  { kind: 'runtimes', label: t('sync.ctxRuntimes') },
  { kind: 'approvals', label: t('sync.ctxApprovals') },
  { kind: 'chains', label: t('sync.ctxChains') },
  { kind: 'uistate', label: t('sync.ctxUIState') },
])
function toggleContext(list: string[], kind: string): string[] {
  return list.includes(kind) ? list.filter(k => k !== kind) : [...list, kind]
}

// ── plan ──
const conflictRows = computed(() => plan.value?.rows.filter(r => r.state === 'conflict') ?? [])
const actionRows = computed(() => plan.value?.rows.filter(r => r.state !== 'synced') ?? [])
const selectedRows = computed(() => plan.value?.rows.filter(r => r.selected) ?? [])
const hasConflictResolutions = ref<Map<string, string>>(new Map())

async function loadPlan() {
  const peerId = selectedPeerIds.value[0]
  if (!peerId) {
    plan.value = null
    return
  }
  planning.value = true
  hasConflictResolutions.value = new Map()
  try {
    const res = await syncApi.plan({
      instanceId: peerId,
      projectKeys: selectedProjectKeys.value,
      contexts: [...selectedContexts.value, ...globalSelected.value],
    })
    plan.value = res.data ?? null
    if (plan.value?.peerUnsupported) {
      message.warning(t('sync.peerUnsupported', { version: plan.value.peerVersion ?? '?' }))
    } else if (plan.value && !plan.value.peerOnline) {
      message.warning(t('sync.peerOffline'))
    } else if (plan.value?.peerDiskInsufficient) {
      message.error(t('sync.diskInsufficient'))
    }
  } catch {
    message.error(t('sync.planFailed'))
    plan.value = null
  } finally {
    planning.value = false
  }
}

const globalSelected = computed(() => globalChips.value.map(c => c.kind).filter(k => selectedContexts.value.includes(k)))

// 冲突批量三键（全部保留本端/全部取对端/全部跳过）+ 逐项微调
function resolveAll(side: 'local' | 'peer' | 'skip') {
  const next = new Map(hasConflictResolutions.value)
  for (const row of conflictRows.value) {
    if (side === 'local') next.set(row.key, direction.value === 'push' ? 'local' : 'peer')
    else if (side === 'peer') next.set(row.key, direction.value === 'push' ? 'peer' : 'local')
    else next.set(row.key, 'skip')
    setRowSelected(row, side !== 'skip')
  }
  hasConflictResolutions.value = next
}
function resolveOne(row: SyncPlanRow, side: 'local' | 'peer' | 'skip') {
  const next = new Map(hasConflictResolutions.value)
  next.set(row.key, side)
  hasConflictResolutions.value = next
  setRowSelected(row, side !== 'skip')
}
function setRowSelected(row: SyncPlanRow, on: boolean) {
  if (!plan.value) return
  const r = plan.value.rows.find(x => x.key === row.key)
  if (r) r.selected = on
}

// 单元方向语义：pull 会话只勾 action=pull 行；push 会话只勾 action=push 行
function rowsForDirection(): { units: string[]; resolutions: Record<string, string> } {
  const units: string[] = []
  const resolutions: Record<string, string> = {}
  for (const row of plan.value?.rows ?? []) {
    if (!row.selected) continue
    if (row.action === direction.value || row.state === 'new') {
      units.push(row.key)
    }
    const res = hasConflictResolutions.value.get(row.key)
    if (res) resolutions[row.key] = res
  }
  return { units, resolutions }
}

// ── 执行 ──
async function execute() {
  if (executing.value) return
  if (selectedPeerIds.value.length === 0) {
    message.warning(t('sync.selectPeerFirst'))
    return
  }
  const { units, resolutions } = rowsForDirection()
  // 携密开关开：units 可以为空（纯凭据档同步——换机最小形态）
  if (units.length === 0 && !includeCredentials.value) {
    message.warning(t('sync.nothingSelected'))
    return
  }
  // 携密确认对话框（发起端仪式第一步：人工显式确认才发起）
  if (includeCredentials.value && !(await confirmCredSync())) return
  executing.value = true
  try {
    const firstPeer = selectedPeerIds.value[0] as string
    const ids = direction.value === 'pull' ? [firstPeer] : [...selectedPeerIds.value]
    const body = {
      instanceIds: ids,
      units,
      resolutions,
      includeIgnored: includeIgnored.value,
      includeGit: includeGit.value,
      includeCredentials: includeCredentials.value,
    }
    if (direction.value === 'pull') await syncApi.pull(body)
    else await syncApi.push(body)
    // 配置记忆（方案③）：方向/项目集/上下文集/目标 → uistate
    void persistPrefs()
    message.success(t('sync.started'))
  } catch (e) {
    const err = e as { message?: string; userMessage?: string }
    const msg: string = err?.message || err?.userMessage || ''
    // 首次携密未核对（服务端稳定标记）：走一次性核对仪式后自动重试
    if (includeCredentials.value && /credential sync requires pairing and fingerprint verification/i.test(msg)) {
      executing.value = false
      const ok = await openCredCeremony(selectedPeerIds.value[0] as string)
      if (ok) { await execute() }
      return
    }
    message.error(t('sync.startFailed'))
  } finally {
    executing.value = false
  }
}

// confirmCredSync 携密发起确认（发起端仪式）
function confirmCredSync(): Promise<boolean> {
  return new Promise((resolve) => {
    const peer = selectedPeerIds.value.length === 1
      ? peerNameOf(selectedPeerIds.value[0])
      : t('sync.pushButton', { count: selectedPeerIds.value.length })
    dialog.warning({
      title: t('sync.credConfirmTitle'),
      content: t('sync.credConfirmBody') + '\n' + (direction.value === 'pull'
        ? t('sync.credConfirmPull', { peer })
        : t('sync.credConfirmPush', { peer })),
      positiveText: t('sync.credInclude'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    })
  })
}

// ── 首次携密核对仪式（一次性；证书指纹短码 + 配对指纹双端对表）──
async function openCredCeremony(peerId: string): Promise<boolean> {
  const localRow = pairingOf(peerId)
  const ack = ref(false)
  // 对端侧数据经既有实例代理通道取（certinfo 自报指纹 + 在册配对指纹交叉核对；
  // 本端比对数据源 = pairingStatus 行的 pairFp/peerCertFp，见服务端 GetPairingStatus）
  const peerCert = await instanceFetch<{ data?: { certFp?: string; tls?: boolean } }>(peerId, 'GET', '/sync/credentials/certinfo').catch(() => null)
  const peerPairings = await instanceFetch<{ data?: Array<{ pairFp?: string }> }>(peerId, 'GET', '/sync/pairing').catch(() => null)
  const localPairFp = localRow?.pairFp ?? ''
  const peerHasPairFp = !!(peerPairings?.data ?? []).some(r => r.pairFp && r.pairFp === localPairFp)
  const localPinnedCert = localRow?.peerCertFp ?? ''
  const peerSelfCert = peerCert?.data?.certFp ?? ''
  const peerTls = !!peerCert?.data?.tls
  const certComparable = peerTls && !!localPinnedCert && !!peerSelfCert

  return new Promise((resolve) => {
    const mono = (v: string) => h('span', { style: 'font-family:var(--font-mono);font-size:11px;word-break:break-all;' }, v || '—')
    const row = (label: string, left: string, right: string) => h('div', { style: 'display:flex;flex-direction:column;gap:2px;margin-bottom:8px;' }, [
      h('div', { style: 'font-weight:600;' }, label),
      h('div', { style: 'display:flex;gap:12px;' }, [
        h('div', { style: 'flex:1;' }, [h('div', { style: 'color:var(--text-dim);font-size:10px;' }, t('sync.credCeremonyLocalPairFp')), mono(left)]),
        h('div', { style: 'flex:1;' }, [h('div', { style: 'color:var(--text-dim);font-size:10px;' }, t('sync.credCeremonyPeerPairFp')), mono(right)]),
      ]),
    ])
    const content = h('div', { style: 'font-size:12px;display:flex;flex-direction:column;gap:6px;' }, [
      h('div', null, t('sync.credCeremonyIntro')),
      row(t('sync.credCeremonyPairFp'), localPairFp, peerHasPairFp ? localPairFp : ''),
      certComparable
        ? row(t('sync.credCeremonyCertFp'), localPinnedCert, peerSelfCert)
        : h('div', { style: 'color:var(--accent-orange,#d97706);' },
            peerTls ? t('sync.credCeremonyNoCert') : t('sync.credCeremonyNoTls')),
      h('label', { style: 'display:flex;align-items:center;gap:6px;margin-top:4px;' }, [
        h('input', { type: 'checkbox', onChange: (e: Event) => { ack.value = (e.target as HTMLInputElement).checked } }),
        t('sync.credCeremonyAck'),
      ]),
    ])
    dialog.warning({
      title: t('sync.credCeremonyTitle'),
      content: () => content,
      positiveText: t('sync.credCeremonyConfirm'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        if (!ack.value) {
          message.warning(t('sync.credCeremonyNeedAck'))
          return false
        }
        if (peerTls && !peerHasPairFp) {
          message.error(t('sync.credCeremonyFailed'))
          return false
        }
        if (certComparable && localPinnedCert !== peerSelfCert) {
          message.error(t('sync.credCeremonyFailed'))
          return false
        }
        try {
          await syncCredApi.verify(peerId)
          await loadCredState()
          resolve(true)
        } catch {
          message.error(t('sync.credCeremonyFailed'))
          resolve(false)
        }
      },
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    })
  })
}

// ── 配对管理对话框（生成/录入/解除——与 Token 同屏人工抄录通道）──
function openPairingDialog(peerId: string) {
  const inst = instanceStore.instances.find(i => i.id === peerId)
  const peerName = inst?.name ?? peerId
  const row = pairingOf(peerId)
  const genCode = ref('')
  const genFp = ref(row?.pairFp ?? '')
  const inputCode = ref('')
  const fpText = (fp: string) => (fp ? fp.replace(/^(.{4})(.{4})(.{4})(.{4})/, '$1-$2-$3-$4…') : '')
  dialog.info({
    title: t('sync.credPairTitle') + ' · ' + peerName,
    content: () => h('div', { style: 'font-size:12px;display:flex;flex-direction:column;gap:10px;' }, [
      h('div', { style: 'color:var(--text-dim);' }, t('sync.credPairIntro')),
      h('div', null, t('sync.credPairFp', { fp: fpText(genFp.value || row?.pairFp || '') })),
      genCode.value
        ? h('div', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
            h('div', { style: 'font-weight:600;' }, t('sync.credPairCodeLabel')),
            h('code', { style: 'font-family:var(--font-mono);font-size:11px;word-break:break-all;background:var(--bg-primary);padding:6px;border-radius:4px;border:1px solid var(--border-default);' }, genCode.value),
            h('button', {
              class: 'sync-chip',
              style: 'align-self:flex-start;',
              onClick: async () => {
                await copyText(genCode.value)
                message.success(t('sync.credPairCopied'))
              },
            }, t('sync.credPairCopy')),
          ])
        : h('button', {
            class: 'sync-chip',
            style: 'align-self:flex-start;',
            onClick: async () => {
              try {
                const r = await syncCredApi.generatePairing(peerId)
                genCode.value = r.data?.pairingCode ?? ''
                genFp.value = r.data?.pairFp ?? ''
                await loadCredState()
              } catch { message.error(t('sync.startFailed')) }
            },
          }, genFp.value ? t('sync.credPairRotate') : t('sync.credPairGenerate')),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
        h('span', { style: 'font-weight:600;' }, t('sync.credPairInputLabel')),
        h('input', {
          value: inputCode.value,
          onInput: (e: Event) => { inputCode.value = (e.target as HTMLInputElement).value },
          placeholder: 'xxxxxxxx-…（64 hex）',
          style: DIALOG_INPUT_STYLE + 'font-family:var(--font-mono);',
        }),
      ]),
      h('div', { style: 'display:flex;gap:8px;' }, [
        h('button', {
          class: 'sync-chip',
          onClick: async () => {
            const code = inputCode.value.trim()
            if (!code) return
            try {
              await syncCredApi.setPairing(peerId, code)
              message.success(t('sync.credPairDone'))
              inputCode.value = ''
              genCode.value = ''
              await loadCredState()
              genFp.value = pairingOf(peerId)?.pairFp ?? ''
            } catch (e) {
              const msg: string = (e as { message?: string })?.message || ''
              message.error(/invalid pairing code/i.test(msg) ? t('sync.credPairInvalid') : t('sync.startFailed'))
            }
          },
        }, t('sync.credPairSet')),
        (genFp.value || row?.pairFp)
          ? h('button', {
              class: 'sync-chip',
              style: 'color:var(--accent-red);',
              onClick: async () => {
                try {
                  await syncCredApi.clearPairing(peerId)
                  message.success(t('sync.credPairDone'))
                  genFp.value = ''
                  genCode.value = ''
                  await loadCredState()
                } catch { message.error(t('sync.startFailed')) }
              },
            }, t('sync.credPairClear'))
          : null,
      ]),
    ]),
  })
}

// ── 接收端暂存终审 ──
async function resolveStaged(row: SyncCredStaged, accept: boolean) {
  try {
    const r = await syncCredApi.resolveStaged(row.ticket, accept)
    message.success(accept ? t('sync.credStagedAccepted') + (r.data?.summary ? ' · ' + r.data.summary : '') : t('sync.credStagedRejected'))
  } catch {
    message.error(t('sync.credStagedFailed'))
  }
  await loadCredState()
}

async function rerunLast() {
  const prefs = await uiState.getSyncPrefs()
  if (!prefs || !prefs.direction || !prefs.peers?.length) {
    message.info(t('sync.noLastRun'))
    return
  }
  direction.value = prefs.direction
  selectedPeerIds.value = prefs.peers
  selectedProjectKeys.value = prefs.projects ?? []
  selectedContexts.value = sanitizeContexts(prefs.contexts)
  await execute()
}

function persistPrefs() {
  void uiState.saveSyncPrefs({
    direction: direction.value,
    peers: [...selectedPeerIds.value],
    projects: [...selectedProjectKeys.value],
    contexts: [...selectedContexts.value],
  })
}
const canRerunLast = ref(false)

// ── 进度（WS 广播 + 轮询兜底）──
let stopPoll: ReturnType<typeof setInterval> | null = null

function onProgressEvent(e: Event) {
  const detail = (e as CustomEvent).detail as SyncJobSnapshot | undefined
  if (detail) applySnapshot(detail)
}
function applySnapshot(snap: SyncJobSnapshot) {
  job.value = snap
  if (snap.outcome !== 'running') {
    lastResult.value = snap
    executing.value = false
  }
}

onMounted(async () => {
  await instanceStore.fetchInstances()
  await loadProjects()
  void loadCredState()
  // 配置记忆回放
  const prefs = await uiState.getSyncPrefs()
  if (prefs?.direction) direction.value = prefs.direction
  if (prefs?.peers?.length) selectedPeerIds.value = prefs.peers.filter(id => remoteInstances.value.some(i => i.id === id))
  if (prefs?.projects?.length) selectedProjectKeys.value = prefs.projects
  if (prefs?.contexts?.length) selectedContexts.value = sanitizeContexts(prefs.contexts)
  canRerunLast.value = !!(prefs?.direction && prefs.peers?.length)
  void loadCrons()
  // 进度快照兜底 + WS 广播监听
  try {
    const res = await syncApi.progress()
    if (res.data) applySnapshot(res.data)
  } catch { /* 读面失败静默 */ }
  window.addEventListener(OPS_SYNC_PROGRESS, onProgressEvent as EventListener)
  stopPoll = setInterval(async () => {
    if (job.value?.outcome === 'running') {
      try {
        const res = await syncApi.progress()
        if (res.data) applySnapshot(res.data)
      } catch { /* 轮询失败保旧 */ }
    }
  }, 2000)
})
onUnmounted(() => {
  window.removeEventListener(OPS_SYNC_PROGRESS, onProgressEvent as EventListener)
  if (stopPoll) clearInterval(stopPoll)
})

watch([selectedPeerIds, selectedProjectKeys, selectedContexts, direction], () => {
  plan.value = null
  if (selectedPeerIds.value.length > 0) void loadPlan()
})

// ── 进度呈现（用户补充注记：百分比/字节/速率/剩余时间 + 单元状态机）──
const progressPercent = computed(() => {
  if (!job.value || job.value.totalBytes === 0) return 0
  return Math.min(100, Math.round((job.value.sentBytes / job.value.totalBytes) * 100))
})
const speedText = computed(() =>
  job.value?.speedBytesPerSec ? `${formatBytes(job.value.speedBytesPerSec)}/s` : t('sync.speedPending'),
)
const etaText = computed(() => {
  const eta = job.value?.etaSeconds
  if (!eta || eta <= 0) return ''
  if (eta < 60) return t('sync.etaSec', { n: Math.round(eta) })
  return t('sync.etaMin', { n: Math.round(eta / 60) })
})
const runningUnit = computed(() => job.value?.units.find(u => u.state === 'transferring' || u.state === 'enumerating'))
const resultSummary = computed(() => {
  const r = lastResult.value
  if (!r) return null
  let done = 0, failed = 0, skipped = 0
  for (const u of r.units) {
    if (u.state === 'done') done++
    else if (u.state === 'failed') failed++
    else if (u.state === 'conflict-skipped' || u.state === 'busy-skipped') skipped++
  }
  return { done, failed, skipped }
})

function unitStateLabel(u: SyncUnitProgress): string {
  return t(`sync.unitState.${u.state}`)
}
function unitStateClass(u: SyncUnitProgress): string {
  switch (u.state) {
    case 'done': return 'is-done'
    case 'failed': return 'is-failed'
    case 'conflict-skipped': return 'is-conflict'
    case 'busy-skipped': return 'is-skipped'
    case 'transferring': case 'enumerating': case 'landing': return 'is-active'
    default: return ''
  }
}

const relTime = (iso?: string) => {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return t('time.justNow')
  if (diff < 3_600_000) return t('time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('time.daysAgo', { n: Math.floor(diff / 86_400_000) })
}

// ── 定时同步（方案⑤：清单 + 新建对话框；调度执行在服务端分钟巡检）──
const crons = ref<SyncCron[]>([])

async function loadCrons() {
  try {
    const res = await syncApi.crons()
    crons.value = res.data ?? []
  } catch { /* 读面失败静默（折叠区非关键数据） */ }
}

const { showSidePanel } = usePanelLayout()
// 重开即刷新清单：侧栏容器是 v-show（SidePanel.vue），关闭面板不卸载本组件
// ——onMounted 的 loadCrons 只在首次挂载跑一次，关→开不会重挂。定时任务可经
// API/其他标签页/试跑链变更，重开面板时重拉一次保「所见即最新」
watch(showSidePanel, (open) => {
  if (open) {
    void loadCrons()
    // 携密面同源保鲜：暂存确认/配对变更可发生在通知卡/其他标签页
    void loadCredState()
  }
})

function cronScheduleText(c: SyncCron): string {
  const hh = String(c.hour).padStart(2, '0')
  const mm = String(c.minute).padStart(2, '0')
  return t('sync.cronSchedule', { time: `${hh}:${mm}` })
}

async function toggleCron(c: SyncCron) {
  if (!c.id) return
  try {
    await syncApi.updateCron(c.id, { ...c, enabled: !c.enabled })
    await loadCrons()
  } catch {
    message.error(t('sync.startFailed'))
  }
}

async function deleteCron(c: SyncCron) {
  if (!c.id) return
  try {
    await syncApi.deleteCron(c.id)
    await loadCrons()
  } catch {
    message.error(t('sync.startFailed'))
  }
}

async function runCronNow(c: SyncCron) {
  if (!c.id) return
  try {
    await syncApi.runCron(c.id)
    message.success(t('sync.started'))
  } catch {
    message.error(t('sync.startFailed'))
  }
}

function openCronDialog() {
  const name = ref(t('sync.cronDefaultName'))
  const dir = ref<'pull' | 'push'>(direction.value)
  const hour = ref(3)
  const minute = ref(0)
  const policy = ref<'safe' | 'local-mirror' | 'peer-mirror'>('safe')
  const peers = () => remoteInstances.value.filter(i => i.status === 'online')
  const pickedPeers = ref<string[]>(selectedPeerIds.value.length ? [...selectedPeerIds.value] : [])
  const onlinePeers = peers()
  const firstPeer = onlinePeers[0]?.id
  if (pickedPeers.value.length === 0 && firstPeer) pickedPeers.value = [firstPeer]

  dialog.create({
    title: t('sync.cronNew'),
    content: () => h('div', { style: 'display:flex;flex-direction:column;gap:10px;font-size:12px;' }, [
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
        h('span', null, t('sync.cronNameField')),
        h('input', {
          value: name.value,
          onInput: (e: Event) => { name.value = (e.target as HTMLInputElement).value },
          style: DIALOG_INPUT_STYLE,
        }),
      ]),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
        h('span', null, t('sync.deliverPeer')),
        h('select', {
          multiple: true,
          style: DIALOG_INPUT_STYLE + 'min-height:64px;',
          onChange: (e: Event) => {
            pickedPeers.value = [...(e.target as HTMLSelectElement).selectedOptions].map(o => o.value)
          },
        }, onlinePeers.map(i => h('option', { value: i.id, selected: pickedPeers.value.includes(i.id) }, i.name))),
      ]),
      h('div', { style: 'display:flex;gap:8px;' }, [
        h('label', { style: 'display:flex;flex-direction:column;gap:4px;flex:1;' }, [
          h('span', null, t('sync.cronDirection')),
          h('select', {
            value: dir.value,
            onChange: (e: Event) => { dir.value = (e.target as HTMLSelectElement).value as 'pull' | 'push' },
            style: DIALOG_INPUT_STYLE,
          }, [
            h('option', { value: 'push' }, t('sync.dirPush')),
            h('option', { value: 'pull' }, t('sync.dirPull')),
          ]),
        ]),
        h('label', { style: 'display:flex;flex-direction:column;gap:4px;width:90px;' }, [
          h('span', null, t('sync.cronTime')),
          h('input', {
            type: 'time',
            value: `${String(hour.value).padStart(2, '0')}:${String(minute.value).padStart(2, '0')}`,
            onInput: (e: Event) => {
              const v = (e.target as HTMLInputElement).value.split(':')
              hour.value = Number(v[0] ?? 3)
              minute.value = Number(v[1] ?? 0)
            },
            style: DIALOG_INPUT_STYLE,
          }),
        ]),
      ]),
      h('label', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
        h('span', null, t('sync.cronPolicyLabel')),
        h('select', {
          value: policy.value,
          onChange: (e: Event) => { policy.value = (e.target as HTMLSelectElement).value as 'safe' | 'local-mirror' | 'peer-mirror' },
          style: DIALOG_INPUT_STYLE,
        }, ['safe', 'local-mirror', 'peer-mirror'].map(p =>
          h('option', { value: p }, t('sync.cronPolicy.' + p)),
        )),
      ]),
    ]),
    positiveText: t('sync.cronCreate'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      if (pickedPeers.value.length === 0) {
        message.warning(t('sync.selectPeerFirst'))
        return false
      }
      try {
        await syncApi.createCron({
          name: name.value.trim() || t('sync.cronDefaultName'),
          direction: dir.value,
          peerIds: pickedPeers.value,
          projectKeys: [...selectedProjectKeys.value],
          contexts: [...selectedContexts.value],
          conflictPolicy: policy.value,
          includeIgnored: includeIgnored.value,
          hour: hour.value,
          minute: minute.value,
          enabled: true,
        })
        await loadCrons()
        message.success(t('sync.started'))
      } catch {
        message.error(t('sync.startFailed'))
        return false
      }
      return true
    },
  })
}
</script>

<template>
  <div
    class="sync-panel"
    data-testid="sync-panel"
  >
    <div class="sync-header">
      <span class="sync-title">{{ t('sync.title') }}</span>
      <NButton
        quaternary
        size="tiny"
        :title="t('common.refresh')"
        data-testid="sync-refresh"
        @click="loadProjects()"
      >
        <template #icon>
          <NIcon><RefreshOutline /></NIcon>
        </template>
      </NButton>
    </div>

    <NSpin :show="loading">
      <div class="sync-body">
        <!-- 方向指示器（常驻大指示器：拉/推切换即翻转，按钮文案带方向词） -->
        <div
          class="sync-direction"
          data-testid="sync-direction"
          :class="direction === 'pull' ? 'is-pull' : 'is-push'"
          role="group"
          :aria-label="t('sync.directionAria')"
        >
          <button
            class="sync-dir-btn"
            data-testid="sync-dir-push"
            :class="{ 'is-active': direction === 'push' }"
            @click="direction = 'push'"
          >
            <NIcon size="18">
              <CloudUploadOutline />
            </NIcon>
            <span>{{ t('sync.dirPush') }}</span>
          </button>
          <span class="sync-dir-mid">
            <NIcon size="16">
              <ArrowUpOutline v-if="direction === 'push'" />
              <ArrowDownOutline v-else />
            </NIcon>
            <span class="sync-dir-label">{{ directionLabel }}</span>
          </span>
          <button
            class="sync-dir-btn"
            data-testid="sync-dir-pull"
            :class="{ 'is-active': direction === 'pull' }"
            @click="direction = 'pull'"
          >
            <NIcon size="18">
              <CloudDownloadOutline />
            </NIcon>
            <span>{{ t('sync.dirPull') }}</span>
          </button>
        </div>

        <!-- 实例对选择器（离线目标即时标灰禁用；push 多选） -->
        <section class="sync-section">
          <h3 class="sync-section-title">
            {{ t('sync.peerTitle') }}
          </h3>
          <div
            v-if="remoteInstances.length === 0"
            class="sync-empty"
          >
            {{ t('sync.noInstances') }}
          </div>
          <div
            v-else
            class="sync-peers"
            data-testid="sync-peers"
          >
            <label
              v-for="inst in remoteInstances"
              :key="inst.id"
              class="sync-peer"
              :class="{ 'is-offline': inst.status !== 'online', 'is-checked': selectedPeerIds.includes(inst.id) }"
            >
              <input
                type="checkbox"
                class="sync-peer-check"
                :disabled="inst.status !== 'online'"
                :checked="selectedPeerIds.includes(inst.id)"
                :aria-label="inst.name"
                @change="togglePeer(inst.id)"
              >
              <span class="sync-peer-name">{{ inst.name }}</span>
              <span
                class="sync-peer-status"
                :data-status="inst.status"
              >{{ t(`sync.peerStatus.${inst.status}`) }}</span>
              <button
                class="sync-chip sync-cred-badge"
                :class="{ 'is-on': credReadyOf(inst.id) }"
                data-testid="sync-cred-badge"
                :title="t('sync.credIncludeHint')"
                @click.prevent="openPairingDialog(inst.id)"
              >{{ credBadgeOf(inst.id) }}</button>
            </label>
            <div
              v-for="pid in selectedPeerIds"
              v-show="pairingOf(pid)?.lastCredSyncAt"
              :key="'cred-' + pid"
              class="sync-cred-meta"
            >
              <template v-if="pairingOf(pid)?.lastCredSyncAt">
                {{ t('sync.credLastSync', { time: relTime(pairingOf(pid)!.lastCredSyncAt), dir: pairingOf(pid)!.lastCredDirection === 'pull' ? t('sync.dirPull') : t('sync.dirPush') }) }}
              </template>
            </div>
          </div>
          <label class="sync-peer is-local">
            <span class="sync-peer-name">{{ t('sync.thisMachine') }}</span>
            <span
              class="sync-peer-status"
              data-status="local"
            >{{ direction === 'push' ? t('sync.srcSide') : t('sync.dstSide') }}</span>
          </label>
        </section>

        <!-- 项目卡片列表（多选/全选/搜索/上次同步/重跑上次） -->
        <section class="sync-section">
          <div class="sync-section-head">
            <h3 class="sync-section-title">
              {{ t('sync.projectsTitle') }}
              <span class="sync-count">{{ selectedProjectKeys.length }}/{{ projectCards.length }}</span>
            </h3>
            <NButton
              v-if="canRerunLast"
              quaternary
              size="tiny"
              data-testid="sync-rerun-last"
              @click="rerunLast()"
            >
              <template #icon>
                <NIcon><RefreshOutline /></NIcon>
              </template>
              {{ t('sync.rerunLast') }}
            </NButton>
          </div>
          <div class="sync-toolbar">
            <NInput
              v-model:value="projectSearch"
              size="small"
              :placeholder="t('sync.searchPlaceholder')"
              clearable
              data-testid="sync-search"
            />
            <NCheckbox
              :checked="allSelected"
              @update:checked="toggleAll()"
            >
              {{ t('sync.selectAll') }}
            </NCheckbox>
          </div>
          <div
            class="sync-projects"
            data-testid="sync-projects"
          >
            <label
              v-for="p in visibleProjects"
              :key="p.key"
              class="sync-project"
              :class="{ 'is-checked': selectedProjectKeys.includes(p.key) }"
            >
              <input
                v-model="selectedProjectKeys"
                type="checkbox"
                :value="p.key"
                :aria-label="p.name"
              >
              <span class="sync-project-main">
                <span class="sync-project-name">{{ p.name }}</span>
                <span
                  v-if="p.lastSyncedAt"
                  class="sync-project-meta"
                  :title="t('sync.lastSync', { time: relTime(p.lastSyncedAt), dir: p.lastDirection === 'pull' ? t('sync.dirPull') : t('sync.dirPush') })"
                >
                  <NIcon size="11"><TimeOutline /></NIcon>
                  {{ relTime(p.lastSyncedAt) }}
                  <span
                    class="sync-behind-dot"
                    :title="t('sync.behindHint')"
                  />
                </span>
              </span>
            </label>
            <div
              v-if="visibleProjects.length === 0"
              class="sync-empty"
            >
              {{ t('sync.noProjects') }}
            </div>
          </div>
        </section>

        <!-- 上下文勾选 chips（默认定时任务；笔记单元 P-20261108-3 退役不再列出；全局组合默认关） -->
        <section class="sync-section">
          <h3 class="sync-section-title">
            {{ t('sync.contextTitle') }}
          </h3>
          <div class="sync-chips">
            <button
              v-for="chip in contextChips"
              :key="chip.kind"
              class="sync-chip"
              :class="{ 'is-on': selectedContexts.includes(chip.kind) }"
              :data-testid="`sync-ctx-${chip.kind}`"
              @click="selectedContexts = toggleContext(selectedContexts, chip.kind)"
            >
              {{ chip.label }}
            </button>
            <span class="sync-chip-divider" />
            <button
              v-for="chip in globalChips"
              :key="chip.kind"
              class="sync-chip"
              :class="{ 'is-on': selectedContexts.includes(chip.kind) }"
              :data-testid="`sync-ctx-${chip.kind}`"
              @click="selectedContexts = toggleContext(selectedContexts, chip.kind)"
            >
              {{ chip.label }}
            </button>
          </div>
          <div class="sync-switches">
            <NCheckbox
              :checked="includeIgnored"
              @update:checked="(v: boolean) => includeIgnored = v"
            >
              {{ t('sync.includeIgnored') }}
            </NCheckbox>
            <NCheckbox
              :checked="includeGit"
              @update:checked="(v: boolean) => includeGit = v"
            >
              {{ t('sync.includeGit') }}
            </NCheckbox>
          </div>
          <!-- 手动携密开关（P-20261024-3）：缺省关；勾选走确认+核对仪式，
               定时/自动路径服务端硬拒（红线分层） -->
          <div class="sync-switches sync-cred-switch">
            <NCheckbox
              :checked="includeCredentials"
              data-testid="sync-cred-include"
              @update:checked="(v: boolean) => includeCredentials = v"
            >
              <span
                class="sync-cred-label"
                :title="t('sync.credIncludeHint')"
              >{{ t('sync.credInclude') }}</span>
            </NCheckbox>
          </div>
        </section>

        <!-- 接收端暂存终审（首次接收未核对 → 10min 内人工确认/拒绝） -->
        <section
          v-if="stagedRows.length > 0"
          class="sync-section"
          data-testid="sync-cred-staged"
        >
          <h3 class="sync-section-title">
            {{ t('sync.credStagedTitle') }}
          </h3>
          <div
            v-for="row in stagedRows"
            :key="row.ticket"
            class="sync-cred-staged-row"
          >
            <div class="sync-cred-staged-main">
              <span class="sync-cred-staged-peer">{{ t('sync.credStagedFrom', { peer: row.peerName }) }}</span>
              <span class="sync-cred-staged-meta">{{ row.summary }} · {{ t('sync.credStagedExpires', { time: relTime(row.expiresAt) }) }}</span>
            </div>
            <span class="sync-cred-staged-actions">
              <NButton
                size="tiny"
                type="warning"
                @click="resolveStaged(row, true)"
              >
                {{ t('sync.credStagedAccept') }}
              </NButton>
              <NButton
                size="tiny"
                @click="resolveStaged(row, false)"
              >
                {{ t('sync.credStagedReject') }}
              </NButton>
            </span>
          </div>
        </section>

        <!-- 红线灰显（红线分层说明：自动永不携密，手动走加密通道） -->
        <div
          class="sync-redline"
          data-testid="sync-redline"
        >
          <NIcon size="13">
            <WarningOutline />
          </NIcon>
          <span>{{ t('sync.redlineNote') }}</span>
          <NTooltip
            trigger="hover"
            placement="top"
          >
            <template #trigger>
              <span class="sync-redline-more">{{ t('sync.redlineMore') }}</span>
            </template>
            {{ t('sync.redlineDetail') }}
          </NTooltip>
        </div>

        <!-- plan 预览（四态 + 冲突批量三键裁决） -->
        <section
          v-if="plan && plan.peerOnline && !plan.peerUnsupported"
          class="sync-section"
        >
          <div class="sync-section-head">
            <h3 class="sync-section-title">
              {{ t('sync.planTitle') }}
              <span
                v-if="plan.peerDiskInsufficient"
                class="sync-disk-warn"
              >{{ t('sync.diskInsufficient') }}</span>
            </h3>
            <span class="sync-plan-meta">{{ t('sync.planTotal', { n: selectedRows.length, size: formatBytes(plan.totalBytes) }) }}</span>
          </div>
          <div
            v-if="conflictRows.length > 0"
            class="sync-conflict-bar"
            data-testid="sync-conflict-bar"
          >
            <span>{{ t('sync.conflictCount', { n: conflictRows.length }) }}</span>
            <NButton
              size="tiny"
              @click="resolveAll('local')"
            >
              {{ t('sync.resolveAllLocal') }}
            </NButton>
            <NButton
              size="tiny"
              @click="resolveAll('peer')"
            >
              {{ t('sync.resolveAllPeer') }}
            </NButton>
            <NButton
              size="tiny"
              @click="resolveAll('skip')"
            >
              {{ t('sync.resolveAllSkip') }}
            </NButton>
          </div>
          <div
            class="sync-plan"
            data-testid="sync-plan"
          >
            <!-- retired 行（P-20261108-3）：旧对端仍带的笔记单元——显式成行标红、
                 勾选禁用（知情不执行，不留静默半态） -->
            <label
              v-for="row in actionRows"
              :key="row.key"
              class="sync-plan-row"
              :class="{ 'is-conflict': row.state === 'conflict', 'is-retired': row.state === 'retired' }"
              :title="row.state === 'retired' ? t('sync.retiredHint') : undefined"
              :data-testid="row.state === 'retired' ? 'sync-plan-retired' : undefined"
            >
              <input
                type="checkbox"
                :checked="row.selected"
                :disabled="row.state === 'retired'"
                @change="setRowSelected(row, !row.selected)"
              >
              <span
                class="sync-plan-state"
                :data-state="row.state"
              >{{ t(`sync.state.${row.state}`) }}</span>
              <span class="sync-plan-name">{{ row.name }}</span>
              <span class="sync-plan-kind">{{ t(`sync.kind.${row.kind}`, row.kind) }}</span>
              <span class="sync-plan-size">{{ formatBytes(row.size) }}</span>
              <span
                v-if="row.state === 'conflict'"
                class="sync-plan-resolve"
              >
                <button
                  class="sync-resolve-btn"
                  :title="t('sync.resolveLocalHint')"
                  @click.prevent="resolveOne(row, 'local')"
                >{{ t('sync.resolveLocal') }}</button>
                <button
                  class="sync-resolve-btn"
                  :title="t('sync.resolvePeerHint')"
                  @click.prevent="resolveOne(row, 'peer')"
                >{{ t('sync.resolvePeer') }}</button>
                <button
                  class="sync-resolve-btn"
                  @click.prevent="resolveOne(row, 'skip')"
                >{{ t('sync.resolveSkip') }}</button>
              </span>
              <span
                v-if="row.gitBothChanged"
                class="sync-plan-gitwarn"
                :title="t('sync.gitBothHint')"
              >git</span>
            </label>
          </div>
        </section>

        <!-- 执行按钮（永远带方向词） -->
        <button
          class="sync-execute"
          :class="direction === 'pull' ? 'is-pull' : 'is-push'"
          :disabled="executing || selectedPeerIds.length === 0"
          data-testid="sync-execute"
          @click="execute()"
        >
          <NIcon size="16">
            <CloudDownloadOutline v-if="direction === 'pull'" />
            <CloudUploadOutline v-else />
          </NIcon>
          {{ mainButtonLabel }}
        </button>

        <!-- 进度体系（总进度条 + 单元状态机 + 结果卡） -->
        <section
          v-if="job"
          class="sync-progress"
          data-testid="sync-progress"
        >
          <div class="sync-progress-head">
            <span>{{ t('sync.progressTitle', { peer: job.peerName }) }}</span>
            <span
              v-if="job.outcome === 'running'"
              class="sync-progress-live"
            >{{ progressPercent }}%</span>
          </div>
          <div class="sync-progress-bar">
            <div
              class="sync-progress-fill"
              :style="{ width: progressPercent + '%' }"
            />
          </div>
          <div class="sync-progress-stats">
            <span>{{ formatBytes(job.sentBytes) }} / {{ formatBytes(job.totalBytes) }}</span>
            <span>{{ speedText }}</span>
            <span
              v-if="etaText"
            >{{ t('sync.etaPrefix') }}{{ etaText }}</span>
          </div>
          <div
            v-if="runningUnit"
            class="sync-progress-current"
          >
            {{ t('sync.currentFile', { name: runningUnit.current || runningUnit.name }) }}
          </div>
          <div
            v-if="job.outcome === 'running' && !runningUnit && progressPercent === 0"
            class="sync-progress-enumerating"
          >
            {{ t('sync.enumerating') }}
          </div>
          <ul class="sync-units">
            <li
              v-for="u in job.units"
              :key="u.key"
              class="sync-unit"
              :class="unitStateClass(u)"
            >
              <span class="sync-unit-state">{{ unitStateLabel(u) }}</span>
              <span class="sync-unit-name">{{ u.name || u.key }}</span>
              <span
                v-if="u.error"
                class="sync-unit-error"
                :title="u.error"
              >{{ u.error }}</span>
            </li>
          </ul>
          <div
            v-if="resultSummary && job.outcome !== 'running'"
            class="sync-result"
            data-testid="sync-result"
          >
            <NIcon
              size="14"
              :color="job.outcome === 'done' ? 'var(--accent-green)' : 'var(--accent-orange)'"
            >
              <CheckmarkCircleOutline v-if="job.outcome === 'done'" /><CloseCircleOutline v-else />
            </NIcon>
            <span>{{ t('sync.resultSummary', { done: resultSummary.done, failed: resultSummary.failed, skipped: resultSummary.skipped }) }}</span>
            <span class="sync-result-meta">{{ formatBytes(job.sentBytes) }} · {{ speedText }}</span>
          </div>
        </section>

        <!-- 定时同步（折叠区：清单 + 新建；方案⑤） -->
        <section class="sync-section">
          <div class="sync-section-head">
            <button
              class="sync-cron-toggle"
              data-testid="sync-cron-toggle"
              @click="cronSectionOpen = !cronSectionOpen"
            >
              <NIcon size="13">
                <TimeOutline />
              </NIcon>
              {{ t('sync.cronTitle') }}
              <span
                v-if="crons.length"
                class="sync-count"
              >{{ crons.length }}</span>
            </button>
            <NButton
              v-if="cronSectionOpen"
              quaternary
              size="tiny"
              data-testid="sync-cron-new"
              @click="openCronDialog()"
            >
              {{ t('sync.cronNew') }}
            </NButton>
          </div>
          <div
            v-if="cronSectionOpen"
            class="sync-crons"
            data-testid="sync-crons"
          >
            <div
              v-for="c in crons"
              :key="c.id"
              class="sync-cron-row"
            >
              <span
                class="sync-cron-name"
                :title="c.lastNote || c.name"
              >{{ c.name }}</span>
              <span class="sync-cron-meta">{{ cronScheduleText(c) }}</span>
              <span
                class="sync-cron-policy"
                :title="t('sync.cronPolicy.' + (c.conflictPolicy || 'safe'))"
              >{{ t('sync.cronPolicy.' + (c.conflictPolicy || 'safe')) }}</span>
              <button
                class="sync-resolve-btn"
                :title="t('sync.cronRunNow')"
                @click="runCronNow(c)"
              >
                ▶
              </button>
              <button
                class="sync-resolve-btn"
                :class="{ 'is-off': !c.enabled }"
                :title="c.enabled ? t('sync.cronDisable') : t('sync.cronEnable')"
                @click="toggleCron(c)"
              >
                {{ c.enabled ? 'ON' : 'OFF' }}
              </button>
              <button
                class="sync-resolve-btn"
                :title="t('common.delete')"
                @click="deleteCron(c)"
              >
                ✕
              </button>
            </div>
            <div
              v-if="crons.length === 0"
              class="sync-empty"
            >
              {{ t('sync.cronEmpty') }}
            </div>
          </div>
        </section>
      </div>
    </NSpin>
  </div>
</template>

<style scoped>
/* 主题适配：全部走既有主题变量（--sc-* / color-mix），禁硬编码色 */
.sync-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.sync-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px 4px;
}
.sync-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}
.sync-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sync-direction {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 6px;
  align-items: center;
  padding: 6px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface);
}
.sync-dir-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 6px 4px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 11px;
}
.sync-dir-btn.is-active {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
}
.sync-dir-mid {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  color: var(--text-secondary);
}
.sync-dir-label {
  font-size: 10px;
  white-space: nowrap;
}
.sync-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sync-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.sync-section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: none;
}
.sync-count {
  color: var(--text-muted);
  font-weight: 400;
}
.sync-peers,
.sync-projects {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow-y: auto;
}
.sync-peer,
.sync-project {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}
.sync-peer:hover,
.sync-project:hover {
  background: color-mix(in srgb, var(--brand-accent) 6%, transparent);
}
.sync-peer.is-offline {
  opacity: 0.45;
  cursor: not-allowed;
}
.sync-peer.is-local {
  cursor: default;
  color: var(--text-muted);
}
.sync-peer-name,
.sync-project-name {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-peer-status {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
}
.sync-peer-status[data-status='online'] {
  color: var(--accent-green, #18a058);
}
.sync-peer-status[data-status='offline'] {
  color: var(--text-muted);
}
.sync-project-main {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.sync-project-meta {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
}
.sync-behind-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-orange, #f0a020);
  display: none;
}
.sync-project-meta .sync-behind-dot {
  display: inline-block;
}
.sync-empty {
  font-size: 11px;
  color: var(--text-muted);
  padding: 4px 2px;
}
.sync-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sync-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.sync-chip {
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 10px;
  border: 1px solid var(--border-default);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}
.sync-chip.is-on {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
}
.sync-chip-divider {
  width: 1px;
  height: 14px;
  background: var(--border-default);
}
.sync-switches {
  display: flex;
  gap: 14px;
  font-size: 12px;
}
/* 手动携密面（P-20261024-3）：配对徽章/携密开关/暂存卡——警示色系与红线一致 */
.sync-cred-switch {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border-default);
}
.sync-cred-label {
  color: var(--accent-orange, #f0a020);
  font-weight: 600;
}
.sync-cred-badge {
  margin-left: auto;
  font-size: 10px;
  padding: 0 5px;
  cursor: pointer;
}
.sync-cred-badge.is-on {
  border-color: var(--accent-green);
  color: var(--accent-green);
}
.sync-cred-meta {
  font-size: 10px;
  color: var(--text-dim);
  padding-left: 22px;
}
.sync-cred-staged-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--accent-orange, #f0a020) 35%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent-orange, #f0a020) 6%, transparent);
}
.sync-cred-staged-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.sync-cred-staged-peer {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-primary);
}
.sync-cred-staged-meta {
  font-size: 10px;
  color: var(--text-dim);
  word-break: break-all;
}
.sync-cred-staged-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.sync-redline {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent-orange, #f0a020) 8%, transparent);
  color: var(--text-secondary);
  font-size: 11px;
}
.sync-redline-more {
  margin-left: auto;
  color: var(--brand-accent);
  cursor: help;
  white-space: nowrap;
}
.sync-conflict-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--accent-orange, #f0a020);
}
.sync-plan {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 200px;
  overflow-y: auto;
}
.sync-plan-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  padding: 3px 4px;
  border-radius: 4px;
}
.sync-plan-row.is-conflict {
  background: color-mix(in srgb, var(--accent-orange, #f0a020) 12%, transparent);
}
.sync-plan-state {
  flex-shrink: 0;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-hover);
}
.sync-plan-state[data-state='conflict'] {
  color: var(--accent-orange, #f0a020);
}
.sync-plan-state[data-state='new'] {
  color: var(--brand-accent);
}
/* 退役单元（P-20261108-3）：对账红点——笔记不再随实例同步，行降透明度 + 状态红字 */
.sync-plan-row.is-retired {
  opacity: 0.75;
}
.sync-plan-state[data-state='retired'] {
  color: var(--accent-red);
}
.sync-plan-name {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.sync-plan-kind {
  color: var(--text-muted);
  flex-shrink: 0;
}
.sync-plan-size {
  margin-left: auto;
  color: var(--text-muted);
  flex-shrink: 0;
}
.sync-plan-resolve {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}
.sync-resolve-btn {
  font-size: 10px;
  padding: 1px 5px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}
.sync-plan-gitwarn {
  font-size: 10px;
  color: var(--accent-orange, #f0a020);
  flex-shrink: 0;
  cursor: help;
}
.sync-disk-warn {
  color: var(--accent-red, #d03050);
  font-weight: 400;
}
.sync-plan-meta {
  font-size: 11px;
  color: var(--text-muted);
}
.sync-execute {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px;
  border: none;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  /* 主色上的对比文字：主题「on-primary」语义变量（既有按钮面同源），不走字面色 */
  color: var(--text-on-accent, var(--bg-primary));
  background: var(--brand-accent);
  cursor: pointer;
}
.sync-execute.is-pull {
  background: var(--accent-blue, #2080f0);
}
.sync-execute:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.sync-progress {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 8px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
}
.sync-progress-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-secondary);
}
.sync-progress-live {
  color: var(--brand-accent);
  font-weight: 600;
}
.sync-progress-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-hover);
  overflow: hidden;
}
.sync-progress-fill {
  height: 100%;
  background: var(--brand-accent);
  /* 进度条 width 跟手（功能性：与传输字节节奏同步，VersionPanel 进度条同款豁免语义） */
  transition: width var(--motion-base) ease;
}
.sync-progress-stats {
  display: flex;
  gap: 12px;
  font-size: 10px;
  color: var(--text-muted);
}
.sync-progress-current,
.sync-progress-enumerating {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-units {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 140px;
  overflow-y: auto;
}
.sync-unit {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.sync-unit-state {
  flex-shrink: 0;
  color: var(--text-muted);
}
.sync-unit.is-done .sync-unit-state { color: var(--accent-green, #18a058); }
.sync-unit.is-failed .sync-unit-state { color: var(--accent-red, #d03050); }
.sync-unit.is-conflict .sync-unit-state { color: var(--accent-orange, #f0a020); }
.sync-unit.is-active .sync-unit-state { color: var(--brand-accent); }
.sync-unit-name {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-unit-error {
  margin-left: auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent-red, #d03050);
  font-size: 10px;
}
.sync-result {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-secondary);
}
.sync-result-meta {
  margin-left: auto;
  color: var(--text-muted);
}
.sync-cron-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 6px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--text-secondary);
  font-size: 11px;
  cursor: pointer;
}
.sync-cron-toggle:hover {
  background: color-mix(in srgb, var(--brand-accent) 6%, transparent);
}
.sync-cron-note {
  font-size: 11px;
  color: var(--text-muted);
  padding: 0 6px;
}
</style>
