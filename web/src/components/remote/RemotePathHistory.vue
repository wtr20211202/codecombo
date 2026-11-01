<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NIcon, NPopover } from 'naive-ui'
import { TimeOutline, PinOutline, FolderOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { pathAlias } from '../../utils/remotePathMemory'

/**
 * 远程文件浏览路径历史快选（P-20261006-19，自 RemoteFilePane 工具条抽出的子组件）：
 * 置顶 pin 区（手动收藏常驻）+ 最近区（LRU 自动入史）两段式下拉，点选直达远端路径
 * （远程文件 API 直达路径无逐级概念，纯人类导航层，P-97 目录钉选同口径）。
 * 列表语义/持久化在 useRemoteFileBrowser + utils/remotePathMemory，本组件纯展示。
 */
const props = defineProps<{ pinned: string[]; recent: string[] }>()

const emit = defineEmits<{
  (e: 'select', path: string): void
  (e: 'togglePin', path: string): void
}>()

const { t } = useI18n()
const show = ref(false)

function onSelect(p: string) {
  show.value = false
  emit('select', p)
}
</script>

<template>
  <n-popover
    v-model:show="show"
    trigger="click"
    placement="bottom-start"
    :show-arrow="false"
  >
    <template #trigger>
      <n-button
        size="small"
        quaternary
        class="rf-hist-btn"
        :title="t('remoteFiles.history.title')"
        :aria-label="t('remoteFiles.history.title')"
      >
        <template #icon>
          <n-icon><TimeOutline /></n-icon>
        </template>
      </n-button>
    </template>
    <div
      class="rf-hist"
      data-testid="rf-history"
    >
      <template v-if="props.pinned.length">
        <div class="rf-hist-head">
          <n-icon :size="11"><PinOutline /></n-icon>
          <span>{{ t('remoteFiles.history.pinned') }}</span>
        </div>
        <div
          v-for="p in props.pinned"
          :key="p"
          class="rf-hist-item"
          :title="p"
          @click="onSelect(p)"
        >
          <n-icon
            :size="12"
            class="rf-hist-ico rf-hist-ico-pin"
          ><PinOutline /></n-icon>
          <span class="rf-hist-alias">{{ pathAlias(p) }}</span>
          <button
            class="rf-hist-act"
            :title="t('remoteFiles.history.unpin')"
            :aria-label="t('remoteFiles.history.unpin')"
            @click.stop="emit('togglePin', p)"
          >
            <n-icon :size="11"><CloseOutline /></n-icon>
          </button>
        </div>
      </template>
      <template v-if="props.recent.length">
        <div class="rf-hist-head">
          <n-icon :size="11"><TimeOutline /></n-icon>
          <span>{{ t('remoteFiles.history.recent') }}</span>
        </div>
        <div
          v-for="p in props.recent"
          :key="p"
          class="rf-hist-item"
          :title="p"
          @click="onSelect(p)"
        >
          <n-icon
            :size="12"
            class="rf-hist-ico"
          ><FolderOutline /></n-icon>
          <span class="rf-hist-alias">{{ pathAlias(p) }}</span>
          <button
            class="rf-hist-act"
            :title="t('remoteFiles.history.pin')"
            :aria-label="t('remoteFiles.history.pin')"
            @click.stop="emit('togglePin', p)"
          >
            <n-icon :size="11"><PinOutline /></n-icon>
          </button>
        </div>
      </template>
      <div
        v-if="!props.pinned.length && !props.recent.length"
        class="rf-hist-empty"
      >
        {{ t('remoteFiles.history.empty') }}
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
/* 面板容器（n-popover 内容区）：宽度定档，条目多时内部滚动 */
.rf-hist {
  width: 260px;
  max-height: 320px;
  overflow-y: auto;
}
.rf-hist-head {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px 2px;
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}
.rf-hist-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-primary);
  border: none;
  background: transparent;
  border-radius: 4px;
  text-align: left;
}
.rf-hist-item:hover { background: var(--bg-hover); }
.rf-hist-ico { flex-shrink: 0; color: var(--text-muted); }
/* 置顶项图标用强调色（FileTreeView 钉选区同式），最近项保持弱化灰 */
.rf-hist-ico-pin { color: var(--accent-blue-light); }
.rf-hist-alias {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
}
/* pin/unpin 微操作：hover 显形（FileTreeView 钉选区同式），占位防抖动 */
.rf-hist-act {
  visibility: hidden;
  flex-shrink: 0;
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 1px 3px;
  border-radius: 3px;
}
.rf-hist-item:hover .rf-hist-act { visibility: visible; }
.rf-hist-act:hover { color: var(--brand-accent); background: var(--bg-hover); }
.rf-hist-empty {
  padding: 10px 8px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
