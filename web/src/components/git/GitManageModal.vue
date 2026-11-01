<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  NEmpty, NSpin, NButton, NInput, NTabs, NTabPane, NCheckbox, NModal, useMessage,
} from 'naive-ui'
import { useProjectStore } from '../../stores/project'
import {
  submoduleApi, gpgApi, lfsApi, hookApi,
} from '../../api/client'
import { useI18n } from '../../composables/useI18n'

/**
 * 仓库管理弹窗（原 ManageView 迁入 Git 面板）：子模块 / GPG 签名 / LFS / Git 钩子。
 * 注意：应用未全局注册 naive-ui，NModal 必须显式 import（历史回归教训）。
 */
const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
}>()

const message = useMessage()
const { t } = useI18n()
const projectStore = useProjectStore()

const activeTab = ref('submodule')

// ---- Submodule ----
const submodules = ref<{ name: string; path: string; url: string; branch: string }[]>([])
const submoduleLoading = ref(false)
const showAddSubmoduleModal = ref(false)
const newSubUrl = ref('')
const newSubPath = ref('')
const newSubBranch = ref('')

// Submodule 移除确认
const showRemoveSubConfirm = ref(false)
const removeSubPath = ref('')

async function fetchSubmodules() {
  if (!projectStore.currentProjectId) return
  submoduleLoading.value = true
  try {
    const res: any = await submoduleApi.list(projectStore.currentProjectId)
    submodules.value = res.data || []
  } catch { /* 拦截器处理 */ } finally {
    submoduleLoading.value = false
  }
}

async function handleAddSubmodule() {
  if (!projectStore.currentProjectId || !newSubUrl.value) return
  try {
    await submoduleApi.add(projectStore.currentProjectId, {
      url: newSubUrl.value,
      path: newSubPath.value || undefined,
      branch: newSubBranch.value || undefined,
    })
    message.success(t('manage.submoduleAdded'))
    showAddSubmoduleModal.value = false
    newSubUrl.value = ''
    newSubPath.value = ''
    newSubBranch.value = ''
    await fetchSubmodules()
  } catch { /* 拦截器处理 */ }
}

function openRemoveSubConfirm(path: string) {
  removeSubPath.value = path
  showRemoveSubConfirm.value = true
}

async function confirmRemoveSub() {
  if (!projectStore.currentProjectId || !removeSubPath.value) return
  try {
    await submoduleApi.remove(projectStore.currentProjectId, removeSubPath.value)
    message.success(t('manage.submoduleRemoved'))
    showRemoveSubConfirm.value = false
    removeSubPath.value = ''
    await fetchSubmodules()
  } catch { /* 拦截器处理 */ }
}

async function handleUpdateSubmodules() {
  if (!projectStore.currentProjectId) return
  try {
    await submoduleApi.update(projectStore.currentProjectId, { init: true, recursive: true })
    message.success(t('manage.submoduleUpdated'))
  } catch { /* 拦截器处理 */ }
}

// ---- GPG ----
const gpgEnabled = ref(false)
const gpgLoading = ref(false)

async function fetchGpgStatus() {
  if (!projectStore.currentProjectId) return
  gpgLoading.value = true
  try {
    const res: any = await gpgApi.getStatus(projectStore.currentProjectId)
    gpgEnabled.value = res.data?.enabled || false
  } catch { /* 拦截器处理 */ } finally {
    gpgLoading.value = false
  }
}

async function handleToggleGpg() {
  if (!projectStore.currentProjectId) return
  try {
    await gpgApi.toggle(projectStore.currentProjectId, !gpgEnabled.value)
    gpgEnabled.value = !gpgEnabled.value
    message.success(gpgEnabled.value ? t('manage.gpgEnabledMsg') : t('manage.gpgDisabledMsg'))
  } catch { /* 拦截器处理 */ }
}

// ---- LFS ----
const lfsInstalled = ref(false)
const lfsTracks = ref<{ pattern: string; locked: boolean }[]>([])
const lfsLoading = ref(false)
const newLfsPattern = ref('')

async function fetchLfsStatus() {
  if (!projectStore.currentProjectId) return
  lfsLoading.value = true
  try {
    const res: any = await lfsApi.getStatus(projectStore.currentProjectId)
    lfsInstalled.value = res.data?.installed || false
    lfsTracks.value = res.data?.tracks || []
  } catch { /* 拦截器处理 */ } finally {
    lfsLoading.value = false
  }
}

async function handleLfsInstall() {
  if (!projectStore.currentProjectId) return
  try {
    await lfsApi.install(projectStore.currentProjectId)
    message.success(t('manage.lfsInstalledMsg'))
    await fetchLfsStatus()
  } catch { /* 拦截器处理 */ }
}

async function handleLfsTrack() {
  if (!projectStore.currentProjectId || !newLfsPattern.value) return
  try {
    await lfsApi.track(projectStore.currentProjectId, newLfsPattern.value)
    message.success(t('manage.trackAdded'))
    newLfsPattern.value = ''
    await fetchLfsStatus()
  } catch { /* 拦截器处理 */ }
}

async function handleLfsUntrack(pattern: string) {
  if (!projectStore.currentProjectId) return
  try {
    await lfsApi.untrack(projectStore.currentProjectId, pattern)
    message.success(t('manage.trackRemoved'))
    await fetchLfsStatus()
  } catch { /* 拦截器处理 */ }
}

async function handleLfsPull() {
  if (!projectStore.currentProjectId) return
  try {
    await lfsApi.pull(projectStore.currentProjectId)
    message.success(t('manage.lfsPullDone'))
  } catch { /* 拦截器处理 */ }
}

async function handleLfsPush() {
  if (!projectStore.currentProjectId) return
  try {
    await lfsApi.push(projectStore.currentProjectId)
    message.success(t('manage.lfsPushDone'))
  } catch { /* 拦截器处理 */ }
}

// ---- Hooks ----
const hooks = ref<{ name: string; enabled: boolean }[]>([])
const hooksLoading = ref(false)
const selectedHook = ref('')
const hookContent = ref('')
const hookContentLoading = ref(false)
const hookSaving = ref(false)

async function fetchHooks() {
  if (!projectStore.currentProjectId) return
  hooksLoading.value = true
  try {
    const res: any = await hookApi.list(projectStore.currentProjectId)
    hooks.value = res.data || []
  } catch { /* 拦截器处理 */ } finally {
    hooksLoading.value = false
  }
}

async function handleHookClick(name: string) {
  if (!projectStore.currentProjectId) return
  selectedHook.value = name
  hookContentLoading.value = true
  try {
    const res: any = await hookApi.get(projectStore.currentProjectId, name)
    hookContent.value = res.data?.content || ''
  } catch { /* 拦截器处理 */ } finally {
    hookContentLoading.value = false
  }
}

async function handleSaveHook() {
  if (!projectStore.currentProjectId || !selectedHook.value) return
  hookSaving.value = true
  try {
    await hookApi.update(projectStore.currentProjectId, selectedHook.value, {
      content: hookContent.value,
      enabled: true,
    })
    message.success(t('manage.hookSaved'))
  } catch { /* 拦截器处理 */ } finally {
    hookSaving.value = false
  }
}

function fetchCurrentTab() {
  switch (activeTab.value) {
    case 'submodule': fetchSubmodules(); break
    case 'gpg': fetchGpgStatus(); break
    case 'lfs': fetchLfsStatus(); break
    case 'hooks': fetchHooks(); break
  }
}

// 每次打开弹窗按当前 tab 拉数据
watch(() => props.show, (show) => {
  if (show && projectStore.currentProjectId) fetchCurrentTab()
})

watch(activeTab, () => {
  if (props.show && projectStore.currentProjectId) fetchCurrentTab()
})
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('manage.title')"
    style="width: var(--modal-w-lg); max-width: 94vw"
    :mask-closable="true"
    @update:show="emit('update:show', $event)"
  >
    <n-tabs
      v-model:value="activeTab"
      type="line"
      size="small"
    >
      <n-tab-pane
        name="submodule"
        :tab="t('manage.submodule')"
      >
        <div style="display: flex; gap: 8px; margin-bottom: 12px">
          <n-button
            size="small"
            type="primary"
            @click="showAddSubmoduleModal = true"
          >
            {{ t('manage.addSubmodule') }}
          </n-button>
          <n-button
            size="small"
            @click="handleUpdateSubmodules"
          >
            {{ t('manage.updateAll') }}
          </n-button>
          <n-button
            size="small"
            @click="fetchSubmodules"
          >
            {{ t('common.refresh') }}
          </n-button>
        </div>
        <div
          v-if="submoduleLoading"
          style="padding: 20px; text-align: center"
        >
          <n-spin size="small" />
        </div>
        <div
          v-else-if="submodules.length === 0"
          style="padding: 20px; text-align: center; color: var(--text-dim); font-size: 13px"
        >
          {{ t('manage.noSubmodule') }}
        </div>
        <div v-else>
          <div
            v-for="sub in submodules"
            :key="sub.path"
            style="padding: 8px 4px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; gap: 12px; font-size: 13px"
          >
            <div style="flex: 1; min-width: 0">
              <div style="color: var(--text-body); font-weight: 500">
                {{ sub.path }}
              </div>
              <div
                style="color: var(--text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap"
                :title="sub.url"
              >
                {{ sub.url }}
              </div>
            </div>
            <span
              v-if="sub.branch"
              style="color: var(--accent-blue-light); font-size: 11px"
            >{{ sub.branch }}</span>
            <n-button
              size="tiny"
              type="error"
              quaternary
              @click="openRemoveSubConfirm(sub.path)"
            >
              {{ t('manage.remove') }}
            </n-button>
          </div>
        </div>
      </n-tab-pane>

      <n-tab-pane
        name="gpg"
        :tab="t('manage.gpgSign')"
      >
        <div
          v-if="gpgLoading"
          style="padding: 20px; text-align: center"
        >
          <n-spin size="small" />
        </div>
        <div
          v-else
          style="padding: 12px 4px"
        >
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px">
            <span style="font-size: 13px; color: var(--text-body)">{{ t('manage.gpgSignCommit') }}</span>
            <label style="display: flex; align-items: center; gap: 6px; cursor: pointer">
              <n-checkbox
                :checked="gpgEnabled"
                @update:checked="handleToggleGpg"
              />
              <span
                style="font-size: 13px"
                :style="{ color: gpgEnabled ? 'var(--accent-green-dim)' : 'var(--text-dim)' }"
              >{{ gpgEnabled ? t('manage.gpgEnabled') : t('manage.gpgDisabled') }}</span>
            </label>
          </div>
          <div style="color: var(--text-dim); font-size: 12px">
            {{ t('manage.gpgDesc') }}
          </div>
        </div>
      </n-tab-pane>

      <n-tab-pane
        name="lfs"
        :tab="t('manage.lfs')"
      >
        <div
          v-if="lfsLoading"
          style="padding: 20px; text-align: center"
        >
          <n-spin size="small" />
        </div>
        <div
          v-else
          style="padding: 12px 4px"
        >
          <div style="display: flex; gap: 8px; margin-bottom: 12px; align-items: center">
            <span style="font-size: 13px; color: var(--text-body)">{{ t('manage.lfsStatus') }}</span>
            <span :style="{ color: lfsInstalled ? 'var(--accent-green-dim)' : 'var(--accent-red)', fontSize: '13px' }">
              {{ lfsInstalled ? t('manage.lfsInstalled') : t('manage.lfsNotInstalled') }}
            </span>
            <n-button
              v-if="!lfsInstalled"
              size="small"
              type="primary"
              @click="handleLfsInstall"
            >
              {{ t('manage.lfsInstall') }}
            </n-button>
            <div style="flex: 1" />
            <n-button
              v-if="lfsInstalled"
              size="small"
              @click="handleLfsPull"
            >
              {{ t('manage.lfsPull') }}
            </n-button>
            <n-button
              v-if="lfsInstalled"
              size="small"
              @click="handleLfsPush"
            >
              {{ t('manage.lfsPush') }}
            </n-button>
          </div>

          <div v-if="lfsInstalled">
            <div style="margin-bottom: 8px; font-size: 13px; color: var(--text-body)">
              {{ t('manage.trackRules') }}
            </div>
            <div style="display: flex; gap: 8px; margin-bottom: 8px">
              <n-input
                v-model:value="newLfsPattern"
                size="small"
                placeholder="*.psd"
                style="flex: 1"
              />
              <n-button
                size="small"
                type="primary"
                @click="handleLfsTrack"
              >
                {{ t('common.add') }}
              </n-button>
            </div>
            <div
              v-for="track in lfsTracks"
              :key="track.pattern"
              style="padding: 6px 4px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; gap: 8px; font-size: 13px"
            >
              <span style="color: var(--text-body); font-family: monospace">{{ track.pattern }}</span>
              <div style="flex: 1" />
              <n-button
                size="tiny"
                quaternary
                type="error"
                @click="handleLfsUntrack(track.pattern)"
              >
                {{ t('manage.remove') }}
              </n-button>
            </div>
          </div>
        </div>
      </n-tab-pane>

      <n-tab-pane
        name="hooks"
        :tab="t('manage.gitHooks')"
      >
        <div style="display: flex; height: 400px">
          <!-- Hook 列表 -->
          <div style="width: 180px; border-right: 1px solid var(--border-default); overflow-y: auto">
            <div
              v-if="hooksLoading"
              style="padding: 20px; text-align: center"
            >
              <n-spin size="small" />
            </div>
            <div
              v-else-if="hooks.length === 0"
              style="padding: 12px; color: var(--text-dim); font-size: 13px"
            >
              {{ t('manage.noHook') }}
            </div>
            <div
              v-for="hook in hooks"
              :key="hook.name"
              style="padding: 6px 12px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 6px"
              :style="{ background: selectedHook === hook.name ? 'var(--bg-active)' : 'transparent' }"
              @click="handleHookClick(hook.name)"
            >
              <span :style="{ color: hook.enabled ? 'var(--accent-green-dim)' : 'var(--text-dim)', fontSize: '10px' }">&#9679;</span>
              <span style="color: var(--text-body)">{{ hook.name }}</span>
            </div>
          </div>
          <!-- Hook 内容 -->
          <div style="flex: 1; display: flex; flex-direction: column; min-width: 0">
            <div
              v-if="!selectedHook"
              style="display: flex; align-items: center; justify-content: center; height: 100%"
            >
              <n-empty :description="t('manage.selectHookView')" />
            </div>
            <template v-else>
              <div style="background: var(--bg-panel); padding: 6px 12px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; gap: 8px">
                <span style="font-size: 13px; color: var(--text-body)">{{ selectedHook }}</span>
                <div style="flex: 1" />
                <n-button
                  size="tiny"
                  type="primary"
                  :loading="hookSaving"
                  @click="handleSaveHook"
                >
                  {{ t('common.save') }}
                </n-button>
              </div>
              <div
                v-if="hookContentLoading"
                style="padding: 20px; text-align: center"
              >
                <n-spin size="small" />
              </div>
              <n-input
                v-else
                v-model:value="hookContent"
                type="textarea"
                :autosize="false"
                style="flex: 1; font-family: var(--font-mono); font-size: 13px"
              />
            </template>
          </div>
        </div>
      </n-tab-pane>
    </n-tabs>

    <!-- 添加 Submodule 弹窗 -->
    <n-modal
      v-model:show="showAddSubmoduleModal"
      preset="dialog"
      :title="t('manage.addSubmodule')"
      :mask-closable="false"
      :positive-text="t('common.add')"
      :negative-text="t('common.cancel')"
      @positive-click="handleAddSubmodule"
    >
      <div style="display: flex; flex-direction: column; gap: 8px">
        <n-input
          v-model:value="newSubUrl"
          :placeholder="t('manage.subUrlPlaceholder')"
        />
        <n-input
          v-model:value="newSubPath"
          :placeholder="t('manage.subPathPlaceholder')"
        />
        <n-input
          v-model:value="newSubBranch"
          :placeholder="t('manage.subBranchPlaceholder')"
        />
      </div>
    </n-modal>

    <!-- 移除 Submodule 确认弹窗 -->
    <n-modal
      v-model:show="showRemoveSubConfirm"
      preset="dialog"
      :title="t('manage.removeSubmodule')"
      type="warning"
      :mask-closable="false"
      :positive-text="t('manage.confirmRemoveSubTitle')"
      :negative-text="t('common.cancel')"
      @positive-click="confirmRemoveSub"
    >
      <div style="color: var(--text-body); font-size: 13px">
        {{ t('manage.confirmRemoveSubmodule', { name: removeSubPath }) }}
      </div>
    </n-modal>
  </n-modal>
</template>
