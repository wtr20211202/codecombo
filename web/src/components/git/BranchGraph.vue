<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useGraphLanesStore } from '../../stores/graph-lanes'

interface Commit {
  hash: string
  shortHash: string
  parents: string[]
  refs: string[]
  message?: string
}

/**
 * 提交拓扑图（原 LogView 附件，迁入 Git 面板提交列表）：
 * 按 commits 顺序为每个提交分配泳道，画父子连线与节点。
 * rowHeight 必须与宿主提交行高一致，节点纵向才能与行对齐。
 */
const props = withDefaults(defineProps<{
  commits: Commit[]
  rowHeight?: number
}>(), {
  rowHeight: 36,
})

/** 节点 hover 的原生 tooltip 文案（短哈希+首行消息） */
function nodeTitle(i: number): string {
  const c = props.commits[i]
  if (!c) return ''
  return c.message ? `${c.shortHash} ${c.message}` : c.shortHash
}

const { t } = useI18n()
const NODE_RADIUS = 4
const COL_WIDTH = 16
const PADDING_LEFT = 4

// 泳道上限（graph-lanes store，P-20261006-29 设置化）：合并极密的近期历史（如
// 增强流水线连续合入数十支分支）会在渲染窗口内累积数十条活跃泳道——分支的
// 分叉点在窗口之外时其泳道永不释放，SVG 宽度按泳道数线性膨胀（实测本仓库
// 100 提交窗口 47 道 = 744px），flex 布局里提交行（.commits-rows flex:1
// min-width:0）被挤到 0 宽、列表不可用。封顶后超出的分支并入末道绘制（图形
// 近似但行区宽度有界），窄面板下列表始终可用；封顶生效时图区给诚实注记
const laneStore = useGraphLanesStore()

// SVG 渲染上限：超过上限的提交不再画节点/连线（泳道分配只算前 MAX 个）。
// 历史实现全量渲染——万级提交的仓库 loadMore 追加一次就全量重算 SVG，
// 节点+连线数可达数万；列表本身可继续滚动加载，仅图形截断
const MAX_RENDERED_COMMITS = 600

const BRANCH_COLORS = [
  'var(--accent-blue-light)', 'var(--accent-green-dim)', 'var(--accent-yellow)', 'var(--accent-red)',
  'var(--accent-purple)', 'var(--accent-teal)', 'var(--graph-1)', 'var(--graph-2)',
  'var(--graph-3)', 'var(--graph-4)', 'var(--graph-5)', 'var(--graph-6)',
]

// 截断提示状态：超过渲染上限时在图末尾给可见提示（历史上限后图形静默消失）
const truncated = computed(() => props.commits.length > MAX_RENDERED_COMMITS)

/**
 * 泳道分配（纯函数）：按 commits 顺序贪心占道；maxLanes 封顶时超限并入末道
 * （该道原有的待连父提交连线让位——图形近似）。返回各提交列号与「封顶是否
 * 发生过」——后者驱动图区诚实注记（压缩不再静默，P-20261006-29）。
 */
function assignLanes(commits: Commit[], maxLanes: number): { columns: number[]; clamped: boolean } {
  const lastLane = maxLanes - 1
  const activeColumns: (string | null)[] = []
  const columns: number[] = new Array(commits.length).fill(0)
  let clamped = false

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!
    let assignedCol = -1
    for (let col = 0; col < activeColumns.length; col++) {
      if (activeColumns[col] === commit.hash) {
        assignedCol = col
        break
      }
    }

    if (assignedCol === -1) {
      assignedCol = Math.min(activeColumns.length, lastLane)
      if (assignedCol === activeColumns.length) activeColumns.push(null)
      else clamped = true
    }

    columns[i] = assignedCol

    if (commit.parents.length > 0) {
      activeColumns[assignedCol] = commit.parents[0]!
    } else {
      activeColumns[assignedCol] = null
    }

    for (let p = 1; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p]!
      let found = false
      for (let col = 0; col < activeColumns.length; col++) {
        if (activeColumns[col] === parentHash) {
          found = true
          break
        }
      }
      if (!found) {
        let freeCol = activeColumns.findIndex((v) => v === null)
        if (freeCol === -1) {
          freeCol = Math.min(activeColumns.length, lastLane)
          if (freeCol === activeColumns.length) activeColumns.push(null)
          else clamped = true
        }
        activeColumns[freeCol] = parentHash
      }
    }
  }

  return { columns, clamped }
}

const graphData = computed(() => {
  const allCommits = props.commits
  const rowHeight = props.rowHeight
  if (allCommits.length === 0) return { width: 0, height: 0, nodes: [], lines: [], compressed: false, overflowLanes: 0 }
  const commits = allCommits.length > MAX_RENDERED_COMMITS ? allCommits.slice(0, MAX_RENDERED_COMMITS) : allCommits

  const hashToIndex = new Map<string, number>()
  commits.forEach((c, i) => hashToIndex.set(c.hash, i))

  const laneLimit = laneStore.limit
  const assigned = assignLanes(commits, laneLimit)
  const commitColumns = assigned.columns

  // 压缩诚实标注：封顶发生过才补跑一次不封顶模拟求「完整拓扑需要的泳道数」，
  // N = 超出封顶并入末道的泳道数。常规仓库（封顶从不触发）零额外开销；触发时
  // 多一趟 O(提交数×泳道数) 纯内存遍历（≤600 行窗口，毫秒级），且仅在
  // commits/档位变化时随 graphData 重算，不进滚动/渲染热路径
  let overflowLanes = 0
  if (assigned.clamped) {
    const full = assignLanes(commits, Number.MAX_SAFE_INTEGER)
    let fullMax = 0
    for (let i = 0; i < full.columns.length; i++) {
      if (full.columns[i]! > fullMax) fullMax = full.columns[i]!
    }
    overflowLanes = Math.max(0, fullMax + 1 - laneLimit)
  }
  const compressed = overflowLanes > 0

  // 使用循环求最大值，避免 spread 操作在大数组时栈溢出
  let maxCol = 0
  for (let i = 0; i < commitColumns.length; i++) {
    if (commitColumns[i]! > maxCol) maxCol = commitColumns[i]!
  }
  const width = (maxCol + 1) * COL_WIDTH + PADDING_LEFT * 2
  const height = commits.length * rowHeight

  const nodes = commits.map((_c, i) => ({
    x: PADDING_LEFT + commitColumns[i]! * COL_WIDTH + COL_WIDTH / 2,
    y: i * rowHeight + rowHeight / 2,
    color: BRANCH_COLORS[commitColumns[i]! % BRANCH_COLORS.length]!,
    isMerge: commits[i]!.parents.length > 1,
  }))

  const lines: { x1: number; y1: number; x2: number; y2: number; color: string }[] = []

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i]!
    const fromNode = nodes[i]!

    commit.parents.forEach((parentHash, pIdx) => {
      const parentIdx = hashToIndex.get(parentHash)
      if (parentIdx === undefined) return

      const toNode = nodes[parentIdx]!
      const fromX = fromNode.x
      const fromY = fromNode.y
      const toX = toNode.x
      const toY = toNode.y
      const color = pIdx === 0 ? fromNode.color : toNode.color

      if (fromX === toX) {
        lines.push({ x1: fromX, y1: fromY, x2: toX, y2: toY, color })
      } else {
        const midY = fromY + rowHeight / 2
        lines.push({ x1: fromX, y1: fromY, x2: fromX, y2: midY, color })
        lines.push({ x1: fromX, y1: midY, x2: toX, y2: midY, color })
        lines.push({ x1: toX, y1: midY, x2: toX, y2: toY, color })
      }
    })
  }

  return { width, height, nodes, lines, compressed, overflowLanes }
})

// 末道「容器道」导轨 x：压缩生效时末道（第 laneLimit 道）并入多条泳道，画
// 纵向虚线与普通泳道区分（可辨此处是压缩容器而非单条分支）
const capLaneX = computed(() => PADDING_LEFT + (laneStore.limit - 1) * COL_WIDTH + COL_WIDTH / 2)

// 底部注记行布局：每行 18px（基线 +14），单行时 SVG 总增高 +20 与既有截断
// 提示完全一致（构造性零回归）；压缩注记在前、截断注记次之
const annotationRows = computed(() => (graphData.value.compressed ? 1 : 0) + (truncated.value ? 1 : 0))
const svgHeight = computed(() => graphData.value.height + (annotationRows.value > 0 ? annotationRows.value * 18 + 2 : 0))
const truncatedNoteY = computed(() => graphData.value.height + 14 + (graphData.value.compressed ? 18 : 0))
</script>

<template>
  <svg
    :width="graphData.width"
    :height="svgHeight"
    style="display: block; flex-shrink: 0"
  >
    <!-- 末道容器道区分：压缩生效时末道整列画虚线边框（容器道形态——此道
         并入了多条泳道，与普通单支泳道可辨），悬停出封顶语义说明。矩形而非
         纵向 line：line 的包围盒零宽，视觉无碍但无障碍树/命中测试不可达 -->
    <rect
      v-if="graphData.compressed"
      :x="capLaneX - COL_WIDTH / 2 + 1"
      y="1"
      :width="COL_WIDTH - 2"
      :height="graphData.height - 2"
      rx="3"
      class="bg-cap-lane"
      data-testid="graph-lane-cap-line"
    ><title>{{ t('git.graphCompressedTip', { max: laneStore.limit }) }}</title></rect>
    <line
      v-for="(line, i) in graphData.lines"
      :key="'l-' + i"
      :x1="line.x1"
      :y1="line.y1"
      :x2="line.x2"
      :y2="line.y2"
      :stroke="line.color"
      stroke-width="1.5"
      stroke-opacity="0.6"
    />
    <circle
      v-for="(node, i) in graphData.nodes"
      :key="'n-' + i"
      :cx="node.x"
      :cy="node.y"
      :r="node.isMerge ? NODE_RADIUS + 1 : NODE_RADIUS"
      :fill="node.isMerge ? 'var(--text-primary)' : node.color"
      :stroke="node.color"
      :stroke-width="node.isMerge ? 2 : 0"
      style="cursor: pointer"
    ><title>{{ nodeTitle(i) }}</title></circle>
    <!-- 压缩诚实注记（仅封顶生效时出现——常规仓库零感）：N = 并入末道的泳道数，
         悬停解释封顶语义与调整入口（设置 → 外观） -->
    <text
      v-if="graphData.compressed"
      :x="PADDING_LEFT + COL_WIDTH"
      :y="graphData.height + 14"
      class="bg-truncated bg-compressed"
      data-testid="graph-lane-compressed"
    >{{ t('git.graphCompressed', { n: graphData.overflowLanes }) }}<title>{{ t('git.graphCompressedTip', { max: laneStore.limit }) }}</title></text>
    <text
      v-if="truncated"
      :x="PADDING_LEFT + COL_WIDTH"
      :y="truncatedNoteY"
      class="bg-truncated"
    >{{ t('git.graphTruncated', { max: MAX_RENDERED_COMMITS }) }}</text>
  </svg>
</template>

<style scoped>
.bg-truncated {
  font-size: 10px;
  fill: var(--text-muted);
}
.bg-cap-lane {
  fill: transparent;
  stroke: var(--text-muted);
  stroke-opacity: 0.45;
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.bg-compressed {
  cursor: help;
}
</style>
