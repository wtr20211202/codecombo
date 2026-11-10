<script setup lang="ts">
// 伴随校验资产未取到告警（P-20261109-9）：版本面板「发现新版本」块内的即时提示——
// 后端检查已判定此刻更新必被校验拒绝（.sha256/.sig 在 release 但没拉到），逐资产
// 原因如实透出。纯展示：「立即更新」按钮由宿主保持可点（点击后端先 skipCache
// 重拉，瞬时失败不该伪装成不可用——置灰方案已否决）。
// 自 VersionPanel 拆出：宿主已超单文件 500 行规范，新增块不再继续内联
import { NIcon } from 'naive-ui'
import { WarningOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

defineProps<{ reason?: string }>()

const { t } = useI18n()
</script>

<template>
  <div
    class="version-companion-warn"
    role="alert"
  >
    <n-icon
      size="16"
      class="version-companion-warn-icon"
    >
      <WarningOutline />
    </n-icon>
    <div class="version-companion-warn-body">
      <span class="version-companion-warn-text">{{ t('update.companionFetchFailedHint') }}</span>
      <span
        v-if="reason"
        class="version-companion-warn-reason"
      >{{ t('update.companionFetchFailedReason', { reason }) }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 告警色走 --accent-yellow-warm（告警 chip 惯例，六主题同键），文字走正文色
   守对比度；原因段含 URL，break-all 防长串撑破面板 */
.version-companion-warn {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 10px; border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--accent-yellow-warm) 45%, transparent);
  background: color-mix(in srgb, var(--accent-yellow-warm) 10%, transparent);
}
.version-companion-warn-icon { color: var(--accent-yellow-warm); flex-shrink: 0; margin-top: 1px; }
.version-companion-warn-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.version-companion-warn-text { color: var(--text-primary); font-size: 12.5px; line-height: 1.5; }
.version-companion-warn-reason { color: var(--text-secondary); font-size: 12px; word-break: break-all; }
</style>
