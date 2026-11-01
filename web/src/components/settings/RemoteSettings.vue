<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import {
  NButton, NInput, NSpin, useMessage,
} from 'naive-ui'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { remoteApi } from '../../api/client'
import { copyText } from '../../utils/clipboard'
import NoProjectHint from './NoProjectHint.vue'

const props = defineProps<{ show: boolean }>()

const route = useRoute()
const projectStore = useProjectStore()
const hasProject = computed<boolean>(() => route.name !== 'home' && !!projectStore.currentProjectId)
const { t } = useI18n()
const message = useMessage()

const remotes = ref<{ name: string; url: string; type: string }[]>([])
const newRemoteName = ref('')
const newRemoteUrl = ref('')
const remoteLoading = ref(false)

async function load() {
  newRemoteName.value = ''
  newRemoteUrl.value = ''
  if (!hasProject.value) return
  remoteLoading.value = true
  try {
    const res: any = await remoteApi.list(projectStore.currentProjectId)
    remotes.value = res.data || []
  } finally { remoteLoading.value = false }
}

async function handleAddRemote() {
  if (!hasProject.value || !newRemoteName.value || !newRemoteUrl.value) {
    message.warning(t('layout.remoteWarning'))
    return
  }
  try {
    await remoteApi.add(projectStore.currentProjectId, newRemoteName.value, newRemoteUrl.value)
    message.success(t('layout.remoteAdded'))
    newRemoteName.value = ''
    newRemoteUrl.value = ''
    await load()
  } catch { /* 拦截器处理 */ }
}

// URL 截断时 title 看全，点击复制（copyText 降级链 + 失败可恢复提示）
async function copyRemoteUrl(url: string) {
  if (await copyText(url)) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}

async function handleDeleteRemote(name: string) {
  if (!hasProject.value) return
  // 删除确认（P-20261005-5）：远端 URL 常为 token 承载形态，误删后未必能凭记忆重建——
  // 与凭据删除（CredentialList deleteConfirm）同款知情确认
  const ok = await confirmDialog({
    title: t('layout.remoteDeleteTitle', { name }),
    content: t('layout.remoteDeleteConfirm'),
    type: 'warning',
    confirmText: t('common.delete'),
  })
  if (!ok) return
  try {
    await remoteApi.remove(projectStore.currentProjectId, name)
    message.success(t('layout.remoteDeleted', { name }))
    await load()
  } catch { /* 拦截器处理 */ }
}

onMounted(() => {
  if (props.show) load()
})
watch(() => props.show, (val) => {
  if (val) load()
})
// 空态里就地「进入项目」后 hasProject 翻转，远端列表需加载
watch(hasProject, (val) => {
  if (val && props.show) load()
})

defineExpose({ load })
</script>

<template>
  <div class="remote-settings">
    <NoProjectHint
      v-if="!hasProject"
      :text="t('layout.remoteConfigNoProject')"
      tab="remote"
    />
    <template v-else>
      <div
        class="remote-add-row"
        data-testid="settings-remote-add"
      >
        <n-input
          v-model:value="newRemoteName"
          :placeholder="t('layout.remoteNamePlaceholder')"
          size="small"
          style="width: 120px"
        />
        <n-input
          v-model:value="newRemoteUrl"
          :placeholder="t('layout.remoteUrlPlaceholder')"
          size="small"
          style="flex: 1"
        />
        <n-button
          size="small"
          type="primary"
          @click="handleAddRemote"
        >
          {{ t('common.add') }}
        </n-button>
      </div>
      <div
        v-if="remoteLoading"
        class="pane-loading"
      >
        <n-spin size="small" />
      </div>
      <div
        v-else-if="remotes.length === 0"
        class="pane-empty"
      >
        {{ t('layout.noRemotes') }}
      </div>
      <div
        v-else
        class="remote-list"
      >
        <div
          v-for="r in remotes"
          :key="r.name + r.type"
          class="remote-item"
        >
          <span class="remote-name-inline">{{ r.name }}</span>
          <span
            class="remote-url-inline"
            role="button"
            tabindex="0"
            :title="`${r.url} · ${t('common.copy')}`"
            @click="copyRemoteUrl(r.url)"
            @keydown.enter.prevent="copyRemoteUrl(r.url)"
            @keydown.space.prevent="copyRemoteUrl(r.url)"
          >{{ r.url }}</span>
          <n-button
            size="tiny"
            quaternary
            type="error"
            @click="handleDeleteRemote(r.name)"
          >
            {{ t('common.delete') }}
          </n-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.remote-add-row {
  display: flex;
  gap: 6px;
  margin-bottom: var(--space-3);
}
.pane-loading { padding: 24px; text-align: center; }
.pane-empty { padding: var(--space-4); text-align: center; color: var(--text-muted); font-size: 12px; }
.remote-list {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}
.remote-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) 10px;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 12px;
}
.remote-item:last-child { border-bottom: none; }
.remote-name-inline {
  color: var(--brand-accent);
  font-weight: var(--fw-medium);
  min-width: 70px;
  font-family: var(--font-mono);
}
.remote-url-inline {
  flex: 1;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-meta-min, 11.5px);
  cursor: pointer;
}
.remote-url-inline:hover { color: var(--text-primary); }
.remote-url-inline:focus-visible { outline: 1px solid var(--brand-accent); outline-offset: 1px; }
</style>
