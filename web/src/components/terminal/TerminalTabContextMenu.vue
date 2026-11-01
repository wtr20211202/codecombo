<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useMenuKeyboardNavigation } from '../../composables/useMenuKeyboardNavigation'

/**
 * 终端 tab 右键菜单（置顶/重命名/复制会话/复制会话 ID/对比输出/关闭/批量关闭/拖出浮动窗，teleport 到 body；自 TerminalView 抽出）。
 * floating = 目标 tab 当前是否浮动（决定浮动动作的文案方向）。
 */
const props = defineProps<{
  x: number
  y: number
  floating?: boolean
  /** 目标 tab 是否已标记敏感（决定敏感动作文案方向，P-20261003-155） */
  sensitive?: boolean
  /** 目标 tab 是否已置顶（决定置顶动作文案方向，P-20261004-53） */
  pinned?: boolean
  /** 目标 tab 是否直播中（P-20261005-161）：直播项文案翻转为「结束直播」
   *  （一键撤销即时断流，同链幂等可重建）；动作 key 仍走 liveShare，宿主按
   *  直播态分流创建/撤销 */
  live?: boolean
}>()

const emit = defineEmits<{
  (e: 'action', action: 'pin' | 'rename' | 'duplicate' | 'copySessionId' | 'close' | 'closeOthers' | 'closeRight' | 'closeAll' | 'float' | 'liveShare' | 'frozenShare' | 'replayShare' | 'exportOutput' | 'compareOutput' | 'markSensitive' | 'wrapUp' | 'bookmarkList'): void
  (e: 'close'): void
}>()

const { t } = useI18n()

// 视口边界钳制（与 TerminalPaneContextMenu 同款）：贴底/贴右打开时不被视口裁切
const menuRef = ref<HTMLElement | null>(null)
// 键盘导航（P-20261004-69）：↑↓ 环绕移焦 / Home/End / Esc 关闭（emit close，
// 开合状态归宿主）/ 打开即聚焦首项；与 pane 菜单共用同一 composable
const { onMenuKeydown } = useMenuKeyboardNavigation({
  menuRef,
  close: () => emit('close'),
})
const pos = ref({ x: props.x, y: props.y })
onMounted(() => {
  const el = menuRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  pos.value = {
    x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
    y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)),
  }
})
</script>

<template>
  <teleport to="body">
    <div
      ref="menuRef"
      class="term-context-menu term-tab-context-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @click.stop
      @keydown="onMenuKeydown"
    >
      <!-- 置顶（P-20261004-53）：置顶会话 tab 常驻分组（编辑器 pinned tab 对称）；
      文案按当前置顶态翻转 -->
      <button
        class="term-context-item"
        data-testid="terminal-pin-tab"
        @click="emit('action', 'pin')"
      >
        <span>{{ pinned ? t('terminal.unpinTab') : t('terminal.pinTab') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'rename')"
      >
        <span>{{ t('terminal.renameTab') }}</span>
      </button>
      <!-- 复制会话（P-20261004-1）：同配置新会话并激活——对照试验「原会话保持
      现场、新会话跑试验命令」一步到位（创建配置级复制，非运行现场克隆） -->
      <button
        class="term-context-item"
        data-testid="terminal-duplicate-tab"
        @click="emit('action', 'duplicate')"
      >
        <span>{{ t('terminal.duplicateTab') }}</span>
      </button>
      <!-- 复制会话 ID（P-20261004-123）：terminalId 已是协作协议的地址（agent
      收件箱/接续链/ui.snapshot 归属/任务进度跳转全用它），一键入剪贴板免手工抓取；
      与「复制会话」同区（同为复制语义，轻量工具动作不挤占关闭族） -->
      <button
        class="term-context-item"
        data-testid="terminal-copy-session-id"
        @click="emit('action', 'copySessionId')"
      >
        <span>{{ t('terminal.copySessionId') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'float')"
      >
        <span>{{ floating ? t('terminal.floatDockBack') : t('terminal.floatOut') }}</span>
      </button>
      <!-- 直播分享 / 结束直播（P-20261003-306 + P-20261005-161）：终端输出只读
      直播给访客短链（遮蔽化 + 默认 30 分钟过期）；目标 tab 直播中时同位翻转
      为「结束直播」——撤销从分享管理器两跳变一跳（幂等同链，可随时重建） -->
      <button
        class="term-context-item"
        data-testid="terminal-live-share"
        @click="emit('action', 'liveShare')"
      >
        <span>{{ live ? t('terminal.endLiveShare') : t('terminal.liveShare') }}</span>
      </button>
      <!-- 分享输出快照（P-20261005-205）：与直播分享同区的定格变体——创建
      时刻的输出快照链接（遮蔽净化 + 默认 30 天），会话继续跑内容不更新 -->
      <button
        class="term-context-item"
        data-testid="terminal-frozen-share"
        @click="emit('action', 'frozenShare')"
      >
        <span>{{ t('terminal.frozenShare') }}</span>
      </button>
      <!-- 分享回放（P-20261004-103）：该会话最近一次过程录制的只读回放短链
      （异步 walkthrough，默认 1 小时）——与直播/快照同为输出出域族；无录制
      时提示先开启审批录制 -->
      <button
        class="term-context-item"
        data-testid="terminal-replay-share"
        @click="emit('action', 'replayShare')"
      >
        <span>{{ t('terminal.shareReplay') }}</span>
      </button>
      <!-- 导出输出（P-20261003-100）：服务端 scrollback 链整体留档 txt——
      与客户端「导出文本」（xterm 当前缓冲直下）互补，不依赖 pane 挂载 -->
      <button
        class="term-context-item"
        data-testid="terminal-export-output"
        @click="emit('action', 'exportOutput')"
      >
        <span>{{ t('terminal.exportOutput') }}</span>
      </button>
      <!-- 对比输出（P-20261005-210）：当前会话 ↔ 所选会话滚回文本 diff 一屏——
      同命令双环境（staging/prod、远程/本地）A/B 验证从肉眼对滚变 diff；
      弹会话选择浮层（本地/agent/远程），紧邻导出（同为整会话输出消费族） -->
      <button
        class="term-context-item"
        data-testid="terminal-compare-output"
        @click="emit('action', 'compareOutput')"
      >
        <span>{{ t('terminal.compareOutput') }}</span>
      </button>
      <!-- 敏感标记（P-20261003-155）：人工策展的安全标注，导出/分享出域命中时
      要求二次确认；文案按当前标记态翻转 -->
      <button
        class="term-context-item"
        data-testid="terminal-mark-sensitive"
        @click="emit('action', 'markSensitive')"
      >
        <span>{{ sensitive ? t('terminal.unmarkSensitive') : t('terminal.markSensitive') }}</span>
      </button>
      <!-- 收工摘要（P-20261004-35）：会话命令账本聚合 + 最近任务进度，关 tab 前一键收账 -->
      <button
        class="term-context-item"
        data-testid="terminal-wrap-up"
        @click="emit('action', 'wrapUp')"
      >
        <span>{{ t('terminal.wrapUp.menuLabel') }}</span>
      </button>
      <!-- 书签列表（P-20261004-16）：该会话的 scrollback 书签浮层（行号 + 行摘要，
      点击滚动定位）；与 pane 右键「标记此行」同功能域，入口在 tab 管理侧 -->
      <button
        class="term-context-item"
        data-testid="terminal-bookmark-list"
        @click="emit('action', 'bookmarkList')"
      >
        <span>{{ t('terminal.bookmark.menuList') }}</span>
      </button>
      <div class="term-context-sep" />
      <button
        class="term-context-item"
        @click="emit('action', 'close')"
      >
        <span>{{ t('terminal.closeTab') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'closeOthers')"
      >
        <span>{{ t('terminal.closeOthers') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'closeRight')"
      >
        <span>{{ t('terminal.closeRight') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'closeAll')"
      >
        <span>{{ t('terminal.closeAll') }}</span>
      </button>
    </div>
  </teleport>
</template>

<style scoped>
.term-context-menu {
  position: fixed;
  z-index: 100000;
  min-width: 160px;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 4px;
  box-shadow: var(--shadow-pop);
  user-select: none;
}
.term-context-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 4px 8px;
  border: none;
  background: none;
  color: var(--text-body);
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  text-align: left;
}
.term-context-item:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.term-context-item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.term-context-sep {
  height: 1px;
  background: var(--border-default);
  margin: 3px 4px;
}
</style>
