<script setup lang="ts">
import { ref, onMounted } from 'vue'
import {
  NList, NListItem, NThing, NTag, NSpace, NButton, NEmpty,
  NModal, NForm, NFormItem, NInput, NSelect, useMessage,
} from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { oauthClientApi, type OAuthClient } from '../../api/client'
import { confirmDialog } from '../../composables/useDialog'

const { t } = useI18n()
const message = useMessage()

// 已配置的 OAuth 应用列表（secret 不回显，仅 has_secret 标记）
const clients = ref<OAuthClient[]>([])
// 新增 / 编辑弹窗显隐
const showAdd = ref(false)
const saving = ref(false)
// 表单字段：platform / host / client_id 必填；client_secret 可选（Device Flow 通常不需要）
const form = ref({
  platform: 'github' as 'github' | 'gitea',
  host: '',
  client_id: '',
  client_secret: '',
})

// 平台下拉选项（目前仅 GitHub / Gitea，后续可扩展）
const platformOptions = [
  { label: 'GitHub', value: 'github' },
  { label: 'Gitea', value: 'gitea' },
]

// 拉取 OAuth 应用列表
// 注意：response 拦截器已 unwrap 返回 body（res 即数据本身），
// 但 axios 类型签名仍按 AxiosResponse 暴露，沿用项目惯例 `const res: any` 取 unwrap 后的 clients。
async function fetchClients() {
  try {
    const res: any = await oauthClientApi.list()
    clients.value = (res?.clients as OAuthClient[] | undefined) ?? []
  } catch {
    // 拦截器统一处理
  }
}

onMounted(fetchClients)

// 保存（新增 / 编辑共用）
// 编辑场景下 client_secret 留空时后端应保留原 secret（不回填、不覆盖）
async function save() {
  if (!form.value.host || !form.value.client_id) {
    message.warning(t('settings.security.oauthClients.requiredFields'))
    return
  }
  saving.value = true
  try {
    await oauthClientApi.save({
      platform: form.value.platform,
      host: form.value.host,
      client_id: form.value.client_id,
      // 空串不传，避免后端误以为要清空 secret
      client_secret: form.value.client_secret || undefined,
    })
    message.success(t('common.saved'))
    showAdd.value = false
    form.value = { platform: 'github', host: '', client_id: '', client_secret: '' }
    await fetchClients()
  } catch (e: any) {
    message.error(e?.userMessage || t('common.saveFailed'))
  } finally {
    saving.value = false
  }
}

// 编辑：回填 platform / host / client_id，secret 永不回填（安全约束）
function edit(c: OAuthClient) {
  form.value = {
    platform: (c.platform || 'github') as 'github' | 'gitea',
    host: c.host,
    client_id: c.client_id,
    client_secret: '',
  }
  showAdd.value = true
}

// 删除（delete 是关键字，client.ts 中方法名是 remove）
async function remove(c: OAuthClient) {
  const ok = await confirmDialog({
    title: t('settings.security.oauthClients.deleteConfirm', {
      platform: c.platform,
      host: c.host,
    }),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await oauthClientApi.remove(c.platform, c.host)
    await fetchClients()
  } catch {
    // 拦截器统一处理
  }
}

// 打开新增弹窗时重置表单
function openAdd() {
  form.value = { platform: 'github', host: '', client_id: '', client_secret: '' }
  showAdd.value = true
}
</script>

<template>
  <div class="oauth-client-manager">
    <div class="header">
      <h3>{{ t('settings.security.oauthClients.title') }}</h3>
      <NButton
        size="small"
        @click="openAdd"
      >
        {{ t('settings.security.oauthClients.add') }}
      </NButton>
    </div>
    <p class="hint">
      {{ t('settings.security.oauthClients.hint') }}
    </p>

    <NList
      v-if="clients.length > 0"
      bordered
    >
      <NListItem
        v-for="c in clients"
        :key="`${c.platform}:${c.host}`"
      >
        <NThing>
          <template #header>
            <NTag
              size="small"
              :type="c.platform === 'github' ? 'info' : 'success'"
            >
              {{ c.platform }}
            </NTag>
            <span class="host">{{ c.host }}</span>
          </template>
          <template #description>
            <span class="client-id">client_id: {{ c.client_id }}</span>
            <NTag
              v-if="c.has_secret"
              size="tiny"
              class="secret-tag"
            >
              + secret
            </NTag>
          </template>
          <template #action>
            <NSpace size="small">
              <NButton
                size="tiny"
                quaternary
                @click="edit(c)"
              >
                {{ t('common.edit') }}
              </NButton>
              <NButton
                size="tiny"
                quaternary
                type="error"
                @click="remove(c)"
              >
                {{ t('common.delete') }}
              </NButton>
            </NSpace>
          </template>
        </NThing>
      </NListItem>
    </NList>
    <NEmpty
      v-else
      :description="t('settings.security.oauthClients.empty')"
    />

    <!-- 新增 / 编辑弹窗：platform / host / client_id / client_secret(可选) -->
    <NModal
      v-model:show="showAdd"
      preset="card"
      style="width: var(--modal-w-sm); max-width: 94vw"
    >
      <template #header>
        {{ t('settings.security.oauthClients.formTitle') }}
      </template>
      <NForm>
        <NFormItem :label="t('settings.security.oauthClients.platform')">
          <NSelect
            v-model:value="form.platform"
            :options="platformOptions"
          />
        </NFormItem>
        <NFormItem :label="t('settings.security.oauthClients.host')">
          <NInput
            v-model:value="form.host"
            :placeholder="form.platform === 'github' ? 'github.com' : 'gitea.company.com'"
          />
        </NFormItem>
        <NFormItem label="Client ID">
          <NInput v-model:value="form.client_id" />
        </NFormItem>
        <NFormItem label="Client Secret">
          <NInput
            v-model:value="form.client_secret"
            type="password"
            show-password-on="click"
            :placeholder="t('settings.security.oauthClients.secretOptional')"
          />
        </NFormItem>
      </NForm>
      <template #action>
        <NSpace justify="end">
          <NButton @click="showAdd = false">
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            type="primary"
            :loading="saving"
            @click="save"
          >
            {{ t('common.save') }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.oauth-client-manager {
  margin-bottom: 24px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
}

.header h3 {
  margin: 0;
}

.hint {
  color: var(--text-color-3);
  font-size: 13px;
  margin-bottom: var(--space-3);
}

.host {
  margin-left: var(--space-2);
}

.secret-tag {
  margin-left: var(--space-2);
}
</style>
