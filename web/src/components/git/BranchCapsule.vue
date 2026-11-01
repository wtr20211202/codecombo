<script setup lang="ts">
// 顶部工具栏的分支胶囊：展示当前分支 + ahead/behind，点击展开分支切换面板
import { ref, computed, onMounted, watch, onBeforeUnmount, nextTick } from 'vue'
import { NIcon, NInput, NEmpty, NSpin } from 'naive-ui'
import { GitBranchOutline, ArrowUpOutline, ArrowDownOutline, AddOutline, CheckmarkOutline, SearchOutline } from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { branchApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'

const projectStore = useProjectStore()
const { t } = useI18n()

interface Branch { name: string; current: boolean; isRemote: boolean }
const branches = ref<Branch[]>([])
const loading = ref(false)
const showPanel = ref(false)
const searchQuery = ref('')
const panelRef = ref<HTMLElement | null>(null)
const capsuleRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<InstanceType<typeof NInput> | null>(null)

// 本地分支 + 远程分支分组
const localBranches = computed(() => branches.value.filter(b => !b.isRemote))
const remoteBranches = computed(() => branches.value.filter(b => b.isRemote))

const filteredLocal = computed(() => {
  if (!searchQuery.value) return localBranches.value
  const q = searchQuery.value.toLowerCase()
  return localBranches.value.filter(b => b.name.toLowerCase().includes(q))
})
const filteredRemote = computed(() => {
  if (!searchQuery.value) return remoteBranches.value
  const q = searchQuery.value.toLowerCase()
  return remoteBranches.value.filter(b => b.name.toLowerCase().includes(q))
})

const currentBranch = computed(() => projectStore.currentProject?.currentBranch || '')

const props = defineProps<{
  ahead?: number
  behind?: number
}>()

const emit = defineEmits<{
  (e: 'new-branch'): void
  (e: 'branch-changed', name: string): void
}>()

async function fetchBranches() {
  if (!projectStore.currentProjectId) return
  loading.value = true
  try {
    const res: any = await branchApi.list(projectStore.currentProjectId)
    branches.value = (res.data || []).map((b: any) => ({
      name: b.name,
      current: b.isCurrent || false,
      isRemote: b.isRemote || false,
    }))
  } catch { branches.value = [] }
  finally { loading.value = false }
}

function togglePanel() {
  showPanel.value = !showPanel.value
  if (showPanel.value) {
    fetchBranches()
    nextTick(() => {
      searchInputRef.value?.focus()
    })
  }
}

function closePanel() {
  showPanel.value = false
  searchQuery.value = ''
}

async function checkout(name: string) {
  if (!projectStore.currentProjectId) return
  // 当前分支不切换
  if (name === currentBranch.value) {
    closePanel()
    return
  }
  try {
    await branchApi.checkout(projectStore.currentProjectId, name)
    emit('branch-changed', name)
    closePanel()
    // 触发项目列表刷新
    await projectStore.fetchProjects()
  } catch (e: any) {
    // 错误由父级 message 处理
    console.error('branch checkout failed', e)
  }
}

// 外部点击关闭
function handleClickOutside(e: MouseEvent) {
  if (!showPanel.value) return
  const target = e.target as Node
  if (panelRef.value && !panelRef.value.contains(target) &&
      capsuleRef.value && !capsuleRef.value.contains(target)) {
    closePanel()
  }
}

// Esc 关闭
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && showPanel.value) {
    closePanel()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})

// 项目切换时重置
watch(() => projectStore.currentProjectId, () => {
  branches.value = []
  closePanel()
})

defineExpose({ refresh: fetchBranches })
</script>

<template>
  <div class="branch-capsule-wrap">
    <!-- 胶囊主体 -->
    <button
      ref="capsuleRef"
      class="branch-capsule"
      :class="{ active: showPanel }"
      :title="t('toolbar2.branchSwitch')"
      @click="togglePanel"
    >
      <n-icon
        size="13"
        class="capsule-icon"
      >
        <GitBranchOutline />
      </n-icon>
      <!-- 分支名在胶囊内 140px 截断；悬停看全名（按钮本体 title 仍是切换动作提示） -->
      <span
        class="capsule-name"
        :title="currentBranch || t('layout.noBranch')"
      >{{ currentBranch || t('layout.noBranch') }}</span>
      <span
        v-if="(props.ahead ?? 0) > 0"
        class="capsule-badge ahead"
      >
        <n-icon size="10"><ArrowUpOutline /></n-icon>{{ props.ahead }}
      </span>
      <span
        v-if="(props.behind ?? 0) > 0"
        class="capsule-badge behind"
      >
        <n-icon size="10"><ArrowDownOutline /></n-icon>{{ props.behind }}
      </span>
      <span
        v-if="(props.ahead ?? 0) === 0 && (props.behind ?? 0) === 0"
        class="capsule-chev"
      >▾</span>
    </button>

    <!-- 下拉面板 -->
    <transition name="fade-slide">
      <div
        v-if="showPanel"
        ref="panelRef"
        class="branch-panel glass-panel"
      >
        <!-- 搜索栏 -->
        <div class="bp-header">
          <n-input
            ref="searchInputRef"
            v-model:value="searchQuery"
            size="small"
            :placeholder="t('toolbar2.searchBranch')"
            clearable
          >
            <template #prefix>
              <n-icon size="12">
                <SearchOutline />
              </n-icon>
            </template>
          </n-input>
          <button
            class="bp-new-btn"
            :title="t('toolbar2.newBranch')"
            @click="emit('new-branch')"
          >
            <n-icon size="14">
              <AddOutline />
            </n-icon>
          </button>
        </div>

        <!-- 分支列表 -->
        <div
          v-if="loading"
          class="bp-loading"
        >
          <n-spin size="small" />
        </div>
        <div
          v-else-if="filteredLocal.length === 0 && filteredRemote.length === 0"
          class="bp-empty"
        >
          <n-empty
            size="small"
            :description="t('commandPalette.noResults')"
          />
        </div>
        <div
          v-else
          class="bp-list"
        >
          <!-- 本地分支 -->
          <div
            v-if="filteredLocal.length > 0"
            class="bp-section"
          >
            <div class="bp-section-title">
              {{ t('git.local') }} · {{ filteredLocal.length }}
            </div>
            <div
              v-for="b in filteredLocal"
              :key="b.name"
              class="bp-item"
              :class="{ current: b.current }"
              :title="b.name"
              @click="checkout(b.name)"
            >
              <n-icon
                size="13"
                class="bp-item-icon"
              >
                <GitBranchOutline />
              </n-icon>
              <span class="bp-item-name">{{ b.name }}</span>
              <n-icon
                v-if="b.current"
                size="14"
                class="bp-item-check"
              >
                <CheckmarkOutline />
              </n-icon>
            </div>
          </div>
          <!-- 远程分支 -->
          <div
            v-if="filteredRemote.length > 0"
            class="bp-section"
          >
            <div class="bp-section-title">
              {{ t('git.remotes') }} · {{ filteredRemote.length }}
            </div>
            <div
              v-for="b in filteredRemote"
              :key="b.name"
              class="bp-item remote"
              :title="b.name"
              @click="checkout(b.name)"
            >
              <n-icon
                size="13"
                class="bp-item-icon"
              >
                <GitBranchOutline />
              </n-icon>
              <span class="bp-item-name">{{ b.name }}</span>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.branch-capsule-wrap {
  position: relative;
  display: inline-flex;
}

.branch-capsule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--border-subtle);
  border-radius: 13px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 12px;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: all var(--motion-base);
  max-width: 240px;
}

.branch-capsule:hover {
  border-color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.branch-capsule.active {
  border-color: var(--brand-accent);
  background: var(--brand-accent-soft);
  box-shadow: 0 0 0 2px var(--brand-accent-soft);
}

.capsule-icon {
  color: var(--brand-accent);
  flex-shrink: 0;
}

.capsule-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
  font-weight: var(--fw-medium);
}

.capsule-badge {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 0 5px;
  height: 16px;
  border-radius: var(--radius-lg);
  font-size: 10px;
  font-weight: var(--fw-semibold);
  font-family: var(--font-ui);
}

.capsule-badge.ahead {
  background: color-mix(in srgb, var(--accent-green) 16%, transparent);
  color: var(--accent-green);
}

.capsule-badge.behind {
  background: color-mix(in srgb, var(--accent-orange) 18%, transparent);
  color: var(--accent-orange);
}

.capsule-chev {
  color: var(--text-muted);
  font-size: 10px;
  margin-left: 1px;
}

/* 下拉面板 */
.branch-panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  width: 320px;
  max-height: 420px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-strong);
  z-index: 100;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.bp-header {
  display: flex;
  gap: 6px;
  padding: 10px 10px var(--space-2);
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-overlay);
}

.bp-new-btn {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--motion-base);
}

.bp-new-btn:hover {
  color: var(--brand-accent);
  border-color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.bp-loading, .bp-empty {
  padding: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.bp-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1) 0;
}

.bp-section {
  margin-bottom: var(--space-1);
}

.bp-section-title {
  font-size: 10px;
  font-weight: var(--fw-semibold);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
  padding: 6px 14px var(--space-1);
}

.bp-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 5px 14px;
  font-size: 12px;
  color: var(--text-body);
  cursor: pointer;
  font-family: var(--font-mono);
  transition: background var(--motion-fast);
}

.bp-item:hover {
  background: var(--bg-hover);
}

.bp-item.current {
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.bp-item.remote {
  color: var(--text-secondary);
}

.bp-item-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.bp-item.current .bp-item-icon {
  color: var(--brand-accent);
}

.bp-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bp-item-check {
  color: var(--brand-accent);
  flex-shrink: 0;
}
</style>
