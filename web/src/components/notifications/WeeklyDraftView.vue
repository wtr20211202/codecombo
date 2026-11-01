<script setup lang="ts">
// 周报草稿视图（P-20261003-135）：日报历史面板多选日期后「拼接为周报草稿」的
// 预览面——纯展示 + 复制/下载两个出口，数据获取与按日装配在宿主
// DailyReportHistory（宿主已持有存档取数与失败反馈链），本组件把
// WeeklyReportDay[] 经 utils/weeklyReport 纯函数合成为 markdown。与 changelog
// 草稿弹层（P-20261003-27）同族形态；复制走 copyText 降级链（健壮性红线）
import { computed } from 'vue'
import { NIcon, createDiscreteApi } from 'naive-ui'
import { ArrowBackOutline, CopyOutline, DownloadOutline } from '@vicons/ionicons5'
import { useThemeStore } from '../../stores/theme'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { buildWeeklyReportDraft, type WeeklyReportDay } from '../../utils/weeklyReport'

const props = defineProps<{
  days: WeeklyReportDay[]
  loading: boolean
}>()

const emit = defineEmits<{
  (e: 'back'): void
}>()

const { t } = useI18n()
const themeStore = useThemeStore()

// 离散 message（宿主同范式）：不依赖祖先 NMessageProvider
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

const draft = computed(() =>
  buildWeeklyReportDraft(props.days, {
    title: t('report.weekly.title'),
    commits: t('report.archive.commits'),
    sessions: t('report.archive.sessions'),
    tokens: t('report.archive.tokens'),
    cmds: t('report.archive.cmds'),
  }),
)

async function handleCopy(): Promise<void> {
  if (draft.value.empty) return
  const ok = await copyText(draft.value.markdown)
  if (ok) message.success(t('common.copied'))
  else message.error(t('common.copyFailed'))
}

// 下载 .md：文件名全部由系统生成的日期段拼成（YYYYMMDD 均为安全字符），不含
// 用户自由文本标题，无需 exportFileName 的净化/摘要链（claude 导出先例是标题
// 为用户内容才需要）
function handleDownload(): void {
  if (draft.value.empty) return
  const dates = props.days.map(d => d.date).filter(Boolean).sort()
  const span = dates.length > 1 ? `${dates[0]!.replaceAll('-', '')}-${dates[dates.length - 1]!.replaceAll('-', '')}` : (dates[0] ?? '').replaceAll('-', '')
  const blob = new Blob([draft.value.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `weekly-report-${span || 'draft'}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
</script>

<template>
  <div
    class="rwd-wrap"
    data-testid="weekly-draft-view"
  >
    <div
      v-if="loading"
      class="rwd-loading"
    >
      {{ t('report.weekly.building') }}
    </div>
    <template v-else-if="!draft.empty">
      <pre
        data-testid="weekly-draft-preview"
        class="rwd-preview"
      >{{ draft.markdown }}</pre>
      <div class="rwd-actions">
        <button
          class="rwd-btn"
          data-testid="weekly-draft-back"
          @click="emit('back')"
        >
          <n-icon size="12">
            <ArrowBackOutline />
          </n-icon>
          {{ t('report.weekly.back') }}
        </button>
        <span class="rwd-spacer" />
        <button
          class="rwd-btn"
          data-testid="weekly-draft-download"
          @click="handleDownload"
        >
          <n-icon size="12">
            <DownloadOutline />
          </n-icon>
          {{ t('report.weekly.download') }}
        </button>
        <button
          class="rwd-btn primary"
          data-testid="weekly-draft-copy"
          @click="handleCopy"
        >
          <n-icon size="12">
            <CopyOutline />
          </n-icon>
          {{ t('report.weekly.copy') }}
        </button>
      </div>
    </template>
    <div
      v-else
      class="rwd-empty"
      data-testid="weekly-draft-empty"
    >
      {{ t('report.weekly.emptyDraft') }}
    </div>
  </div>
</template>

<style scoped>
.rwd-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.rwd-loading {
  padding: 24px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
.rwd-preview {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 10px 12px;
  overflow-y: auto;
  border: 1px solid var(--border-default);
  border-radius: 7px;
  background: var(--bg-surface);
  color: var(--text-body);
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.rwd-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
}
.rwd-spacer { flex: 1; }
.rwd-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 5px;
  cursor: pointer;
  transition: all var(--motion-base);
}
.rwd-btn:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}
.rwd-btn.primary {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
}
.rwd-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 30px 16px;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
