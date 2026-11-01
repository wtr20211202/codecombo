<script setup lang="ts">
// 设置弹窗中项目级配置的空态：首页打开设置时项目级项（Git 用户名/远程仓库）
// 不可配置，只有一行提示逼用户 关弹窗→回首页点项目→重开弹窗 走三步。
// 就地给出「选项目 → 进入工作空间」动作，一步到达
import { computed, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NSelect } from 'naive-ui'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { openSettingsTab } from '../../utils/openSettings'

const props = defineProps<{ text: string; tab?: string }>()

const projectStore = useProjectStore()
const router = useRouter()
const { t } = useI18n()

const options = computed(() =>
  projectStore.projects.map(p => ({ label: p.name, value: p.id })))
// 仅作为「进入」的目标选择：选中只改 store 的当前项目（首页上无害），
// 点「进入」才真正切工作空间（selectProjectExplicit 防历史值覆盖）
const picked = computed<string | null>({
  get: () => projectStore.currentProjectId || null,
  set: (v) => { if (v) projectStore.selectProject(v) },
})

async function enter() {
  if (!picked.value) return
  // 显式选择：进项目后 uiState 恢复流程不得用历史值覆盖（"进 A 跳 B"防回归）
  projectStore.selectProjectExplicit(picked.value)
  await router.push({ name: 'project' })
  // Layout 懒加载组件，等其完成挂载（onMounted 注册监听）后再请求打开设置；
  // openSettingsTab 是既有全局通道：宿主置 show + 弹窗切到来源分节，
  // 配置上下文不断层。错过事件也只是弹窗不开（退化为原行为），无副作用
  await nextTick()
  await nextTick()
  openSettingsTab(props.tab || 'general')
}
</script>

<template>
  <div
    class="no-project-hint"
    :class="{ empty: options.length === 0 }"
  >
    <span>{{ props.text }}</span>
    <div
      v-if="options.length > 0"
      class="no-project-actions"
    >
      <NSelect
        v-model:value="picked"
        size="small"
        :options="options"
        :placeholder="t('layout.pickProject')"
        style="width: 200px"
      />
      <NButton
        size="small"
        type="primary"
        @click="enter"
      >
        {{ t('layout.enterProject') }}
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.no-project-hint {
  font-size: 13px;
  color: var(--text-muted);
  padding: var(--space-4) 0;
}
.no-project-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: 10px;
}
</style>
