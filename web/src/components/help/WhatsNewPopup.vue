<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import { marked } from 'marked'
import { watch } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useLockStore } from '../../stores/lock'
import { checkWhatsNew, dismissWhatsNew, useWhatsNew } from '../../composables/useWhatsNew'
import { openHelpEntry } from '../../utils/openHelp'

// 升级后首启一次性轻弹层（P-20261007-17）：对比 localStorage 上次已读版本，
// delta 只显新版段落（判定与记账在 useWhatsNew）。解锁后启动判定——锁定遮罩
// 之下弹层不可交互，盖在锁屏上纯属打扰；「查看历史」经 sc-open-help 深链直达
// 帮助中心 whats-new 条目（后端 help.Get 并入的同一份数据源，历史版本可回看）
const { t } = useI18n()
const lockStore = useLockStore()
const { show, delta } = useWhatsNew()

// 解锁态门控：锁屏期间不判定（等解锁后跑一次）；isReady 防 boot 竞态误判
watch(
  () => lockStore.isReady && !lockStore.isLocked,
  (unlocked) => { if (unlocked) checkWhatsNew() },
  { immediate: true },
)

/** 段落要点为构建期冻结的本系统嵌入文档（docs/whatsnew.md），marked 渲染 */
function renderBody(md: string): string {
  return marked.parse(md, { async: false }) as string
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :title="t('whatsNew.title')"
    style="width: var(--modal-w-sm); max-width: 94vw"
    class="whats-new-modal"
    data-test="whats-new-modal"
  >
    <div class="wn-sections">
      <div
        v-for="s in delta"
        :key="s.version + s.title"
        class="wn-section"
      >
        <div class="wn-ver">
          <span
            v-if="s.version"
            class="wn-badge"
          >v{{ s.version }}</span>
          <span
            v-if="s.title"
            class="wn-title"
          >{{ s.title }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html —— 内容为本系统后端嵌入的受信静态文档（构建期冻结） -->
        <div
          class="wn-body"
          v-html="renderBody(s.body)"
        />
      </div>
    </div>
    <template #footer>
      <div class="wn-footer">
        <button
          class="wn-history"
          data-test="whats-new-history"
          @click="openHelpEntry('whats-new')"
        >
          {{ t('whatsNew.viewHistory') }}
        </button>
        <NButton
          type="primary"
          size="small"
          data-test="whats-new-dismiss"
          @click="dismissWhatsNew"
        >
          {{ t('whatsNew.dismiss') }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.wn-sections { display: flex; flex-direction: column; gap: 14px; max-height: 56vh; overflow: auto; }
.wn-ver { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
.wn-badge {
  font-size: 12px; font-weight: 600; color: var(--accent-blue);
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  padding: 1px 8px; border-radius: 5px; flex-shrink: 0;
}
.wn-title { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.wn-body {
  font-size: 12.5px; line-height: 1.7; color: var(--text-secondary);
  padding-left: 2px;
}
.wn-body :deep(ul), .wn-body :deep(ol) { margin: 4px 0; padding-left: 18px; }
.wn-body :deep(p) { margin: 4px 0; }
.wn-body :deep(code) {
  font-family: var(--font-mono); font-size: 11.5px;
  padding: 1px 5px; border-radius: 4px;
  background: var(--bg-canvas); border: 1px solid var(--border-subtle);
}
.wn-footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.wn-history {
  border: none; background: transparent; padding: 2px 0;
  color: var(--text-muted); font-size: 12px; cursor: pointer;
}
.wn-history:hover { color: var(--accent-blue); }
</style>
