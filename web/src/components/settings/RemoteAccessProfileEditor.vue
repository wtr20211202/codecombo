<script setup lang="ts">
// 远程接入档案编辑器（P-20261019-11）：表单 + 预检结果展示。编辑态本地副本，
// 保存/测试把提交形态（password 留空=保持）交回父组件，父组件统一调 settings/
// remoteaccess API 并处理提示与刷新。
import { computed, reactive, watch } from 'vue'
import { NAlert, NButton, NInput, NInputNumber, NRadio, NRadioGroup, NSelect, NTag } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { RemoteAccessProbeResult, SshKey } from '../../api/client'
import type { RemoteAccessEditorState } from './remoteAccessEditor'

const props = defineProps<{
  editor: RemoteAccessEditorState
  sshKeys: SshKey[]
  testing: boolean
  saving: boolean
  probe: RemoteAccessProbeResult | null
  probeUrl: string
}>()

const emit = defineEmits<{
  (e: 'save', state: RemoteAccessEditorState): void
  (e: 'test', state: RemoteAccessEditorState): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
const form = reactive<RemoteAccessEditorState>({ ...props.editor })
watch(() => props.editor, (v) => { Object.assign(form, v) }, { immediate: true })

const editing = computed(() => !!props.editor.id)
const authOptions = computed(() => [
  { label: t('remoteAccess.profiles.authPassword'), value: 'password' },
  { label: t('remoteAccess.profiles.authSshKey'), value: 'sshkey' },
])
const bindOptions = computed(() => [
  { label: t('remoteAccess.profiles.bindPublic'), value: '0.0.0.0' },
  { label: t('remoteAccess.profiles.bindLoopback'), value: '127.0.0.1' },
])
const sshKeyOptions = computed(() => props.sshKeys.map(k => ({
  label: `${k.name} (${k.fingerprint.slice(0, 16)}…)`,
  value: k.id,
})))

function snapshot(): RemoteAccessEditorState { return { ...form } }
</script>

<template>
  <div
    class="ra-card"
    data-testid="settings-remote-access-editor"
  >
    <div class="ra-card-head">
      <span class="ra-card-title">
        {{ editing ? t('remoteAccess.profiles.edit') : t('remoteAccess.profiles.add') }}
      </span>
    </div>
    <div class="ra-form-grid">
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.name') }}</span>
        <NInput
          v-model:value="form.name"
          size="small"
          :placeholder="t('remoteAccess.profiles.namePlaceholder')"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.host') }}</span>
        <NInput
          v-model:value="form.host"
          size="small"
          :placeholder="t('remoteAccess.profiles.hostPlaceholder')"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.sshPort') }}</span>
        <NInputNumber
          v-model:value="form.port"
          size="small"
          :min="1"
          :max="65535"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.user') }}</span>
        <NInput
          v-model:value="form.user"
          size="small"
          placeholder="root"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.authType') }}</span>
        <NRadioGroup
          v-model:value="form.authType"
          size="small"
        >
          <NRadio
            v-for="o in authOptions"
            :key="o.value"
            :value="o.value"
          >
            {{ o.label }}
          </NRadio>
        </NRadioGroup>
      </label>
      <label
        v-if="form.authType === 'password'"
        class="ra-field"
      >
        <span>{{ t('remoteAccess.profiles.password') }}</span>
        <NInput
          v-model:value="form.password"
          type="password"
          show-password-on="click"
          size="small"
          :placeholder="form.hasPassword ? t('remoteAccess.profiles.passwordKeep') : t('remoteAccess.profiles.passwordPlaceholder')"
        />
      </label>
      <label
        v-else
        class="ra-field"
      >
        <span>{{ t('remoteAccess.profiles.sshKey') }}</span>
        <NSelect
          v-model:value="form.sshKeyId"
          size="small"
          :options="sshKeyOptions"
          :placeholder="props.sshKeys.length ? t('remoteAccess.profiles.sshKeyPlaceholder') : t('remoteAccess.profiles.sshKeyEmpty')"
          :disabled="props.sshKeys.length === 0"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.bindMode') }}</span>
        <NSelect
          v-model:value="form.remoteBindHost"
          size="small"
          :options="bindOptions"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.remotePort') }}</span>
        <NInputNumber
          v-model:value="form.remotePort"
          size="small"
          :min="1"
          :max="65535"
        />
      </label>
      <label class="ra-field">
        <span>{{ t('remoteAccess.profiles.domain') }}</span>
        <NInput
          v-model:value="form.domain"
          size="small"
          :placeholder="t('remoteAccess.profiles.domainPlaceholder')"
        />
      </label>
    </div>
    <p class="ra-hint">
      {{ t('remoteAccess.profiles.bindHint') }}
    </p>
    <!-- 反代边界告知（P-20261020-1）：域名/反代模式下 TLS 在 VPS 终结，
         VPS 内存中可见明文——不阻断保存，但必须在填写域名的当场说清 -->
    <NAlert
      v-if="form.domain.trim()"
      type="warning"
      :show-icon="true"
      class="ra-proxy-warn"
      data-testid="settings-remote-access-proxy-warn"
    >
      {{ t('remoteAccess.profiles.reverseProxyWarn') }}
    </NAlert>
    <div class="ra-editor-actions">
      <NButton
        size="small"
        data-testid="settings-remote-access-test"
        :loading="props.testing"
        @click="emit('test', snapshot())"
      >
        {{ props.testing ? t('remoteAccess.profiles.testing') : t('remoteAccess.profiles.test') }}
      </NButton>
      <NButton
        size="small"
        @click="emit('cancel')"
      >
        {{ t('remoteAccess.profiles.cancel') }}
      </NButton>
      <NButton
        size="small"
        type="primary"
        :loading="props.saving"
        data-testid="settings-remote-access-save"
        @click="emit('save', snapshot())"
      >
        {{ t('remoteAccess.profiles.save') }}
      </NButton>
    </div>

    <div
      v-if="props.probe"
      class="ra-probe"
      data-testid="settings-remote-access-probe"
    >
      <div class="ra-probe-head">
        <NTag
          size="small"
          :type="props.probe.ok ? 'success' : 'error'"
          round
        >
          {{ props.probe.ok ? t('remoteAccess.test.ok') : t('remoteAccess.test.fail') }}
        </NTag>
        <span
          v-if="props.probeUrl"
          class="ra-muted"
        >{{ props.probeUrl }}</span>
      </div>
      <div
        v-for="s in props.probe.steps"
        :key="s.step"
        class="ra-probe-step"
      >
        <span
          class="ra-probe-dot"
          :class="s.ok ? 'is-ok' : 'is-bad'"
        />
        <div class="ra-probe-body">
          <div class="ra-probe-name">
            {{ t(`remoteAccess.test.step.${s.step}`) }}
          </div>
          <div
            v-if="s.message"
            class="ra-probe-msg"
          >
            {{ s.message }}
          </div>
          <div
            v-if="s.hint"
            class="ra-probe-hint"
          >
            {{ s.hint }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ra-card {
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  padding: 12px;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ra-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ra-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.ra-muted {
  font-size: 12px;
  color: var(--text-tertiary);
}
.ra-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: 10px;
}
.ra-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}
.ra-hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-tertiary);
}
.ra-proxy-warn {
  margin: 0;
  font-size: 12px;
}
.ra-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.ra-probe {
  border-top: 1px dashed var(--border-subtle);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ra-probe-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ra-probe-step {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.ra-probe-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 5px;
  flex: 0 0 auto;
}
.ra-probe-dot.is-ok {
  background: var(--accent-green);
}
.ra-probe-dot.is-bad {
  background: var(--accent-red);
}
.ra-probe-body {
  min-width: 0;
}
.ra-probe-name {
  font-size: 12px;
  color: var(--text-primary);
}
.ra-probe-msg {
  font-size: 11px;
  color: var(--text-secondary);
  word-break: break-word;
}
.ra-probe-hint {
  font-size: 11px;
  color: var(--accent-orange);
  line-height: 1.5;
  word-break: break-word;
}
</style>
