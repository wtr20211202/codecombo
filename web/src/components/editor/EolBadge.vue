<script setup lang="ts">
// 编辑器行尾（EOL）徽标（P-20261004-140）：Breadcrumb extra 槽 EncodingBadge
// 邻位，展示当前 Monaco 模型的行尾序列（LF/CRLF）。EOL 是文件内容属性、无
// 平台假设（win 开发者 CRLF 常态、远端 Linux 一律 LF），行尾无可见性时误存
// 异种行尾 = git 整文件伪 diff（内容零实质变更却全文件红绿）。点击弹小菜单
// 「转为 LF / 转为 CRLF」（当前项打勾）；转换只改模型 EOL 属性（宿主
// convertEol 链，pushEOL 落撤销栈可回退），产生脏态走显式 Ctrl+S。可见性由
// 宿主控制（eol 传 null 即不渲染）：沿 EncodingBadge 惯例排除 diff 伪文件/
// 元信息卡/载入中/未命名草稿，远程伪路径同样适用（远端文件 EOL 语义一致），
// 离线只读（remoteOffline）不提供——只读态转换完不成写回
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  /** 当前模型行尾序列（宿主从编辑器实例读取；null = 不可显示不渲染） */
  eol: 'LF' | 'CRLF' | null
}>()

const emit = defineEmits<{
  (e: 'convert', target: 'LF' | 'CRLF'): void
}>()

const { t } = useI18n()

// ── 行尾菜单弹层（EncodingBadge 同款交互：锚定按钮下缘、点外关闭、ESC 关闭）
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
    // 右缘防溢出（EncodingBadge 同款收紧）
    menuX.value = Math.max(4, Math.min(rect.left, window.innerWidth - 200))
    menuY.value = rect.bottom + 4
  }
  showMenu.value = true
}

function closeMenu() {
  showMenu.value = false
}

function onConvert(target: 'LF' | 'CRLF') {
  closeMenu()
  emit('convert', target)
}

function handleClickOutside(e: MouseEvent) {
  if (!showMenu.value) return
  const target = e.target as HTMLElement
  const menu = document.querySelector('.eol-menu')
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
    v-if="props.eol"
    ref="badgeRef"
    class="eol-badge"
    data-testid="eol-badge"
    :title="t('files.eol.badgeTip', { eol: props.eol })"
    @click="toggleMenu"
  >
    {{ props.eol }}
  </button>
  <transition name="fade-fast">
    <div
      v-if="showMenu"
      class="eol-menu"
      data-testid="eol-menu"
      :style="{ left: menuX + 'px', top: menuY + 'px' }"
    >
      <button
        class="eol-item"
        :class="{ current: props.eol === 'LF' }"
        data-testid="eol-to-lf"
        @click="onConvert('LF')"
      >
        {{ t('files.eol.toLf') }}<span
          v-if="props.eol === 'LF'"
          class="eol-item-note"
        >✓</span>
      </button>
      <button
        class="eol-item"
        :class="{ current: props.eol === 'CRLF' }"
        data-testid="eol-to-crlf"
        @click="onConvert('CRLF')"
      >
        {{ t('files.eol.toCrlf') }}<span
          v-if="props.eol === 'CRLF'"
          class="eol-item-note"
        >✓</span>
      </button>
    </div>
  </transition>
</template>

<style scoped>
/* 徽标/弹层视觉与 EncodingBadge 同一套语言（scoped 隔离各自成套，随组件走） */
.eol-badge {
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
.eol-badge:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.eol-menu {
  position: fixed;
  z-index: 9999;
  min-width: 150px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-strong);
  padding: 4px 0;
}

.eol-item {
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
.eol-item:hover {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}
/* 当前行尾行：品牌色标记（EncodingBadge .current 同形态） */
.eol-item.current {
  color: var(--brand-accent);
  font-weight: 500;
}

.eol-item-note {
  margin-left: auto;
  font-size: 10px;
  font-weight: 400;
  color: var(--text-muted);
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
