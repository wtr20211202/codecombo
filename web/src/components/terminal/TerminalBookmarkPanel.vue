<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, useMessage } from 'naive-ui'
import { CloseOutline, TrashOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import {
  bookmarkVersion,
  listBookmarks,
  removeBookmarkAtLine,
  scrollToBookmark,
  type TerminalBookmarkInfo,
} from '../../composables/terminalBookmarks'

/**
 * 终端 scrollback 书签列表（P-20261004-16）：侧板形式挂在终端区内（命令历史
 * 面板同款布局语）。
 * - 列表：行号 + 标记时刻行文本摘要 → 点击滚动定位（书签行落视口顶）；
 *   行内 ✕ 摘除（免确认——低风险且可重新标记，与命令历史单条删除同口径）
 * - 数据面：composable 模块级书签表（会话内存态，MVP 不持久化），watch
 *   bookmarkVersion 重读——加/删/环形淘汰失效（书签行滚出 scrollback 上限，
 *   xterm dispose marker）都会 bump 版本，列表即时反映，无轮询
 * - 书签按会话（pane）隔离：split 双 pane 各自书签互不串（sessionId 键控）
 */
const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const { t } = useI18n()
const message = useMessage()

// 列表快照：watch 版本号重读（模块级非响应式 Map 的响应式投影）
const bookmarks = ref<TerminalBookmarkInfo[]>([])
watch(
  [bookmarkVersion, () => props.sessionId],
  () => {
    bookmarks.value = listBookmarks(props.sessionId)
  },
  { immediate: true },
)

const hasBookmarks = computed(() => bookmarks.value.length > 0)

/** 点击定位：书签行落视口顶；实例缺失（挂起/已断开）明确告知而非静默无效 */
function jumpTo(bm: TerminalBookmarkInfo): void {
  if (!scrollToBookmark(props.sessionId, bm.line)) {
    message.warning(t('terminal.notConnected'))
  }
}

/** 行内摘除：marker dispose 即装饰连带消亡 + 版本 bump，行随重读消失 */
function removeAt(bm: TerminalBookmarkInfo): void {
  removeBookmarkAtLine(props.sessionId, bm.line)
}
</script>

<template>
  <aside
    class="bookmark-panel"
    data-testid="terminal-bookmark-panel"
  >
    <div class="bookmark-header">
      <span class="bookmark-title">
        {{ t('terminal.bookmark.panelTitle') }}
        <span
          v-if="hasBookmarks"
          class="bookmark-count"
        >{{ bookmarks.length }}</span>
      </span>
      <n-button
        size="tiny"
        quaternary
        :title="t('common.close')"
        data-testid="terminal-bookmark-close"
        @click="emit('close')"
      >
        <template #icon>
          <n-icon size="13">
            <CloseOutline />
          </n-icon>
        </template>
      </n-button>
    </div>
    <div
      v-if="hasBookmarks"
      class="bookmark-list"
    >
      <div
        v-for="bm in bookmarks"
        :key="bm.line"
        class="bookmark-row"
        :title="bm.text"
        data-testid="terminal-bookmark-row"
        @click="jumpTo(bm)"
      >
        <span class="bookmark-line-no">L{{ bm.line + 1 }}</span>
        <span class="bookmark-text">{{ bm.text || t('terminal.bookmark.emptyLine') }}</span>
        <button
          class="bookmark-remove"
          :title="t('terminal.bookmark.remove')"
          @click.stop="removeAt(bm)"
        >
          <n-icon size="12">
            <TrashOutline />
          </n-icon>
        </button>
      </div>
    </div>
    <div
      v-else
      class="bookmark-empty"
    >
      <n-empty
        size="small"
        :description="t('terminal.bookmark.empty')"
      />
      <div class="bookmark-empty-hint">
        {{ t('terminal.bookmark.emptyHint') }}
      </div>
    </div>
  </aside>
</template>

<style scoped>
.bookmark-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 360px;
  max-width: 60%;
  z-index: 25;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-default);
  box-shadow: var(--shadow-pop-drawer);
}
.bookmark-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-default);
}
.bookmark-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}
.bookmark-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-dim);
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 0 7px;
  line-height: 16px;
}
.bookmark-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.bookmark-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-body);
}
.bookmark-row:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.bookmark-line-no {
  flex: none;
  min-width: 44px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--accent-yellow-warm);
  text-align: right;
}
.bookmark-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bookmark-remove {
  flex: none;
  display: none;
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
}
.bookmark-remove:hover {
  color: var(--accent-red);
  background: var(--bg-hover);
}
.bookmark-row:hover .bookmark-remove {
  display: inline-flex;
}
.bookmark-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
}
.bookmark-empty-hint {
  font-size: 12px;
  color: var(--text-dim);
  text-align: center;
  line-height: 1.6;
}
</style>
