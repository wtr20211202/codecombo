<script setup lang="ts">
import { computed, effectScope, onBeforeUnmount, ref, shallowRef, toValue, watch } from 'vue'
import { NButton, NIcon } from 'naive-ui'
import { useVirtualList } from '@vueuse/core'
import { diffApi } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { lineBgStyle, useDiffLineSlots, type UnifiedRow } from './diffViewModels'

/**
 * DiffViewer 统一（unified）视图（自 DiffViewer 按视图区拆分，纯搬运零逻辑
 * 改动）：行序列由父组件产出（unifiedRows，折叠槽位已并入），本视图虚拟化
 * 渲染。hunk 级暂存/取消暂存/放弃三键只在统一视图内联渲染，操作逻辑就近本
 * 视图（结果经事件上抛父组件转发原 emit 契约）。滚动容器 = 本组件根节点
 * （containerProps 含 ref/onScroll，父组件导航定位经 expose 取用）。
 * 行槽随 diff 字号档联动（P-20261004-104，行槽换算收口 diffViewModels）：
 * useVirtualList 的 itemHeight 整只随字号重建（见下方注记）。
 */
const props = defineProps<{
  /** 折叠后的扁平行序列（父组件 unifiedRows，虚拟列表数据源） */
  rows: UnifiedRow[]
  /** 落点高亮的 hunk 序号（变更导航数秒熄灭提示） */
  navFlash: number
  projectId?: string
  file?: string
  staged?: boolean
  enableHunkStaging?: boolean
}>()

const emit = defineEmits<{
  (e: 'staged'): void
  (e: 'discarded'): void
  (e: 'toggleFold', regionStart: number): void
}>()

const { t } = useI18n()

const { DIFF_LINE_HEIGHT, DIFF_LINE_NO_WIDTH } = useDiffLineSlots()

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
const virtualList = shallowRef(vlScope.run(() => createVirtualList(DIFF_LINE_HEIGHT.value))!)
watch(DIFF_LINE_HEIGHT, (h) => {
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

// ── hunk 级暂存/取消暂存/放弃（P-20261003-49 第三键）──
const hunkLoading = ref(-1)

async function handleStageHunk(displayIndex: number) {
  if (!props.projectId || !props.file) return
  hunkLoading.value = displayIndex
  try {
    // 服务端 hunkIndex 是 0 基且只数真实 @@ 块（server/git parseHunks 跳过文件头
    // 行）；本组件解析把文件头行归入伪块 0，真实块从展示索引 1 起——API 寻址
    // 需 -1 对位（三键休眠期无人踩中，单测曾把错位固化，P-20261004-25 点亮
    // 承载面时修正）。hunkLoading/导航锚点全程用展示索引，只在此处换算
    const serverIndex = displayIndex - 1
    if (props.staged) {
      await diffApi.unstageHunk(props.projectId, props.file, serverIndex)
    } else {
      await diffApi.stageHunk(props.projectId, props.file, serverIndex)
    }
    emit('staged')
  } catch { /* 拦截器处理 */ } finally {
    hunkLoading.value = -1
  }
}

// 放弃工作区单个 hunk（P-20261003-49）：服务端按当前未暂存 diff 派生该块补丁
// git apply -R 回工作区（暂存区不动）。与 stage/unstage 可逆不同，丢弃不可恢复，
// 先确认再动手（VS Code「撤销更改」同款拦截）；块已被再改 → 后端 409 稳定标记
// （hunk no longer applies），拦截器映射「此变更块已变化，无法直接回滚」
async function handleDiscardHunk(displayIndex: number) {
  if (!props.projectId || !props.file) return
  const ok = await confirmDialog({
    type: 'warning',
    title: t('diff.discard.title'),
    content: t('diff.discard.confirm', { name: props.file }),
  })
  if (!ok) return
  hunkLoading.value = displayIndex
  try {
    // 同 stage/unstage：展示索引 → 服务端 0 基真实块索引（见 handleStageHunk 注）
    await diffApi.discardHunk(props.projectId, props.file, displayIndex - 1)
    emit('discarded')
  } catch { /* 拦截器处理（冲突文案含在内） */ } finally {
    hunkLoading.value = -1
  }
}
</script>

<template>
  <!-- Unified 模式（虚拟滚动：行高随 diff 字号档联动，hunk 头/暂存按钮随行内联）。
       --diff-line-h/--diff-line-no-w（P-20261004-104）：行槽 var 供给 CSS 侧钉高
       （.diff-line/.diff-line-no 等），与虚拟列表 itemHeight 同源自 DIFF_LINE_HEIGHT，
       字号联动不散点 -->
  <div
    v-bind="containerProps"
    style="flex: 1; overflow: auto; font-family: var(--font-mono); font-size: var(--fs-diff); line-height: 1.5"
    :style="{ '--diff-line-h': DIFF_LINE_HEIGHT + 'px', '--diff-line-no-w': DIFF_LINE_NO_WIDTH + 'px' }"
  >
    <div v-bind="wrapperProps">
      <template
        v-for="row in visible"
        :key="row.data.hunkIndex + '-' + row.index"
      >
        <!-- 折叠占位行（P-20261004-99）：点击展开/收起所在区域；行高钉与虚拟化
             行槽一致，不破对位。展开后占位行留顶部作「收起」控件 -->
        <div
          v-if="row.data.type === 'fold'"
          class="diff-fold-row"
          data-testid="diff-fold-row"
          role="button"
          :style="{ height: DIFF_LINE_HEIGHT + 'px' }"
          @click="emit('toggleFold', row.data.regionId!)"
        >
          <span class="diff-fold-glyph">⋯</span>
          <span>{{ row.data.expanded ? t('diff.foldCollapse') : t('diff.foldExpand', { count: row.data.restoreCount }) }}</span>
        </div>
        <!-- Hunk 暂存按钮（跳过第一个 hunk，它包含 header 行）；行槽与内容行同高
             （border-box，var(--diff-line-h)）——不在扁平序列里的额外行，高度随
             字号联动保持视觉节奏一致（对位偏差由 alignNavTarget 实测修正） -->
        <div
          v-if="enableHunkStaging && file && row.data.type === 'hunk' && (row.data.hunkIndex ?? 0) > 0"
          style="display: flex; align-items: center; padding: 1px 0; height: var(--diff-line-h)"
          :style="lineBgStyle('hunk')"
        >
          <n-button
            size="tiny"
            data-testid="diff-hunk-stage"
            :type="staged ? 'warning' : 'success'"
            :loading="hunkLoading === row.data.hunkIndex"
            style="margin: 0 8px; font-size: 10px"
            quaternary
            @click="handleStageHunk(row.data.hunkIndex!)"
          >
            {{ staged ? t('diff.unstageHunk') : t('diff.stageHunk') }}
          </n-button>
          <!-- 放弃此更改块（P-20261003-49 第三键）：仅工作区侧（staged=索引侧
               语义只有 unstage，索引块无可丢弃的工作区形态）；与 stage/unstage
               既有逻辑并列，不改动原键。点击行 spinner、其余行禁用（在飞锁） -->
          <n-button
            v-if="!staged"
            size="tiny"
            data-testid="diff-hunk-discard"
            type="error"
            quaternary
            :loading="hunkLoading === row.data.hunkIndex"
            :disabled="hunkLoading !== -1 && hunkLoading !== row.data.hunkIndex"
            style="margin-right: 8px; font-size: 10px"
            @click="handleDiscardHunk(row.data.hunkIndex!)"
          >
            {{ t('diff.discard.hunk') }}
          </n-button>
        </div>
        <div
          v-if="row.data.type !== 'fold'"
          class="diff-line"
          :data-hunk-nav="row.data.type === 'hunk' ? row.data.hunkIndex : undefined"
          :class="{ 'diff-nav-flash': row.data.type === 'hunk' && row.data.hunkIndex === navFlash }"
          :style="{ ...lineBgStyle(row.data.type), height: DIFF_LINE_HEIGHT + 'px' }"
        >
          <span class="diff-line-no">{{ row.data.oldLineNo ?? '' }}</span>
          <span class="diff-line-no">{{ row.data.newLineNo ?? '' }}</span>
          <span class="diff-line-prefix">{{
            row.data.type === 'add' ? '+' : row.data.type === 'del' ? '-' : row.data.type === 'hunk' ? '' : ' '
          }}</span>
          <span class="diff-line-content">{{ row.data.content }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.diff-line {
  display: flex;
  white-space: pre;
  /* 行槽下限随字号联动（--diff-line-h 由根节点按 DIFF_LINE_HEIGHT 注入），
   * 实际钉高走行内 height（与虚拟列表 itemHeight 同源） */
  min-height: var(--diff-line-h);
  position: relative;
}
/* 新增行左侧绿色边条标记（diff 色板变量 P-20261006-5，色弱档随档换蓝） */
.diff-line-add::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--diff-added);
  border-radius: 0 2px 2px 0;
}
/* 删除行左侧红色边条标记（色弱档随档换橙） */
.diff-line-del::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--diff-removed);
  border-radius: 0 2px 2px 0;
}
.diff-line-no {
  display: inline-block;
  /* 列宽随字号档联动（--diff-line-no-w，默认档 50px），大字档不截断 5 位数行号 */
  width: var(--diff-line-no-w);
  min-width: var(--diff-line-no-w);
  /* 行内容不换行后长行横向滚动：行号钉在左侧保住对位参照。
   * 底色用弹窗面板色（DiffViewer 仅文件历史弹窗消费，行底 transparent
   * 即透出该色），z-index 压住横向滚过的行内容 */
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--bg-panel);
  text-align: right;
  padding-right: 8px;
  color: var(--text-muted);
  user-select: none;
  font-size: var(--fs-diff);
}
.diff-line-prefix {
  display: inline-block;
  width: 16px;
  min-width: 16px;
  user-select: none;
}
.diff-line-content {
  flex: 1;
  /* 不换行：Unified 视图按固定行槽虚拟化（DIFF_LINE_HEIGHT，随 diff 字号档联动），
   * pre-wrap 的换行行会撑出行槽与下一行重叠渲染；长行随容器横向滚动
   * （VS Code 同款），并排表格模式行高自适应不受此约束 */
  white-space: pre;
}
.diff-line-header {
  color: var(--text-dim);
}
.diff-line-hunk {
  font-weight: 500;
}
.diff-line-add .diff-line-prefix {
  color: var(--diff-added);
}
.diff-line-del .diff-line-prefix {
  color: var(--diff-removed);
}
/* 变更导航落点提示（P-20261003-212）：跳转后短暂内描边高亮目标 hunk 头，
 * 数秒自动熄灭；用内描边而非底色——行底色是 inline 语义色，类选择器压不过。
 * 与并排视图（DiffSideBySideView）两处同名同款——scoped 边界各自带一份同值
 * 规则，改动需两边同步 */
.diff-nav-flash {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent-blue-light) 60%, transparent);
}
/* 折叠占位行（P-20261004-99）：unified 行形态——flex 横排、钉死行槽由内联
 * height 提供；悬停给亮提示（可点击），文字取弱化色不与变更行争注意 */
.diff-fold-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  color: var(--text-dim);
  cursor: pointer;
  user-select: none;
  white-space: pre;
}
.diff-fold-row:hover {
  background: color-mix(in srgb, var(--accent-vs-blue) 10%, transparent);
}
.diff-fold-glyph {
  color: var(--text-muted);
}
</style>
