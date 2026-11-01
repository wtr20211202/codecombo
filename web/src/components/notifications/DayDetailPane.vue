<script setup lang="ts">
// 单日详情视图（P-20261003-4 渲染面拆出）：项目聚合行（提交/会话/Token/命令
// 四项事实 + 提交主题明细）+ 实例级事实条。纯展示——取数与失败反馈在宿主
// DailyReportHistory；拆出的另一半原因：宿主叠加周报拼接（P-20261003-135）
// 后逼近 500 行上限（前端编码规范），详情渲染面自包含保住单文件预算
import { computed } from 'vue'
import { NEmpty } from 'naive-ui'
import type { DailyReportEntry } from '../../api/domains/report'
import { useI18n } from '../../composables/useI18n'
import { fmtTokensCompact } from '../../utils/weeklyReport'

const props = defineProps<{
  detail: DailyReportEntry[]
  loading: boolean
}>()

const { t } = useI18n()

// 实例级事实（审批/部署）无项目归属、同日各条相同——取首条展示一次
const instanceFacts = computed(() => props.detail[0] ?? null)
</script>

<template>
  <div
    class="rdd-detail"
    data-testid="report-archive-detail"
  >
    <div
      v-if="loading"
      class="rdd-loading"
    >
      {{ t('report.archive.loading') }}
    </div>
    <template v-else-if="detail.length > 0">
      <div
        v-for="e in detail"
        :key="e.projectId"
        class="rdd-entry"
        :data-testid="'report-archive-entry-' + e.projectId"
      >
        <div class="rdd-entry-head">
          <span class="rdd-entry-name">{{ e.projectName }}</span>
          <span class="rdd-entry-stat">{{ t('report.archive.commits') }} {{ e.commits }}</span>
          <span class="rdd-entry-stat">{{ t('report.archive.sessions') }} {{ e.sessions }}</span>
          <span class="rdd-entry-stat">{{ t('report.archive.tokens') }} {{ fmtTokensCompact(e.tokens) }}</span>
          <span class="rdd-entry-stat">{{ t('report.archive.cmds') }} {{ e.cmds }}</span>
        </div>
        <ul
          v-if="e.commitSubjects && e.commitSubjects.length > 0"
          class="rdd-subjects"
          data-testid="report-archive-subjects"
        >
          <li
            v-for="(s, i) in e.commitSubjects"
            :key="i"
          >
            {{ s }}
          </li>
        </ul>
      </div>
      <div
        v-if="instanceFacts"
        class="rdd-instance"
      >
        {{ t('report.archive.approvals') }} {{ t('report.archive.approvalsDetail', { done: instanceFacts.approvalsDone, pending: instanceFacts.approvalsPending }) }}
        <span class="rdd-instance-sep">·</span>
        {{ t('report.archive.deploys') }} {{ t('report.archive.deploysDetail', { ok: instanceFacts.deploysOk, fail: instanceFacts.deploysFail }) }}
      </div>
    </template>
    <div
      v-else
      class="rdd-empty"
    >
      <n-empty
        size="small"
        :description="t('report.archive.emptyDay')"
      />
    </div>
  </div>
</template>

<style scoped>
.rdd-detail {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.rdd-loading {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
  width: 100%;
}
.rdd-entry {
  border: 1px solid var(--border-default);
  border-radius: 7px;
  padding: 8px 10px;
  background: var(--bg-panel);
}
.rdd-entry-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.rdd-entry-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-right: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rdd-entry-stat {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
.rdd-subjects {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 120px;
  overflow-y: auto;
}
.rdd-subjects li {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-body);
  word-break: break-word;
}
.rdd-instance {
  flex-shrink: 0;
  border-top: 1px solid var(--border-default);
  padding: 7px 2px 2px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
}
.rdd-instance-sep { margin: 0 6px; }
.rdd-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px 16px;
}
</style>
