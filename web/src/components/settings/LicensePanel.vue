<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NButton, NIcon, NTag, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { licenseApi, type LicenseStatus } from '../../api/domains/license'
import { KeyOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5'

const { t } = useI18n()
const message = useMessage()
const status = ref<LicenseStatus | null>(null)
const activating = ref(false)
const licenseKeyInput = ref('')
const showActivate = ref(false)

async function fetch() {
  try {
    const res: any = await licenseApi.getStatus({ silent: true })
    status.value = res?.data ?? res
  } catch { /* 静默 */ }
}

async function activate() {
  if (!licenseKeyInput.value.trim() || activating.value) return
  activating.value = true
  try {
    await licenseApi.activate(licenseKeyInput.value.trim())
    message.success(t('license.activated'))
    licenseKeyInput.value = ''
    showActivate.value = false
    await fetch()
  } catch (e: any) {
    // userMessage 优先（拦截器已映射），原始信息在控制台
    message.error(e?.userMessage || e?.message || t('license.activateFailed'))
  } finally {
    activating.value = false
  }
}

async function deactivate() {
  try {
    await licenseApi.deactivate()
    message.success(t('license.deactivated'))
    await fetch()
  } catch { /* 静默 */ }
}


onMounted(fetch)
</script>

<template>
  <div class="license-panel">
    <div class="license-header">
      <n-icon
        size="24"
        class="license-icon"
      >
        <ShieldCheckmarkOutline />
      </n-icon>
      <div>
        <div class="license-title">
          {{ t('license.title') }}
        </div>
        <div class="license-subtitle">
          {{ t('license.subtitle') }}
        </div>
      </div>
    </div>

    <template v-if="status?.activated">
      <div class="license-info-grid">
        <div class="license-field">
          <span class="license-label">{{ t('license.licensee') }}</span>
          <span class="license-value">{{ status.licensee }}</span>
        </div>
        <div class="license-field">
          <span class="license-label">{{ t('license.edition') }}</span>
          <n-tag
            size="small"
            type="success"
          >
            {{ status.edition }}
          </n-tag>
        </div>
        <div class="license-field">
          <span class="license-label">{{ t('license.features') }}</span>
          <span class="license-value">{{ (status.features || []).join(', ') }}</span>
        </div>
        <div
          v-if="status.issuedAt"
          class="license-field"
        >
          <span class="license-label">{{ t('license.issuedAt') }}</span>
          <span class="license-value">{{ status.issuedAt }}</span>
        </div>
        <div
          v-if="status.expiresAt"
          class="license-field"
        >
          <span class="license-label">{{ t('license.expiresAt') }}</span>
          <span class="license-value">{{ status.expiresAt }}</span>
        </div>
      </div>
      <n-button
        size="small"
        quaternary
        type="error"
        @click="deactivate"
      >
        {{ t('license.deactivate') }}
      </n-button>
    </template>

    <template v-else>
      <div class="license-empty">
        <n-icon
          size="28"
          class="license-empty-icon"
        >
          <KeyOutline />
        </n-icon>
        <span>{{ t('license.notActivated') }}</span>
      </div>
      <div
        v-if="!showActivate"
        class="license-activate-row"
      >
        <n-button
          size="small"
          type="primary"
          @click="showActivate = true"
        >
          {{ t('license.activateBtn') }}
        </n-button>
      </div>
      <div
        v-else
        class="license-activate-form"
      >
        <textarea
          v-model="licenseKeyInput"
          class="license-key-input"
          :placeholder="t('license.keyPlaceholder')"
          rows="5"
        />
        <div class="license-activate-actions">
          <n-button
            size="small"
            @click="showActivate = false"
          >
            {{ t('common.cancel') }}
          </n-button>
          <n-button
            size="small"
            type="primary"
            :loading="activating"
            :disabled="!licenseKeyInput.trim()"
            @click="activate"
          >
            {{ t('license.activateBtn') }}
          </n-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.license-panel { display: flex; flex-direction: column; gap: 14px; }
.license-header { display: flex; align-items: center; gap: 10px; }
.license-icon { color: var(--brand-accent); }
.license-title { font-size: 15px; font-weight: var(--fw-semibold); color: var(--text-primary); }
.license-subtitle { font-size: 12px; color: var(--text-secondary); }
.license-info-grid { display: flex; flex-direction: column; gap: var(--space-2); }
.license-field { display: flex; align-items: center; gap: var(--space-2); }
.license-label { font-size: 12px; color: var(--text-muted); min-width: 80px; }
.license-value { font-size: 13px; color: var(--text-body); }
.license-empty { display: flex; align-items: center; gap: var(--space-2); font-size: 13px; color: var(--text-muted); padding: var(--space-3) 0; }
.license-empty-icon { color: var(--text-dim); }
.license-activate-row { display: flex; }
.license-activate-form { display: flex; flex-direction: column; gap: var(--space-2); }
.license-activate-actions { display: flex; gap: 6px; justify-content: flex-end; }
.license-key-input {
  font-family: var(--font-mono); font-size: 12px;
  padding: var(--space-2); background: var(--bg-canvas); color: var(--text-body);
  border: 1px solid var(--border-default); border-radius: var(--radius-md); resize: vertical;
}
</style>
