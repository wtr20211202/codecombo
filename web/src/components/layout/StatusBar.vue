<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NIcon } from 'naive-ui'
import { GitBranchOutline, OpenOutline, RefreshOutline, AlertCircleOutline, WarningOutline, TimeOutline } from '@vicons/ionicons5'
import { useProjectStore } from '@/stores/project'
import { useChangesStore } from '@/stores/changes'
import { useUpdateCheckStore } from '@/stores/updateCheck'
import { useEditorProblems } from '@/composables/useEditorProblems'
import { useI18n } from '@/composables/useI18n'
import { useCompareBaseline } from '@/composables/useCompareBaseline'
import { useWatchFallback } from '@/composables/useWatchFallback'
import HomeVersionModal from '../home/HomeVersionModal.vue'

const projectStore = useProjectStore()
const changesStore = useChangesStore()
const updateCheckStore = useUpdateCheckStore()
const { t } = useI18n()
// 两文件对比基准（P-20261002-75）：模块单例同源展示；跨项目残留按不匹配隐藏
const { baseline: compareBase, clearCompareBaseline } = useCompareBaseline()
const compareBaseName = computed(() => {
  const b = compareBase.value
  return b && b.projectId === projectStore.currentProjectId ? b.name : ''
})

const props = defineProps<{
  ahead?: number
  behind?: number
  remoteLoading?: boolean
  buildInfo?: {
    version: string
    commit: string
    buildTime: string
    goVersion: string
    platform: string
  } | null
}>()

const emit = defineEmits<{
  sync: []
  copyRemote: []
  showGit: []
  showChanges: []
  showProblems: []
}>()

// 问题面板计数徽标（P-20261003-297）：与底部问题面板同源（useEditorProblems
// 单例）。无诊断时不渲染——状态栏已很密，零诊断是最常见稳态不值得常驻一格；
// 有错时红色 errorCount，仅警告时黄色，点击打开问题面板。
// 注意不解构 aggregate：聚合是整体替换语义，须经返回的只读代理逐次访问
const problemsState = useEditorProblems()
const problemsVisible = computed(() => problemsState.aggregate.total > 0)
const problemsTitle = computed(() =>
  t('problems.statusTitle', {
    errors: problemsState.aggregate.errorCount,
    warnings: problemsState.aggregate.warningCount,
  }))

// 版本弹窗自持：点击版本号打开，更新检测置位高亮点。
// 角标双来源：面板手动检查的事件置位 + 全局更新检查 store
//（GitHub 分发源 / 所属中心任一路径有更新都点亮，点击版本号查看详情）
const showVersionModal = ref(false)
const hasUpdateTipEvent = ref(false)
const hasUpdateTip = computed(
  () => hasUpdateTipEvent.value || !!updateCheckStore.github?.hasUpdate || !!updateCheckStore.center,
)
const version = computed(() => props.buildInfo?.version ?? '')

const remoteDisplay = computed(() => {
  const url = projectStore.currentProject?.remoteURL
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\.git$/, '')
})

// 外部 git 操作（其他终端/编辑器里 commit、切分支等）不产生工作区文件事件，
// 变更计数会无限滞留——窗口重新聚焦时拉一次最新状态（refetch-on-focus 惯例）
function refetchChangesOnFocus(): void {
  const id = projectStore.currentProject?.id
  if (!document.hasFocus() || !id) return
  void changesStore.fetchStatus(id)
}
onMounted(() => window.addEventListener('focus', refetchChangesOnFocus))
onBeforeUnmount(() => window.removeEventListener('focus', refetchChangesOnFocus))

// 文件监听降级微标（P-20261006-34）：降级是持续态，常驻可见不靠一次性通知
// 记忆——快照拉取（挂载时一次）+ 迁移广播事件驱动显隐，聚焦重拉在单例内
//（useWatchFallback 自装 focus 监听，不挂这里防随组件重挂重复注册）
const { status: fallbackStatus, refresh: refreshFallback } = useWatchFallback()
const fallbackOn = computed(() => !!fallbackStatus.value?.enabled)
// hover 说明按来源分流恢复条件：auto 自动恢复 / manual 不参与，需经通知动作关闭
const fallbackTitle = computed(() =>
  fallbackStatus.value?.source === 'manual'
    ? t('statusbar.watchFallbackManualTip')
    : t('statusbar.watchFallbackAutoTip'),
)
onMounted(() => { void refreshFallback() })
</script>

<template>
  <div class="status-bar">
    <div class="statusbar-left">
      <button
        class="statusbar-item statusbar-branch"
        :title="t('toolbar2.branchSwitch')"
        @click="emit('showGit')"
      >
        <NIcon size="12">
          <GitBranchOutline />
        </NIcon>
        {{ projectStore.currentProject?.currentBranch || t('layout.noBranch') }}
      </button>
      <button
        v-if="(ahead ?? 0) > 0 || (behind ?? 0) > 0"
        class="statusbar-item statusbar-sync"
        :title="t('toolbar2.syncTooltip')"
        :disabled="remoteLoading"
        @click="emit('sync')"
      >
        <span
          v-if="(ahead ?? 0) > 0"
          class="sync-ahead"
        >↑{{ ahead }}</span>
        <span
          v-if="(behind ?? 0) > 0"
          class="sync-behind"
        >↓{{ behind }}</span>
        <NIcon
          v-if="remoteLoading"
          size="11"
        >
          <RefreshOutline />
        </NIcon>
      </button>
      <button
        v-if="problemsVisible"
        class="statusbar-item statusbar-problems"
        data-testid="statusbar-problems"
        :class="{ 'has-errors': problemsState.aggregate.errorCount > 0 }"
        :title="problemsTitle"
        @click="emit('showProblems')"
      >
        <NIcon
          size="11"
          class="problems-err-icon"
        >
          <AlertCircleOutline />
        </NIcon>
        <span class="problems-errors">{{ problemsState.aggregate.errorCount }}</span>
        <NIcon
          size="11"
          class="problems-warn-icon"
        >
          <WarningOutline />
        </NIcon>
        <span class="problems-warnings">{{ problemsState.aggregate.warningCount }}</span>
      </button>
      <button
        class="statusbar-item statusbar-changes"
        :title="t('statusbar.changesCount')"
        @click="emit('showChanges')"
      >
        <span class="changes-staged">{{ changesStore.stagedFiles.length }}</span>
        <span class="changes-sep">/</span>
        <span class="changes-unstaged">{{ changesStore.files.length }}</span>
        <span class="changes-label">{{ t('layout.changes') }}</span>
      </button>
      <!-- 轮询降级微标（P-20261006-34）：紧邻变更计数——它标记的正是「变更感知
           已降级」这一事实。被动指示器非动作（span 非 button，无 false affordance）：
           开关入口在通知「切换轮询」动作，悬停说明浅层扫描边界与恢复条件 -->
      <span
        v-if="fallbackOn"
        class="statusbar-item statusbar-watch-fallback"
        data-testid="statusbar-watch-fallback"
        :title="fallbackTitle"
      >
        <NIcon size="11">
          <TimeOutline />
        </NIcon>
        <span class="watch-fallback-label">{{ t('statusbar.watchFallback') }}</span>
      </span>
      <button
        v-if="compareBaseName"
        class="statusbar-item statusbar-compare-base"
        data-testid="compare-baseline"
        :title="t('compare.pick.statusTitle')"
        @click="clearCompareBaseline()"
      >
        {{ t('compare.pick.status', { name: compareBaseName }) }}
      </button>
    </div>
    <div class="statusbar-right">
      <button
        v-if="projectStore.currentProject?.remoteURL"
        class="statusbar-item statusbar-remote"
        :title="projectStore.currentProject!.remoteURL"
        @click="emit('copyRemote')"
      >
        <NIcon size="11">
          <OpenOutline />
        </NIcon>
        <span class="remote-text">{{ remoteDisplay }}</span>
      </button>
      <span
        v-if="version"
        class="statusbar-item statusbar-version"
        :class="{ 'has-update': hasUpdateTip }"
        @click="showVersionModal = true"
      >
        <span>v{{ version }}</span>
        <span
          v-if="hasUpdateTip"
          class="update-dot"
          :title="t('statusbar.hasUpdate')"
        />
      </span>
    </div>

    <HomeVersionModal
      :show="showVersionModal"
      :build-info="buildInfo ?? null"
      @close="showVersionModal = false"
      @update-detected="hasUpdateTipEvent = true"
    />
  </div>
</template>

<style scoped>
.status-bar {
  height: 24px;
  background: var(--bg-panel);
  border-top: 1px solid var(--border-default);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--space-3);
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-secondary);
}

.statusbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.statusbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.statusbar-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0 var(--space-1);
  border-radius: var(--radius-sm);
  transition: background var(--motion-base);
  font-family: var(--font-ui);
}

.statusbar-item:hover:not(:disabled) { background: var(--bg-hover); }
.statusbar-item:disabled { opacity: 0.55; cursor: not-allowed; }

.statusbar-branch {
  color: var(--accent-blue);
  font-weight: var(--fw-medium);
}

.statusbar-sync { display: inline-flex; align-items: center; gap: 3px; }

.sync-ahead { color: var(--accent-green); }
.sync-behind { color: var(--accent-orange); }

.statusbar-changes { color: var(--text-dim); }
.statusbar-changes:hover { background: var(--bg-hover); }

/* 问题计数徽标（P-20261003-297）：有错误整格红色、仅警告黄色（点击开问题面板） */
.statusbar-problems { color: var(--accent-yellow); }
.statusbar-problems.has-errors { color: var(--accent-red); }

/* 对比基准（P-20261002-75）：待决工作态用暖色点出，点击即取消 */
.statusbar-compare-base { color: var(--accent-orange); }
.statusbar-compare-base:hover { background: var(--bg-hover); }

/* 轮询降级微标（P-20261006-34）：弱化黄色常驻，被动指示器不承接点击
  （默认光标 + 无 hover 底色，与动作格区分防 false affordance） */
.statusbar-watch-fallback {
  color: var(--accent-yellow);
  cursor: default;
  white-space: nowrap;
}
.statusbar-watch-fallback:hover { background: transparent; }

.changes-staged { color: var(--accent-green-dim); }
.changes-sep { margin: 0 2px; color: var(--text-muted); }
.changes-unstaged { color: var(--accent-yellow); }
.changes-label { margin-left: var(--space-1); color: var(--text-dim); }

.statusbar-remote {
  max-width: 280px;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  color: var(--text-dim);
}
.statusbar-remote .remote-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.statusbar-version {
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  transition: all var(--motion-base);
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.statusbar-version:hover { color: var(--brand-accent); background: var(--brand-accent-soft); }
.statusbar-version.has-update { color: var(--accent-green); background: color-mix(in srgb, var(--accent-green) 12%, transparent); }

.update-dot {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--accent-green);
  box-shadow: 0 0 6px var(--accent-green);
  animation: dot-pulse 1.6s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.3); }
}

/* 窄屏状态栏（P-20261019-7）：390px 放不下远程 URL/版本号二栏——隐藏右半，
   左半只留分支、同步、问题、变更计数；「变更」文字标签收起只留数字，给
   分支名留出省略空间 */
@media (max-width: 700px) {
  .status-bar { padding: 0 var(--space-2); }
  .statusbar-left {
    gap: var(--space-1);
    min-width: 0;
    overflow: hidden;
  }
  .statusbar-right { display: none; }
  .statusbar-branch {
    max-width: 110px;
    overflow: hidden;
    text-overflow: ellipsis;
    display: inline-flex;
  }
  .statusbar-changes .changes-label { display: none; }
  /* 降级微标窄屏收起文字只留图标（P-20261019-7 同空间纪律）：指示语义仍在，
     悬停说明交给宽屏/桌面端 */
  .statusbar-watch-fallback .watch-fallback-label { display: none; }
}
</style>
