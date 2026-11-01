<script setup lang="ts">
/**
 * 分支行悬停提交预览浮窗（P-20261003-274）：分支列表行悬停延迟弹出该分支
 * 最近 3 条提交——切换前速读「这个分支在干什么」。审批卡 target 浮窗
 * （TargetDiffPopover，P-20261003-253）同族交互：hover 400ms 延迟防误弹、
 * 首开拉取、失败浮窗内降级。
 *
 * - 触发器经默认 slot 注入（分支行整体），点击链不经过本组件——行点击
 *   选中/右键切换语义原样保留；
 * - 数据面 = 既有 `GET /log?branch=&limit=`（分支参数端点现成，零后端改动；
 *   本地分支名与 `remotes/<remote>/<branch>` 全名 git 均可直接作 rev）；
 *   成功后缓存，宿主分支列表刷新（epoch 递增）即失效——预览跟随最新数据面；
 *   失败不缓存，下次悬停重试；silent 请求：hover 链失败只降级浮窗内提示，
 *   不弹拦截器全局错误；
 * - branch 为空（分离头指针行无可用 hash 等）时退化直出 slot，不挂浮窗。
 */
import { NPopover } from 'naive-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useProjectStore } from '../../stores/project'
import { logApi } from '../../api/client'
import { formatDate } from '../../utils/git'

/** 预览条数：任务书口径「最近 3 条」——够速读分支动向，浮窗不滚屏 */
const PREVIEW_COUNT = 3

/** 预览行（服务端 model.Commit 的展示子集；message 已是首行 subject） */
interface BranchCommit { shortHash: string; message: string; author: string; date: string }

const props = defineProps<{
  /** 分支 git rev 全名（本地分支名 / remotes/<remote>/<branch> / 短 hash），
   *  空串 = 不挂浮窗（slot 直出） */
  branch: string
  /** 宿主分支列表刷新纪元：递增即清缓存，下次悬停按新数据面重拉 */
  epoch: number
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

// 受控显隐（TargetDiffPopover 同款）：hover 触发由 naive-ui 驱动 update:show，
// 开合状态收口到 show——延迟参数见模板（400ms 防误弹）
const show = ref(false)
function onShowUpdate(v: boolean): void {
  show.value = v
  if (v) void fetchCommits()
}

const loading = ref(false)
/** 成功拉取后置位：首开缓存闸（失败不置位，下次悬停重试） */
const loaded = ref(false)
const failed = ref(false)
const commits = ref<BranchCommit[]>([])

// 分支列表刷新（checkout/push/自动刷新等）即清缓存；浮窗开着时被刷新命中
// 则就地重拉，避免展示面停在「已清空的缓存」误报空态
watch(() => props.epoch, () => {
  loaded.value = false
  commits.value = []
  if (show.value) void fetchCommits()
})

/** 首开拉取（并发悬停/重复开合只发一轮）：limit=3 的分支 log 轻量查询，
 *  仅悬停时刻触发，不进渲染热路径；响应形状守卫后取前 3 条，异常载荷按
 *  失败态降级（下次悬停重试） */
async function fetchCommits(): Promise<void> {
  if (loaded.value || loading.value) return
  const pid = projectStore.currentProjectId
  if (!pid) {
    failed.value = true // 无当前项目上下文：无处取数，浮窗内如实降级
    return
  }
  loading.value = true
  failed.value = false
  try {
    // 响应拦截器直返响应体（http.ts interceptors.response）：body = { data: 提交数组 }，
    // res.data 即提交列表。形状守卫后取前 3 条，异常载荷按失败面降级（下次悬停重试）
    const res = await logApi.getLog(pid, { branch: props.branch, limit: PREVIEW_COUNT }, { silent: true })
    const list: unknown = res?.data
    commits.value = Array.isArray(list) ? list.filter(isBranchCommit).slice(0, PREVIEW_COUNT) : []
    loaded.value = true
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}

function isBranchCommit(c: unknown): c is BranchCommit {
  return typeof c === 'object' && c !== null &&
    typeof (c as BranchCommit).shortHash === 'string' &&
    typeof (c as BranchCommit).message === 'string'
}

const disabled = computed(() => props.branch === '')
</script>

<template>
  <slot
    v-if="disabled"
  />
  <n-popover
    v-else
    :show="show"
    trigger="hover"
    :delay="400"
    :duration="100"
    placement="right"
    raw
    :z-index="3100"
    @update:show="onShowUpdate"
  >
    <template #trigger>
      <slot />
    </template>
    <div
      class="bbranch-pop"
      data-test="branch-log-pop"
      role="tooltip"
      :aria-label="t('git.branchHover.title')"
    >
      <!-- 头部：分支 rev 全名（浮窗自身携带归属上下文，多分支悬停可辨） -->
      <div
        class="bbranch-pop-head"
        data-test="branch-log-pop-name"
      >{{ branch }}</div>
      <div
        v-if="loading"
        class="bbranch-pop-note"
        data-test="branch-log-pop-loading"
      >{{ t('git.branchHover.loading') }}</div>
      <!-- 失败态：浮窗内降级提示（可恢复——下次悬停重试），点击链不受影响 -->
      <div
        v-else-if="failed"
        class="bbranch-pop-note"
        data-test="branch-log-pop-error"
      >{{ t('git.branchHover.error') }}</div>
      <!-- 零提交（未出生分支/空仓）如实提示 -->
      <div
        v-else-if="commits.length === 0"
        class="bbranch-pop-note"
        data-test="branch-log-pop-empty"
      >{{ t('git.branchHover.empty') }}</div>
      <div
        v-else
        class="bbranch-pop-body"
      >
        <div
          v-for="c in commits"
          :key="c.shortHash + c.message"
          class="bbranch-pop-row"
          data-test="branch-log-pop-row"
          :title="`${c.shortHash} ${c.author} ${formatDate(c.date)}`"
        >
          <span class="bbranch-pop-hash">{{ c.shortHash }}</span>
          <span class="bbranch-pop-msg">{{ c.message }}</span>
          <span class="bbranch-pop-date">{{ formatDate(c.date) }}</span>
        </div>
      </div>
    </div>
  </n-popover>
</template>

<style scoped>
/* raw popover：内容样式自持（scoped 不跨组件）。颜色全走主题变量，四主题
   自适应；同族 TargetDiffPopover 同款面板底/圆角/阴影 */
.bbranch-pop {
  max-width: 380px; padding: var(--space-2) 10px;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-pop-lg);
}
.bbranch-pop-head {
  font-family: monospace; font-size: 0.78em; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-bottom: var(--space-1);
}
.bbranch-pop-note {
  font-size: 0.76em; color: var(--text-secondary); line-height: 1.5;
}
.bbranch-pop-body {
  display: flex; flex-direction: column; gap: 2px;
}
.bbranch-pop-row {
  display: flex; align-items: baseline; gap: 6px; min-width: 0;
  font-size: 0.76em; line-height: 1.6;
}
.bbranch-pop-hash {
  flex-shrink: 0; font-family: monospace; color: var(--accent-green);
}
.bbranch-pop-msg {
  flex: 1 1 auto; min-width: 0; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.bbranch-pop-date {
  flex-shrink: 0; font-size: 0.9em; color: var(--text-muted);
}
</style>
