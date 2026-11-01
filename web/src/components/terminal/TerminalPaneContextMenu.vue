<script setup lang="ts">
import { NIcon } from 'naive-ui'
import { onMounted, ref } from 'vue'
import { ArrowRedoOutline, Bookmark, BookmarkOutline, BuildOutline, ClipboardOutline, CopyOutline, DownloadOutline, PaperPlaneOutline, RefreshOutline, ShareSocialOutline, SparklesOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useMenuKeyboardNavigation } from '../../composables/useMenuKeyboardNavigation'

/** 终端 pane 右键菜单（复制/粘贴/全量复制/导出/清屏重启/刷新，teleport 到 body；自 TerminalView 抽出）
 *  restartable=false（全局终端等宿主）：末项降级为纯「清屏」——重启 shell 会终止
 *  会话内运行中的智能体/长任务，宿主自行决定动作实现
 *  askable=false（远程控制台/agent 管理页宿主）：隐藏「询问智能体此输出」——
 *  该动作以当前项目根为会话工作目录发起，两宿主（远程主机输出/免项目绑定的
 *  会话页）与当前项目无归属关系，点了只会拼出答非所问的上下文 */
const props = withDefaults(
  defineProps<{
    x: number
    y: number
    /** 当前 pane 选区长度（0 = 禁用「复制」） */
    selectionLength: number
    /** 末项是否为「清屏并重启」（默认 true；false 时仅「清屏」语义） */
    restartable?: boolean
    /** 是否展示「询问智能体此输出」（默认 true；无项目归属的宿主传 false） */
    askable?: boolean
    /** 会话是否有最近失败命令记录（P-20261003-150「交给 agent 修」的置灰门禁；
     *  显隐随 askable 同口径——无项目归属的宿主不展示） */
    hasFailedCommand?: boolean
    /** 是否展示书签行级动作（P-20261004-16；仅注入了 toggleBookmarkLine 且右键
     *  行解析成功的宿主为真——agent 管理页/远程控制台宿主不展示） */
    bookmarker?: boolean
    /** 右键行是否已有书签（决定「标记此行/取消标记」文案方向） */
    bookmarked?: boolean
  }>(),
  { restartable: true, askable: true, hasFailedCommand: false, bookmarker: false, bookmarked: false },
)

const emit = defineEmits<{
  (e: 'action', action: 'copy' | 'copyAsCodeBlock' | 'paste' | 'copyAll' | 'copyLastOutput' | 'shareSelection' | 'sendClip' | 'askAgent' | 'fixWithAgent' | 'bookmarkLine' | 'export' | 'clearAndRestart' | 'redraw'): void
  (e: 'close'): void
}>()

const { t } = useI18n()

// 视口边界钳制：宿主传入的是光标坐标，菜单向下/向右展开时不翻转就会溢出
// 视口被裁（终端 pane 常贴窗口底部，实测右键下半区必裁末项）。宿主均以
// v-if 每次打开重新挂载本组件，onMounted 实测自身尺寸后向内收缩即可。
const menuRef = ref<HTMLElement | null>(null)
// 键盘导航（P-20261004-69）：↑↓ 环绕移焦（禁用项跳过）/ Home/End / Esc 关闭
// （emit close，开合状态归宿主）/ 打开即聚焦首项；与 tab 菜单共用同一 composable
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
      class="term-context-menu"
      :style="{ left: pos.x + 'px', top: pos.y + 'px' }"
      @click.stop
      @keydown="onMenuKeydown"
    >
      <button
        class="term-context-item"
        data-testid="term-copy"
        :disabled="!selectionLength"
        @click="emit('action', 'copy')"
      >
        <n-icon size="13">
          <CopyOutline />
        </n-icon>
        <span>{{ t('terminal.copy') }}</span>
        <kbd class="term-context-kbd">⌃⇧C</kbd>
      </button>
      <!-- 复制为代码块（P-20261003-270）：与「复制」并列的第二个复制入口，纯文本
           复制行为不受影响——选区包 ```bash 围栏 + 最近命令 `$ <command>` 头。
           同一选区门禁（无选区禁用），插在「复制」与「粘贴」之间保持复制族邻位；
           禁用时键盘导航自动跳过，菜单首焦点/回绕语义零变化 -->
      <button
        class="term-context-item"
        data-testid="term-copy-as-code-block"
        :title="t('terminal.copyAsCodeBlock.tooltip')"
        :disabled="!selectionLength"
        @click="emit('action', 'copyAsCodeBlock')"
      >
        <n-icon size="13">
          <CopyOutline />
        </n-icon>
        <span>{{ t('terminal.copyAsCodeBlock.menu') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'paste')"
      >
        <n-icon size="13">
          <ClipboardOutline />
        </n-icon>
        <span>{{ t('terminal.paste') }}</span>
        <kbd class="term-context-kbd">⌃⇧V</kbd>
      </button>
      <!-- 书签「标记/取消标记此行」（P-20261004-16）：右键命中的缓冲行钉成
           scrollback 书签（gutter 小旗装饰），配合书签列表跳回定位。行解析失败的
           宿主/场景整项隐藏（bookmarker 门控）；文案按当前行书签态翻转 -->
      <button
        v-if="props.bookmarker"
        class="term-context-item"
        data-testid="term-bookmark-line"
        @click="emit('action', 'bookmarkLine')"
      >
        <n-icon size="13">
          <Bookmark v-if="props.bookmarked" />
          <BookmarkOutline v-else />
        </n-icon>
        <span>{{ props.bookmarked ? t('terminal.bookmark.menuRemove') : t('terminal.bookmark.menuAdd') }}</span>
      </button>
      <div class="term-context-sep" />
      <button
        class="term-context-item"
        @click="emit('action', 'copyAll')"
      >
        <n-icon size="13">
          <CopyOutline />
        </n-icon>
        <span>{{ t('terminal.copyAll') }}</span>
      </button>
      <!-- 复制上一条命令输出（P-20261002-56）：OSC 133 C/D 行号记账区间提取。
           不禁用：运行中命令也可复制已有输出；无记账/区间为空由点击后 toast 提示 -->
      <button
        class="term-context-item"
        data-testid="term-copy-last-output"
        @click="emit('action', 'copyLastOutput')"
      >
        <n-icon size="13">
          <CopyOutline />
        </n-icon>
        <span>{{ t('terminal.copyLast.menu') }}</span>
      </button>
      <!-- 分享选中文本（P-20261002-71）：选区一键变排障贴短链（无选区禁用，
           与「复制」同一可用性门禁） -->
      <button
        class="term-context-item"
        :disabled="!selectionLength"
        data-testid="term-share-selection"
        @click="emit('action', 'shareSelection')"
      >
        <n-icon size="13">
          <ShareSocialOutline />
        </n-icon>
        <span>{{ t('share.snippet.menuSelection') }}</span>
      </button>
      <!-- 发送剪贴板到其他设备（P-20261008-3，P-32 缩范围二阶段兑现）：本机剪贴板
           一键走跨设备中继（useClipRelay.sendLocalClipboard 现成链——读取/回退/
           32KB 前置拦截全复用），终端是剪贴板内容主产地，免绕命令面板两跳。
           与分享选中同簇邻位（内容带出族）；不随选区置灰——发送的是整机剪贴板
           而非终端选区，空板/超限由发送链 toast 知情反馈 -->
      <button
        class="term-context-item"
        data-testid="term-send-clip"
        @click="emit('action', 'sendClip')"
      >
        <n-icon size="13">
          <PaperPlaneOutline />
        </n-icon>
        <span>{{ t('clip.sendCmd') }}</span>
      </button>
      <!-- 询问智能体此输出（P-20261003-7）：选中文本组装 prompt 经
           createAgentTerminal 发起新 agent 会话（无选区禁用，与「复制」同一
           可用性门禁；宿主无项目归属时整项隐藏，见 askable prop 注释） -->
      <button
        v-if="props.askable"
        class="term-context-item"
        :disabled="!selectionLength"
        data-testid="term-ask-agent"
        @click="emit('action', 'askAgent')"
      >
        <n-icon size="13">
          <SparklesOutline />
        </n-icon>
        <span>{{ t('terminal.ask.menu') }}</span>
      </button>
      <!-- 失败命令「交给 agent 修」（P-20261003-150）：最近失败命令 + 输出尾部
           组装 prompt 经 createAgentTerminal 发起新 agent 会话。无失败记录置灰
           （与「复制」同一可用性门禁形态）；宿主无项目归属时整项隐藏（askable
           同口径——prompt 以当前项目根为会话工作目录） -->
      <button
        v-if="props.askable"
        class="term-context-item"
        :disabled="!hasFailedCommand"
        data-testid="term-fix-with-agent"
        @click="emit('action', 'fixWithAgent')"
      >
        <n-icon size="13">
          <BuildOutline />
        </n-icon>
        <span>{{ t('terminal.fix.menu') }}</span>
      </button>
      <button
        class="term-context-item"
        @click="emit('action', 'export')"
      >
        <n-icon size="13">
          <DownloadOutline />
        </n-icon>
        <span>{{ t('terminal.exportText') }}</span>
      </button>
      <div class="term-context-sep" />
      <button
        class="term-context-item"
        @click="emit('action', 'clearAndRestart')"
      >
        <n-icon size="13">
          <ArrowRedoOutline />
        </n-icon>
        <span>{{ props.restartable ? t('terminal.clearAndRestart') : t('terminal.clear') }}</span>
      </button>
      <!-- 刷新 = fit 重算行列 + xterm 滚动区 refresh + tmux 权威重绘：
           治无法上翻/窗口变化后渲染错乱（与 pane 右上角重绘按钮同链路） -->
      <button
        class="term-context-item"
        :title="t('terminal.redraw')"
        @click="emit('action', 'redraw')"
      >
        <n-icon size="13">
          <RefreshOutline />
        </n-icon>
        <span>{{ t('terminal.refresh') }}</span>
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
.term-context-kbd {
  margin-left: auto;
}
</style>
