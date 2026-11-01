<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { NButton, NInput, NModal, useMessage } from 'naive-ui'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { gitConfigApi, gitignoreApi, gitattributesApi } from '../../api/client'
import NoProjectHint from './NoProjectHint.vue'
import SettingModifiedMark from './SettingModifiedMark.vue'

const props = defineProps<{ show: boolean }>()

const route = useRoute()
const projectStore = useProjectStore()
const { t } = useI18n()
const message = useMessage()

// 行级「已修改」标记（P-20261003-171，P-20261006-49 分区补全）：git 用户名/邮箱
// 出厂默认为空（空=跟随全局 git config，placeholder 同文案），非空即出标记；
// 恢复钮只清空本地输入，仍走「保存」链落盘，isDirty 关闭护栏语义不变。
// gitignore/gitattributes 是文件编辑器（无默认可比）、凭据类是 CRUD 面，跳过
const GIT_IDENTITY_DEFAULT = ''

const gitUserName = ref('')
const gitUserEmail = ref('')
// load 完成时的快照：关闭护栏用（gitignore/gitattributes 编辑器独立即时保存，不参与脏判定）
const savedUserName = ref('')
const savedUserEmail = ref('')
const showGitignoreModal = ref(false)
const gitignoreContent = ref('')
const gitignoreLoading = ref(false)
const showGitattributesModal = ref(false)
const gitattributesContent = ref('')
const gitattributesLoading = ref(false)

const hasProject = computed(() => route.name !== 'home' && !!projectStore.currentProjectId)

async function load() {
  gitUserName.value = ''
  gitUserEmail.value = ''
  if (hasProject.value) {
    try {
      const res: any = await gitConfigApi.get(projectStore.currentProjectId)
      gitUserName.value = res.data?.['user.name'] || ''
      gitUserEmail.value = res.data?.['user.email'] || ''
    } catch { /* silent */ }
  }
  savedUserName.value = gitUserName.value
  savedUserEmail.value = gitUserEmail.value
}

// 关闭护栏：表单相对 load 快照是否有偏离
function isDirty(): boolean {
  return gitUserName.value !== savedUserName.value || gitUserEmail.value !== savedUserEmail.value
}

async function save() {
  if (!hasProject.value) return
  const data: Record<string, string> = {}
  if (gitUserName.value) data['user.name'] = gitUserName.value
  if (gitUserEmail.value) data['user.email'] = gitUserEmail.value
  if (Object.keys(data).length > 0) {
    await gitConfigApi.set(projectStore.currentProjectId, data)
  }
}

async function openGitignoreEditor() {
  if (!hasProject.value) return
  gitignoreLoading.value = true
  showGitignoreModal.value = true
  try {
    const res: any = await gitignoreApi.get(projectStore.currentProjectId)
    gitignoreContent.value = res.data || ''
  } catch { /* 拦截器处理 */ }
  finally { gitignoreLoading.value = false }
}

async function saveGitignore() {
  if (!hasProject.value) return
  try {
    await gitignoreApi.update(projectStore.currentProjectId, gitignoreContent.value)
    message.success(t('layout.gitignoreSaved'))
    showGitignoreModal.value = false
  } catch { /* 拦截器处理 */ }
}

async function openGitattributesEditor() {
  if (!hasProject.value) return
  gitattributesLoading.value = true
  showGitattributesModal.value = true
  try {
    const res: any = await gitattributesApi.get(projectStore.currentProjectId)
    gitattributesContent.value = res.data || ''
  } catch { /* 拦截器处理 */ }
  finally { gitattributesLoading.value = false }
}

async function saveGitattributes() {
  if (!hasProject.value) return
  try {
    await gitattributesApi.update(projectStore.currentProjectId, gitattributesContent.value)
    message.success(t('layout.gitattributesSaved'))
    showGitattributesModal.value = false
  } catch { /* 拦截器处理 */ }
}

onMounted(() => {
  if (props.show) load()
})
watch(() => props.show, (val) => {
  if (val) load()
})
// 空态里就地「进入项目」后 hasProject 翻转，表单需加载当前项目配置
watch(hasProject, (val) => {
  if (val && props.show) load()
})

defineExpose({ load, save, isDirty })
</script>

<template>
  <div class="git-settings">
    <NoProjectHint
      v-if="!hasProject"
      :text="t('layout.gitConfigNoProject')"
      tab="git"
    />
    <template v-else>
      <div class="form-group">
        <div
          class="slider-row"
          data-testid="settings-git-user-name"
        >
          <span class="slider-label">{{ t('layout.userName') }}</span>
          <n-input
            v-model:value="gitUserName"
            size="small"
            style="flex: 1"
            :placeholder="t('layout.useGlobal')"
          />
          <SettingModifiedMark
            :modified="gitUserName !== GIT_IDENTITY_DEFAULT"
            @restore="gitUserName = GIT_IDENTITY_DEFAULT"
          />
        </div>
        <div
          class="slider-row"
          data-testid="settings-git-user-email"
        >
          <span class="slider-label">{{ t('layout.userEmail') }}</span>
          <n-input
            v-model:value="gitUserEmail"
            size="small"
            style="flex: 1"
            :placeholder="t('layout.useGlobal')"
          />
          <SettingModifiedMark
            :modified="gitUserEmail !== GIT_IDENTITY_DEFAULT"
            @restore="gitUserEmail = GIT_IDENTITY_DEFAULT"
          />
        </div>
      </div>
      <div
        class="form-actions"
        data-testid="settings-git-ignore-files"
      >
        <n-button
          size="small"
          @click="openGitignoreEditor"
        >
          {{ t('layout.editGitignore') }}
        </n-button>
        <n-button
          size="small"
          @click="openGitattributesEditor"
        >
          {{ t('layout.editGitattributes') }}
        </n-button>
      </div>
    </template>

    <!-- gitignore 弹窗 -->
    <n-modal
      v-model:show="showGitignoreModal"
      preset="dialog"
      title=".gitignore"
      :mask-closable="false"
      :positive-text="t('common.save')"
      :negative-text="t('common.cancel')"
      style="width: var(--modal-w-md); max-width: 94vw"
      @positive-click="saveGitignore"
    >
      <div
        v-if="gitignoreLoading"
        style="padding: 20px; text-align: center"
      >
        {{ t('layout.loading') }}
      </div>
      <n-input
        v-else
        v-model:value="gitignoreContent"
        type="textarea"
        :placeholder="t('layout.gitignorePlaceholder')"
        :autosize="{ minRows: 15, maxRows: 25 }"
        style="font-family: var(--font-mono); font-size: 13px"
      />
    </n-modal>

    <!-- gitattributes 弹窗 -->
    <n-modal
      v-model:show="showGitattributesModal"
      preset="dialog"
      title=".gitattributes"
      :mask-closable="false"
      :positive-text="t('common.save')"
      :negative-text="t('common.cancel')"
      style="width: var(--modal-w-md); max-width: 94vw"
      @positive-click="saveGitattributes"
    >
      <div
        v-if="gitattributesLoading"
        style="padding: 20px; text-align: center"
      >
        {{ t('layout.loading') }}
      </div>
      <n-input
        v-else
        v-model:value="gitattributesContent"
        type="textarea"
        :placeholder="t('layout.gitattributesPlaceholder')"
        :autosize="{ minRows: 15, maxRows: 25 }"
        style="font-family: var(--font-mono); font-size: 13px"
      />
    </n-modal>
  </div>
</template>

<style scoped>
.form-group { margin-bottom: 18px; }
.slider-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: 6px;
}
.slider-label {
  font-size: 12px;
  color: var(--text-dim);
  min-width: 80px;
}
.form-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: 10px;
}
</style>
