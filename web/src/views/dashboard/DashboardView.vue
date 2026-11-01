<script setup lang="ts">
// 项目仪表盘（P-20261005-224）：进项目先看状态再动手的项目级一屏聚合——
// git 态（分支/ahead-behind/脏文件数/最近 3 提交）、会话态（本项目运行中会话数）、
// 问题面（P-297 编辑器诊断计数）、近期活动（P-232 变更流按项目过滤）四分区卡，
// 各卡点击直达对应面板（纯导航），全零态紧凑单条呈现（不摆空卡）。
//
// 数据面零新增 API：ahead-behind 走 Layout 桥共享的批量探测结果（sharedAheadBehindMap），
// 脏文件/分支读 WS 保鲜的既有 store；最近 3 提交自拉（log store 单列表无项目键，
// 跨项目切换窗口期会滞留上个项目的数据——分支悬停浮窗 P-274 同款自拉先例，silent）；
// 会话归属判定收口 utils/sessionProjectMatch（agent 会话按工作目录归项目）；
// 活动走 useChangeStream 既有轮询聚合。取数并行防瀑布：四路互不依赖，提交清单
// 只有一路 HTTP（git 卡），其余全是既有响应式源直读，无 Promise.all 需求面。
//
// 显隐契约：宿主（Layout）以 v-show 保活挂载并传 visible——隐藏期停活动流轮询、
// 跳过提交刷新（git 面板自动刷新事件到达时幂等吞掉），重见即全量对账。
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { NIcon } from 'naive-ui'
import {
  GitBranchOutline, AlertCircleOutline, ChatbubblesOutline, PulseOutline,
  GitCommitOutline, RefreshOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { usePanelLayout } from '../../composables/usePanelLayout'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import { useGitPanelAutoRefresh } from '../../composables/useGitPanelAutoRefresh'
import { useChangeStream } from '../../composables/useChangeStream'
import { useEditorProblems } from '../../composables/useEditorProblems'
import { useProjectStore } from '../../stores/project'
import { useChangesStore } from '../../stores/changes'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { logApi } from '../../api/client'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import { sessionBelongsToProject } from '../../utils/sessionProjectMatch'
import { formatDate } from '../../utils/git'

const props = defineProps<{ visible: boolean }>()

const { t } = useI18n()
const layout = usePanelLayout()
const projectStore = useProjectStore()
const changesStore = useChangesStore()
const sessionsStore = useTerminalSessionsStore()
const problems = useEditorProblems()

// Layout 桥共享状态（TopBar 同款 inject 缺省形态：独立渲染/单测不炸）
const sharedAheadBehind = inject<Ref<Record<string, { ahead: number; behind: number }>>>(
  'sharedAheadBehindMap', ref({}))

const currentProject = computed(() => projectStore.currentProject)

// ============== git 态卡 ==============
const dirtyCount = computed(() => changesStore.files.length)
const aheadBehind = computed(() =>
  sharedAheadBehind.value[projectStore.currentProjectId || ''] || { ahead: 0, behind: 0 })
const branch = computed(() => currentProject.value?.currentBranch || '')

interface RecentCommit { hash: string; shortHash: string; message: string; date: string }
const recentCommits = ref<RecentCommit[]>([])
const commitsFailed = ref(false)
let commitsGen = 0

async function refreshCommits(): Promise<void> {
  const pid = projectStore.currentProjectId
  if (!props.visible || !pid) return
  const gen = ++commitsGen
  try {
    const res = await logApi.getLog(pid, { limit: 3 }, { silent: true })
    if (gen !== commitsGen) return
    recentCommits.value = ((res.data || []) as RecentCommit[]).slice(0, 3)
    commitsFailed.value = false
  } catch {
    if (gen !== commitsGen) return
    // silent 拉：失败就地降级为「暂无提交」不弹全局错误（悬停浮窗 P-274 同口径）
    commitsFailed.value = true
  }
}

// git 写类命令自动刷新（P-74/81/7 感知链复用）：隐藏期 refreshCommits 自行早退
useGitPanelAutoRefresh(() => { void refreshCommits() })

// ============== 会话态卡 ==============
// 归属判定收口 utils/sessionProjectMatch：shell 按 projectId 绑定、agent 按工作
// 目录归项目（在项目根/子目录跑的 agent 计入）
const projectSessions = computed(() => {
  const p = currentProject.value
  if (!p) return []
  return sessionsStore.sessions.filter(s => sessionBelongsToProject(s, p.id, p.path))
})
const runningCount = computed(() =>
  projectSessions.value.filter(s => sessionsStore.runningMap[s.id] === true).length)

// ============== 近期活动卡 ==============
// useChangeStream 各宿主独立实例（值班卡/活动栏面板同范式，不同路由不同时挂载）；
// 批次按当前项目过滤——服务端快照是跨项目环形缓冲，过滤是纯客户端投影
const changeStream = useChangeStream()
const activityBatches = computed(() =>
  changeStream.batches.value.filter(b => b.projectId === projectStore.currentProjectId))

// ============== 全零态 ==============
// 「无事可报」= 工作区干净且与远程同步、无运行中会话、无诊断、无近期活动。
// 最近提交不算信号（非空仓库恒有），零态条里仍带末条提交供定位
const hasSignal = computed(() =>
  dirtyCount.value > 0
  || aheadBehind.value.ahead > 0
  || aheadBehind.value.behind > 0
  || runningCount.value > 0
  || problems.aggregate.total > 0
  || activityBatches.value.length > 0)

// ============== 直达接线（纯导航） ==============
function openGitPanel() {
  layout.showBottomPanel.value = true
  layout.bottomTab.value = 'git'
}
function openProblemsPanel() {
  layout.showBottomPanel.value = true
  layout.bottomTab.value = 'problems'
}
function openSessionCenter() {
  void useAgentTerminal().open('docked')
}
function openChangeStreamPanel() {
  layout.sideView.value = 'stream'
  layout.showSidePanel.value = true
}
function openActivityFile(path: string) {
  // 活动行点击走 OPS_OPEN_FILE_AT「打开文件+定位」既有链（问题面板/TODO 面板同款
  // 解耦派发）：打开编辑器意图会顺带把主区从仪表盘切回编辑器（useLayoutViews 收口）
  const pid = projectStore.currentProjectId
  if (!pid) return
  window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
    detail: { path, projectId: pid },
  }))
}

// ============== 可见性驱动的取数节奏 ==============
// 重见（首次挂载 / v-show 切回 / 项目切换）即对账；隐藏期停活动流轮询
watch(() => props.visible, (v) => {
  if (v) {
    void refreshCommits()
    changeStream.start()
  } else {
    changeStream.stop()
  }
}, { immediate: true })

// 项目切换：提交清单是按 pid 拉的，切换即重取（活动批次 computed 随 pid 自动重投影）
watch(() => projectStore.currentProjectId, () => {
  void refreshCommits()
})

const gitHint = computed(() => {
  const ab = aheadBehind.value
  if (ab.ahead > 0 && ab.behind > 0) return t('dashboard.git.aheadBehind', { ahead: ab.ahead, behind: ab.behind })
  if (ab.ahead > 0) return t('dashboard.git.ahead', { n: ab.ahead })
  if (ab.behind > 0) return t('dashboard.git.behind', { n: ab.behind })
  return t('dashboard.git.synced')
})

/** 活动批次时间（相对时间复用 formatDate 的 locale 分档） */
function batchTime(ts: number): string {
  return formatDate(new Date(ts).toISOString())
}
</script>

<template>
  <div
    class="dashboard-view"
    data-testid="dashboard-view"
  >
    <div
      v-if="!currentProject"
      class="dashboard-empty"
    >
      {{ t('dashboard.noProject') }}
    </div>
    <template v-else>
      <header class="dashboard-head">
        <h2 class="dashboard-title">
          {{ t('dashboard.title') }}
        </h2>
        <span class="dashboard-project">{{ currentProject.name }}</span>
        <button
          class="dashboard-refresh"
          data-testid="dashboard-refresh"
          :title="t('dashboard.refresh')"
          :aria-label="t('dashboard.refresh')"
          @click="refreshCommits(); changeStream.refresh()"
        >
          <NIcon
            :component="RefreshOutline"
            size="15"
          />
        </button>
      </header>

      <!-- 全零态：单条紧凑呈现，不摆空卡 -->
      <div
        v-if="!hasSignal"
        class="dashboard-calm"
        data-testid="dashboard-calm"
      >
        <span
          class="calm-dot"
          aria-hidden="true"
        />
        <span class="calm-text">{{ t('dashboard.calm') }}</span>
        <button
          class="calm-branch"
          data-testid="dashboard-calm-branch"
          :title="t('dashboard.card.git')"
          @click="openGitPanel"
        >
          <NIcon
            :component="GitBranchOutline"
            size="13"
          />
          {{ branch || t('dashboard.git.noBranch') }}
        </button>
        <span
          v-if="recentCommits[0]"
          class="calm-commit"
        >{{ recentCommits[0].message.split('\n')[0] }} · {{ formatDate(recentCommits[0].date) }}</span>
      </div>

      <!-- 四分区卡 -->
      <div
        v-else
        class="dashboard-grid"
      >
        <!-- git 态 -->
        <button
          class="dash-card"
          data-testid="dashboard-card-git"
          @click="openGitPanel"
        >
          <span class="dash-card-head">
            <NIcon
              :component="GitBranchOutline"
              size="15"
            />
            <span class="dash-card-title">{{ t('dashboard.card.git') }}</span>
            <span
              class="dash-chip branch-chip"
              data-testid="dashboard-branch"
            >{{ branch || t('dashboard.git.noBranch') }}</span>
          </span>
          <span class="dash-card-lines">
            <span class="dash-line">
              {{ gitHint }}
              <span
                v-if="dirtyCount > 0"
                class="dash-dirty"
                data-testid="dashboard-dirty"
              >{{ t('dashboard.git.dirty', { n: dirtyCount }) }}</span>
            </span>
            <span
              v-if="!commitsFailed"
              class="dash-commits"
            >
              <span
                v-for="c in recentCommits"
                :key="c.hash"
                class="dash-commit-row"
              >
                <NIcon
                  :component="GitCommitOutline"
                  size="12"
                  class="commit-ico"
                />
                <span class="commit-hash">{{ c.shortHash }}</span>
                <span class="commit-msg">{{ c.message.split('\n')[0] }}</span>
                <span class="commit-date">{{ formatDate(c.date) }}</span>
              </span>
            </span>
            <span
              v-else
              class="dash-muted"
            >{{ t('dashboard.git.loadFailed') }}</span>
          </span>
        </button>

        <!-- 会话态 -->
        <button
          class="dash-card"
          data-testid="dashboard-card-sessions"
          @click="openSessionCenter"
        >
          <span class="dash-card-head">
            <NIcon
              :component="ChatbubblesOutline"
              size="15"
            />
            <span class="dash-card-title">{{ t('dashboard.card.sessions') }}</span>
            <span
              v-if="runningCount > 0"
              class="dash-chip running-chip"
              data-testid="dashboard-sessions-running"
            >{{ t('dashboard.sessions.running', { n: runningCount }) }}</span>
          </span>
          <span class="dash-card-lines">
            <span
              v-if="projectSessions.length === 0"
              class="dash-muted"
            >{{ t('dashboard.sessions.none') }}</span>
            <template v-else>
              <span
                v-for="s in projectSessions.slice(0, 3)"
                :key="s.id"
                class="dash-session-row"
              >
                <span
                  class="session-dot"
                  :class="{ 'is-running': sessionsStore.runningMap[s.id] === true }"
                  aria-hidden="true"
                />
                <span class="session-name">{{ s.name }}</span>
              </span>
              <span
                v-if="projectSessions.length > 3"
                class="dash-muted"
              >{{ t('dashboard.sessions.more', { n: projectSessions.length - 3 }) }}</span>
            </template>
          </span>
        </button>

        <!-- 问题面 -->
        <button
          class="dash-card"
          data-testid="dashboard-card-problems"
          @click="openProblemsPanel"
        >
          <span class="dash-card-head">
            <NIcon
              :component="AlertCircleOutline"
              size="15"
            />
            <span class="dash-card-title">{{ t('dashboard.card.problems') }}</span>
          </span>
          <span class="dash-card-lines">
            <span
              v-if="problems.aggregate.total === 0"
              class="dash-muted"
            >{{ t('dashboard.problems.none') }}</span>
            <template v-else>
              <span
                class="dash-line problems-counts"
                data-testid="dashboard-problems-counts"
              >
                <span
                  v-if="problems.aggregate.errorCount > 0"
                  class="prob-errors"
                >{{ t('dashboard.problems.errors', { n: problems.aggregate.errorCount }) }}</span>
                <span
                  v-if="problems.aggregate.warningCount > 0"
                  class="prob-warnings"
                >{{ t('dashboard.problems.warnings', { n: problems.aggregate.warningCount }) }}</span>
              </span>
              <span class="dash-muted">{{ t('dashboard.problems.scope') }}</span>
            </template>
          </span>
        </button>

        <!-- 近期活动 -->
        <button
          class="dash-card"
          data-testid="dashboard-card-activity"
          @click="openChangeStreamPanel"
        >
          <span class="dash-card-head">
            <NIcon
              :component="PulseOutline"
              size="15"
            />
            <span class="dash-card-title">{{ t('dashboard.card.activity') }}</span>
          </span>
          <span class="dash-card-lines">
            <span
              v-if="activityBatches.length === 0"
              class="dash-muted"
            >{{ t('dashboard.activity.none') }}</span>
            <template v-else>
              <span
                v-for="b in activityBatches.slice(0, 4)"
                :key="b.id"
                class="dash-activity-row"
                @click.stop="openActivityFile(b.files[0] || '')"
              >
                <span class="activity-file">{{ b.files[0] }}<template v-if="b.count > 1"> +{{ b.count - 1 }}</template></span>
                <span class="activity-time">{{ batchTime(b.lastTs) }}</span>
              </span>
            </template>
          </span>
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 镜像 monitor 卡片语言（ActivityHeatmapCard 同款：面板底/主题描边/软阴影），
   色值全部走主题变量零硬编码 */
.dashboard-view {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px;
  background: var(--bg-primary);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dashboard-empty {
  margin: auto;
  color: var(--text-muted);
  font-size: 13px;
}
.dashboard-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-shrink: 0;
}
.dashboard-title { font-size: 16px; font-weight: 600; color: var(--text-primary); margin: 0; }
.dashboard-project { font-size: 13px; color: var(--text-muted); }
.dashboard-refresh {
  margin-left: auto;
  border: 1px solid var(--border-default);
  background: var(--bg-panel);
  color: var(--text-secondary);
  border-radius: 5px;
  padding: 4px 6px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}
.dashboard-refresh:hover { color: var(--text-primary); background: var(--bg-hover); }

/* 全零态紧凑条：单行弱呈现 */
.dashboard-calm {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  color: var(--text-secondary);
}
.calm-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent-green);
  flex-shrink: 0;
}
.calm-text { color: var(--text-primary); }
.calm-branch {
  display: inline-flex; align-items: center; gap: 4px;
  border: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 12px;
  cursor: pointer;
}
.calm-branch:hover { color: var(--text-primary); background: var(--bg-hover); }
.calm-commit { font-size: 12px; color: var(--text-muted); }

/* 四卡栅格：窄主区单列，宽主区两列 */
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 12px;
  align-content: start;
}
.dash-card {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  color: var(--text-primary);
  font-size: 13px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
}
.dash-card:hover { border-color: var(--accent-blue); }
.dash-card:focus-visible { outline: 1px solid var(--accent-blue); outline-offset: 1px; }
.dash-card-head { display: flex; align-items: center; gap: 6px; color: var(--text-secondary); }
.dash-card-title { font-weight: 600; font-size: 12px; }
.dash-chip {
  margin-left: auto;
  border-radius: 4px;
  padding: 1px 7px;
  font-size: 11px;
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
}
.branch-chip { color: var(--accent-blue); border-color: color-mix(in srgb, var(--accent-blue) 40%, var(--border-default)); }
.running-chip { color: var(--accent-green); border-color: color-mix(in srgb, var(--accent-green) 40%, var(--border-default)); }
.dash-card-lines { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dash-line { color: var(--text-secondary); }
.dash-dirty { color: var(--accent-blue); margin-left: 6px; }
.dash-muted { color: var(--text-muted); font-size: 12px; }

.dash-commits { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-commit-row { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--text-secondary); }
.commit-ico { flex-shrink: 0; color: var(--text-muted); }
.commit-hash { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.commit-msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-date { margin-left: auto; flex-shrink: 0; font-size: 11px; color: var(--text-muted); }

.dash-session-row { display: flex; align-items: center; gap: 7px; min-width: 0; color: var(--text-secondary); }
.session-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); opacity: 0.5; flex-shrink: 0; }
.session-dot.is-running { background: var(--status-running); opacity: 1; }
.session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.problems-counts { display: flex; gap: 10px; font-weight: 600; }
.prob-errors { color: var(--accent-red); }
.prob-warnings { color: var(--accent-orange); }

.dash-activity-row {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  color: var(--text-secondary);
  border-radius: 4px;
  padding: 1px 3px;
  margin: -1px -3px;
}
.dash-activity-row:hover { background: var(--bg-hover); color: var(--text-primary); }
.activity-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 12px; }
.activity-time { margin-left: auto; flex-shrink: 0; font-size: 11px; color: var(--text-muted); }
</style>
