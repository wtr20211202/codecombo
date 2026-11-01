<script setup lang="ts">
// SSH 密钥设置 Tab（自 SecuritySettings 按区块拆出，P-20261002-27）：
// 密钥生成（Ed25519/RSA）/导入/删除/公钥复制。自包含：数据自行加载；
// show=true 时（重新）拉取，与原容器每次打开设置即刷新同语义。
import { ref, watch, onMounted } from 'vue'
import { NButton, NInput, NSelect } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { sshKeyApi, type SshKey } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import { useMessage } from 'naive-ui'

const props = defineProps<{ show: boolean }>()

const { t } = useI18n()
const message = useMessage()

// === SSH Key 状态 ===
const sshKeys = ref<SshKey[]>([])
const newKeyName = ref('')
const newKeyAlgo = ref('ed25519')
const keyGenLoading = ref(false)
const showKeyResult = ref(false)
const generatedPubKey = ref('')
const importKeyName = ref('')
const importKeyPEM = ref('')
const importKeyLoading = ref(false)
const showImportKey = ref(false)

async function load() {
  newKeyName.value = ''
  showKeyResult.value = false
  showImportKey.value = false
  await fetchSshKeys()
}

// === SSH Key CRUD ===
async function fetchSshKeys() {
  try {
    const res: any = await sshKeyApi.list()
    sshKeys.value = res.data || []
  } catch { /* silent */ }
}

async function generateKey() {
  if (!newKeyName.value) return
  keyGenLoading.value = true
  try {
    const res: any = await sshKeyApi.generate({ name: newKeyName.value, algo: newKeyAlgo.value })
    generatedPubKey.value = res.pubKey || ''
    showKeyResult.value = true
    newKeyName.value = ''
    await fetchSshKeys()
  } catch { /* 拦截器处理 */ }
  finally { keyGenLoading.value = false }
}

async function importKey() {
  if (!importKeyName.value || !importKeyPEM.value) return
  importKeyLoading.value = true
  try {
    await sshKeyApi.import({ name: importKeyName.value, privateKey: importKeyPEM.value })
    message.success(t('settings.sshKeyImported'))
    importKeyName.value = ''
    importKeyPEM.value = ''
    showImportKey.value = false
    await fetchSshKeys()
  } catch { /* 拦截器处理 */ }
  finally { importKeyLoading.value = false }
}

// 删除确认（P-20261005-5）：密钥删除后依赖它的主机连接即断，重加须重装
// authorized_keys——与凭据删除（CredentialList deleteConfirm）同款知情确认
async function deleteSshKey(k: SshKey) {
  const ok = await confirmDialog({
    title: t('settings.sshKeyDeleteTitle', { name: k.name }),
    content: t('settings.sshKeyDeleteConfirm'),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await sshKeyApi.remove(k.id)
    await fetchSshKeys()
  } catch { /* 拦截器处理 */ }
}

async function copyGeneratedPubKey() {
  if (await copyText(generatedPubKey.value)) {
    message.success(t('settings.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

async function copyPubKey(id: string) {
  try {
    const res: any = await sshKeyApi.getPub(id)
    const pub = res.pubKey || ''
    if (await copyText(pub)) {
      message.success(t('settings.copied'))
    } else {
      message.error(t('common.copyFailed'))
    }
  } catch { /* 拦截器处理 */ }
}

onMounted(() => {
  if (props.show) load()
})
watch(() => props.show, (val) => {
  if (val) load()
})
</script>

<template>
  <div class="tab-section">
    <div class="cred-warn">
      {{ t('settings.sshKeyWarn') }}
    </div>
    <div class="cred-add-row">
      <n-input
        v-model:value="newKeyName"
        size="small"
        style="width: 160px"
        :placeholder="t('settings.sshKeyNamePlaceholder')"
      />
      <n-select
        v-model:value="newKeyAlgo"
        size="small"
        style="width: 110px"
        :options="[
          { label: 'Ed25519', value: 'ed25519' },
          { label: 'RSA 2048', value: 'rsa' },
        ]"
      />
      <n-button
        size="small"
        type="primary"
        :loading="keyGenLoading"
        :disabled="!newKeyName"
        @click="generateKey"
      >
        {{ t('settings.sshKeyGenerate') }}
      </n-button>
      <n-button
        size="small"
        @click="showImportKey = !showImportKey"
      >
        {{ t('settings.sshKeyImport') }}
      </n-button>
    </div>
    <div
      v-if="showKeyResult"
      class="token-result"
    >
      <div class="token-result-title">
        {{ t('settings.sshKeyGenerated') }}
      </div>
      <code class="token-plain">{{ generatedPubKey }}</code>
      <n-button
        size="tiny"
        @click="copyGeneratedPubKey"
      >
        {{ t('common.copy') }}
      </n-button>
    </div>
    <div
      v-if="showImportKey"
      class="token-result"
    >
      <div class="token-result-title">
        {{ t('settings.sshKeyImport') }}
      </div>
      <n-input
        v-model:value="importKeyName"
        size="small"
        style="margin-bottom: 8px"
        :placeholder="t('settings.sshKeyNamePlaceholder')"
      />
      <n-input
        v-model:value="importKeyPEM"
        type="textarea"
        size="small"
        :autosize="{ minRows: 4, maxRows: 10 }"
        :placeholder="t('settings.sshKeyImportPlaceholder')"
        style="font-family: var(--font-mono); font-size: 12px; margin-bottom: 8px"
      />
      <n-button
        size="tiny"
        type="primary"
        :loading="importKeyLoading"
        :disabled="!importKeyName || !importKeyPEM"
        @click="importKey"
      >
        {{ t('common.save') }}
      </n-button>
    </div>
    <div class="token-list">
      <div
        v-for="k in sshKeys"
        :key="k.id"
        class="token-item"
      >
        <code class="token-prefix">{{ k.algo }}</code>
        <span class="token-name">{{ k.name }}</span>
        <span
          class="token-expiry"
          style="font-family: var(--font-mono); font-size: var(--fs-meta-min, 11.5px)"
        >{{ k.fingerprint?.slice(0, 25) }}…</span>
        <span style="flex: 1" />
        <n-button
          size="tiny"
          quaternary
          @click="copyPubKey(k.id)"
        >
          {{ t('common.copy') }}
        </n-button>
        <n-button
          size="tiny"
          quaternary
          type="error"
          @click="deleteSshKey(k)"
        >
          {{ t('common.delete') }}
        </n-button>
      </div>
      <div
        v-if="sshKeys.length === 0"
        class="pane-empty"
      >
        {{ t('settings.noSshKeys') }}
      </div>
    </div>
  </div>
</template>

<style scoped src="./security-settings.css"></style>
