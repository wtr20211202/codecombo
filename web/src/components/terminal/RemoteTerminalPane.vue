<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import TerminalPane from './TerminalPane.vue'
import { getRemoteTerminalWsUrl, remoteHostApi } from '../../api/client'
import { createRemoteInputHistoryCollector } from '../../composables/useRemoteInputHistory'

/**
 * 远程主机终端 pane：TerminalPane 的远程包装。
 * - WS / resize / 粘贴上传（截图/文件）全部指向远程主机端点（wsUrlFactory / resizeCall / uploadPaste 注入）
 * - 右键菜单能力与项目终端同层：contextmenu 事件上抛宿主（远程控制台），
 *   复制/粘贴/导出/清屏动作经 defineExpose 转发到内部 TerminalPane
 * - 输入域命令历史采集（P-20261005-188）：远程 shell 无 shell integration，
 *   onData 收口（写入 WS 前）截获按键流行缓冲，回车分条上报 source=input +
 *   host=主机键；未提交的半截行随 pane 卸载丢弃
 */
const props = defineProps<{
  hostId: string
  sessionId: string
  active?: boolean
  /** 会话终态（tab ended）：隐藏 pane 级断开浮层，宿主（远程控制台）渲染「重开」入口 */
  ended?: boolean
}>()

const emit = defineEmits<{
  (e: 'exit', sessionId: string): void
  (e: 'contextmenu', ev: MouseEvent): void
}>()

const paneRef = ref<InstanceType<typeof TerminalPane> | null>(null)

// 输入域历史采集器：pane 生命周期即采集生命周期（每 pane 独立行缓冲）
const inputCollector = createRemoteInputHistoryCollector({
  hostId: () => props.hostId,
  sessionId: () => props.sessionId,
})
onBeforeUnmount(() => inputCollector.dispose())

// PTY resize 上报：远程主机 resize 端点。
// ended（对账判死的恢复 tab）：会话已不存在，resize 必 404——静默跳过
function resizeCall(id: string, rows: number, cols: number, _silent?: boolean) {
  if (props.ended) return
  void remoteHostApi.resizeTerminal(props.hostId, id, rows, cols, { silent: true }).catch(() => {})
}

// 权威重绘（tmux refresh-client）：与项目终端 redrawTerminal 同语义——pane 重新可见/
// 宿主 fit 后由 TerminalPane 回调，服务端对原生 shell 会话 no-op、失败静默
function redrawCall(id: string) {
  void remoteHostApi.redrawTerminal(props.hostId, id, { silent: true }).catch(() => {})
}

// 粘贴上传：截图/文件经远程端点上传远端 /tmp 后把路径贴入终端。
// kind=image 截图链 / kind=file 白名单文件链（P-20261024-2）——同端点按字段分派
async function uploadPaste(file: File, kind: 'image' | 'file'): Promise<string | null> {
  // 响应拦截器已解包：res 即响应体 { data: { path, size } }
  const res = (kind === 'image'
    ? await remoteHostApi.uploadPasteImage(props.hostId, file)
    : await remoteHostApi.uploadPasteFile(props.hostId, file)) as unknown as { data?: { path: string } }
  return res.data?.path ?? null
}

// 供宿主（远程控制台视图）编排：写入能力（常用命令）+ 右键菜单动作（与项目终端同款转发语义）
defineExpose({
  writeInput: (data: string) => paneRef.value?.writeInput(data) ?? false,
  focus: () => paneRef.value?.focus(),
  copySelection: () => paneRef.value?.copySelection(),
  copyAsCodeBlock: () => paneRef.value?.copyAsCodeBlock(),
  copyAll: () => paneRef.value?.copyAll(),
  copyLastOutput: () => paneRef.value?.copyLastOutput(),
  pasteFromClipboard: () => paneRef.value?.pasteFromClipboard(),
  exportAsText: (name: string) => paneRef.value?.exportAsText(name),
  getSelectionLength: () => paneRef.value?.getSelectionLength() ?? 0,
  clear: () => paneRef.value?.clear(),
  // 会话是否收到过服务端输出：宿主延迟提示（SFTP 无 shell → 长时间零输出）判定用
  hasReceivedOutput: () => paneRef.value?.hasReceivedOutput() ?? false,
  // 宿主主动断开（对账判死已结束的恢复 tab：终止无效的重连尝试）
  disconnect: () => paneRef.value?.disconnect(),
  // deep 透传：宿主「刷新」入口的深度语义（滚动区强制重同步）不能在转发层丢失
  fit: (deep?: boolean) => paneRef.value?.fit(deep),
})
</script>

<template>
  <div class="remote-pane-root">
    <TerminalPane
      ref="paneRef"
      :key="sessionId"
      :session-id="sessionId"
      :ws-url-factory="getRemoteTerminalWsUrl"
      :resize-call="resizeCall"
      :upload-paste="uploadPaste"
      :active="props.active !== false"
      :ended="props.ended"
      :redraw-call="redrawCall"
      :input-tap="inputCollector.tap"
      @exit="(sid: string) => emit('exit', sid)"
      @contextmenu="(ev: MouseEvent) => emit('contextmenu', ev)"
    />
  </div>
</template>

<style scoped>
.remote-pane-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
/* .term-pane 的布局由宿主视图的 scoped 样式管理（项目终端路径由
   TerminalPanesArea 的 flex 规则给满高度）。远程路径的宿主是本组件——
   若不补齐满高尺寸，容器高度恒等于画布高度：ResizeObserver 永不触发、
   PTY 列行数停在创建时刻，窗口/面板放大后终端下方留大片死区（用户实测） */
.remote-pane-root :deep(.term-pane) {
  width: 100%;
  height: 100%;
}
</style>
