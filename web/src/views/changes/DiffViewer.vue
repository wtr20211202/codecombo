<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NButton, NButtonGroup, NIcon } from 'naive-ui'
import { ChevronDownOutline, ChevronUpOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { buildFoldSlots, computeFoldRegions } from '../../utils/diffFold'
import { coalesceWhitespaceOnly, type HunkGroup } from '../../utils/diffWhitespace'
import { parseUnifiedDiff } from '../../utils/diffParse'
import { type FlatUnifiedLine, type SideBySideLine, type UnifiedRow } from './diffViewModels'
import DiffUnifiedView from './DiffUnifiedView.vue'
import DiffSideBySideView from './DiffSideBySideView.vue'

/**
 * 自绘 diff 视图（变更面板/文件历史/提交对比等多入口共用）：
 *   - 统一 / 并排两模式，虚拟滚动承载大 diff（数十万行不冻结面板）
 *   - 工具条：变更导航 prev/next（循环 + N/M 计数 + Alt+↑/↓ 键盘导航）、
 *     「忽略空白」（会话级）、折叠未变区域 ⋯（P-20261004-99，会话级默认关）
 *   - hunk 级暂存/取消暂存/放弃三键（enableHunkStaging 时，统一视图内联）
 *
 * 视图区拆分（热点瘦身第三批，纯搬运零逻辑改动）：解析收口 utils/diffParse
 * （纯函数），视图模型类型/行槽常量收口 diffViewModels，统一视图 = 
 * DiffUnifiedView（含 hunk 三键操作）、并排视图 = DiffSideBySideView（各自
 * 虚拟化渲染）。本壳持有数据管线（解析/空白合并/折叠槽位）、变更导航与
 * 工具条——两视图消费同一份行序列与折叠态，导航下标两模式通用。
 */

const { t } = useI18n()

const props = defineProps<{
  content: string
  file?: string
  projectId?: string
  staged?: boolean
  enableHunkStaging?: boolean
}>()

const emit = defineEmits<{
  (e: 'hunk-staged'): void
  (e: 'hunk-discarded'): void
}>()

// Unified / Side-by-Side 模式切换
type DiffMode = 'unified' | 'side-by-side'
const diffMode = ref<DiffMode>('unified')

// 「忽略空白」：会话级开关（视图级状态，对标 JetBrains，不持久化）
const ignoreWs = ref(false)

// 「折叠未变区域」（P-20261004-99）：会话级开关（默认关，与编辑器 DiffEditor 的
// ⋯ 开关同款默认与视觉语——P-20261003-40 Monaco hideUnchangedRegions 的自绘侧
// 对称）。折叠单位是「两个变更行之间」的文件空间未变区域而非显示行 context 段：
// 服务端 diff 默认 -U3 上下文，hunk 内 context 至多 ±3 行、hunk 间隙不进 diff
// 文本，按显示行数判永不触发（判定细节见 utils/diffFold.ts）
const foldEnabled = ref(false)
// 区域展开态集合：键 = 区域在未折叠扁平序列里的 start（其他区域展开/收起不改变
// 该下标，可作稳定键）；内容/ignoreWs 切换会重排行区间，随导航游标一同重置
const expandedFolds = ref(new Set<number>())

function toggleFold(regionStart: number) {
  const next = new Set(expandedFolds.value)
  if (next.has(regionStart)) next.delete(regionStart)
  else next.add(regionStart)
  expandedFolds.value = next
}

// 解析 unified diff 文本（utils/diffParse 纯函数）
const parsed = computed(() => parseUnifiedDiff(props.content))

// 展示层 hunks：忽略空白开启时做空白-only 行对合并（hunk 一一映射，hunkIndex 不变）
const displayHunks = computed<HunkGroup[]>(() => {
  if (!ignoreWs.value) return parsed.value
  return parsed.value.map(coalesceWhitespaceOnly)
})

const sideBySideLines = computed<SideBySideLine[]>(() => {
  const result: SideBySideLine[] = []
  displayHunks.value.forEach((hunk, hi) => {
    for (const line of hunk.lines) {
      if (line.type === 'hunk' || line.type === 'header') {
        result.push({
          type: line.type,
          leftContent: line.content,
          rightContent: line.content,
          // 仅 hunk 头行携带块序号：变更导航的滚动锚点（文件头伪块无块序号）
          hunkIndex: line.type === 'hunk' ? hi : undefined,
        })
        continue
      }

      if (line.type === 'context') {
        result.push({
          type: 'context',
          leftContent: line.content,
          rightContent: line.content,
          leftLineNo: line.oldLineNo,
          rightLineNo: line.newLineNo,
        })
      } else if (line.type === 'add') {
        result.push({
          type: 'add',
          leftContent: '',
          rightContent: line.content,
          rightLineNo: line.newLineNo,
        })
      } else if (line.type === 'del') {
        result.push({
          type: 'del',
          leftContent: line.content,
          leftLineNo: line.oldLineNo,
          rightContent: '',
        })
      }
    }
  })
  return result
})

const unifiedFlat = computed<FlatUnifiedLine[]>(() => {
  const out: FlatUnifiedLine[] = []
  displayHunks.value.forEach((hunk, hi) => {
    for (const line of hunk.lines) {
      out.push({ type: line.type, content: line.content, oldLineNo: line.oldLineNo, newLineNo: line.newLineNo, hunkIndex: hi })
    }
  })
  return out
})

// ── 折叠未变区域（P-20261004-99）：在上游把行集合折成最终序列再入虚拟列表，
// 行数骤减渲染窗口随之变小。两模式消费同一份槽位（buildFoldSlots），行序恒 1:1，
// 导航下标两模式通用；开关关（默认）时零开销直通，大 diff 不多付一遍扫描。
// 展开态集合的键 = 区域 start（未折叠下标），展开/收起其他区域不漂移
const foldRegions = computed(() => (foldEnabled.value ? computeFoldRegions(unifiedFlat.value, displayHunks.value) : []))

const unifiedRows = computed<UnifiedRow[]>(() => {
  const base = unifiedFlat.value
  const regions = foldRegions.value
  if (!regions.length) return base
  return buildFoldSlots(base.length, regions, expandedFolds.value).map((slot) => {
    if (slot.kind === 'row') return base[slot.flat]!
    return {
      type: 'fold',
      content: '',
      regionId: slot.region.start,
      restoreCount: slot.region.restoreCount,
      expanded: slot.expanded,
    }
  })
})

const sideRows = computed<SideBySideLine[]>(() => {
  // sideBySideLines 与 unifiedFlat 逐行 1:1（displayHunks 每行两模式各产一行），
  // 折叠槽位按同一份下标折叠两侧行序
  const base = sideBySideLines.value
  const regions = foldRegions.value
  if (!regions.length) return base
  return buildFoldSlots(base.length, regions, expandedFolds.value).map((slot) => {
    if (slot.kind === 'row') return base[slot.flat]!
    return {
      type: 'fold',
      leftContent: '',
      rightContent: '',
      regionId: slot.region.start,
      restoreCount: slot.region.restoreCount,
      expanded: slot.expanded,
    }
  })
})

// ── 变更导航 prev/next（P-20261003-212）：变更面板 DiffViewer 与编辑器
// DiffEditor（Monaco goToDiff）的交互 parity——工具条一键跳上一/下一变更块，
// 循环导航（尾→首、首→尾）。落点 = hunk 头行，两种模式统一锚 [data-hunk-nav]
// 「变更」口径：展示态 hunks 中带 +/- 行的块——文件头伪块与 ignoreWs 合并后的
// 全 context 块不是变更，不进导航序列（跳过去什么改动都看不到）
const navHunks = computed(() => {
  const out: number[] = []
  displayHunks.value.forEach((h, i) => {
    if (h.lines.some((l) => l.type === 'add' || l.type === 'del')) out.push(i)
  })
  return out
})

// hunk 头行在未折叠扁平序列中的行下标（折叠定位用：判定导航目标是否被区域罩住）
const hunkStartFlat = computed(() => {
  const starts: number[] = []
  let acc = 0
  for (const h of displayHunks.value) {
    starts.push(acc)
    acc += h.lines.length
  }
  return starts
})

// hunk 头行在**折叠后**序列中的行下标（虚拟列表 scrollTo 按行下标×行高定位）；
// undefined = 头行被折叠区罩住（导航到它需先展开所在区域）
const hunkStartVisible = computed(() => {
  const starts: Array<number | undefined> = displayHunks.value.map(() => undefined)
  unifiedRows.value.forEach((row, idx) => {
    if (row.type === 'hunk' && row.hunkIndex !== undefined && row.hunkIndex < starts.length) starts[row.hunkIndex] = idx
  })
  return starts
})

const navPos = ref(-1) // 导航游标：-1=未导航（首击 next 落首块 / prev 落末块，Monaco 同语义）
const navFlash = ref(-1) // 落点高亮的 hunk 序号，数秒后熄灭（大 diff 一眼锁定跳到哪）
let navFlashTimer: ReturnType<typeof setTimeout> | undefined
const NAV_FLASH_MS = 2000

function flashNavTarget(hunkIndex: number) {
  navFlash.value = hunkIndex
  if (navFlashTimer) clearTimeout(navFlashTimer)
  navFlashTimer = setTimeout(() => { navFlash.value = -1 }, NAV_FLASH_MS)
}

/** 两视图子组件句柄：scrollTo / 滚动容器元素（expose 解包 ref） */
const unifiedViewRef = ref<{ scrollTo: (i: number) => void; containerRef: HTMLElement | null } | null>(null)
const sideViewRef = ref<{ scrollTo: (i: number) => void; containerRef: HTMLElement | null } | null>(null)

/** 把 hunk 头行对齐到滚动容器顶部。scrollTo 按「行下标×行高」估算落点，
 *  unified 的 hunk 暂存按钮行不在扁平序列里（每块多渲一个行高按钮行）会整体
 *  偏上——虚拟窗口渲染完成后按 DOM 实际位置修正一次；目标行未挂载（overscan
 *  内理论必挂）则保留估算落点 */
function alignNavTarget(hunkIndex: number) {
  const container = diffMode.value === 'unified' ? unifiedViewRef.value?.containerRef : sideViewRef.value?.containerRef
  if (!container) return
  const el = container.querySelector(`[data-hunk-nav="${hunkIndex}"]`)
  if (!el) return
  const delta = el.getBoundingClientRect().top - container.getBoundingClientRect().top
  if (delta !== 0) container.scrollTop += delta
}

async function scrollToHunk(hunkIndex: number) {
  // 两模式折叠后序列 1:1（同一份槽位序列），下标两模式通用
  let start = hunkStartVisible.value[hunkIndex]
  if (start === undefined) {
    // 目标 hunk 头被折叠区罩住（P-54 导航 × 折叠联动）：先展开所在区域再取新
    // 下标——展开/收起会整体平移后续行下标，旧值不可复用；区域缺失（理论不达，
    // 头行只在折叠区内不可见）则放弃跳转
    const flatIdx = hunkStartFlat.value[hunkIndex]
    const region = foldRegions.value.find((r) => flatIdx !== undefined && r.start <= flatIdx && flatIdx <= r.end)
    if (!region) return
    toggleFold(region.start)
    await nextTick() // 待 unifiedRows/sideRows 按新展开态重算
    start = hunkStartVisible.value[hunkIndex]
    if (start === undefined) return
  }
  if (diffMode.value === 'unified') unifiedViewRef.value?.scrollTo(start)
  else sideViewRef.value?.scrollTo(start)
  await nextTick() // 虚拟列表按新 scrollTop 重算可见窗口后再量 DOM
  alignNavTarget(hunkIndex)
}

function goToChange(dir: 1 | -1) {
  const n = navHunks.value.length
  if (!n) return
  navPos.value = navPos.value === -1
    ? (dir === 1 ? 0 : n - 1)
    : (((navPos.value + dir) % n) + n) % n
  const target = navHunks.value[navPos.value]!
  flashNavTarget(target)
  void scrollToHunk(target)
}

// N/M 计数（P-20261004-54）：navPos=-1（未导航）时当前位置以「–」占位，格式恒定
// 「x/y」——一眼可知总变更数，导航后随游标实时更新（循环回绕 2/2→1/2 可读）
const navCountText = computed(() =>
  `${navPos.value >= 0 ? navPos.value + 1 : '–'}/${navHunks.value.length}`,
)

// 键盘导航（P-20261004-54，Alt+↑/↓ 与编辑器 diff 标签同键位）：作用域收在本组件
// 根节点（tabindex=0，点击 diff 区域即按「最近可聚焦祖先」聚焦）——布局链的
// diffNav（useLayoutKeyboard，服务编辑器 diff 标签）是 document 气泡相位监听，
// 此处消费后 stopPropagation 防双跳（diff 标签开着 + 焦点在本组件时两套导航都在
// 事件路径上）；无变更块时不消费，事件放行布局链（下层 diff 标签可能要用）。
// 匹配条件与布局链 diffNav 同口径（只判 altKey，不排 ctrl/meta 组合）
function handleNavKeydown(e: KeyboardEvent) {
  if (!e.altKey || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
  if (!navHunks.value.length) return
  e.preventDefault()
  e.stopPropagation()
  goToChange(e.key === 'ArrowDown' ? 1 : -1)
}

// 内容/文件/视图态变化后游标失效：旧落点对新 diff 无意义，重新从边界起跳
// （ignoreWs 可能让空白-only 块从导航序列消失，也一并重置；foldEnabled 切换
// 平移全部行下标，游标同样作废）
watch([() => props.content, () => props.file, ignoreWs, diffMode, foldEnabled], () => {
  navPos.value = -1
})

// 区域展开态跟随内容重排失效：行区间按新 diff 重算，旧键指向的区域已无意义
// （foldEnabled 单独开/关不清——同内容下重开折叠还原上次展开面，键仍稳定）
watch([() => props.content, () => props.file, ignoreWs], () => {
  expandedFolds.value = new Set()
})

onBeforeUnmount(() => {
  if (navFlashTimer) clearTimeout(navFlashTimer)
})

</script>

<template>
  <!-- tabindex=0（P-20261004-54）：键盘导航（Alt+↑/↓）的聚焦锚——点击 diff 区域内
       任意非可聚焦子元素时，浏览器按「最近可聚焦祖先」把焦点落到根节点，键入即导航；
       键盘 Tab 用户也能直达。鼠标点击不触发 :focus-visible，无视觉噪音 -->
  <div class="diff-root" style="display: flex; flex-direction: column; height: 100%; font-size: var(--fs-diff)" tabindex="0" @keydown="handleNavKeydown">
    <!-- 工具栏 -->
    <div style="display: flex; justify-content: flex-end; gap: 6px; padding: 4px 8px; border-bottom: 1px solid var(--border-default); background: var(--bg-panel)">
      <!-- 变更导航（P-20261003-212）：与编辑器 DiffEditor 同款 prev/next 变更跳转，
           循环（尾→首）；无变更（纯上下文/空 diff）时成对禁用 -->
      <n-button-group size="tiny">
        <n-button
          data-testid="diff-nav-prev"
          :disabled="!navHunks.length"
          :title="t('diff.prevHunk')"
          @click="goToChange(-1)"
        >
          <n-icon :size="14">
            <ChevronUpOutline />
          </n-icon>
        </n-button>
        <n-button
          data-testid="diff-nav-next"
          :disabled="!navHunks.length"
          :title="t('diff.nextHunk')"
          @click="goToChange(1)"
        >
          <n-icon :size="14">
            <ChevronDownOutline />
          </n-icon>
        </n-button>
      </n-button-group>
      <!-- N/M 计数（P-20261004-54）：导航游标位/变更总数，未导航以「–」占位；
           无变更时随按钮一同隐没（disabled 成对禁用语义一致） -->
      <span
        v-if="navHunks.length"
        data-testid="diff-nav-count"
        class="diff-nav-count"
        :title="t('diff.navCount')"
      >{{ navCountText }}</span>
      <n-button-group size="tiny">
        <n-button
          :type="diffMode === 'unified' ? 'primary' : 'default'"
          @click="diffMode = 'unified'"
        >
          {{ t('diff.unified') }}
        </n-button>
        <n-button
          :type="diffMode === 'side-by-side' ? 'primary' : 'default'"
          @click="diffMode = 'side-by-side'"
        >
          {{ t('diff.sideBySide') }}
        </n-button>
      </n-button-group>
      <n-button-group size="tiny">
        <n-button
          :type="ignoreWs ? 'primary' : 'default'"
          :title="t('diff.ignoreWhitespace')"
          @click="ignoreWs = !ignoreWs"
        >
          {{ t('diff.ignoreWhitespace') }}
        </n-button>
      </n-button-group>
      <!-- 折叠未变区域（P-20261004-99）：与编辑器 DiffEditor 的 ⋯ 开关同视觉语
           （P-20261003-40），会话级默认关；自绘侧折叠「变更之间」的文件空间未变区 -->
      <n-button-group size="tiny">
        <n-button
          data-testid="diff-fold-toggle"
          :type="foldEnabled ? 'primary' : 'default'"
          :title="t('diff.collapseUnchanged')"
          :aria-pressed="foldEnabled"
          @click="foldEnabled = !foldEnabled"
        >
          ⋯
        </n-button>
      </n-button-group>
    </div>

    <!-- 统一视图（虚拟滚动 + hunk 三键内联，行序列/折叠态在壳） -->
    <DiffUnifiedView
      v-if="diffMode === 'unified'"
      ref="unifiedViewRef"
      :rows="unifiedRows"
      :nav-flash="navFlash"
      :project-id="projectId"
      :file="file"
      :staged="staged"
      :enable-hunk-staging="enableHunkStaging"
      @staged="emit('hunk-staged')"
      @discarded="emit('hunk-discarded')"
      @toggle-fold="toggleFold"
    />
    <!-- 并排视图（虚拟滚动 + 折叠占位，同一份行序列与折叠态） -->
    <DiffSideBySideView
      v-else
      ref="sideViewRef"
      :rows="sideRows"
      :nav-flash="navFlash"
      @toggle-fold="toggleFold"
    />
  </div>
</template>

<style scoped>
/* N/M 计数（P-20261004-54）：工具条导航按钮旁的「游标位/总数」指示。
 * min-width 给足两位数余量 + 居中，循环回绕 3/3→1/3 时工具条不横跳 */
.diff-nav-count {
  align-self: center;
  min-width: 36px;
  text-align: center;
  font-size: 11px;
  color: var(--text-muted);
  user-select: none;
}
</style>
