<script setup lang="ts">
import { ref, watch } from 'vue'
import { NButton, NIcon, NInput } from 'naive-ui'
import { ChevronDownOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { remoteApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { useDialog, useMessage } from 'naive-ui'
import { copyText } from '../../utils/clipboard'

/**
 * Git 侧栏远程仓库分节（从 GitPanel.vue 抽出）：
 * 列表/添加远程弹窗/删除。删除与新增会改变远程分支集合，
 * 因此变更后 emit('changed', remoteNames) 供宿主触发分支刷新。
 */
const emit = defineEmits<{
  (e: 'changed', remoteNames: string[]): void
}>()

const projectStore = useProjectStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const remotes = ref<{ name: string; url: string; type: string }[]>([])
const newRemoteName = ref('')
const newRemoteUrl = ref('')
const showAddRemote = ref(false)
const collapsed = ref(false)

async function fetchRemotes() {
  if (!projectStore.currentProjectId) return
  try {
    const res: any = await remoteApi.list(projectStore.currentProjectId)
    remotes.value = res.data || []
  } catch { /* silent */ }
}

watch(() => projectStore.currentProjectId, () => void fetchRemotes(), { immediate: true })

function openAddRemote() {
  showAddRemote.value = true
}

// 侧栏窄幅下 URL 常态 ellipsis（audit：91px 显示 212px）：title 看全 + 点击复制，
// 走 copyText 降级链并按返回值反馈（剪贴板红线）
async function copyRemoteUrl(url: string) {
  if (await copyText(url)) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}

async function handleAddRemote() {
  if (!projectStore.currentProjectId || !newRemoteName.value || !newRemoteUrl.value) return
  try {
    await remoteApi.add(projectStore.currentProjectId, newRemoteName.value, newRemoteUrl.value)
    message.success(t('git.remoteAdded', { name: newRemoteName.value }))
    newRemoteName.value = ''
    newRemoteUrl.value = ''
    showAddRemote.value = false
    await fetchRemotes()
    emit('changed', remotes.value.map(r => r.name))
  } catch { /* 拦截器处理 */ }
}

async function handleDeleteRemote(name: string) {
  if (!projectStore.currentProjectId) return
  dialog.warning({
    title: t('git.deleteRemoteTitle'),
    content: t('git.deleteRemoteConfirm', { name: name }),
    positiveText: t('common.delete'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      try {
        await remoteApi.remove(projectStore.currentProjectId!, name)
        message.success(t('git.remoteDeleted', { name: name }))
        await fetchRemotes()
        emit('changed', remotes.value.map(r => r.name))
      } catch { /* 拦截器处理 */ }
    },
  })
}
</script>

<template>
  <div class="branch-section">
    <div
      class="section-header"
      @click="collapsed = !collapsed"
    >
      <n-icon size="12">
        <component :is="collapsed ? ChevronForwardOutline : ChevronDownOutline" />
      </n-icon>
      <span>{{ t('git.remotes') }}</span>
      <span class="section-count">{{ remotes.length }}</span>
      <button
        class="section-add-btn"
        :title="t('git.addRemoteTitle')"
        @click.prevent.stop="openAddRemote"
      >
        +
      </button>
    </div>
    <template v-if="!collapsed">
      <div
        v-for="r in remotes"
        :key="r.name + r.type"
        class="branch-item remote-entry"
        @contextmenu.prevent
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
        <button
          class="section-action"
          :title="t('common.delete')"
          @click="handleDeleteRemote(r.name)"
        >
          ×
        </button>
      </div>
      <div
        v-if="remotes.length === 0"
        class="remote-empty"
      >
        {{ t('git.noRemotesOption') }}
      </div>
    </template>
  </div>

  <!-- 添加远程仓库弹窗 -->
  <div
    v-show="showAddRemote"
    class="modal-overlay"
    @click.self="showAddRemote = false"
  >
    <div class="modal-card">
      <div class="modal-title">
        {{ t('git.addRemoteTitle') }}
      </div>
      <div class="modal-body">
        <div class="modal-field">
          <label>{{ t('git.name') }}</label>
          <n-input
            v-model:value="newRemoteName"
            :placeholder="t('git.remoteNamePlaceholder')"
            size="small"
          />
        </div>
        <div class="modal-field">
          <label>{{ t('git.url') }}</label>
          <n-input
            v-model:value="newRemoteUrl"
            :placeholder="t('git.remoteUrlPlaceholder')"
            size="small"
          />
        </div>
      </div>
      <div class="modal-footer">
        <n-button
          size="small"
          @click="showAddRemote = false"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :disabled="!newRemoteName || !newRemoteUrl"
          @click="handleAddRemote"
        >
          {{ t('common.add') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 可读性下限（P-20261019-3）：同 GitBranchesSection——标题 12px + 元信息/操作钮
   走 --fs-meta-min，max(px 下限, em) 解标题内嵌套叠乘 */
.section-header {
  padding: var(--space-1) var(--space-2); font-size: max(var(--fs-section-min, 12px), 0.92em); font-weight: var(--fw-medium); color: var(--text-secondary);
  background: var(--bg-panel); display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; user-select: none; line-height: var(--lh-meta, 1.45);
}
.section-header:hover { color: var(--text-primary); }
.section-count { margin-left: auto; font-size: max(var(--fs-meta-min, 11.5px), 0.8em); color: var(--text-muted); }
.branch-section { border-bottom: 1px solid color-mix(in srgb, var(--border-default) 20%, transparent); }
.branch-item {
  padding: 2px var(--space-2) 2px 20px; display: flex; align-items: center; gap: var(--space-1);
  cursor: pointer; color: var(--text-primary); font-size: max(var(--fs-meta-min, 11.5px), 0.92em);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.section-action {
  border: none; background: transparent; color: var(--text-secondary); cursor: pointer;
  padding: 0 var(--space-1); font-size: max(var(--fs-meta-min, 11.5px), 0.9em); line-height: 1; border-radius: 2px; margin-left: auto;
  /* 最小热区（P-20261019-5）：× 图标视觉尺寸不动（字面量），命中区走全局底线 */
  min-width: var(--hit-target-min, 28px); min-height: var(--hit-target-min, 28px);
  display: inline-flex; align-items: center; justify-content: center;
}
.section-action:hover { color: var(--text-primary); background: var(--border-default); }
.section-add-btn {
  margin-left: var(--space-1); border: none; background: transparent; color: var(--text-secondary); cursor: pointer;
  padding: 0 var(--space-1); font-size: max(var(--fs-meta-min, 11.5px), 0.9em); line-height: 1; border-radius: 2px;
  /* 最小热区（P-20261019-5）：+ 原实测 14×10（11.5px 字 + 4px 横 padding），
     撑到桌面 28 / coarse 40；flex 居中防字面量基线偏移 */
  min-width: var(--hit-target-min, 28px); min-height: var(--hit-target-min, 28px);
  display: inline-flex; align-items: center; justify-content: center;
}
.section-add-btn:hover { color: var(--text-primary); background: var(--border-default); }
.remote-entry {
  display: flex; align-items: center; gap: var(--space-1); padding: 2px var(--space-2) 2px 20px;
  font-size: max(var(--fs-meta-min, 11.5px), 0.92em); cursor: default;
}
.remote-name-inline { color: var(--accent-blue-light); font-weight: var(--fw-medium); flex-shrink: 0; }
.remote-url-inline {
  color: var(--text-muted); flex: 1; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: max(var(--fs-meta-min, 11.5px), 0.9em);
  cursor: pointer;
}
.remote-url-inline:hover { color: var(--text-primary); }
.remote-url-inline:focus-visible { outline: 1px solid var(--brand-accent); outline-offset: 1px; }
.remote-empty { padding: 6px 10px; font-size: max(var(--fs-meta-min, 11.5px), 0.82em); color: var(--text-muted); }
.modal-overlay {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--overlay-mask);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  width: 380px; background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop-lg);
}
.modal-title {
  padding: var(--space-3) var(--space-4); font-size: 0.95em; font-weight: var(--fw-medium); color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
}
.modal-body { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.modal-field { display: flex; flex-direction: column; gap: var(--space-1); }
.modal-field label { font-size: 0.85em; color: var(--text-secondary); }
.modal-footer {
  padding: 10px var(--space-4); display: flex; justify-content: flex-end; gap: var(--space-2);
  border-top: 1px solid var(--border-default);
}
</style>
