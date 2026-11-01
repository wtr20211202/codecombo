<script setup lang="ts">
// 跨项目变更时间线（P-20261003-232）：聚合视图的行渲染——项目徽标 + 文件
// 预览 + 相对时间。值班大屏卡（ChangeStreamCard）与活动栏独立面板
// （ChangeStreamPanel）两宿主共用；数据与轮询归宿主的 useChangeStream 实例。
// 徽标色 = projectId 散列到四主题同名的 7 个语义强调色（同项目恒同色，跨项目
// 一眼可分；颜色零硬编码全走 CSS 变量）
// 条目深链（P-20261006-52）：批次行 button 语义可点——跨项目条目两段式深链
// （守卫切项目 + /project?file= 打开），无可靠相对路径降级只切项目；单条目
// 粒度只开批内最新文件不整批打开（防误开 N tab）。项目不在清单的行不可点
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '../../composables/useI18n'
import { relativeTimeParts } from '../../utils/relative-time'
import { deepLinkRelPath, type ChangeBatch } from '../../composables/useChangeStream'
import { useProjectStore } from '../../stores/project'

const props = defineProps<{
  batches: ChangeBatch[]
  /** 紧凑形态（值班卡）：行高与文件预览更收敛 */
  compact?: boolean
  /** 容量逐出总数 >0 时行尾弱提示「风暴期记录可能不完整」 */
  dropped?: number
}>()

const { t } = useI18n()
const router = useRouter()
const projectStore = useProjectStore()

// 四主题同名语义强调色（已核对 dark/light/one-dark/dracula 四文件全在位）；
// 散列取 projectId——稳定标识而非下标，行序变化不闪色
const BADGE_VARS = [
  'var(--accent-blue)', 'var(--accent-green)', 'var(--accent-yellow)',
  'var(--accent-orange)', 'var(--accent-purple)', 'var(--accent-teal)',
  'var(--accent-red)',
] as const

function badgeColor(projectId: string): string {
  let h = 0
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0
  return BADGE_VARS[h % BADGE_VARS.length] ?? BADGE_VARS[0]
}

/** 未知/已删项目降级：短 id（后 6 位），title 带全 id 可对账 */
function badgeLabel(b: ChangeBatch): string {
  return b.projectName || (b.projectId.slice(-6) || '?')
}

function timeText(ts: number): string {
  // 复用 agentTerminal.activity* 相对时间文案（与值班会话卡/悬浮列表一致）
  const { key, n } = relativeTimeParts(ts)
  return t(`agentTerminal.${key}`, { n })
}

/** 批次行 testid：双项目条目断言与去抖断言的定位锚 */
function rowTestid(b: ChangeBatch): string {
  return 'stream-row-' + b.projectId
}

function moreCount(b: ChangeBatch): number {
  return Math.max(0, b.count - b.files.length)
}

/** 行深链目标表：项目在清单内才可点（未知/已删项目既无处可切也无根可剥，
 *  维持纯展示）；file=null = lastPath 剥不出可靠相对路径（项目根不匹配等），
 *  降级为只切项目不打开。computed 一次算全表供模板多处取用：每轮轮询重算
 *  ≤60 行 × 项目清单 find，量级可忽略（5s 轮询非热路径） */
interface RowTarget { projectId: string; projectName: string; file: string | null }
const rowTargets = computed(() => {
  const m = new Map<string, RowTarget>()
  for (const b of props.batches) {
    const proj = projectStore.projects.find(p => p.id === b.projectId)
    if (proj) {
      m.set(b.id, {
        projectId: proj.id,
        projectName: proj.name || b.projectId,
        file: deepLinkRelPath(b.lastPath, proj.path),
      })
    }
  }
  return m
})

/** 行 title/aria：可点行动作的人读描述（徽标可能显短 id，此处给全上下文） */
function rowTitle(b: ChangeBatch): string | undefined {
  const target = rowTargets.value.get(b.id)
  if (!target) return undefined
  return target.file
    ? t('changeStream.openHint', { file: target.file, project: target.projectName })
    : t('changeStream.switchHint', { project: target.projectName })
}

async function onRowClick(b: ChangeBatch): Promise<void> {
  const target = rowTargets.value.get(b.id)
  if (!target) return
  // 有可靠相对路径：两段式深链（P-20261006-43 规则文件同款）——router.push 带
  // project+file，Layout 消费链 consumeFileQuery 负责必要时守卫切项目（未保存
  // 草稿确认）+ 打开 + 清 query；同项目条目该链天然跳过切换直开文件
  if (target.file) {
    await router.push({ path: '/project', query: { project: target.projectId, file: target.file } })
    return
  }
  // 降级只切项目：selectProjectExplicit 走切换族守卫管道，显式标记防 bootstrap
  // 的 uiState 恢复把项目翻回旧值（首页点项目卡进入同款链）；守卫取消（未保存
  // 草稿确认选「取消」）则放弃导航
  if ((await projectStore.selectProjectExplicit(target.projectId)) === false) return
  if (router.currentRoute.value.name !== 'project') await router.push({ name: 'project' })
}
</script>

<template>
  <div
    class="cs-list"
    :class="{ 'is-compact': compact }"
    data-testid="change-stream-list"
  >
    <component
      :is="rowTargets.has(b.id) ? 'button' : 'div'"
      v-for="b in batches"
      :key="b.id"
      class="cs-row"
      :data-testid="rowTestid(b)"
      :type="rowTargets.has(b.id) ? 'button' : undefined"
      :title="rowTitle(b)"
      :aria-label="rowTitle(b)"
      @click="onRowClick(b)"
    >
      <span
        class="cs-badge"
        :style="{ color: badgeColor(b.projectId), borderColor: badgeColor(b.projectId) }"
        :title="b.projectName || b.projectId"
      >{{ badgeLabel(b) }}</span>
      <span class="cs-body">
        <span
          v-for="(f, i) in b.files"
          :key="i"
          class="cs-file"
          :title="f"
        >{{ f }}</span>
        <span
          v-if="moreCount(b) > 0"
          class="cs-more"
        >{{ t('changeStream.moreFiles', { n: moreCount(b) }) }}</span>
      </span>
      <span class="cs-time">{{ timeText(b.lastTs) }}</span>
    </component>
    <div
      v-if="(dropped ?? 0) > 0"
      class="cs-dropped"
      data-testid="change-stream-dropped"
    >
      {{ t('changeStream.droppedHint') }}
    </div>
  </div>
</template>

<style scoped>
.cs-list {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cs-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 5px 0;
  border-bottom: 1px solid var(--bg-border);
}
/* 可点行（button 语义，P-20261006-52）：清 button 默认面容、继承行排版——
   可点与纯展示行共享同一布局，仅 hover 背景/焦点环/cursor 表达可点性 */
button.cs-row {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 1px solid var(--bg-border);
  border-radius: 6px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  /* 0.15s 裸时长收敛到 --motion-base（P-20261007-16 门禁；数值等值行为不变——P-20261006-52 深链存量暴露后收敛 token） */
  transition: background-color var(--motion-base) ease;
}
button.cs-row:hover {
  background: var(--bg-hover);
}
button.cs-row:focus-visible {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
}
.is-compact .cs-row {
  padding: 3px 0;
}
.cs-badge {
  flex-shrink: 0;
  max-width: 45%;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  padding: 2px 7px;
  border: 1px solid;
  border-radius: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 4px 10px;
  flex-wrap: wrap;
}
.cs-file {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.is-compact .cs-file { font-size: 11px; }
.cs-more {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.cs-time {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}
.cs-dropped {
  padding-top: 6px;
  font-size: 11px;
  color: var(--text-muted);
}
</style>
