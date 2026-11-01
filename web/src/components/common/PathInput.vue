<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { NInput, NButton, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { usePathBrowse } from '../../composables/usePathBrowse'

const props = withDefaults(
  defineProps<{
    value: string
    placeholder?: string
    size?: 'tiny' | 'small' | 'medium' | 'large'
    browseLabel?: string
    disabled?: boolean
  }>(),
  {
    size: 'small',
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:value': [v: string]
  select: [path: string]
  enter: []
}>()

const { t } = useI18n()

// 受控镜像：外部 value ↔ inner ref 双向同步（!== 守卫防回环）
const inner = ref(props.value)
watch(
  () => props.value,
  v => {
    if (v !== inner.value) inner.value = v
  },
)
watch(inner, v => emit('update:value', v))

const buttonLabel = computed(() => props.browseLabel ?? t('common.browse'))

// 自包含路径浏览状态机
const {
  suggestions,
  showSuggestions,
  selectedIdx,
  browseDirs,
  browseCurrent,
  browseLoading,
  canGoUp,
  goUp,
  selectCurrent,
  handleInputKeydown,
  blurSuggestions,
  selectSuggestion,
  handleBrowse,
  selectBrowseDir,
  closeBrowse,
} = usePathBrowse(inner, { onSelect: p => emit('select', p) })

// 面板列表不含 '..' 条目（上级交互收敛到头部按钮），链接目录保留展示
const browseSubDirs = computed(() => browseDirs.value.filter(d => d.name !== '..'))

// 输入框 Enter：联想下拉未消费时（未选中联想项）上抛 enter——宿主可接
// 提交动作（如添加项目弹窗 Enter 直达）；Shift/修饰键组合不上抛
function onInputKeydown(e: KeyboardEvent) {
  handleInputKeydown(e)
  if (e.defaultPrevented) return
  if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return
  emit('enter')
}

// 点击组件外部时关闭浏览面板 + 隐藏联想
const rootRef = ref<HTMLElement | null>(null)
function handleClickOutside(e: MouseEvent) {
  if (!rootRef.value) return
  if (!rootRef.value.contains(e.target as Node)) {
    closeBrowse()
    blurSuggestions()
  }
}
onMounted(() => document.addEventListener('mousedown', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('mousedown', handleClickOutside))
</script>

<template>
  <div
    ref="rootRef"
    class="path-input-root"
  >
    <div class="path-input-row">
      <div class="path-input-wrapper">
        <n-input
          v-model:value="inner"
          :placeholder="placeholder"
          :size="size"
          :disabled="disabled"
          @keydown="onInputKeydown"
          @blur="blurSuggestions"
        />
        <div
          v-if="showSuggestions && suggestions.length > 0"
          class="suggestions-dropdown"
        >
          <div
            v-for="(item, index) in suggestions"
            :key="item.path"
            class="suggestion-item"
            :class="{ 'suggestion-active': index === selectedIdx }"
            @mousedown.prevent="selectSuggestion(item)"
          >
            <span class="suggestion-icon">📁</span>
            <span>{{ item.name }}</span>
          </div>
        </div>
      </div>
      <n-button
        :size="size"
        :disabled="disabled"
        @click="handleBrowse"
      >
        {{ buttonLabel }}
      </n-button>
    </div>

    <div
      v-if="browseDirs.length > 0 || browseLoading"
      class="browse-panel"
    >
      <!-- 头部工具行（固定不随列表滚动）：常驻上级 + 当前路径 + 选中当前目录 -->
      <div class="browse-header">
        <button
          class="browse-up-btn"
          :disabled="!canGoUp"
          :title="t('common.parentDir')"
          @click="goUp"
        >
          ⬆
        </button>
        <span
          class="browse-path"
          :title="browseCurrent"
        >{{ browseCurrent }}</span>
        <n-button
          size="tiny"
          type="primary"
          :disabled="!browseCurrent"
          @click="selectCurrent"
        >
          {{ t('common.selectCurrentDir') }}
        </n-button>
      </div>
      <!-- 列表独立滚动：头部固定可见（sticky 在部分滚动链下不可靠） -->
      <div class="browse-list">
        <div
          v-if="browseLoading"
          style="padding: 16px; text-align: center; color: var(--text-dim)"
        >
          <n-spin size="small" />
        </div>
        <template v-else>
          <div
            v-if="browseSubDirs.length === 0"
            class="browse-empty"
          >
            {{ t('common.dirEmpty') }}
          </div>
          <div
            v-for="dir in browseSubDirs"
            :key="dir.path"
            class="browse-item"
            @click="selectBrowseDir(dir)"
          >
            <span class="browse-icon">{{ dir.link ? '🔗' : '📁' }}</span>
            <span class="browse-name">{{ dir.name }}</span>
            <span
              v-if="dir.link"
              class="browse-link-tag"
            >{{ t('common.symlinkDir') }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.path-input-row {
  display: flex;
  gap: 6px;
}
.path-input-wrapper {
  position: relative;
  flex: 1;
}
.suggestions-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  max-height: 240px;
  overflow-y: auto;
  margin-top: 4px;
  box-shadow: var(--shadow-pop);
}
.suggestion-item {
  padding: 8px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-hover);
  transition: background var(--motion-fast);
}
.suggestion-item:hover {
  background: var(--bg-hover);
}
.suggestion-active {
  background: var(--bg-active);
}
.suggestion-icon {
  font-size: 12px;
  width: 18px;
  text-align: center;
}
.browse-panel {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-primary);
  margin-top: 6px;
  display: flex;
  flex-direction: column;
}
.browse-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
}
.browse-list {
  overflow-y: auto;
  overflow-x: hidden;
  max-height: 210px;
}
.browse-up-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-hover);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
.browse-up-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.browse-up-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.browse-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
}
.browse-empty {
  padding: 14px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--text-dim);
}
.browse-item {
  padding: 6px 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-hover);
  transition: background var(--motion-fast);
}
.browse-item:hover {
  background: var(--bg-hover);
}
.browse-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.browse-link-tag {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 10px;
  color: var(--text-dim);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  padding: 0 4px;
  line-height: 16px;
}
.browse-icon {
  font-size: 12px;
  width: 18px;
  text-align: center;
}
</style>
