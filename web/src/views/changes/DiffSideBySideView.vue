<script setup lang="ts">
import { computed, effectScope, onBeforeUnmount, shallowRef, toValue, watch } from 'vue'
import { useVirtualList } from '@vueuse/core'
import { useI18n } from '../../composables/useI18n'
import { lineBgStyle, useDiffLineSlots, type SideBySideLine } from './diffViewModels'

/**
 * DiffViewer 并排（side-by-side）视图（自 DiffViewer 按视图区拆分，纯搬运零
 * 逻辑改动）：行序列由父组件产出（sideRows，折叠槽位已并入），本视图虚拟化
 * 渲染。滚动容器 = 本组件根节点（containerProps 含 ref/onScroll，父组件导航
 * 定位经 expose 取用）。行槽随 diff 字号档联动（P-20261004-104，行槽换算
 * 收口 diffViewModels），useVirtualList 的 itemHeight 整只随字号重建。
 */
const props = defineProps<{
  /** 折叠后的并排行序列（父组件 sideRows，虚拟列表数据源） */
  rows: SideBySideLine[]
  /** 落点高亮的 hunk 序号（变更导航数秒熄灭提示） */
  navFlash: number
}>()

const emit = defineEmits<{
  (e: 'toggleFold', regionStart: number): void
}>()

const { t } = useI18n()

// 并排视图虚拟化（P-20261003-325）：与统一模式共用同款虚拟化参数（固定行槽 +
// overscan）。服务端 diff 上限 5MB（git/diff.go MaxDiffOutput），大文件重写类
// 改动可达数十万行，并排全量直渲染会把整表 <tr> 压进 DOM 冻结面板。
// 行结构保持 table/td（单测与 e2e 锚 td[data-hunk-nav]、跨行文本选择语义不变），
// 前提是行槽恒定——内容格不折行（.diff-cell white-space: pre，长行随容器
// 横向滚动与 unified 同款），且格内文本装进显式行高的内块（.diff-cell，
// var(--diff-line-h) 与 unified 行内固定 height 同源）：个别平台字体度量会撑高
// 行框（实测 12px 字体行框 32px），表格行随之翻倍、虚拟切片 scrollTop 对位失准
const { DIFF_LINE_HEIGHT, DIFF_LINE_NO_WIDTH } = useDiffLineSlots()
const SIDE_LINE_HEIGHT = DIFF_LINE_HEIGHT

// useVirtualList 的 itemHeight 在创建期被捕获为裸数字（vueuse 内部闭包按
// typeof === 'number' 走 O(1) 定距分支；ref 形态不识别、函数形态每次滚动
// O(行下标) 求距——50 万行不可取，P-20261003-325 同款结论），字号变化必须
// 整只重建才能同步 scrollTop↔行下标换算。字号调整是低频手势，重建 O(1)
// （可见窗口由 containerRef/size watch 按新行高复算）；旧实例的 resize 监听
// 与 watch 经 effectScope 停止释放，设置滑条连点不积泄漏。
function createVirtualList(lineHeight: number) {
  return useVirtualList(computed(() => props.rows), { itemHeight: lineHeight, overscan: 20 })
}
let vlScope = effectScope()
const virtualList = shallowRef(vlScope.run(() => createVirtualList(SIDE_LINE_HEIGHT.value))!)
watch(SIDE_LINE_HEIGHT, (h) => {
  vlScope.stop()
  vlScope = effectScope()
  virtualList.value = vlScope.run(() => createVirtualList(h))!
})
onBeforeUnmount(() => vlScope.stop())

// 模板消费面：virtualList 整只换实例时统一换绑到当前实例（list 容器 props 与
// scrollTo 都取 virtualList 现值，toValue 兼容 ref 与测试桩的裸对象形态）
const visible = computed(() => toValue(virtualList.value.list))
const containerProps = computed(() => virtualList.value.containerProps)
const wrapperProps = computed(() => toValue(virtualList.value.wrapperProps))
const scrollTo = (index: number) => virtualList.value.scrollTo(index)
// containerRef 双层解包：computed 的值是 useVirtualList 的 ref 形态（字号重建
// 换实例即换 ref），expose 代理只解顶层一层，父组件取用时须已是元素
const containerRef = computed(() => toValue(containerProps.value.ref))

defineExpose({ scrollTo, containerRef })

// 预定义样式常量，避免每次渲染创建新对象。
// added/removed 语义色走 diff 色板变量（P-20261006-5）——theme store 按当前主题
// × 色板档（设置·外观「diff 色板」）解析写入，色弱档切换时与 Monaco diff 编辑器
// 同源换蓝橙；不直引 --accent-green/--accent-red（全局成功/失败语义色防涟漪）
const STYLE_EMPTY: Record<string, string> = {}
const STYLE_SIDE_DEL: Record<string, string> = { background: 'color-mix(in srgb, var(--diff-removed) 20%, transparent)', borderLeft: '3px solid var(--diff-removed)' }
const STYLE_SIDE_ADD: Record<string, string> = { background: 'color-mix(in srgb, var(--diff-added) 20%, transparent)', borderLeft: '3px solid var(--diff-added)' }

function sideLeftBg(type: string): Record<string, string> {
  if (type === 'del') return STYLE_SIDE_DEL
  return STYLE_EMPTY
}

function sideRightBg(type: string): Record<string, string> {
  if (type === 'add') return STYLE_SIDE_ADD
  return STYLE_EMPTY
}

</script>

<template>
  <!-- Side-by-Side 模式（虚拟滚动：与 unified 同款窗口切片，仅渲染可见 ±overscan
       行；wrapper 撑全量高度提供滚动占位）。--diff-line-h/--diff-line-no-w
       （P-20261004-104）：行槽 var 供给 CSS 侧钉高（.diff-cell 等），与虚拟列表
       itemHeight 同源自 SIDE_LINE_HEIGHT，字号联动不散点 -->
  <div
    v-bind="containerProps"
    style="flex: 1; overflow: auto; font-family: var(--font-mono); font-size: var(--fs-diff); line-height: 1.5"
    :style="{ '--diff-line-h': DIFF_LINE_HEIGHT + 'px', '--diff-line-no-w': DIFF_LINE_NO_WIDTH + 'px' }"
  >
    <div v-bind="wrapperProps">
      <table style="width: 100%; border-collapse: collapse">
        <colgroup>
          <col :style="{ width: DIFF_LINE_NO_WIDTH + 'px' }">
          <col :style="{ width: `calc(50% - ${DIFF_LINE_NO_WIDTH}px)` }">
          <col :style="{ width: DIFF_LINE_NO_WIDTH + 'px' }">
          <col :style="{ width: `calc(50% - ${DIFF_LINE_NO_WIDTH}px)` }">
        </colgroup>
        <tr
          v-for="row in visible"
          :key="(row.data.leftLineNo ?? 'x') + '-' + (row.data.rightLineNo ?? 'y') + '-' + row.index + '-' + row.data.type"
        >
          <!-- 折叠占位行（P-20261004-99）：与 unified 同一区域状态、同款交互 -->
          <template v-if="row.data.type === 'fold'">
            <td
              colspan="4"
              class="diff-fold-cell"
              data-testid="diff-fold-row"
              role="button"
              @click="emit('toggleFold', row.data.regionId!)"
            >
              <span class="diff-cell">
                <span class="diff-fold-glyph">⋯</span>
                {{ row.data.expanded ? t('diff.foldCollapse') : t('diff.foldExpand', { count: row.data.restoreCount }) }}
              </span>
            </td>
          </template>
          <template v-else-if="row.data.type === 'hunk' || row.data.type === 'header'">
            <td
              colspan="4"
              :data-hunk-nav="row.data.hunkIndex"
              :class="{ 'diff-nav-flash': row.data.hunkIndex !== undefined && row.data.hunkIndex === navFlash }"
              :style="{ ...lineBgStyle(row.data.type), padding: '0 8px' }"
            >
              <span class="diff-cell">{{ row.data.leftContent }}</span>
            </td>
          </template>
          <template v-else>
            <td
              class="diff-td-no"
              :style="sideLeftBg(row.data.type)"
            >
              <span class="diff-cell">{{ row.data.leftLineNo ?? '' }}</span>
            </td>
            <td
              class="diff-td-content"
              :style="sideLeftBg(row.data.type)"
            >
              <span class="diff-cell">{{ row.data.leftContent }}</span>
            </td>
            <td
              class="diff-td-no"
              :style="sideRightBg(row.data.type)"
            >
              <span class="diff-cell">{{ row.data.rightLineNo ?? '' }}</span>
            </td>
            <td
              class="diff-td-content"
              :style="sideRightBg(row.data.type)"
            >
              <span class="diff-cell">{{ row.data.rightContent }}</span>
            </td>
          </template>
        </tr>
      </table>
    </div>
  </div>
</template>

<style scoped>
.diff-td-no {
  padding: 0 8px;
  text-align: right;
  color: var(--text-muted);
  user-select: none;
  font-size: var(--fs-diff);
  vertical-align: top;
  border-right: 1px solid var(--border-default);
}
.diff-td-content {
  padding: 0 8px;
  vertical-align: top;
}
/* 行槽钉定：格内文本装进显式行高（var(--diff-line-h)，与 unified 行内固定 height
 * 同源联动）的块级内衬。不钉则个别平台字体度量撑高行框（实测 12px 字体行框
 * 32px），表格行翻倍、虚拟切片 scrollTop 对位失准；white-space: pre 不折行
 * （pre-wrap 会撑破行槽），长行随容器横向滚动，与 unified / Monaco diff 编辑器
 * 同口径 */
.diff-cell {
  display: block;
  height: var(--diff-line-h);
  line-height: var(--diff-line-h);
  white-space: pre;
}
/* 变更导航落点提示（P-20261003-212）：跳转后短暂内描边高亮目标 hunk 头，
 * 数秒自动熄灭；用内描边而非底色——行底色是 inline 语义色，类选择器压不过。
 * 与统一视图（DiffUnifiedView）两处同名同款——scoped 边界各自带一份同值
 * 规则，改动需两边同步 */
.diff-nav-flash {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent-blue-light) 60%, transparent);
}
/* 并排表格形态：td 不吃 flex，样式收敛到色与光标，行槽由 .diff-cell 钉定 */
.diff-fold-cell {
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
  padding: 0 8px;
}
.diff-fold-cell:hover {
  background: color-mix(in srgb, var(--accent-vs-blue) 10%, transparent);
}
.diff-fold-glyph {
  color: var(--text-muted);
}
</style>
