<script setup lang="ts">
// 大纲视图：从当前编辑器内容提取结构（Markdown 标题、代码符号）
// 通过 Monaco 编辑器的 quick outline 命令导航
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { NIcon, NEmpty } from 'naive-ui'
import { ListOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { extractOutline, isMarkdownPath, type OutlineItem } from '../../utils/outline'

const props = defineProps<{
  content: string
  path: string
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'navigate', line: number): void
}>()

const { t } = useI18n()

// 大纲数据源：纯函数提取（Markdown 标题 / 代码声明行），见 utils/outline.ts
const outlineItems = computed<OutlineItem[]>(() => extractOutline(props.path, props.content))

const isMarkdown = computed(() => isMarkdownPath(props.path))

function clickItem(item: OutlineItem) {
  emit('navigate', item.line)
  emit('update:show', false)
}

function close() {
  emit('update:show', false)
}

// Esc 关闭：与其他弹层（命令面板/设置）的关闭惯例一致；有模态/抽屉在场上时让位
// （hasBlockingOverlay，Esc 一次只关最上层）
// ── 结果键盘导航（quick outline 惯例）：↑↓ 环绕移动，Enter 跳转 ──
const activeIdx = ref(-1)

watch([() => props.show, outlineItems], ([show]) => {
  // 打开/内容变化时定位首个条目；无条目重置
  activeIdx.value = show && outlineItems.value.length > 0 ? 0 : -1
})

function moveActive(delta: number) {
  const n = outlineItems.value.length
  if (n === 0) return
  activeIdx.value = ((activeIdx.value + delta) % n + n) % n
  void nextTick(() => {
    document.querySelector('.op-item.is-active')?.scrollIntoView({ block: 'nearest' })
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
  if (e.key === 'Enter' && activeIdx.value >= 0 && outlineItems.value[activeIdx.value]) {
    e.preventDefault()
    clickItem(outlineItems.value[activeIdx.value]!)
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
</script>

<template>
  <transition name="op-fade">
    <div
      v-if="props.show"
      class="op-mask"
      @click.self="close"
    >
      <div class="op-card glass-panel">
        <div class="op-header">
          <n-icon
            size="13"
            class="op-icon"
          >
            <ListOutline />
          </n-icon>
          <span class="op-title">{{ t('outline.title') }}</span>
          <span class="op-file">{{ props.path.split('/').pop() }}</span>
          <button
            class="op-close"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <div class="op-list">
          <div
            v-if="outlineItems.length === 0 && !isMarkdown"
            class="op-hint"
          >
            <n-empty
              size="small"
              :description="t('outline.codeHint')"
            />
          </div>
          <div
            v-else-if="outlineItems.length === 0"
            class="op-hint"
          >
            <n-empty
              size="small"
              :description="t('outline.empty')"
            />
          </div>
          <template v-else>
            <button
              v-for="(item, idx) in outlineItems"
              :key="idx"
              class="op-item"
              :class="{ 'is-active': idx === activeIdx }"
              :style="{ paddingLeft: (8 + (item.level - 1) * 14) + 'px' }"
              @click="clickItem(item)"
            >
              <span class="op-h-marker">H{{ item.level }}</span>
              <span class="op-text">{{ item.text }}</span>
              <span class="op-line">{{ item.line }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.op-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.op-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 320px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.op-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.op-icon { color: var(--brand-accent); }
.op-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.op-file {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-close {
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
.op-close:hover { color: var(--text-primary); background: var(--bg-hover); }

.op-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}
.op-hint {
  padding: 28px 16px;
  display: flex;
  justify-content: center;
}
.op-item {
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
.op-item:hover { background: var(--bg-hover); }

.op-item.is-active,
.op-item.is-active:hover {
  background: var(--bg-active);
}
.op-h-marker {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.op-text {
  font-size: 12px;
  color: var(--text-body);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.op-line {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.op-fade-enter-active,
.op-fade-leave-active { transition: opacity var(--motion-base); }
.op-fade-enter-active .op-card,
.op-fade-leave-active .op-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.op-fade-enter-from,
.op-fade-leave-to { opacity: 0; }
.op-fade-enter-from .op-card,
.op-fade-leave-to .op-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
