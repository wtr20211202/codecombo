<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AtPopoverPlacement, AtSuggestion } from '../../composables/useAtFileCompletion'

/**
 * @ 文件引用补全浮层（P-20261005-196，NewSessionDialog 与排队指令输入共用）：
 * 纯展示 + 点选上报，触发/过滤/插入全在 useAtFileCompletion。fixed 定位（侧栏
 * 树与模态卡都有 overflow 滚动祖先，absolute 会被裁剪；z-index 3500 = 模态
 * 卡与审批卡堆（3000）之上——补全是临时增益面，在场时必须可点）。条目按
 * 「目录段淡化 + 当前段高亮」展示完整相对路径（提案②「显示相对路径（目录段
 * 淡化）」）；mousedown.prevent 保住输入框焦点（focusout 关浮层链不误触点选）。
 */
const props = defineProps<{
  items: AtSuggestion[]
  activeIndex: number
  placement: AtPopoverPlacement
}>()

const emit = defineEmits<{
  (e: 'select', index: number): void
  (e: 'hover', index: number): void
}>()

const { t } = useI18n()

const listEl = ref<HTMLElement | null>(null)

/** 路径拆展示段：目录段（含尾斜杠）淡化数组 + 末段高亮（目录条目末段带尾 /） */
function splitDisplay(path: string): { dirs: string[]; name: string } {
  const isDir = path.endsWith('/')
  const p = isDir ? path.slice(0, -1) : path
  const i = p.lastIndexOf('/')
  if (i === -1) return { dirs: [], name: path }
  return {
    dirs: p.slice(0, i + 1).split('/').filter(Boolean).map(seg => `${seg}/`),
    name: p.slice(i + 1) + (isDir ? '/' : ''),
  }
}

// 键盘 ↑↓ 移动活动项时保持其在滚动视口内（命令面板/下拉同款跟随语义）
watch(() => props.activeIndex, async (i) => {
  await nextTick()
  const el = listEl.value?.children[i] as HTMLElement | undefined
  el?.scrollIntoView({ block: 'nearest' })
})
</script>

<template>
  <div
    class="atfc-pop"
    data-testid="at-completion"
    :style="{ left: placement.left, top: placement.top, bottom: placement.bottom }"
  >
    <div
      ref="listEl"
      class="atfc-list"
    >
      <button
        v-for="(it, i) in items"
        :key="it.path"
        type="button"
        class="atfc-item"
        :class="{ active: i === activeIndex }"
        :data-testid="`at-completion-item-${i}`"
        @mousedown.prevent
        @click="emit('select', i)"
        @mousemove="emit('hover', i)"
      >
        <span class="atfc-path">
          <span
            v-for="(seg, j) in splitDisplay(it.path).dirs"
            :key="j"
            class="atfc-dir"
          >{{ seg }}</span>
          <span
            class="atfc-name"
            :class="{ 'is-dir': it.kind === 'dir' }"
          >{{ splitDisplay(it.path).name }}</span>
        </span>
      </button>
    </div>
    <div class="atfc-hint">
      {{ t('agentTerminal.atComplete.hint') }}
    </div>
  </div>
</template>

<style scoped>
.atfc-pop {
  position: fixed;
  z-index: 3500; /* 模态卡（naive 默认 2000+）与审批卡堆（3000）之上的临时增益面 */
  display: flex;
  flex-direction: column;
  width: 420px;
  max-width: calc(100vw - 8px);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-elevated);
  /* 输入建议弹层 = 弹层投影阶梯 --shadow-pop（main.css 四档制，禁止散落硬编码） */
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.atfc-list {
  max-height: 248px;
  overflow-y: auto;
  padding: 3px;
}
.atfc-item {
  display: block;
  width: 100%;
  padding: 4px 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.atfc-item:hover,
.atfc-item.active {
  background: var(--bg-hover);
}
.atfc-path {
  font-family: var(--font-mono, monospace);
}
.atfc-dir {
  color: var(--text-dim);
}
.atfc-name.is-dir {
  color: var(--accent-blue);
}
.atfc-hint {
  padding: 3px 10px;
  border-top: 1px solid var(--border-subtle);
  color: var(--text-dim);
  font-size: 11px;
  user-select: none;
}
</style>
