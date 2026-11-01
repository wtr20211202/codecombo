<script setup lang="ts">
/**
 * 回放深链消费宿主（P-20261003-154）：Layout 挂载一次，渲染 ?session=&turn=
 * 深链打开的回放弹层。深链与会话中心/审批卡的回放弹层互不相干——深链自有
 * 宿主，不依赖任何列表面处于打开态（直达语义）。消费时序（bootstrap 后 flush /
 * 锁定解锁接力 / SPA 再入即时消费）收口在 useSessionReplayDeepLink。
 */
import { onBeforeUnmount } from 'vue'
import SessionReplayModal from './SessionReplayModal.vue'
import { closeReplayDeepLink, useSessionReplayDeepLink } from '../../composables/useSessionReplayDeepLink'

const { replaySession, replayTurn } = useSessionReplayDeepLink()

// 实例切换 = Layout 重挂载：弹层状态是模块单例，残留会把旧实例的会话 id 打到
// 新实例的数据面（timeline 404/异实）——卸载即收口；挂起未消费的 pending 不清，
// 新宿主从 URL 重新捕获接力（composable 模块头注释）
onBeforeUnmount(closeReplayDeepLink)
</script>

<template>
  <SessionReplayModal
    :show="!!replaySession"
    :session="replaySession"
    :focus-turn="replayTurn >= 0 ? replayTurn : undefined"
    @update:show="(v: boolean) => { if (!v) closeReplayDeepLink() }"
  />
</template>
