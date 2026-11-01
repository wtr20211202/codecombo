<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { NInput, NModal } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'
import { useKeymapStore, keycapParts, type KeymapAction } from '@/stores/keymap'

// 快捷键备忘单（? 键呼出）：把散落在命令面板/编辑器/终端等处的键位聚合为
// 分组清单，提升快捷键可发现性。全局分组与终端分组（P-20261003-111）、编辑器
// 自定义动作分组（P-20261008-14）键位来自 keymap store 实时生效值（设置→快捷键
// 改绑后此清单跟随）；Monaco 内建键（F/H/D 查找替换多光标）不改绑，编辑器分组
// 中该三行维持静态（与 vendored 默认键位对账，审计脚本 vendor 作用域）。
// 「鼠标与拖拽」分组（P-20261005-184）：非键盘交互（拖拽/中键/双击/面包屑
// 点选）速查——触发方式以 trigger 短语呈现（kbd 同款键帽样式），无注册表不对账。
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()
const { t } = useI18n()
const keymap = useKeymapStore()

// 作用域标签（P-20261003-99）：条目按「生效条件」打标（与功能域分组正交——
// 同组内混布不同作用域，如编辑器组的 Alt+↑/↓ 实际是全局注册、编辑器组键位行
// 混有全局改键范围），徽标 + 按作用域筛选让「按了没反应」可自助归因：
//   global   任何焦点域生效（keymap 改键表/布局硬编码链）
//   editor   Monaco 聚焦时生效（addAction + Monaco 内建）
//   terminal xterm 聚焦时生效（customKeyEventHandler 拦截域）
//   approval 待裁决审批卡在屏时生效（焦点不在输入面且无模态让位，useApprovalHotkeys）
//   monitor  仅值班大屏路由页内生效（裸 R 刷新）
// 标注与实际注册的一致性由 scripts/check-keybindings.mjs 单向对账兜底
// （帮助承诺键 ⊆ 实际注册；approval 作用域同样在审计面内），静态行改动须同步。
type ShortcutScope = 'global' | 'editor' | 'terminal' | 'approval' | 'monitor'
const SCOPES: ShortcutScope[] = ['global', 'editor', 'terminal', 'approval', 'monitor']

// keys=键盘行键帽数组；trigger=鼠标/拖拽行触发短语（P-20261005-184）。鼠标交互
// 无键位注册表，check-keybindings 的单向对账（帮助承诺键 ⊆ 实际注册，静态提取
// 正则锚定 keys 数组字面量、含本文件注释文本）只覆盖键盘行、trigger 行天然不
// 扫描——本节条目维护靠此处自陈与实现同步（各行注释即 grep 锚点），这是对账
// 体系的已知豁免面而非遗漏；注释里勿写字面 keys 冒号方括号形态防正则误配。
interface ShortcutItem { keys?: string[]; trigger?: string[]; scope: ShortcutScope; desc: string }
interface ShortcutGroup { title: string; items: ShortcutItem[] }

/** 行尾键帽渲染源：键盘行取 keys、鼠标行取 trigger（模板与文本过滤共用） */
function capsOf(it: ShortcutItem): string[] {
  return it.keys ?? it.trigger ?? []
}

// keymap 动作 → 备忘单键帽数组（实时生效值；改绑后动态跟随）
function keysOf(action: KeymapAction): string[] {
  return keycapParts(keymap.combos[action])
}

const groups = computed<ShortcutGroup[]>(() => [
  {
    title: t('shortcuts.groupGlobal'),
    items: [
      { keys: keysOf('commandPalette'), scope: 'global', desc: t('shortcuts.cmdPalette') },
      { keys: keysOf('commandMode'), scope: 'global', desc: t('shortcuts.commandMode') },
      { keys: keysOf('quickOpen'), scope: 'global', desc: t('shortcuts.quickOpen') },
      { keys: keysOf('projectSearch'), scope: 'global', desc: t('shortcuts.projectSearch') },
      { keys: keysOf('outline'), scope: 'global', desc: t('shortcuts.outline') },
      { keys: keysOf('toggleSidebar'), scope: 'global', desc: t('shortcuts.toggleSidebar') },
      // 不可改键 MVP 范围（数字直达链 / 单键 / 成对键）：维持静态展示
      { keys: ['Ctrl', '1-9'], scope: 'global', desc: t('shortcuts.railPanels') },
      // 工作区预设直达（P-20261004-49）：恢复弹层列表第 N 个预设，数字 = 弹层序号
      { keys: ['Ctrl', 'Alt', '1-9'], scope: 'global', desc: t('shortcuts.workspacePresets') },
      { keys: keysOf('openSettings'), scope: 'global', desc: t('shortcuts.openSettings') },
      { keys: keysOf('toggleTerminal'), scope: 'global', desc: t('shortcuts.toggleTerminal') },
      { keys: keysOf('newTerminal'), scope: 'global', desc: t('shortcuts.newTerminal') },
      { keys: keysOf('previewToggle'), scope: 'global', desc: t('shortcuts.previewToggle') },
      { keys: keysOf('closeTab'), scope: 'global', desc: t('shortcuts.closeTab') },
      { keys: keysOf('cycleTab'), scope: 'global', desc: t('shortcuts.cycleTabs') },
      { keys: keysOf('reopenClosedTab'), scope: 'global', desc: t('shortcuts.reopenTab') },
      { keys: keysOf('navBack'), scope: 'global', desc: t('shortcuts.navBack') },
      { keys: keysOf('navForward'), scope: 'global', desc: t('shortcuts.navForward') },
      { keys: keysOf('newUntitledDraft'), scope: 'global', desc: t('shortcuts.newDraft') },
      // 全部保存（P-20261002-101）：全局改键范围，键位取 keymap 实时生效值
      { keys: keysOf('saveAll'), scope: 'global', desc: t('shortcuts.saveAll') },
      // 多剪贴板粘贴（P-20261002-149）：全局改键范围，键位取 keymap 实时生效值
      { keys: keysOf('clipHistoryPaste'), scope: 'global', desc: t('shortcuts.clipHistoryPaste') },
      { keys: ['Esc'], scope: 'global', desc: t('shortcuts.exitMaximized') },
    ],
  },
  {
    title: t('shortcuts.groupEditor'),
    items: [
      // 编辑器域自定义动作（P-20261008-14）：keymap 注册表动态行（改绑后跟随，
      // 审计脚本 editor→monaco 作用域 + keysOf 合法性对账）
      { keys: keysOf('editorSave'), scope: 'editor', desc: t('shortcuts.save') },
      { keys: keysOf('editorBookmarkToggle'), scope: 'editor', desc: t('shortcuts.bookmarkToggle') },
      { keys: keysOf('editorInlineEdit'), scope: 'editor', desc: t('shortcuts.inlineEdit') },
      // scope=editor：Monaco 内建聚焦域（F/H/D=Monaco 默认键位，不改绑——审计
      // 脚本 vendor 作用域对账）
      { keys: ['Ctrl', 'F'], scope: 'editor', desc: t('shortcuts.find') },
      { keys: ['Ctrl', 'H'], scope: 'editor', desc: t('shortcuts.replace') },
      { keys: ['Ctrl', 'D'], scope: 'editor', desc: t('shortcuts.multiCursor') },
      // scope=global：diff 导航成对键注册于 useLayoutKeyboard 全局链（非 Monaco 域）
      { keys: ['Alt', '↑/↓'], scope: 'global', desc: t('shortcuts.diffNav') },
      // 分屏键盘闭环（P-20261002-93）：全局改键范围，键位取 keymap 实时生效值
      //（改绑后此清单跟随，同全局组口径——虽列在编辑器组，作用域徽标同标 global）
      { keys: keysOf('toggleSplit'), scope: 'global', desc: t('shortcuts.toggleSplit') },
      // 下方分屏/方向切换（P-20261005-230）：与右侧分屏键位同族（正交拆分对称）
      { keys: keysOf('splitDown'), scope: 'global', desc: t('shortcuts.splitDown') },
      { keys: keysOf('focusOtherGroup'), scope: 'global', desc: t('shortcuts.focusOtherGroup') },
      // 标签线性切换（P-20261002-135）：全局改键范围，键位取 keymap 实时生效值
      //（同上方分屏键位的编辑器组口径）
      { keys: keysOf('switchTabPrev'), scope: 'global', desc: t('shortcuts.prevTab') },
      { keys: keysOf('switchTabNext'), scope: 'global', desc: t('shortcuts.nextTab') },
      // 键盘移动标签（P-20261005-201）：全局改键范围，键位取 keymap 实时生效值
      //（同上方标签切换键位的编辑器组口径——拖拽重排的键盘对位）
      { keys: keysOf('moveTabPrev'), scope: 'global', desc: t('shortcuts.moveTabPrev') },
      { keys: keysOf('moveTabNext'), scope: 'global', desc: t('shortcuts.moveTabNext') },
      // 书签间跳转（P-20261004-102）：全局改键范围，键位取 keymap 实时生效值
      //（同上方分屏/标签键位的编辑器组口径——动作是编辑器域工作流、注册在全局链）
      { keys: keysOf('bookmarkPrev'), scope: 'global', desc: t('shortcuts.bookmarkPrev') },
      { keys: keysOf('bookmarkNext'), scope: 'global', desc: t('shortcuts.bookmarkNext') },
      // Markdown 模式循环（P-20261003-18）：全局改键范围，键位取 keymap 实时生效值
      { keys: keysOf('mdModeCycle'), scope: 'global', desc: t('shortcuts.mdModeCycle') },
    ],
  },
  {
    title: t('shortcuts.groupTerminal'),
    items: [
      // 终端域单组合键（P-20261003-111）：keymap 注册表动态行（改绑后此清单跟随）
      { keys: keysOf('terminalHistory'), scope: 'terminal', desc: t('shortcuts.history') },
      { keys: keysOf('terminalSnippet'), scope: 'terminal', desc: t('shortcuts.snippet') },
      { keys: keysOf('terminalFontIn'), scope: 'terminal', desc: t('shortcuts.fontIn') },
      { keys: keysOf('terminalFontOut'), scope: 'terminal', desc: t('shortcuts.fontOut') },
      { keys: keysOf('terminalFontReset'), scope: 'terminal', desc: t('shortcuts.fontReset') },
      { keys: keysOf('terminalCopy'), scope: 'terminal', desc: t('shortcuts.termCopy') },
      { keys: keysOf('terminalPaste'), scope: 'terminal', desc: t('shortcuts.termPaste') },
      // 命令块跳过导航（P-20261003-269）：长输出命令块间掠读（无 shell 集成不响应）
      { keys: keysOf('terminalCmdPrev'), scope: 'terminal', desc: t('shortcuts.cmdNavPrev') },
      { keys: keysOf('terminalCmdNext'), scope: 'terminal', desc: t('shortcuts.cmdNavNext') },
      // 书签列表（P-20261004-16）：scrollback 书签浮层开关（历史/片段同族面板键）
      { keys: keysOf('terminalBookmarkList'), scope: 'terminal', desc: t('shortcuts.bookmarkList') },
      // pane 键盘切换（P-20261004-111）：编辑器组 focusOtherGroup 的终端对称
      //（分屏双 pane 互切，单 pane 放行不吞键）
      { keys: keysOf('termFocusOtherPane'), scope: 'terminal', desc: t('shortcuts.focusOtherPane') },
      // Alt+1-9 切终端标签：区间键不在注册表，静态行（TerminalView 硬编码，审计脚本对账）
      { keys: ['Alt', '1-9'], scope: 'terminal', desc: t('shortcuts.switchTerm') },
    ],
  },
  // 审批等待组（P-20261003-99 补录）：键盘裁决（P-20261003-1）三选——生效条件
  // 最苛刻的一族（待裁决卡在屏 + 焦点不在输入面 + 无模态让位），此前帮助面
  // 完全未收录，是「按了没反应」的高发区。静态行（useApprovalHotkeys，审计脚本 approval 作用域对账）
  {
    title: t('shortcuts.groupApproval'),
    items: [
      { keys: ['1'], scope: 'approval', desc: t('shortcuts.approvalAllowOnce') },
      { keys: ['2'], scope: 'approval', desc: t('shortcuts.approvalTier') },
      { keys: ['3'], scope: 'approval', desc: t('shortcuts.approvalDeny') },
    ],
  },
  // 辅助组（P-20261002-80）：独立路由页的页内键位——非全局改键范围，静态展示
  {
    title: t('monitorBoard.title'),
    items: [
      { keys: ['R'], scope: 'monitor', desc: t('shortcuts.monitorRefresh') },
    ],
  },
  // 鼠标与拖拽组（P-20261005-184）：非键盘交互速查——操作效率一半在指针交互上
  //（跨组拖签/树拖放/中键关签/面包屑同级导航/终端插路径/广播多选），此前全靠
  // 口口相传。分组维度是「交互形态」而非功能域（与键盘组正交），故徽标跨
  // editor/terminal 两域混布，作用域筛选照常按行生效。条目全部经 grep 实现处
  // 核实（P-99 核实纪律），各行注释即锚点
  {
    title: t('shortcuts.groupMouse'),
    items: [
      // 跨组拖签＝移动（EditorGroupPane onPaneDrop → tabMoveIn，默认无 Alt）
      { trigger: [t('shortcuts.mouseTriggerDrag')], scope: 'editor', desc: t('shortcuts.mouseDragTabMove') },
      // Alt＝复制（EditorGroupPane onPaneDrop e.altKey 分支：目标组开签源组保留）
      { trigger: ['Alt', t('shortcuts.mouseTriggerDrag')], scope: 'editor', desc: t('shortcuts.mouseDragTabCopy') },
      // 树拖入编辑器＝打开（EditorGroupPane onPaneDrop SC_PATH_TYPE 分支，P-20261003-13）
      { trigger: [t('shortcuts.mouseTriggerDrop')], scope: 'editor', desc: t('shortcuts.mouseTreeDropEditor') },
      // 中键关编辑器签（EditorGroupPane onTabAuxClick，pinned 签豁免）
      { trigger: [t('shortcuts.mouseTriggerMiddle')], scope: 'editor', desc: t('shortcuts.mouseMiddleCloseEditorTab') },
      // 双击签钉选（EditorGroupPane .editor-tab @dblclick → togglePin）
      { trigger: [t('shortcuts.mouseTriggerDblclick')], scope: 'editor', desc: t('shortcuts.mouseDblclickPinTab') },
      // 面包屑段点击同级下拉（Breadcrumb toggleSiblings，非末段目录段，P-20261002-128）
      { trigger: [t('shortcuts.mouseTriggerClick')], scope: 'editor', desc: t('shortcuts.mouseCrumbSiblings') },
      // 中键关终端签（TerminalTabbar onTabAux → requestClose）
      { trigger: [t('shortcuts.mouseTriggerMiddle')], scope: 'terminal', desc: t('shortcuts.mouseMiddleCloseTermTab') },
      // 拖文件进终端插路径（useTerminalDnd onTerminalDrop：内部路径 paste 不执行）
      { trigger: [t('shortcuts.mouseTriggerDrop')], scope: 'terminal', desc: t('shortcuts.mouseDropTermPath') },
      // 广播多选（useTerminalBroadcast：工具条开关进多选态，tab 点击 toggleTab）
      { trigger: [t('shortcuts.mouseTriggerClick')], scope: 'terminal', desc: t('shortcuts.mouseBroadcastSelect') },
    ],
  },
])

// 作用域徽标/筛选项文案（computed 随 locale 响应）
const scopeLabels = computed<Record<ShortcutScope, string>>(() => ({
  global: t('shortcuts.scopeGlobal'),
  editor: t('shortcuts.scopeEditor'),
  terminal: t('shortcuts.scopeTerminal'),
  approval: t('shortcuts.scopeApproval'),
  monitor: t('shortcuts.scopeMonitor'),
}))

// 过滤（P-20261003-31）：按条目描述文案 + 键位/触发短语串不分大小写子串匹配
//（capsOf 统一键盘 keys 与鼠标 trigger 两形态，P-20261005-184）——条目量
// 40+ 直接 computed 全量过滤即可，无需防抖/虚拟化。
// 作用域筛选（P-20261003-99）：与文本过滤正交叠加（AND），''=不限——作用域
// 徽标维度独立于描述文案（如 diff 导航行文案不含「全局」但作用域是），仅靠
// 文本筛不出来的生效条件在此收口；条目量不变，仍零成本全量过滤
const filterText = ref('')
const scopeFilter = ref<ShortcutScope | ''>('')
const filteredGroups = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  const sf = scopeFilter.value
  if (!q && !sf) return groups.value
  return groups.value
    .map(g => ({
      ...g,
      items: g.items.filter(
        it => (!sf || it.scope === sf) &&
          (!q || it.desc.toLowerCase().includes(q) || capsOf(it).join(' ').toLowerCase().includes(q)),
      ),
    }))
    .filter(g => g.items.length > 0)
})

// Esc 两段式（P-20261003-31）：首次清空过滤（文本+作用域一并复位）、二次关闭
// 面板（naive 自理 closeOnEsc）。capture 相位 document 监听先于 naive FocusTrap
// 的 document 气泡监听：过滤非空时清空并 stopPropagation，让 naive 完全看不到
// 这一次 Esc；已空则放行由 naive 关面板。全局 Esc 逐层收起链（useLayoutKeyboard）
// 在面板在场时已被 INPUT veto + hasBlockingOverlay(.n-modal) 双重让位，不会竞争。
function onDocEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return
  if (!filterText.value && !scopeFilter.value) return
  e.preventDefault()
  e.stopPropagation()
  filterText.value = ''
  scopeFilter.value = ''
  inputRef.value?.focus()
}

// 打开即清空上次过滤（文本+作用域）并自动聚焦输入框（同 CommandPalette 开面板聚焦惯例）
const inputRef = ref<InstanceType<typeof NInput> | null>(null)
watch(() => props.show, async (val) => {
  if (val) {
    filterText.value = ''
    scopeFilter.value = ''
    document.addEventListener('keydown', onDocEsc, true)
    await nextTick()
    inputRef.value?.focus()
  } else {
    document.removeEventListener('keydown', onDocEsc, true)
  }
})
onBeforeUnmount(() => document.removeEventListener('keydown', onDocEsc, true))
</script>

<template>
  <n-modal
    :show="props.show"
    @update:show="emit('update:show', $event)"
  >
    <div class="sc-help">
      <div class="sc-help-head">
        <span class="sc-help-title">{{ t('shortcuts.title') }}</span>
        <button
          class="sc-help-close"
          :title="t('common.close')"
          @click="emit('update:show', false)"
        >
          ×
        </button>
      </div>
      <div class="sc-help-filter">
        <n-input
          ref="inputRef"
          v-model:value="filterText"
          size="small"
          clearable
          :placeholder="t('shortcuts.filterPlaceholder')"
        />
        <!-- 作用域筛选链（P-20261003-99）：「全部」复位 + 五作用域点选（再点已选
             同复位）；与上方文本过滤 AND 叠加，选中态高亮给足操作反馈 -->
        <div
          class="sc-help-scopes"
          role="group"
          :aria-label="t('shortcuts.scopeFilterLabel')"
        >
          <button
            type="button"
            class="sc-help-scope-chip"
            :class="{ active: scopeFilter === '' }"
            data-scope="all"
            @click="scopeFilter = ''"
          >
            {{ t('shortcuts.scopeAll') }}
          </button>
          <button
            v-for="s in SCOPES"
            :key="s"
            type="button"
            class="sc-help-scope-chip"
            :class="{ active: scopeFilter === s }"
            :data-scope="s"
            @click="scopeFilter = scopeFilter === s ? '' : s"
          >
            {{ scopeLabels[s] }}
          </button>
        </div>
      </div>
      <div class="sc-help-body">
        <div
          v-if="filteredGroups.length === 0"
          class="sc-help-empty"
        >
          {{ t('shortcuts.filterEmpty') }}
        </div>
        <section
          v-for="g in filteredGroups"
          :key="g.title"
          class="sc-help-group"
        >
          <div class="sc-help-group-title">
            {{ g.title }}
          </div>
          <div
            v-for="item in g.items"
            :key="item.desc"
            class="sc-help-row"
          >
            <span class="sc-help-desc">
              {{ item.desc }}
              <!-- 作用域徽标：生效条件一眼可辨（分组是功能域、徽标是生效域，二者正交） -->
              <span
                class="sc-help-scope"
                :data-scope="item.scope"
              >{{ scopeLabels[item.scope] }}</span>
            </span>
            <span class="sc-help-keys">
              <kbd
                v-for="k in capsOf(item)"
                :key="k"
              >{{ k }}</kbd>
            </span>
          </div>
        </section>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.sc-help {
  width: 560px;
  max-width: 92vw;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.sc-help-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-default);
}
.sc-help-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.sc-help-close {
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
}
.sc-help-close:hover { color: var(--text-primary); }
.sc-help-filter {
  padding: 10px 16px 0;
}
/* 作用域筛选链（P-20261003-99）：紧贴过滤框下方，胶囊 chip 可换行（窄窗不溢出） */
.sc-help-scopes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding-top: 8px;
}
.sc-help-scope-chip {
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 18px;
  padding: 1px 10px;
  cursor: pointer;
}
.sc-help-scope-chip:hover {
  color: var(--text-primary);
  border-color: var(--text-tertiary);
}
.sc-help-scope-chip.active {
  color: var(--accent-blue);
  border-color: var(--accent-blue);
  background: var(--bg-hover);
}
.sc-help-empty {
  padding: 18px 0 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}
.sc-help-body {
  padding: 8px 16px 14px;
  overflow-y: auto;
}
.sc-help-group-title {
  margin: 12px 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}
.sc-help-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--text-body);
}
/* 作用域徽标（P-20261003-99）：描述尾随的小胶囊，弱化于键帽（生效条件是
   辅助信息，键位是主信息），颜色全走主题变量不引入新语义色 */
.sc-help-scope {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border: 1px solid var(--border-default);
  border-radius: 999px;
  background: var(--bg-hover);
  font-size: 10px;
  line-height: 15px;
  color: var(--text-tertiary);
  vertical-align: 1px;
  white-space: nowrap;
}
.sc-help-keys { display: inline-flex; gap: 4px; }
.sc-help-keys kbd {
  padding: 1px 6px;
  border: 1px solid var(--border-default);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg-hover);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-secondary);
}
</style>
