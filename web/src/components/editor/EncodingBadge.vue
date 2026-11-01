<script setup lang="ts">
// 编辑器编码徽标（P-20261002-146）：Breadcrumb extra 槽位展示当前文件编码
// （GBK/UTF-8 等小徽标），点击弹小编码菜单——重新以指定编码载入 / 转为指定
// 编码保存。diff 伪文件、未命名草稿、元信息卡（binary/too-large）、载入中
// 均无编码信息不渲染；动作经宿主 emit 链落到 useOpenFiles（状态修改不走直调）
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { FILE_ENCODINGS, encodingLabel, encodingTestId } from '../../utils/fileEncoding'
import { isUntitledPath, type OpenFile } from '../../composables/useOpenFiles'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  /** 当前打开的文件（宿主组的 currentFile；null = 空组不渲染） */
  file: OpenFile | null
}>()

const emit = defineEmits<{
  (e: 'reload', encoding: string): void
  (e: 'saveAs', encoding: string): void
}>()

const { t } = useI18n()

// 可见性：真实磁盘文本文件才谈编码（调用方约定同「无编码信息时不显示」）
const visible = computed(() => {
  const f = props.file
  if (!f) return false
  if (f.isDiff) return false
  if (f.meta) return false
  if (f.loading) return false
  if (isUntitledPath(f.path)) return false
  return true
})

const label = computed(() => encodingLabel(props.file?.encoding))
const currentEncoding = computed(() => props.file?.encoding || '')

// ── 编码菜单弹层（Breadcrumb 同级导航弹层同款交互：锚定按钮下缘、
// 点外关闭、ESC 关闭）───────────────────────────────────────
const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const badgeRef = ref<HTMLElement | null>(null)

function toggleMenu() {
  if (showMenu.value) {
    showMenu.value = false
    return
  }
  const rect = badgeRef.value?.getBoundingClientRect()
  if (rect) {
    // 右缘防溢出（同级导航弹层同款收紧）
    menuX.value = Math.max(4, Math.min(rect.left, window.innerWidth - 230))
    menuY.value = rect.bottom + 4
  }
  showMenu.value = true
}

function closeMenu() {
  showMenu.value = false
}

function onReload(encoding: string) {
  closeMenu()
  emit('reload', encoding)
}

function onSaveAs(encoding: string) {
  closeMenu()
  emit('saveAs', encoding)
}

function handleClickOutside(e: MouseEvent) {
  if (!showMenu.value) return
  const target = e.target as HTMLElement
  const menu = document.querySelector('.encoding-menu')
  if (menu && !menu.contains(target) && !badgeRef.value?.contains(target)) closeMenu()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && showMenu.value) closeMenu()
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <button
    v-if="visible"
    ref="badgeRef"
    class="encoding-badge"
    data-testid="encoding-badge"
    :title="t('files.encoding.badgeTip', { enc: label })"
    @click="toggleMenu"
  >
    {{ label }}
  </button>
  <transition name="fade-fast">
    <div
      v-if="showMenu"
      class="encoding-menu"
      data-testid="encoding-menu"
      :style="{ left: menuX + 'px', top: menuY + 'px' }"
    >
      <div class="encoding-menu-title">
        {{ t('files.encoding.reloadTitle') }}
      </div>
      <button
        v-for="opt in FILE_ENCODINGS"
        :key="'r-' + opt.value"
        class="encoding-item"
        :class="{ current: opt.value === currentEncoding }"
        :data-testid="'encoding-reload-' + encodingTestId(opt.value)"
        @click="onReload(opt.value)"
      >
        {{ opt.label }}
      </button>
      <div class="encoding-menu-divider" />
      <div class="encoding-menu-title">
        {{ t('files.encoding.saveAsTitle') }}
      </div>
      <button
        v-for="opt in FILE_ENCODINGS"
        :key="'s-' + opt.value"
        class="encoding-item"
        :class="{ current: opt.value === currentEncoding }"
        :data-testid="'encoding-save-' + encodingTestId(opt.value)"
        @click="onSaveAs(opt.value)"
      >
        {{ opt.label }}<span
          v-if="opt.value === currentEncoding"
          class="encoding-item-note"
        >{{ t('files.encoding.current') }}</span>
      </button>
    </div>
  </transition>
</template>

<style scoped>
.encoding-badge {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  font-size: 10px;
  font-family: var(--font-mono);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  cursor: pointer;
  transition: all var(--motion-base);
  flex-shrink: 0;
}
.encoding-badge:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.encoding-menu {
  position: fixed;
  z-index: 9999;
  min-width: 190px;
  max-width: 230px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-strong);
  padding: 4px 0;
}

.encoding-menu-title {
  padding: 5px 12px 3px;
  font-size: 10px;
  color: var(--text-muted);
  user-select: none;
}

.encoding-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-body);
  font-size: 12px;
  font-family: var(--font-mono);
  cursor: pointer;
  text-align: left;
  transition: background var(--motion-fast);
}
.encoding-item:hover {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}
/* 当前编码行：品牌色标记（同级导航弹层 .current 同形态），不做禁用——
   重载当前编码 = 单纯重读磁盘，按当前编码保存 = 既有保存链，均有语义 */
.encoding-item.current {
  color: var(--brand-accent);
  font-weight: 500;
}

.encoding-item-note {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted);
}

.encoding-menu-divider {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity var(--motion-base), transform var(--motion-base);
}
.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
