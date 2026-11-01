<script setup lang="ts">
/**
 * 审批卡 target 浮窗 diff 预览（P-20261003-253）：路径形态 target 悬停延迟
 * 弹出工作区 diff 摘要，裁决时不离开卡面即可速读「agent 要改什么」（P-47
 * 点击跳编辑器的浮窗版，P-50 预览标签的浮窗形态）。
 *
 * - 触发器经默认 slot 注入（卡内 target 可点态按钮），点击链不经过本组件
 *   ——P-47 点击语义（开文件 / 直开 vs HEAD 差异视图）原样保留；
 * - 数据面 = 既有 `GET /file/diff`（staged + 未 staged 两次轻量单文件 diff
 *   并行，合成即「未提交 vs HEAD」摘要；同段改动先暂存再改会各计一次，示意
 *   口径与 P-20261003-177 diffstat 同语义）。一次性拉取：首开拉取、成功后
 *   缓存（卡生命周期短，裁决时刻的差异快照足够）；失败不缓存，下次悬停重试；
 * - 展示文本：target 走脱敏后数据（P-20261003-197 边界在组件内收口）；
 *   diff 内容行是工作区文件差异，与 DiffViewer 同面不做审批文本遮蔽。
 */
import { NPopover } from 'naive-ui'
import { computed, ref } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { diffApi } from '../../api/client'
import { normRelPath } from '../../utils/approvalTarget'
import { maskApprovalSecrets } from '../../utils/sensitiveMask'
import { diffSummaryHasChanges, summarizeUnifiedDiff, type DiffSummary } from '../../utils/diffSummary'

const props = defineProps<{
  /** 原始 target 文本（宿主已过 isPathLikeTarget 形态守卫）；展示走脱敏，
   *  API 取 normRelPath 归一（反斜杠统一正斜杠，git 双平台均接受） */
  target: string
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

/** 展示头 target 文本（P-20261003-197：审批自由文本出卡面前遮蔽兜底） */
const safePath = computed(() => maskApprovalSecrets(props.target))

// 受控显隐（单点状态，ApprovalTierPopover 同款）：hover 触发器由 naive-ui
// 驱动 update:show，开合状态收口到 show——延迟参数见模板（400ms 防误弹）
const show = ref(false)
function onShowUpdate(v: boolean): void {
  show.value = v
  if (v) void fetchSummary()
}

const loading = ref(false)
/** 成功拉取后置位：一次性拉取的缓存闸（失败不置位，下次悬停重试） */
const loaded = ref(false)
const failed = ref(false)
const summary = ref<DiffSummary | null>(null)
const hasChanges = computed(() => !!summary.value && diffSummaryHasChanges(summary.value))

/** 首开拉取（并发悬停/重复开合只发一轮）：两次单文件 git diff 并行，静默
 *  失败降级为浮窗内提示（hover 链不弹拦截器全局错误）。仅悬停时刻触发，
 *  不进渲染热路径 */
async function fetchSummary(): Promise<void> {
  if (loaded.value || loading.value) return
  const pid = projectStore.currentProjectId
  if (!pid) {
    failed.value = true // 无当前项目上下文：无处取数，浮窗内如实降级
    return
  }
  loading.value = true
  failed.value = false
  try {
    const file = normRelPath(props.target)
    const [wt, staged] = await Promise.all([
      diffApi.getFileDiff(pid, file, false, { silent: true }),
      diffApi.getFileDiff(pid, file, true, { silent: true }),
    ])
    summary.value = summarizeUnifiedDiff(`${wt.data || ''}\n${staged.data || ''}`)
    loaded.value = true
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <n-popover
    :show="show"
    trigger="hover"
    :delay="400"
    :duration="100"
    placement="top"
    raw
    :z-index="3100"
    @update:show="onShowUpdate"
  >
    <template #trigger>
      <slot />
    </template>
    <div
      class="aprv-tdiff"
      data-test="aprv-target-pop"
      role="tooltip"
      :aria-label="t('approval.targetDiff.title')"
    >
      <!-- 头部：脱敏 target 文本（浮窗自身携带路径上下文，多卡弹窗可辨归属）+
           增删计数（+/- 符号与数字为 diff 速记记法，非文案）+ 改动块数 -->
      <div class="aprv-tdiff-head">
        <span
          class="aprv-tdiff-path"
          data-test="aprv-target-pop-path"
        >{{ safePath }}</span>
        <span
          v-if="!loading && !failed && summary"
          class="aprv-tdiff-stat"
          data-test="aprv-target-pop-stat"
        >
          <span class="aprv-tdiff-add">+{{ summary.additions }}</span>
          <span
            class="aprv-tdiff-del"
            :class="{ 'is-zero': summary.deletions === 0 }"
          >-{{ summary.deletions }}</span>
          <span
            v-if="summary.hunks > 0"
            class="aprv-tdiff-hunks"
          >{{ t('approval.targetDiff.hunks', { n: summary.hunks }) }}</span>
        </span>
      </div>
      <div
        v-if="loading"
        class="aprv-tdiff-note"
        data-test="aprv-target-pop-loading"
      >{{ t('approval.targetDiff.loading') }}</div>
      <!-- 失败态：浮窗内降级提示（可恢复——下次悬停重试），点击链不受影响 -->
      <div
        v-else-if="failed"
        class="aprv-tdiff-note"
        data-test="aprv-target-pop-error"
      >{{ t('approval.targetDiff.error') }}</div>
      <!-- 无 diff：如实提示（干净文件/将新建路径/二进制外的空差异），引导点击 -->
      <div
        v-else-if="!hasChanges"
        class="aprv-tdiff-note"
        data-test="aprv-target-pop-empty"
      >{{ t('approval.targetDiff.empty') }}</div>
      <template v-else>
        <div class="aprv-tdiff-body">
          <div
            v-for="(l, i) in summary!.preview"
            :key="i"
            class="aprv-tdiff-line"
            :class="`is-${l.kind}`"
            data-test="aprv-target-pop-line"
          >{{ l.text }}</div>
          <div
            v-if="summary!.hidden > 0"
            class="aprv-tdiff-more"
          >{{ t('approval.targetDiff.more', { n: summary!.hidden }) }}</div>
        </div>
      </template>
      <!-- 底部引导：点击仍走 P-47 链（有差异直开对比视图，无差异开文件） -->
      <div class="aprv-tdiff-foot">{{ t('approval.targetDiff.openHint') }}</div>
    </div>
  </n-popover>
</template>

<style scoped>
/* raw popover：内容样式自持（scoped 不跨组件）。颜色全走主题变量，四主题
   自适应；增删行底色与 DiffViewer 同源（color-mix 低占比），速读不喧宾 */
.aprv-tdiff {
  max-width: 460px; padding: 8px 10px;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: 8px; box-shadow: var(--shadow-pop-lg);
}
.aprv-tdiff-head {
  display: flex; align-items: baseline; gap: 8px; min-width: 0;
  margin-bottom: 4px;
}
.aprv-tdiff-path {
  font-family: monospace; font-size: 0.78em; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aprv-tdiff-stat {
  margin-left: auto; flex-shrink: 0; display: inline-flex; gap: 6px;
  font-family: monospace; font-size: 0.74em;
}
.aprv-tdiff-add { color: var(--accent-green); }
.aprv-tdiff-del { color: var(--accent-red-bright); }
/* 零删除弱化呈现（+N -0 场景 -0 不抢视觉），保持数字可见 */
.aprv-tdiff-del.is-zero { opacity: 0.55; }
.aprv-tdiff-hunks { color: var(--text-secondary); }
.aprv-tdiff-note {
  font-size: 0.76em; color: var(--text-secondary); line-height: 1.5;
}
.aprv-tdiff-body {
  display: flex; flex-direction: column; gap: 1px;
  max-height: 180px; overflow-y: auto;
}
.aprv-tdiff-line {
  font-family: monospace; font-size: 0.74em; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all;
  padding: 0 4px; border-radius: 3px;
}
.aprv-tdiff-line.is-add { background: color-mix(in srgb, var(--accent-green) 15%, transparent); }
.aprv-tdiff-line.is-del { background: color-mix(in srgb, var(--accent-red-bright) 15%, transparent); }
.aprv-tdiff-line.is-meta { color: var(--text-dim); }
.aprv-tdiff-more {
  font-size: 0.72em; color: var(--text-secondary); padding: 2px 4px 0;
}
.aprv-tdiff-foot {
  margin-top: 5px; padding-top: 4px; border-top: 1px solid var(--border-subtle);
  font-size: 0.7em; color: var(--text-dim);
}
</style>
