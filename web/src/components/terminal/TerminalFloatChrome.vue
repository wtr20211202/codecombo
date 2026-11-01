<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'

/**
 * 浮动终端窗的轻 chrome（P-20261004-91）：识别 / 状态 / 收回三合一 affordance。
 * 从 TerminalPanesArea 抽出（原 .term-float-bar 内联块 + 本提案新增状态条，
 * 同文件域债项拆分，主文件控制在 500 行内）。
 *
 * 结构（浮动窗顶部两段，均只随浮动形态渲染）：
 * - .term-float-status：常驻 4px 语义色状态条（idle 中性 / running 蓝带微光 /
 *   done 绿 / failed 红）——不 hover 也有最低可见性，「完成即变绿一瞥可知」；
 *   数据源 task.progress（assistantTask.bySession），无进度归属时回落 shell 层
 *   tab.running（由宿主归一为 tier 下发）。
 * - .term-float-bar：轻标题条（状态点 + 会话名 + 收回面板按钮），默认收起
 *   （max-height 0 不占终端可视区——终端寸土寸金），hover 顶区状态条（4px
 *   保守阈值，窗体其余区域的终端交互零布局位移）/ hover 标题条自身 / 键盘
 *   Tab 聚焦到收回按钮（focus-within）三者之一显现。
 *
 * 活动窗高亮（多浮动窗 z 序顶层）：is-top 由宿主按 bringToFront 序号判定下发，
 * 标题条下缘走焦点色混合——窗口边框高亮在宿主 .is-floating.is-top 侧。
 */
const props = defineProps<{
  /** 会话名（标题条文本） */
  name: string
  /** 状态档（宿主归一：bySession.status 优先，回落 tab.running） */
  tier: 'running' | 'done' | 'failed' | 'idle'
  /** 是否多浮动窗中的活动窗（z 序顶层） */
  top: boolean
}>()

const emit = defineEmits<{
  /** 标题条 pointerdown（宿主接 float.startBarDrag 拖动窗口） */
  (e: 'drag-start', ev: PointerEvent): void
  /** 收回面板 */
  (e: 'dock'): void
}>()

const { t } = useI18n()

// 状态档 → tooltip 键（点/条 hover 即知颜色语义，四档全给文案）
const TIER_TIP_KEYS = {
  running: 'terminal.floatStatusRunning',
  done: 'terminal.floatStatusDone',
  failed: 'terminal.floatStatusFailed',
  idle: 'terminal.floatStatusIdle',
} as const
const tierTip = computed(() => t(TIER_TIP_KEYS[props.tier]))
</script>

<template>
  <div class="term-float-chrome" :class="{ 'is-top': top }">
    <div
      class="term-float-status"
      :class="`is-${tier}`"
      :title="tierTip"
      aria-hidden="true"
    />
    <div
      class="term-float-bar"
      @pointerdown="(e: PointerEvent) => emit('drag-start', e)"
    >
      <span
        class="term-float-dot"
        :class="`is-${tier}`"
        role="img"
        :aria-label="tierTip"
        :title="tierTip"
      />
      <span
        class="term-float-title"
        :title="name"
      >{{ name }}</span>
      <button
        class="term-float-btn"
        :title="t('terminal.floatDockBack')"
        :aria-label="t('terminal.floatDockBack')"
        @pointerdown.stop
        @click="emit('dock')"
      >
        &#x23EC;
      </button>
    </div>
  </div>
</template>

<style scoped>
.term-float-chrome {
  flex-shrink: 0;
}
/* ============== 常驻 4px 语义色状态条（②）==============
   窗口 overflow:hidden 裁出圆角，无需自带 radius；idle 用边框色保持
   「窗沿」观感，有状态档即语义色接管 */
.term-float-status {
  height: 4px;
  background: var(--border-default);
  opacity: 0.9;
}
.term-float-status.is-running {
  background: var(--status-running);
  opacity: 1;
  /* running 态微光：呼吸式辉光（微光档，非醒目闪烁） */
  animation: term-float-status-glow 1.6s ease-in-out infinite;
}
.term-float-status.is-done { background: var(--status-success); opacity: 1; }
.term-float-status.is-failed { background: var(--status-failed); opacity: 1; }
@keyframes term-float-status-glow {
  0%, 100% { box-shadow: 0 0 3px color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 9px color-mix(in srgb, var(--status-running) 85%, transparent); }
}
/* ============== 轻标题条（①）：默认收起，hover 顶区 / hover 自身 /
   键盘聚焦收回按钮时展开 ==============
   收起态 max-height:0（box-sizing 显式 border-box，border 一并归零）+
   pointer-events:none——不占终端可视区，也不拦终端首行点击 */
.term-float-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  box-sizing: border-box;
  max-height: 0;
  padding: 0 6px 0 10px;
  overflow: hidden;
  border-bottom: 0 solid var(--border-default);
  opacity: 0;
  pointer-events: none;
  flex-shrink: 0;
  background: var(--bg-panel);
  cursor: grab;
  user-select: none;
  touch-action: none;
  /* border-bottom-width 一并收展：max-height:0 时 border 仍占 1px（盒模型
     下限），非空 bbox 会被可访问性树/测试视为可见——收起态必须零占位 */
  transition: max-height var(--motion-base) ease, opacity var(--motion-base) ease, border-bottom-width var(--motion-base) ease;
}
.term-float-chrome:has(.term-float-status:hover) .term-float-bar,
.term-float-chrome:has(.term-float-bar:hover) .term-float-bar,
.term-float-chrome:has(.term-float-bar:focus-within) .term-float-bar {
  max-height: 30px;
  border-bottom-width: 1px;
  opacity: 1;
  pointer-events: auto;
}
.term-float-bar:active { cursor: grabbing; }
/* 活动窗（③）：标题条下缘走焦点色混合（窗口边框高亮在宿主侧） */
.term-float-chrome.is-top .term-float-bar {
  border-bottom-color: color-mix(in srgb, var(--accent-blue) 45%, var(--border-default));
}
.term-float-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border-default);
  flex-shrink: 0;
}
.term-float-dot.is-running { background: var(--status-running); }
.term-float-dot.is-done { background: var(--status-success); }
.term-float-dot.is-failed { background: var(--status-failed); }
.term-float-title {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.term-float-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--border-default);
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}
.term-float-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--accent-blue);
}
</style>
