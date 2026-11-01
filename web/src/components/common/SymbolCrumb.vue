<script setup lang="ts">
// 面包屑符号段（P-20261005-195）：路径层之后的符号层——当前光标所在符号祖先链
// 常驻显示（VS Code 双层面包屑对标），尾部段点击下拉同层符号列表定点跳转
// （位置态+免快捷键，与 Ctrl+Shift+O quick access 搜索态互补不替代）。
// 独立子组件：Breadcrumb.vue 已超 500 行上限，符号段 UI+下拉自包含于此；
// 数据面（符号树收集/光标归属）在 views/editor/symbolCrumbBridge.ts，本组件纯展示。
// 交互形态复用 P-20261002-128 同级导航弹层（锚点定位/右缘防溢出/点外收起/Esc）。
import { computed, ref, watch, onMounted, onBeforeUnmount, type ComponentPublicInstance } from 'vue'
import { NIcon } from 'naive-ui'
import { ChevronDownOutline, ChevronForwardOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

/** 与 utils/symbolCrumb.CrumbSymbolRef 同形（展示层最小面，kind 暂为扩展位） */
interface CrumbSymbolRef { name: string; kind: number; line: number }

const props = defineProps<{
  /** 光标所在符号祖先链（空 = 语言无符号 provider 或光标在符号外，整段不渲染） */
  chain: CrumbSymbolRef[]
  /** 尾段同层符号（含尾段自身，下拉数据；跳转按行号定点） */
  siblings: CrumbSymbolRef[]
}>()

const emit = defineEmits<{
  (e: 'navigate', line: number): void
}>()

const { t } = useI18n()

const tail = computed(() => props.chain[props.chain.length - 1] ?? null)
// 尾段可下拉 = 同层候选多于 1（只有自己时无可跳项，不亮交互态）
const tailInteractive = computed(() => props.siblings.length > 1)

// ── 同层下拉弹层（P-128 面包屑弹层同形态）────────────────────
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const tailRef = ref<HTMLElement | null>(null)

/** 尾段函数 ref：点外收起判定要认「点在尾段上」（P-128 同款，点击归 toggleMenu） */
function setTailRef(el: Element | ComponentPublicInstance | null) {
  tailRef.value = el instanceof HTMLElement ? el : null
}

function toggleMenu(e: MouseEvent) {
  e.stopPropagation()
  if (!tailInteractive.value) return
  if (menuOpen.value) {
    closeMenu()
    return
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // 右缘防溢出：按弹层最大宽度收紧锚点（Breadcrumb toggleSiblings 同式）
  menuX.value = Math.max(4, Math.min(rect.left, window.innerWidth - 340))
  menuY.value = rect.bottom + 4
  menuOpen.value = true
}

function closeMenu() {
  menuOpen.value = false
}

function pick(entry: CrumbSymbolRef) {
  closeMenu()
  emit('navigate', entry.line)
}

/** 链尾变化（光标移走/换符号）即收起：下拉列的是打开时刻的同层，陈旧列表不滞留 */
watch(() => [tail.value?.name, tail.value?.line], () => {
  if (menuOpen.value) closeMenu()
})

function handleClickOutside(e: MouseEvent) {
  if (!menuOpen.value) return
  const target = e.target as HTMLElement
  // 点在尾段上交给 toggleMenu 处理（否则「再点收起」被先关后开打断，P-128 同款）
  const ownTail = !!(target instanceof Element) && !!tailRef.value?.contains(target)
  const menu = document.querySelector('.symbol-crumb-menu')
  if (!(menu && menu.contains(target)) && !ownTail) closeMenu()
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && menuOpen.value) closeMenu()
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
  <!-- 分段渲染在路径段之后的同一滚动行内（fragment，不引入包裹层） -->
  <template v-if="chain.length">
    <n-icon
      size="10"
      class="sym-sep"
    >
      <ChevronForwardOutline />
    </n-icon>
    <span
      v-for="(s, i) in chain"
      :key="`${s.name}:${s.line}:${i}`"
      :ref="i === chain.length - 1 ? setTailRef : undefined"
      class="sym-crumb"
      :class="{ tail: i === chain.length - 1, interactive: i === chain.length - 1 && tailInteractive }"
      :data-testid="i === chain.length - 1 ? 'symbol-crumb-tail' : undefined"
      :title="i === chain.length - 1 && tailInteractive ? t('editor.symbol.peerNavTip') : undefined"
      @click="i === chain.length - 1 ? toggleMenu($event) : undefined"
    >
      <span class="sym-name">{{ s.name }}</span>
      <n-icon
        v-if="i === chain.length - 1 && tailInteractive"
        size="9"
        class="sym-caret"
      ><ChevronDownOutline /></n-icon>
    </span>

    <!-- 同层符号下拉：文档序排列，当前尾段高亮（.current，P-128 命中项同语） -->
    <transition name="fade-fast">
      <div
        v-if="menuOpen"
        class="symbol-crumb-menu"
        data-testid="symbol-crumb-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
      >
        <button
          v-for="entry in siblings"
          :key="`${entry.name}:${entry.line}`"
          class="sym-item"
          :class="{ current: entry.name === tail?.name && entry.line === tail?.line }"
          :title="`Ln ${entry.line}`"
          @click="pick(entry)"
        >
          <span class="sym-item-name">{{ entry.name }}</span>
        </button>
      </div>
    </transition>
  </template>
</template>

<style scoped>
/* 分隔符与路径段 .crumb-sep 同规格（10px / --text-dim / 0.7） */
.sym-sep {
  color: var(--text-dim);
  flex-shrink: 0;
  opacity: 0.7;
}

/* 符号段基样式与路径段 .crumb 同构（等宽字体/2px 5px 内边距/3px 圆角），
   颜色降一档（--text-muted → 尾段 --text-secondary）区分两层 */
.sym-crumb {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border-radius: 3px;
  color: var(--text-secondary);
  cursor: default;
  white-space: nowrap;
  flex-shrink: 0;
  font-family: var(--font-mono);
  transition: background var(--motion-fast);
}

.sym-crumb.tail {
  color: var(--text-primary);
  font-weight: 500;
}

.sym-crumb:hover {
  background: var(--bg-hover);
}

.sym-crumb.interactive {
  cursor: pointer;
}

.sym-name {
  font-size: 11px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sym-caret {
  color: var(--text-dim);
  flex-shrink: 0;
}

/* 同层符号弹层：几何与 P-128 .breadcrumb-sib-menu 同 token */
.symbol-crumb-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  max-width: 340px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-strong);
  padding: 4px 0;
}

.sym-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-body);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-mono);
  transition: background var(--motion-fast);
}

.sym-item:hover {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}

/* 当前符号命中项：品牌色标记（P-128 当前文件命中项同语） */
.sym-item.current {
  color: var(--brand-accent);
  font-weight: 500;
}

.sym-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
