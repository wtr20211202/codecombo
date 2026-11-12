<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { useSidebarWidth } from '../../composables/useSidebarWidth'

/**
 * 通用侧栏宽度拖拽把手（P-20261106-5 配 useSidebarWidth 泛化实现）：
 * 拖拽调宽 + 宽度记忆 + 双击恢复默认 + 键盘可达（ARIA slider 语义）。
 *
 * - v-model 桥接宿主持有的宽度值；持久化键/钳制由 props 声明（约定
 *   storageKey = `sc.<panel>.sidebarWidth`），组件内部完成读盘/落盘/复位
 * - 键盘：聚焦后 ←/↓ 减、→/↑ 加（step 步长），Home/End 到最小/最大——
 *   组件内 ARIA slider 语义，不注册全局快捷键（防撞终端/编辑器键位）
 * - 双击：恢复 defaultWidth；布局锁定时拖拽入口在 useSidebarWidth 短路
 * - 视觉与 ide-side-resizer / atv-side-resizer 同设计语言（8px 命中区 +
 *   2px 握把纹 + 悬停/拖拽高亮；body.sc-layout-locked cursor 归位在
 *   assets/main.css 统一挂 `.sidebar-resizer`）。命中区不对称（P-20261111-7
 *   S1）：内收贴侧栏侧、主区侧零重叠——atv-side-resizer 同步同款几何
 */
const props = withDefaults(defineProps<{
  /** 宽度记忆键（sc.<panel>.sidebarWidth） */
  storageKey: string
  min: number
  max: number
  /** 双击复位目标宽度，也是无持久化值时的初始宽度 */
  defaultWidth: number
  /** aria-label / title（复用 i18n 既有 sidebarResizeTip 族键） */
  label: string
  /** 键盘微调步长 px */
  step?: number
}>(), { step: 16 })

const emit = defineEmits<{
  /** 拖拽结束（宿主可做 xterm refit 等补齐） */
  (e: 'resize-end'): void
}>()

// 宿主宽度 v-model：composable 直接写此 ref（读盘/拖拽/微调/复位全部落在这里）
const width = defineModel<number>({ required: true })

const { resizing, load, onResizeDown, nudge, resetToDefault, dispose } = useSidebarWidth({
  width,
  // min/max/defaultWidth 按静态配置捕获（接入面都是常量钳制）；动态钳制非本组件场景
  storageKey: props.storageKey,
  min: props.min,
  max: props.max,
  defaultWidth: props.defaultWidth,
  onResizeEnd: () => emit('resize-end'),
})

// setup 期同步读盘（localStorage 读为同步）：首帧即持久宽度，宿主侧栏不闪默认宽
load()
// 卸载兜底：拖拽中途卸载（宿主切视图/销毁）摘除 window/document 级监听与选择抑制
onBeforeUnmount(dispose)

function onKeydown(e: KeyboardEvent) {
  switch (e.key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      nudge(-props.step)
      break
    case 'ArrowRight':
    case 'ArrowUp':
      nudge(props.step)
      break
    case 'Home':
      nudge(props.min - width.value)
      break
    case 'End':
      nudge(props.max - width.value)
      break
    default:
      return
  }
  e.preventDefault()
}
</script>

<template>
  <div
    class="sidebar-resizer"
    :class="{ 'is-resizing': resizing }"
    role="slider"
    aria-orientation="horizontal"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuenow="Math.round(width)"
    :aria-label="label"
    :title="label"
    tabindex="0"
    @pointerdown="onResizeDown"
    @dblclick="resetToDefault"
    @keydown="onKeydown"
  />
</template>

<style scoped>
/* 8px 命中区 + 常显 2px 握把纹（与 ide-side-resizer / atv-side-resizer 同款）。
   命中区不对称（P-20261111-7 S1）：整体内收贴侧栏侧（左溢 8px、右溢 0）——
   右缘与侧栏分界线齐平、不压主区/终端 pane，贴左缘起的文本选区 pointerdown
   不再落进命中区误触调宽；带宽 8px 不变，pointerdown 落在带内即拖拽，手感不劣化。
   （曾用 margin: 0 -4px 对称骑跨分界线：右缘 4px 压在主区上，xterm 最左列
   选区被截胡——实测负 margin 只移主区不移把手盒，收右溢须同步加大左溢） */
.sidebar-resizer {
  width: 8px;
  margin-left: -8px;
  z-index: 5;
  cursor: col-resize;
  flex-shrink: 0;
  position: relative;
  transition: background var(--motion-base);
}
.sidebar-resizer::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  /* 握把纹贴命中区右缘：与侧栏分界线对齐（命中区内收后盒中线已不落在
     分界线上，取中会浮进侧栏 4px）；纹不越过右缘，主区侧零视觉侵入 */
  right: 0;
  width: 2px;
  border-radius: 1px;
  background: var(--border-default);
  opacity: 0.6;
  transition: background var(--motion-base), opacity var(--motion-base);
}
.sidebar-resizer:hover::after,
.sidebar-resizer.is-resizing::after { background: var(--accent-blue); opacity: 1; }
.sidebar-resizer:hover,
.sidebar-resizer.is-resizing { background: color-mix(in srgb, var(--accent-blue) 14%, transparent); }
/* 键盘可达的焦点指示：与悬停同款握把高亮（容器无 outline，避免分隔条上突兀描边） */
.sidebar-resizer:focus-visible { outline: none; }
.sidebar-resizer:focus-visible::after { background: var(--accent-blue); opacity: 1; }
</style>
