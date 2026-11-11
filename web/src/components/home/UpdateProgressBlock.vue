<script setup lang="ts">
/**
 * 版本面板的更新进度/结局块（P-20261109-10，自 VersionPanel 抽出）：数据全取自
 * updateProgress store——轮询在 store（全局），面板只是消费方之一，关面板/切路由/
 * F5 后重开进度照常恢复；全局徽标（UpdateProgressBadge）同源。
 *   - 进行中：阶段文案（update.phase.* 全态登记，取键走 phaseLabelKey——不再
 *     动态拼 update.<status> 直出键名原文）+ 进度条（下载按字节百分比，其余在途
 *     阶段流动条）+ 字节明细（续传会话追加「已续传 xxMB」，P-20261110-1-S4）+
 *     「可关闭面板继续操作」提示（非模态）；
 *   - 结局：本会话终局，或服务端快照里的上次失败/回滚（失败通知「查看详情」
 *     回跳的落点——原因原文在此）。成功提示刷新（本页仍跑旧 bundle）；
 *     失败态一键重试（P-20261110-1-S2：复用 apply 受理端点，拒因落回原因行）；
 *     「知道了」确认已读（DELETE 清结果文件与失败态）
 */
import { computed, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { formatBytes } from '../../utils/bytes'
import { useUpdateProgressStore, phaseLabelKey } from '../../stores/updateProgress'

const { t } = useI18n()
const progress = useUpdateProgressStore()

const phaseText = computed(() => t(phaseLabelKey(progress.phase)))
/** 下载阶段且有字节进度 → 确定进度条；其余在途阶段 → 流动条 */
const determinate = computed(() => progress.phase === 'downloading' && progress.percent > 0)
const bytesText = computed(() => t('update.progressInfo.bytes', {
  percent: progress.percent,
  done: formatBytes(progress.snapshot?.progress ?? 0),
  total: formatBytes(progress.snapshot?.total ?? 0),
}))
/** 断点续传透出（P-20261110-1-S4）：续传会话（服务端 resumedBytes>0）在字节明细
 *  旁追加「已续传 xxMB」；全量会话/回退归 0 不显，语义 = 这次尝试从哪继续 */
const resumedVisible = computed(() => progress.phase === 'downloading' && progress.resumedBytes > 0)
const resumedText = computed(() => t('update.progressInfo.resumed', { bytes: formatBytes(progress.resumedBytes) }))

const outcome = computed(() => progress.lastOutcome)
const outcomeTone = computed(() => {
  const ph = outcome.value?.phase
  if (ph === 'success') return 'success'
  if (ph === 'rolled_back') return 'waiting'
  return 'failed'
})

/** 结果文件时刻（服务端 RFC3339）→ 本地时间；非法串原样回显 */
function formatAt(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function reloadPage(): void {
  window.location.reload()
}

// 失败态一键重试（P-20261110-1-S2）：复用 apply 受理端点重新受理（服务端对
// failed 终态自 Reset 重走受理链）——此前失败后重试须绕回「立即更新」，通知
// 「查看详情」回跳的落点（本结局块）直接可重试（升级链中断恢复形态）。拒因经
// store 落回结局块的原因行（本组件无 message 注入点，以原因行为准不弹层）
const retrying = ref(false)

async function retryUpdate(): Promise<void> {
  if (retrying.value) return
  retrying.value = true
  try {
    await progress.retry({ silent: true })
  } catch { /* 拒因已由 store settle 回结局块，无 message 注入点不重复出提示 */ } finally {
    retrying.value = false
  }
}
</script>

<template>
  <div
    v-if="progress.inFlight"
    class="upd-block"
    data-testid="version-update-progress"
  >
    <div class="upd-row">
      <span class="upd-label">{{ t('update.status') }}</span>
      <span
        class="upd-value"
        data-testid="version-update-phase"
      >{{ phaseText }}</span>
    </div>
    <div
      class="upd-bar"
      :class="{ 'upd-bar--indeterminate': !determinate }"
    >
      <div
        class="upd-fill"
        :style="determinate ? { width: progress.percent + '%' } : undefined"
      />
    </div>
    <div
      v-if="determinate"
      class="upd-row"
    >
      <span
        class="upd-value muted"
        data-testid="version-update-bytes"
      >{{ bytesText }}</span>
      <span
        v-if="resumedVisible"
        class="upd-resumed"
        data-testid="version-update-resumed"
      >{{ resumedText }}</span>
    </div>
    <div class="upd-row">
      <span class="upd-value muted">{{ t('update.progressInfo.background') }}</span>
    </div>
  </div>
  <div
    v-else-if="outcome"
    class="upd-block upd-outcome"
    :class="`upd-outcome--${outcomeTone}`"
    data-testid="version-update-outcome"
  >
    <div class="upd-row">
      <span class="upd-label">{{ progress.outcome ? t('update.status') : t('update.progressInfo.lastOutcome') }}</span>
      <span
        class="upd-value upd-outcome-phase"
        data-testid="version-update-outcome-phase"
      >{{ t(phaseLabelKey(outcome.phase)) }}</span>
    </div>
    <div
      v-if="outcome.error"
      class="upd-row"
    >
      <span
        class="upd-value muted prewrap"
        data-testid="version-update-outcome-reason"
      >{{ t('update.progressInfo.reason', { reason: outcome.error }) }}</span>
    </div>
    <div
      v-if="outcome.at"
      class="upd-row"
    >
      <span class="upd-value muted">{{ t('update.progressInfo.at', { time: formatAt(outcome.at) }) }}</span>
    </div>
    <div
      v-if="outcome.phase === 'unknown'"
      class="upd-row"
    >
      <span class="upd-value muted">{{ t('update.progressInfo.unknownHint') }}</span>
    </div>
    <template v-if="outcome.phase === 'success'">
      <div class="upd-row">
        <span class="upd-value muted">{{ t('update.progressInfo.refreshHint') }}</span>
      </div>
      <button
        type="button"
        class="upd-btn primary"
        data-testid="version-update-refresh"
        @click="reloadPage"
      >
        {{ t('update.progressInfo.refreshNow') }}
      </button>
    </template>
    <!-- 失败态一键重试（P-20261110-1-S2）：主按钮位（与成功态刷新同级显眼），
         知道了退居其后——失败的首要出口是重试而非关闭 -->
    <button
      v-if="outcome.phase === 'failed'"
      type="button"
      class="upd-btn primary"
      data-testid="version-update-retry"
      :disabled="retrying"
      @click="retryUpdate"
    >
      {{ retrying ? t('update.progressInfo.retrying') : t('update.progressInfo.retry') }}
    </button>
    <button
      type="button"
      class="upd-btn"
      data-testid="version-update-ack"
      @click="progress.acknowledge()"
    >
      {{ t('update.progressInfo.dismiss') }}
    </button>
  </div>
</template>

<style scoped>
.upd-block { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.upd-row { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
.upd-label { color: var(--text-dim); flex-shrink: 0; min-width: 64px; }
.upd-value { color: var(--text-primary); word-break: break-all; }
.upd-value.muted { font-size: 12px; color: var(--text-dim); }
.upd-value.prewrap { white-space: pre-wrap; }
/* 续传标记（P-20261110-1-S4）：正向状态语义色，尺寸与字节明细同级保持克制 */
.upd-resumed { font-size: 12px; color: var(--status-success); white-space: nowrap; flex-shrink: 0; }
.upd-bar {
  position: relative; width: 100%; height: 4px; border-radius: 2px; overflow: hidden;
  background: var(--border-default);
}
.upd-fill {
  height: 100%; width: 0; border-radius: 2px; background: var(--accent-blue);
  transition: width var(--motion-slow) var(--ease-standard);
}
/* 非下载在途阶段（校验/安装/重启/推断重连）：流动条——有进展但无字节分母 */
.upd-bar--indeterminate .upd-fill {
  width: 30%;
  animation: upd-flow 1.4s ease-in-out infinite;
}
@keyframes upd-flow {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(340%); }
}
@media (prefers-reduced-motion: reduce) {
  .upd-bar--indeterminate .upd-fill { animation: none; width: 100%; }
}
/* 结局块：左缘色条按结局语义着色（色彩红线：状态语义变量） */
.upd-outcome { padding-left: 10px; border-left: 3px solid var(--status-failed); }
.upd-outcome--success { border-left-color: var(--status-success); }
.upd-outcome--waiting { border-left-color: var(--status-waiting); }
.upd-outcome-phase { font-weight: 600; }
.upd-btn {
  width: 100%; padding: 8px 0; border: 1px solid var(--border-default); border-radius: 6px;
  background: transparent; color: var(--text-secondary); font-size: 13px; cursor: pointer;
  transition: all var(--motion-base);
}
.upd-btn:hover { border-color: var(--accent-blue); color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 8%, transparent); }
.upd-btn.primary { background: var(--accent-blue); border-color: var(--accent-blue); color: var(--bg-primary); font-weight: 600; }
.upd-btn.primary:hover { opacity: 0.85; background: var(--accent-blue); color: var(--bg-primary); }
</style>
