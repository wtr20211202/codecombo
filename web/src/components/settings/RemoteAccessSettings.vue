<script setup lang="ts">
// 远程接入（SSH 反向隧道，P-20261019-11）：用户自带 VPS 中继的任意网络访问。
// 形态 = 多档案 + 单活 + 一键切换；公网 URL 复制 + 二维码；预检结果逐步展示。
// 档案 CRUD 走 settingsApi（password 永不回参，编辑留空保持原密码）；
// 启停/切换走 remoteAccessApi.control（服务端同步持久化 enabled/activeId）。
// 状态卡/编辑器拆子组件（单文件上限），本组件持状态、轮询与动作编排。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NAlert, NButton, NSpin, useDialog, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { openSettingsTab } from '../../utils/openSettings'
import { sshKeyApi, type SshKey } from '../../api/client'
import {
  remoteAccessApi, settingsApi,
  type RemoteAccessProfileInput, type RemoteAccessProfileView,
  type RemoteAccessProbeResult, type RemoteAccessStatus,
} from '../../api/client'
import RemoteAccessStatusCard from './RemoteAccessStatusCard.vue'
import RemoteAccessProfileList from './RemoteAccessProfileList.vue'
import RemoteAccessProfileEditor from './RemoteAccessProfileEditor.vue'
import {
  emptyRemoteAccessEditor, remoteAccessEditorInput,
  type RemoteAccessEditorState,
} from './remoteAccessEditor'

const props = defineProps<{ show: boolean; paneActive?: boolean }>()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const status = ref<RemoteAccessStatus | null>(null)
const profiles = ref<RemoteAccessProfileView[]>([])
const sshKeys = ref<SshKey[]>([])
const probe = ref<RemoteAccessProbeResult | null>(null)
const probeURL = ref('')
const showQR = ref(false)
const editor = ref<RemoteAccessEditorState | null>(null)

const running = computed(() => status.value?.state === 'online' || status.value?.state === 'reconnecting')
const stateType = computed<'default' | 'success' | 'warning' | 'error'>(() => {
  switch (status.value?.state) {
    case 'online': return 'success'
    case 'reconnecting':
    case 'connecting': return 'warning'
    case 'failed': return 'error'
    default: return 'default'
  }
})
const stateLabel = computed(() => t(`remoteAccess.state.${status.value?.state || 'stopped'}`))

// 低频轮询保鲜（状态机断线重连期间 UI 可见）；事件到达即时刷新
let pollTimer: ReturnType<typeof setInterval> | null = null
let eventTimer: ReturnType<typeof setTimeout> | null = null

async function refreshStatus() {
  try {
    const res: any = await remoteAccessApi.status({ silent: true })
    status.value = res?.data || null
  } catch { /* 锁定/网络失败静默，下次轮询自愈 */ }
}

async function load() {
  loading.value = true
  try {
    const [settingsRes, keyRes]: any[] = await Promise.all([
      settingsApi.get({ silent: true }),
      sshKeyApi.list(),
    ])
    const ra = settingsRes?.data?.remoteAccess
    profiles.value = ra?.profiles || []
    sshKeys.value = keyRes?.data || []
    await refreshStatus()
  } finally {
    loading.value = false
  }
}

function onOpsStatus() {
  if (eventTimer) return
  eventTimer = setTimeout(() => {
    eventTimer = null
    void refreshStatus()
  }, 300)
}

onMounted(() => {
  window.addEventListener('sc-ops:remoteaccess.status', onOpsStatus)
  if (props.show) void load()
})
onBeforeUnmount(() => {
  window.removeEventListener('sc-ops:remoteaccess.status', onOpsStatus)
  if (eventTimer) clearTimeout(eventTimer)
  stopPolling()
})
watch(() => props.show, (v) => {
  if (v) {
    void load()
  } else {
    stopPolling()
    editor.value = null
    probe.value = null
    showQR.value = false
  }
})
watch(() => props.paneActive, () => { if (props.show) syncPolling() }, { immediate: true })
watch(() => props.show, syncPolling)

function syncPolling() {
  const active = props.show && (props.paneActive ?? true)
  if (active && !pollTimer) {
    pollTimer = setInterval(() => { void refreshStatus() }, 10000)
  } else if (!active) {
    stopPolling()
  }
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function openCreate() {
  editor.value = emptyRemoteAccessEditor()
  probe.value = null
  showQR.value = false
}

function openEdit(p: RemoteAccessProfileView) {
  editor.value = {
    id: p.id, name: p.name, host: p.host, port: p.port || 22, user: p.user,
    authType: p.authType === 'sshkey' ? 'sshkey' : 'password',
    sshKeyId: p.sshKeyId || '', password: '', hasPassword: !!p.hasPassword,
    remoteBindHost: p.remoteBindHost || '0.0.0.0', remotePort: p.remotePort || 22022,
    domain: p.domain || '',
  }
  probe.value = null
  showQR.value = false
}

function validateEditor(e: RemoteAccessEditorState): string {
  if (!e.name.trim() || !e.host.trim() || !e.user.trim()) return t('remoteAccess.profiles.required')
  if (!e.port || e.port < 1 || e.port > 65535) return t('remoteAccess.profiles.portInvalid')
  if (!e.remotePort || e.remotePort < 1 || e.remotePort > 65535) return t('remoteAccess.profiles.portInvalid')
  if (e.authType === 'sshkey' && !e.sshKeyId) return t('remoteAccess.profiles.sshKeyRequired')
  // 新建/从 sshkey 切到 password 时没有可保留的旧密文，必须输入
  if (e.authType === 'password' && !e.password && !e.hasPassword) return t('remoteAccess.profiles.passwordRequired')
  return ''
}

function profileInputs(excludeID = ''): RemoteAccessProfileInput[] {
  return profiles.value
    .filter(p => p.id !== excludeID)
    .map(p => ({
      id: p.id, name: p.name, host: p.host, port: p.port, user: p.user,
      authType: p.authType, sshKeyId: p.sshKeyId || undefined,
      remoteBindHost: p.remoteBindHost, remotePort: p.remotePort, domain: p.domain || '',
    }))
}

async function saveProfile(state: RemoteAccessEditorState) {
  if (saving.value) return
  const invalid = validateEditor(state)
  if (invalid) { message.error(invalid); return }
  saving.value = true
  try {
    const input = remoteAccessEditorInput(state)
    const list = profileInputs()
    const i = list.findIndex(p => p.id === state.id)
    if (i >= 0) list[i] = input
    else list.push(input)
    await settingsApi.update({ remoteAccess: { profiles: list } })
    message.success(t('remoteAccess.profiles.saved'))
    editor.value = null
    await load()
  } catch (err: any) {
    message.error(err?.userMessage || err?.message || t('remoteAccess.profiles.saveFailed'))
  } finally {
    saving.value = false
  }
}

function deleteProfile(p: RemoteAccessProfileView) {
  const isActive = p.id === (status.value?.activeId || '')
  const doDelete = async () => {
    if (isActive && running.value) {
      await stopTunnel(true)
    }
    try {
      await settingsApi.update({ remoteAccess: { profiles: profileInputs(p.id) } })
      message.success(t('remoteAccess.profiles.deleted'))
      await load()
    } catch (err: any) {
      message.error(err?.userMessage || err?.message || t('remoteAccess.profiles.saveFailed'))
    }
  }
  dialog.warning({
    title: t('remoteAccess.profiles.delete'),
    content: isActive && running.value
      ? t('remoteAccess.profiles.deleteActiveConfirm', { name: p.name })
      : t('remoteAccess.profiles.deleteConfirm', { name: p.name }),
    positiveText: t('remoteAccess.profiles.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => { void doDelete() },
  })
}

async function testProfile(state: RemoteAccessEditorState) {
  if (testing.value) return
  const invalid = validateEditor(state)
  if (invalid) { message.error(invalid); return }
  testing.value = true
  probe.value = null
  probeURL.value = ''
  try {
    const res: any = await remoteAccessApi.test({ profile: remoteAccessEditorInput(state) })
    probe.value = res?.data || null
    probeURL.value = res?.publicUrl || ''
  } catch (err: any) {
    message.error(err?.userMessage || err?.message || t('remoteAccess.test.fail'))
  } finally {
    testing.value = false
  }
}

function requestStart(profileId?: string) {
  const s = status.value
  if (!s?.lockReady) {
    message.error(t('remoteAccess.status.lockRequired') + (s?.lockReason ? ` (${s.lockReason})` : ''))
    return
  }
  if (!s.tlsEnabled) {
    dialog.warning({
      title: t('remoteAccess.status.tlsConfirmTitle'),
      content: t('remoteAccess.status.tlsConfirm'),
      positiveText: t('remoteAccess.status.tlsConfirmAction'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => { void startTunnel(profileId, true) },
    })
    return
  }
  void startTunnel(profileId, false)
}

async function startTunnel(profileId?: string, confirmInsecureTls = false) {
  try {
    await remoteAccessApi.control({ action: 'start', profileId, confirmInsecureTls })
    message.success(t('remoteAccess.status.startOk'))
    await refreshStatus()
  } catch (err: any) {
    message.error(err?.userMessage || err?.message || t('remoteAccess.status.failed'))
    await refreshStatus()
  }
}

async function stopTunnel(silent = false) {
  try {
    await remoteAccessApi.control({ action: 'stop' })
    if (!silent) message.success(t('remoteAccess.status.stopOk'))
    await refreshStatus()
  } catch (err: any) {
    message.error(err?.userMessage || err?.message || t('remoteAccess.status.failed'))
  }
}

// 重连中「立即重连」：Start 对同档案是幂等复用（不打断在途退避），
// 强制立即重试 = 停 → 起（服务端 start/stop 持久化 enabled 位随之翻转）
async function reconnectNow() {
  const id = status.value?.activeId
  if (!id) return
  await stopTunnel(true)
  requestStart(id)
}

function switchTo(p: RemoteAccessProfileView) {
  if (p.id === status.value?.activeId && running.value) return
  dialog.warning({
    title: t('remoteAccess.profiles.activate'),
    content: t('remoteAccess.status.switchConfirm', { name: p.name }),
    positiveText: t('remoteAccess.status.switchAction'),
    negativeText: t('common.cancel'),
    onPositiveClick: () => { requestStart(p.id) },
  })
}

async function copyPublicURL() {
  const url = status.value?.publicUrl
  if (!url) return
  if (await copyText(url)) message.success(t('remoteAccess.status.copied'))
}

function resetHostKey() {
  const id = status.value?.activeId
  if (!id) return
  dialog.warning({
    title: t('remoteAccess.status.resetHostKey'),
    content: t('remoteAccess.status.resetConfirm'),
    positiveText: t('remoteAccess.status.resetHostKey'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await remoteAccessApi.resetHostKey(id)
        message.success(t('remoteAccess.status.resetDone'))
        await refreshStatus()
      } catch (err: any) {
        message.error(err?.userMessage || err?.message || t('remoteAccess.status.failed'))
      }
    },
  })
}
</script>

<template>
  <div
    class="remote-access-settings"
    data-testid="settings-pane-remoteaccess-content"
  >
    <NSpin :show="loading">
      <!-- 安全门槛（红字/警示）：未启用锁定拒绝启用；TLS 未启用强警示 -->
      <NAlert
        v-if="status && !status.lockReady"
        type="error"
        :show-icon="true"
        class="ra-alert"
        data-testid="settings-remote-access-gate-lock"
      >
        {{ t('remoteAccess.gate.lockOff') }}
        <span
          v-if="status.lockReason"
          class="ra-muted"
        >({{ status.lockReason }})</span>
        <NButton
          text
          type="primary"
          class="ra-inline-btn"
          @click="openSettingsTab('security')"
        >
          {{ t('remoteAccess.gate.goSecurity') }}
        </NButton>
      </NAlert>
      <NAlert
        v-if="status && !status.tlsEnabled"
        type="warning"
        :show-icon="true"
        class="ra-alert"
        data-testid="settings-remote-access-gate-tls"
      >
        {{ t('remoteAccess.gate.tlsOff') }}
      </NAlert>
      <NAlert
        v-if="status && status.lockReady && status.lockDefaultPassword"
        type="warning"
        :show-icon="true"
        class="ra-alert"
      >
        {{ t('remoteAccess.gate.defaultPassword') }}
      </NAlert>

      <RemoteAccessStatusCard
        :status="status"
        :running="running"
        :state-type="stateType"
        :state-label="stateLabel"
        :show-qr="showQR"
        @start="requestStart()"
        @stop="stopTunnel()"
        @copy="copyPublicURL"
        @toggle-qr="showQR = !showQR"
        @reset-hostkey="resetHostKey"
        @reconnect="reconnectNow"
      />

      <RemoteAccessProfileList
        :profiles="profiles"
        :active-id="status?.activeId || ''"
        :running="running"
        @add="openCreate"
        @edit="openEdit"
        @delete="deleteProfile"
        @activate="switchTo"
      />

      <RemoteAccessProfileEditor
        v-if="editor"
        :editor="editor"
        :ssh-keys="sshKeys"
        :testing="testing"
        :saving="saving"
        :probe="probe"
        :probe-url="probeURL"
        @save="saveProfile"
        @test="testProfile"
        @cancel="editor = null; probe = null"
      />
    </NSpin>
  </div>
</template>

<style scoped>
.remote-access-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ra-alert {
  margin: 0;
}
.ra-inline-btn {
  margin-left: 6px;
}
.ra-muted {
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
