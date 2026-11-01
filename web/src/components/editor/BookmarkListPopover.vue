<script setup lang="ts">
// 书签列表弹层（P-20261002-131）：当前项目全部书签（跨文件），点选跳回书签行
// （开文件 + 行定位走宿主 handleSearchOpenFile 既有链路，同 OutlinePopover 的
// outline-navigate 接线）。数据源 useEditorBookmarks 模块单例，与本组件宿主
// 层级解耦
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NIcon, NEmpty } from 'naive-ui'
import { BookmarkOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { useProjectStore } from '../../stores/project'
import { useEditorBookmarks, type BookmarkLocation } from '../../composables/useEditorBookmarks'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'navigate', path: string, line: number): void
}>()

const { t } = useI18n()
const projectStore = useProjectStore()
const bookmarks = useEditorBookmarks()

// 展开前确保持久化状态已加载（懒加载一次；重复调用幂等）
watch(() => props.show, (show) => {
  if (show) void bookmarks.ensureLoaded()
}, { immediate: true })

const projectId = computed(() => projectStore.currentProjectId || '')
const items = computed<BookmarkLocation[]>(() =>
  props.show ? bookmarks.listBookmarksOf(projectId.value) : [])

function clickItem(item: BookmarkLocation) {
  emit('navigate', item.path, item.line)
  emit('update:show', false)
}

function close() {
  emit('update:show', false)
}

// Esc 关闭：与其他弹层（命令面板/大纲）的关闭惯例一致；有模态/抽屉在场上时让位
// ── 结果键盘导航（quick outline 惯例）：↑↓ 环绕移动，Enter 跳转 ──
const activeIdx = ref(-1)

watch([() => props.show, items], ([show]) => {
  // 打开/内容变化时定位首个条目；无条目重置
  activeIdx.value = show && items.value.length > 0 ? 0 : -1
})

function moveActive(delta: number) {
  const n = items.value.length
  if (n === 0) return
  activeIdx.value = ((activeIdx.value + delta) % n + n) % n
  void nextTick(() => {
    document.querySelector('.bm-item.is-active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show) return
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出最大化）不重复处理
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveActive(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveActive(-1)
    return
  }
  if (e.key === 'Enter' && activeIdx.value >= 0 && items.value[activeIdx.value]) {
    e.preventDefault()
    clickItem(items.value[activeIdx.value]!)
    return
  }
  if (e.key === 'Escape') {
    if (hasBlockingOverlay()) return
    e.preventDefault()
    close()
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

/** 行显示名：路径末段；同名文件（跨目录）在副标题路径里区分 */
function fileNameOf(p: string): string {
  return p.split('/').pop() || p
}
</script>

<template>
  <transition name="bm-fade">
    <div
      v-if="props.show"
      class="bm-mask"
      @click.self="close"
    >
      <div
        class="bm-card glass-panel"
        data-testid="bookmark-list"
      >
        <div class="bm-header">
          <n-icon
            size="13"
            class="bm-icon"
          >
            <BookmarkOutline />
          </n-icon>
          <span class="bm-title">{{ t('editor.bookmark.listTitle') }}</span>
          <span class="bm-count">{{ items.length }}</span>
          <button
            class="bm-close"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <div class="bm-list">
          <div
            v-if="items.length === 0"
            class="bm-hint"
          >
            <n-empty
              size="small"
              :description="t('editor.bookmark.empty')"
            />
          </div>
          <template v-else>
            <button
              v-for="(item, idx) in items"
              :key="item.path + ':' + item.line + ':' + idx"
              class="bm-item"
              :class="{ 'is-active': idx === activeIdx }"
              :data-testid="`bookmark-item-${item.line}`"
              @click="clickItem(item)"
            >
              <n-icon
                size="12"
                class="bm-item-icon"
                :class="{ 'is-stale': item.stale }"
              >
                <BookmarkOutline />
              </n-icon>
              <div class="bm-item-main">
                <div class="bm-item-name">
                  {{ fileNameOf(item.path) }}
                </div>
                <div class="bm-item-path">
                  {{ item.path }}
                </div>
              </div>
              <span
                v-if="item.stale"
                class="bm-item-stale"
                data-testid="bookmark-stale-badge"
              >{{ t('editor.bookmark.staleBadge') }}</span>
              <span class="bm-item-line">{{ t('editor.bookmark.lineLabel', { line: item.line }) }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.bm-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.bm-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 340px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.bm-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.bm-icon { color: var(--accent-orange); }
.bm-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.bm-count {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-panel);
  border-radius: 8px;
  padding: 0 6px;
}
.bm-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bm-close:hover { color: var(--text-primary); background: var(--bg-hover); }

.bm-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.bm-hint {
  padding: 28px 16px;
  display: flex;
  justify-content: center;
}
.bm-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 12px 5px 8px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}
.bm-item:hover { background: var(--bg-hover); }

.bm-item.is-active,
.bm-item.is-active:hover {
  background: var(--bg-active);
}
.bm-item-icon { color: var(--accent-orange); flex-shrink: 0; }
/* 失效弱标（P-20261004-105）：锚未找回落位的条目整体弱化，附「可能已漂移」小标 */
.bm-item-icon.is-stale { opacity: 0.45; filter: grayscale(0.9); }
.bm-item-stale {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-muted);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 0 5px;
  line-height: 16px;
}
.bm-item-main {
  flex: 1;
  min-width: 0;
}
.bm-item-name {
  font-size: 12px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-item-path {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bm-item-line {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.bm-fade-enter-active,
.bm-fade-leave-active { transition: opacity var(--motion-base); }
.bm-fade-enter-active .bm-card,
.bm-fade-leave-active .bm-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.bm-fade-enter-from,
.bm-fade-leave-to { opacity: 0; }
.bm-fade-enter-from .bm-card,
.bm-fade-leave-to .bm-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
