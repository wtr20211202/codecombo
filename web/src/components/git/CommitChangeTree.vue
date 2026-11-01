<script setup lang="ts">
import { reactive } from 'vue'
import { NDropdown, NIcon } from 'naive-ui'
import { BarChartOutline, ChevronForwardOutline, ChevronDownOutline, ChevronUpOutline, CopyOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { getStatusColor, getStatusLabel } from '../../utils/git'
import type { ChangeTreeState, ChangeTreeList } from '../../composables/useChangeTree'
import CommitInlineDiff from './CommitInlineDiff.vue'

// 变更树（自 CommitPanel.vue 拆出，P-20261003-143）：纯 UI——树构建/折叠态/
// 虚拟滚动切片/键盘导航/右键菜单逻辑在 useChangeTree（面板宿主 setup 期调用，
// 状态挂在面板实例上：changes 页签 v-if 卸载本组件时不丢折叠态与键盘光标）。
// tree 为 reactive 面板（模板内赋值如 clickoutside 关菜单直接路由回 ref）；
// list 是 useVirtualList 的 containerProps/wrapperProps 裸对象（不可进 reactive，
// 见 composable 文件头注）。
const props = defineProps<{
  tree: ChangeTreeState
  list: ChangeTreeList
}>()

// 同一响应式代理（reactive(reactive proxy) 返回自身）：本地别名让模板读写与
// props 解耦，赋值经代理路由回 useChangeTree 的 ref
const tree = reactive(props.tree)

const { t } = useI18n()
</script>

<template>
  <!-- 树头批量展开/收起（P-20261003-169）：agent 批量改动几十组目录逐组点击的
       一键化（文件树 collapseAll 钮同视觉语）；过滤激活时命中自动展开优先
       （useChangeTree isTreeFiltering），两钮仍改折叠集本身，清过滤后生效 -->
  <div class="cp-tree-head">
    <!-- 按改动量排序（P-20261003-239）：审阅焦点模式钮（默认路径序，会话内
         显示态不持久化）；热力条是被动呈现无独立开关，共用同一 numstat 数据面 -->
    <button
      class="cp-tree-head-btn"
      data-testid="cp-sort-by-size"
      :class="{ active: tree.sortBySize }"
      :title="tree.sortBySize ? t('changes.tree.sortBySizeOn') : t('changes.tree.sortBySizeOff')"
      @click="tree.toggleSortBySize()"
    >
      <n-icon size="12">
        <BarChartOutline />
      </n-icon>
    </button>
    <button
      class="cp-tree-head-btn"
      data-testid="cp-expand-all"
      :title="t('changes.tree.expandAll')"
      @click="tree.expandAllDirs()"
    >
      <n-icon size="12">
        <ChevronDownOutline />
      </n-icon>
    </button>
    <button
      class="cp-tree-head-btn"
      data-testid="cp-collapse-all"
      :title="t('changes.tree.collapseAll')"
      @click="tree.collapseAllDirs()"
    >
      <n-icon size="12">
        <ChevronUpOutline />
      </n-icon>
    </button>
    <!-- 复制变更摘要（P-20261003-219）：文件清单 + 各文件 +N/-M 行式入剪贴板，
         贴给 agent/记录的概要转述出口；右键菜单同名项同动作 -->
    <button
      class="cp-tree-head-btn"
      data-testid="cp-copy-summary"
      :title="t('changes.tree.copySummary')"
      @click="tree.copyChangeSummary()"
    >
      <n-icon size="12">
        <CopyOutline />
      </n-icon>
    </button>
  </div>
  <div
    v-bind="list.containerProps"
    class="cp-file-list virtual-list-container"
    tabindex="0"
    @keydown="tree.onFileListKeydown"
  >
    <div v-bind="list.wrapperProps">
      <template
        v-for="row in tree.visibleNodes"
        :key="row.data.path"
      >
        <div
          class="cp-node"
          :class="{ 'is-selected': row.data.file && tree.selectedFilePath === row.data.file.path, 'is-active': row.index === tree.activeIdx, 'is-multi-selected': row.data.file && tree.multiSelectedPaths.has(row.data.file.path) }"
          :style="{ paddingLeft: (6 + row.data.depth * 14) + 'px' }"
          :title="row.data.file ? t('commitPanel.openDiffHint') : undefined"
          @click="row.data.isDir ? tree.toggleDir(row.data.path) : row.data.file && tree.handleFileClick(row.data.file)"
          @dblclick="row.data.file && tree.handleFileDblClick(row.data.file)"
          @contextmenu="row.data.file && tree.handleContextMenu($event, row.data.file)"
        >
          <!-- 目录展开图标 -->
          <span
            v-if="row.data.isDir"
            class="cp-chevron"
          >
            <n-icon size="12"><component :is="tree.collapsedDirs.has(row.data.path) ? ChevronForwardOutline : ChevronDownOutline" /></n-icon>
          </span>
          <!-- 文件行内联 diff 展开 chevron（P-20261004-25）：独立点击区（stop 冒泡
               不改行选中/双击主路径），与目录 chevron 同款图标语；dblclick 一并
               拦下——快速双击 chevron 会被行级双击判据捕获误开编辑器 Diff 标签 -->
          <span
            v-if="row.data.file"
            class="cp-chevron cp-expand-chevron"
            :title="tree.expandedDiffPath === row.data.file.path ? t('changes.tree.collapseDiff') : t('changes.tree.expandDiff')"
            @click.stop="tree.toggleDiffExpand(row.data.file)"
            @dblclick.stop
          >
            <n-icon size="12"><component :is="tree.expandedDiffPath === row.data.file.path ? ChevronDownOutline : ChevronForwardOutline" /></n-icon>
          </span>
          <!-- 行数热力条（P-20261003-239）：numstat 覆盖且 ≥1 档才渲染（二进制/
               无行数数据不虚构热度），档位进 data-level、精确行数进 tooltip -->
          <span
            v-if="row.data.file && row.data.heat"
            class="cp-heat"
            :class="'is-l' + row.data.heat.level"
            :data-level="row.data.heat.level"
            :title="tree.heatTip(row.data.heat)"
          />
          <!-- 文件暂存切换 -->
          <span
            v-if="row.data.file"
            class="cp-stage-toggle"
            :class="{ staged: row.data.file.staged }"
            :title="row.data.file.staged ? t('commitPanel.ctxUnstage') : t('commitPanel.stageTitle')"
            @click.stop="tree.toggleFileStage(row.data.file, $event)"
          >
            {{ row.data.file.staged ? '✓' : '○' }}
          </span>
          <!-- 提交选择复选框 -->
          <span
            v-if="row.data.file && row.data.file.staged"
            class="cp-commit-check"
            :title="t('commitPanel.selectCommitTitle')"
            @click.stop="tree.toggleFileSelection(row.data.file)"
          >
            {{ tree.selectedForCommit.has(row.data.file.path) ? '☑' : '☐' }}
          </span>
          <span class="cp-icon">{{ row.data.isDir ? (tree.collapsedDirs.has(row.data.path) ? '📁' : '📂') : '📄' }}</span>
          <span
            class="cp-name"
            :class="{ 'is-dir': row.data.isDir }"
          >{{ row.data.name }}</span>
          <!-- 会话归属点标（P-20261003-22）：agent 产出文件打点，tooltip 列
               运行时/会话数——与文件树 item-agent-dot 同视觉语 -->
          <span
            v-if="row.data.file && tree.agentMarks.has(row.data.file.path)"
            class="cp-agent-dot"
            data-testid="cp-agent-dot"
            :title="tree.agentMarkTip(row.data.file.path)"
            @click.stop
          />
          <span
            v-if="row.data.file"
            class="cp-status"
            :style="{ color: getStatusColor(row.data.file.status) }"
          >{{ getStatusLabel(row.data.file.status) }}</span>
          <!-- 组头统计（P-20261003-280）：目录行右缘「N 文件 +x -y」——组内 diffstat
               聚合（P-239 numstat 数据面同源，聚合在 useChangeTree 树构建一遍顺带
               求出），组级改动量一眼：文件级行数热力/排序的组级补充。数据面未就位
               不渲染（useChangeTree dirStat 不挂，加载窗假零比空缺误导） -->
          <span
            v-if="row.data.isDir && row.data.dirStat"
            class="cp-dir-stat"
            data-testid="cp-dir-stat"
          >
            <span>{{ t('changes.tree.dirStatFiles', { n: row.data.dirStat.files }) }}</span>
            <span class="cp-dir-stat-add">+{{ row.data.dirStat.additions }}</span>
            <span class="cp-dir-stat-del">-{{ row.data.dirStat.deletions }}</span>
          </span>
        </div>
        <!-- 行内嵌 diff（P-20261004-25）：v-if 懒挂载（收起零请求），accordion
             单文件展开态在 useChangeTree（面板宿主）；槽高固定并已计入虚列表
             itemHeight（展开行 = 行高 + 槽高），切片/滚动定位几何一致 -->
        <div
          v-if="row.data.file && tree.expandedDiffPath === row.data.file.path"
          class="cp-inline-diff"
          data-testid="cp-inline-diff"
          :style="{ height: tree.inlineDiffHeight + 'px' }"
        >
          <CommitInlineDiff :file="row.data.file" />
        </div>
      </template>
    </div>
  </div>

  <!-- 右键菜单宿主：manual 触发 + x/y 定位，弹出层 teleport 渲染、原位无 DOM -->
  <NDropdown
    placement="bottom-start"
    trigger="manual"
    :x="tree.contextX"
    :y="tree.contextY"
    :options="tree.contextOptions"
    :show="tree.showContext"
    @select="tree.handleContextSelect"
    @clickoutside="tree.showContext = false"
  />
</template>

<!-- 样式沿用面板共享样式表（scoped 按组件各编译一份，同 SecuritySettings 拆分先例） -->
<style scoped src="../../views/git/commit-panel.css"></style>
