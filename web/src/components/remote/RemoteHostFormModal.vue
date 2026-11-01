<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import {
  NModal, NForm, NFormItem, NInput, NInputNumber, NSelect, NGrid, NGridItem,
  NButton, NSpace, NSwitch, NPopconfirm, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useRemoteHostStore } from '../../stores/remoteHost'
import { remoteHostApi, sshKeyApi, type SshKey, type RemoteHostAuthType, type RemoteHost, type RemoteHostKeyPin } from '../../api/client'
import { friendlyRemoteError } from '../../utils/remoteErrors'

/**
 * 远程主机编辑弹窗（设置页与远程控制台共用）：
 * host=null 为新建，否则编辑既有主机；密码/PEM 留空表示保持原凭据。
 * 协议选择（sftp/ftp）：FTP 仅文件管理能力（无终端/部署），认证固定密码。
 * SSH 主机另含 TOFU 主机密钥校验分区（P-20261003-34）：开关 + 已钉扎指纹
 * 展示 + 重置入口（合法迁移场景；重置动作入审计与通知中心）。
 */
const props = defineProps<{
  show: boolean
  /** 编辑目标；null = 新建 */
  host: RemoteHost | null
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'saved', host: RemoteHost): void
}>()

const { t } = useI18n()
const message = useMessage()
const remoteHostStore = useRemoteHostStore()

const saving = ref(false)
const sshKeys = ref<SshKey[]>([])

const formName = ref('')
const formHost = ref('')
const formPort = ref(22)
const formUser = ref('root')
const formProtocol = ref<'sftp' | 'ftp'>('sftp')
const formAuthType = ref<RemoteHostAuthType>('password')
const formPassword = ref('')
const formSshKeyId = ref<string | null>(null)
const formPemContent = ref('')

const isFTP = computed(() => formProtocol.value === 'ftp')

// ============== SSH 主机密钥 TOFU（P-20261003-34） ==============
const formDisableVerify = ref(false) // true = 关闭校验（内网完全信任场景）
const hostKeyPin = ref<RemoteHostKeyPin | null>(null)
const hostKeyLoading = ref(false)
const resettingHostKey = ref(false)

async function fetchHostKeyPin() {
  if (!props.host || isFTP.value) {
    hostKeyPin.value = null
    return
  }
  hostKeyLoading.value = true
  try {
    const res = await remoteHostApi.hostKey(props.host.id)
    hostKeyPin.value = (res as unknown as { data?: RemoteHostKeyPin }).data || { pinned: false }
  } catch { /* 指纹读取失败不阻塞编辑流；展示为未知态 */ hostKeyPin.value = null }
  finally { hostKeyLoading.value = false }
}

async function resetHostKey() {
  if (!props.host) return
  resettingHostKey.value = true
  try {
    await remoteHostApi.resetHostKey(props.host.id)
    hostKeyPin.value = { pinned: false }
    message.success(t('deploy.host.hostkey.resetOk'))
  } catch (e: any) {
    message.error(e?.userMessage || t('deploy.host.hostkey.resetFailed'))
  } finally {
    resettingHostKey.value = false
  }
}

// 校验开关正向语义（开 = 启用 TOFU 校验）；落库字段是反向的 hostKeyVerifyDisabled
const hostVerifyOn = computed({
  get: () => !formDisableVerify.value,
  set: (v: boolean) => { formDisableVerify.value = !v },
})

const protocolOptions = computed(() => [
  { label: t('deploy.host.protocol.sftp'), value: 'sftp' },
  { label: t('deploy.host.protocol.ftp'), value: 'ftp' },
])
const authTypeOptions = computed(() => [
  { label: t('deploy.authType.password'), value: 'password' },
  { label: t('deploy.authType.sshkey'), value: 'sshkey' },
  { label: t('deploy.authType.pem'), value: 'pem' },
])
const sshKeyOptions = computed(() =>
  sshKeys.value.map(k => ({ label: `${k.name} (${k.fingerprint.substring(0, 12)}...)`, value: k.id })),
)

async function fetchSshKeys() {
  try {
    const res = await sshKeyApi.list()
    sshKeys.value = (res as any).data || []
  } catch { /* silent */ }
}

// 切协议时若端口还是另一协议的默认值则跟随切换（用户手填过的不动）
function onProtocolChange(p: 'sftp' | 'ftp') {
  if (formPort.value === 21 || formPort.value === 22) {
    formPort.value = p === 'ftp' ? 21 : 22
  }
}

// 每次打开时重置表单（编辑时回填；密码/PEM 不回填明文，留空 = 保持原值）
watch(() => props.show, (v) => {
  if (!v) return
  const h = props.host
  formName.value = h?.name || ''
  formHost.value = h?.host || ''
  formProtocol.value = h?.protocol === 'ftp' ? 'ftp' : 'sftp'
  formPort.value = h?.port || (formProtocol.value === 'ftp' ? 21 : 22)
  formUser.value = h?.user || 'root'
  formAuthType.value = h?.authType || 'password'
  formPassword.value = ''
  formSshKeyId.value = h?.sshKeyId || null
  formPemContent.value = ''
  formDisableVerify.value = h?.hostKeyVerifyDisabled ?? false
  void fetchSshKeys()
  void fetchHostKeyPin()
})

async function save() {
  if (!formName.value.trim() || !formHost.value.trim() || !formUser.value.trim()) {
    message.warning(t('deploy.host.form.required'))
    return
  }
  saving.value = true
  try {
    const payload: any = {
      name: formName.value.trim(),
      host: formHost.value.trim(),
      port: formPort.value,
      user: formUser.value.trim(),
      protocol: formProtocol.value,
      authType: isFTP.value ? 'password' : formAuthType.value,
    }
    if (formPassword.value) payload.password = formPassword.value
    if (!isFTP.value && formAuthType.value === 'sshkey' && formSshKeyId.value) payload.sshKeyId = formSshKeyId.value
    if (!isFTP.value && formAuthType.value === 'pem' && formPemContent.value) payload.pemContent = formPemContent.value
    // 布尔开关无条件随表单提交（update 走 *bool 语义：缺席 = 不改）
    payload.hostKeyVerifyDisabled = !isFTP.value && formDisableVerify.value

    let saved: RemoteHost | undefined
    if (props.host) {
      await remoteHostStore.update(props.host.id, payload)
      saved = remoteHostStore.hosts.find(x => x.id === props.host!.id)
    } else {
      saved = await remoteHostStore.create(payload)
    }
    message.success(t('deploy.host.saved'))
    emit('update:show', false)
    if (saved) emit('saved', saved)
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

// ============== 测试连接（保存前验证连通性） ==============
// 统一走表单参数直测；编辑时附 id，密码/密钥留空 = 「保持原值」由服务端回填已存凭据
// （与保存语义一致）——复制主机改 IP、编辑改端口后再测试不再误报 password is empty；
// 新建无 id，凭据留空按空测（新主机本就无凭据可沿用）
const testing = ref(false)

async function testConnection() {
  if (!formHost.value.trim() || !formUser.value.trim()) {
    message.warning(t('deploy.host.form.required'))
    return
  }
  testing.value = true
  try {
    // 响应拦截器直接返回 body；测试端点应答即 { ok, whoami, os, arch, error }（无 data 包装）
    const res = await remoteHostApi.testParams({
      id: props.host?.id || undefined,
      host: formHost.value.trim(),
      port: formPort.value,
      user: formUser.value.trim(),
      protocol: formProtocol.value,
      authType: isFTP.value ? 'password' : formAuthType.value,
      password: formPassword.value || undefined,
      sshKeyId: formAuthType.value === 'sshkey' ? formSshKeyId.value : null,
      pemContent: formPemContent.value || undefined,
    }) as unknown as { ok?: boolean; whoami?: string; os?: string; arch?: string; error?: string }
    if (res?.ok) {
      message.success(t('remoteConsole.testOk', { whoami: res.whoami || '?', os: res.os || '?', arch: res.arch || '?' }))
      return
    }
    const msg = friendlyRemoteError(res?.error || '', t)
    const hint = msg.includes('credential decrypt failed')
      ? ` ${t('remoteConsole.decryptFailHint')}`
      : msg.includes('auth rejected') || msg.includes('unable to authenticate')
        ? ` ${t('remoteConsole.authFailHint')}`
        : ''
    message.error(t('remoteConsole.testFailed', { msg: msg || '?' }) + hint)
  } catch (e: any) {
    // 网络/HTTP 层错误（超时、拦截器已本地化文案）
    message.error(e?.userMessage || t('remoteConsole.testFailed', { msg: e?.message || '?' }))
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="dialog"
    :title="host ? t('deploy.host.editTitle') : t('deploy.host.addTitle')"
    :mask-closable="false"
    style="width: var(--modal-w-md); max-width: 94vw"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <n-form
      label-placement="top"
      size="small"
    >
      <n-grid
        :cols="2"
        :x-gap="12"
      >
        <n-grid-item :span="2">
          <n-form-item :label="t('deploy.host.field.name')">
            <n-input v-model:value="formName" />
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item :label="t('deploy.host.field.host')">
            <n-input
              v-model:value="formHost"
              placeholder="192.168.1.10"
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item :label="t('deploy.host.field.port')">
            <n-input-number
              v-model:value="formPort"
              :min="1"
              :max="65535"
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item :label="t('deploy.host.field.user')">
            <n-input
              v-model:value="formUser"
              placeholder="root"
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item>
          <n-form-item :label="t('deploy.host.field.protocol')">
            <n-select
              v-model:value="formProtocol"
              :options="protocolOptions"
              @update:value="onProtocolChange"
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item v-if="!isFTP">
          <n-form-item :label="t('deploy.host.field.authType')">
            <n-select
              v-model:value="formAuthType"
              :options="authTypeOptions"
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item :span="2">
          <n-form-item :label="t('deploy.host.field.password')">
            <n-input
              v-model:value="formPassword"
              type="password"
              :input-props="{ autocomplete: 'new-password' }"
              :placeholder="host ? t('deploy.host.field.passwordKeep') : ''"
            />
            <div
              v-if="isFTP"
              class="ftp-hint"
            >
              {{ t('deploy.host.field.ftpHint') }}
            </div>
          </n-form-item>
        </n-grid-item>
        <n-grid-item
          v-if="!isFTP && formAuthType === 'sshkey'"
          :span="2"
        >
          <n-form-item :label="t('deploy.host.field.sshKey')">
            <n-select
              v-model:value="formSshKeyId"
              :options="sshKeyOptions"
              :placeholder="t('deploy.host.field.sshKeyPlaceholder')"
              clearable
            />
          </n-form-item>
        </n-grid-item>
        <n-grid-item
          v-if="!isFTP && formAuthType === 'pem'"
          :span="2"
        >
          <n-form-item :label="t('deploy.host.field.pem')">
            <n-input
              v-model:value="formPemContent"
              type="textarea"
              :rows="6"
              :placeholder="t('deploy.host.field.pemPlaceholder')"
              :readonly="!!host"
            />
            <div
              v-if="host"
              style="font-size: 11px; color: var(--text-secondary)"
            >
              {{ t('deploy.host.field.pemKeepHint') }}
            </div>
          </n-form-item>
        </n-grid-item>
        <n-grid-item
          v-if="!isFTP"
          :span="2"
        >
          <n-form-item
            :show-feedback="false"
            :label="t('deploy.host.hostkey.title')"
          >
            <div class="hostkey-row">
              <div class="hostkey-switch">
                <n-switch
                  v-model:value="hostVerifyOn"
                  size="small"
                />
                <span class="hostkey-switch-label">{{ t('deploy.host.hostkey.switch') }}</span>
              </div>
              <div class="hostkey-hint">
                {{ t('deploy.host.hostkey.hint') }}
              </div>
              <div
                v-if="host"
                class="hostkey-pin"
              >
                <template v-if="hostKeyPin?.pinned">
                  <code
                    class="hostkey-fp"
                    :title="hostKeyPin.fingerprint"
                  >{{ hostKeyPin.fingerprint }}</code>
                  <span class="hostkey-algo">{{ hostKeyPin.algo }}</span>
                  <n-popconfirm
                    @positive-click="resetHostKey"
                  >
                    <template #trigger>
                      <n-button
                        size="tiny"
                        quaternary
                        type="warning"
                        :loading="resettingHostKey"
                      >
                        {{ t('deploy.host.hostkey.reset') }}
                      </n-button>
                    </template>
                    {{ t('deploy.host.hostkey.resetConfirm') }}
                  </n-popconfirm>
                </template>
                <span
                  v-else
                  class="hostkey-unpinned"
                >
                  {{ hostKeyLoading ? t('deploy.host.hostkey.loading') : t('deploy.host.hostkey.unpinned') }}
                </span>
              </div>
            </div>
          </n-form-item>
        </n-grid-item>
      </n-grid>
    </n-form>
    <template #action>
      <n-space
        justify="space-between"
        style="width: 100%"
      >
        <n-button
          :loading="testing"
          :title="host ? t('deploy.host.testConnectionHint') : t('deploy.host.test')"
          @click="testConnection"
        >
          {{ t('deploy.host.test') }}
        </n-button>
        <n-space>
          <n-button @click="emit('update:show', false)">
            {{ t('common.cancel') }}
          </n-button>
          <n-button
            type="primary"
            :loading="saving"
            @click="save"
          >
            {{ t('common.save') }}
          </n-button>
        </n-space>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.ftp-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* SSH 主机密钥 TOFU 分区：开关 + 钉扎指纹 + 重置入口 */
.hostkey-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.hostkey-switch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.hostkey-switch-label {
  font-size: 12px;
  color: var(--text-primary);
}
.hostkey-hint {
  font-size: 11px;
  color: var(--text-muted);
}
.hostkey-pin {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.hostkey-fp {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-active);
  padding: 1px 6px;
  border-radius: 4px;
  max-width: 340px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hostkey-algo {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.hostkey-unpinned {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
