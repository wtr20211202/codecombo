<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import RemoteConsoleView from '../../views/remote/RemoteConsoleView.vue'

/**
 * 首页远程控制台全屏 overlay：不进项目即可使用远程控制台。
 * - 打开后保活（v-if everOpened + v-show）：关闭仅隐藏，不断开进行中的 WS 会话；
 *   服务端会话由关闭 tab / GC 管理，重开 overlay 自动恢复 tab 列表
 * - Esc 关闭（有弹窗/片段面板时让位）
 */
const show = defineModel<boolean>('show', { required: true })

const everOpened = ref(false)
watch(show, (v) => { if (v) everOpened.value = true })

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape' && show.value) {
    if (document.querySelector('.n-modal, .n-dialog, .remote-snippet-panel')) return
    show.value = false
  }
}
onMounted(() => document.addEventListener('keydown', onKeyDown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="everOpened"
      v-show="show"
      class="remote-console-overlay"
    >
      <RemoteConsoleView
        standalone
        @close="show = false"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.remote-console-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: var(--bg-primary);
}
</style>
