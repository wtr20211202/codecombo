<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { NIcon } from 'naive-ui'
import {
  AddOutline, SettingsOutline, EllipsisHorizontalOutline, CloseOutline,
} from '@vicons/ionicons5'
import InstanceSwitcher from '@/components/instance/InstanceSwitcher.vue'
import { panelList, moveRailPanel, type PanelDef } from '@/panels/registry'
import { usePanelLayout } from '@/composables/usePanelLayout'
import { useLayoutLockStore } from '@/stores/layoutLock'
import { useI18n } from '@/composables/useI18n'
import { useNarrowLayout } from '@/composables/useNarrowLayout'
import { SELECTION_DRAG_SPRING_EVENT } from '@/utils/selectionDrag'

const { t } = useI18n()
const { narrow } = useNarrowLayout()
const layout = usePanelLayout()

// 活动栏按钮来自面板注册表（web/src/panels/registry.ts）——
// 新增面板只需注册 PanelDef，不再在此硬编码按钮。
// computed 而非 setup 期一次性取表：bootstrap 异步恢复的手动序（P-20261003-252）
// 晚于本组件 setup 落地，静态值会展示陈旧顺序直到下次挂载
const railButtons = computed(() => panelList('rail-top'))

// ── 选区拖拽 spring-open（P-20261003-162）──────────────────────────
// 编辑器选区 Alt+拖拽悬停 rail 按钮 400ms 时，拖拽源派发 SELECTION_DRAG_SPRING_EVENT
// （detail.id = 面板 id）；本组件查注册表执行该面板的 onSelectionDragSpring。
// 职责留在注册表：新增可 spring 的面板只加一个回调字段，活动栏零硬编码。
function onSelectionDragSpring(e: Event): void {
  const id = (e as CustomEvent<{ id?: string }>).detail?.id
  if (!id) return
  railButtons.value.find(p => p.id === id)?.onSelectionDragSpring?.()
}
onMounted(() => window.addEventListener(SELECTION_DRAG_SPRING_EVENT, onSelectionDragSpring))
onBeforeUnmount(() => window.removeEventListener(SELECTION_DRAG_SPRING_EVENT, onSelectionDragSpring))

defineProps<{ showInstanceDetail: boolean }>()
const emit = defineEmits<{ addProject: []; openSettings: []; sessions: []; fleet: []; notify: []; 'update:showInstanceDetail': [v: boolean] }>()

// ── 图标拖拽重排（P-20261003-252）：拖到目标图标 = 移到其前（VS Code 活动栏
// 惯例），顺序经注册表 moveRailPanel 落 uiState railOrder 即时持久。布局锁定
// （P-20261003-180）经 interceptDrag 在 dragstart 短路——拖拽不启动、无拖影，
// 点击切面板与键盘直达不受影响（TerminalTabbar tab 重排同款手势语义）
const dragId = ref('')
const overId = ref('')

function onRailDragStart(p: PanelDef, e: DragEvent): void {
  if (useLayoutLockStore().interceptDrag(e)) return
  dragId.value = p.id
  // Firefox 需 dataTransfer 有数据才启动拖拽；drop 判定只认组件内 dragId 状态，
  // 该值不参与语义（headless/合成事件里 dropEffect 赋值不生效，同 TerminalTabbar 教训）
  e.dataTransfer?.setData('text/plain', p.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onRailDragOver(p: PanelDef, e: DragEvent): void {
  if (!dragId.value || p.id === dragId.value) return
  e.preventDefault() // 允许在此目标上 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  overId.value = p.id
}
function onRailDragLeave(p: PanelDef): void {
  if (overId.value === p.id) overId.value = ''
}
function onRailDrop(p: PanelDef): void {
  if (dragId.value && p.id !== dragId.value) moveRailPanel(dragId.value, p.id)
  overId.value = ''
}
function onRailDragEnd(): void {
  dragId.value = ''
  overId.value = ''
}

// ── 窄屏底部切换器（P-20261019-7）──────────────────────────────────
// 桌面左侧 44px 竖栏在手机上只剩图标、挤占编辑器宽度；≤700px 改为底部
// 横条：只留三个高频入口（文件/提交/终端）+「更多」抽屉。其余面板仍由
// 注册表驱动（registry 是唯一数据源），不做第二套硬编码清单。
const NARROW_PRIMARY_IDS = ['files', 'changes', 'terminal'] as const

const narrowPrimaryPanels = computed(() => {
  const byId = new Map(panelList('rail-top').map(p => [p.id, p]))
  return NARROW_PRIMARY_IDS
    .map(id => byId.get(id))
    .filter((p): p is PanelDef => !!p)
})

const narrowMorePanels = computed(() =>
  panelList('rail-top').filter(p => !(NARROW_PRIMARY_IDS as readonly string[]).includes(p.id)),
)

const sheetOpen = ref(false)

function panelLabel(p: PanelDef): string {
  return p.titleKey ? t(p.titleKey) : p.id
}

/** 窄屏底栏入口：单栏形态下同一时间只留一个覆盖层——打开侧栏 drawer 前先
 *  收底栏抽屉，打开终端抽屉前先收侧栏 drawer；同一面板再点是既有 toggle
 *  收起语义（实测：终端开着点「项目文件」时若只叠 drawer，选完文件仍被
 *  终端盖住，观感等同没打开） */
function onNarrowPrimaryPanel(p: PanelDef): void {
  if (p.active?.()) {
    p.onClick?.()
    return
  }
  if (p.id === 'files' || p.id === 'changes') {
    if (layout.showBottomPanel.value) layout.showBottomPanel.value = false
    if (layout.showSidePanel.value) layout.showSidePanel.value = false
  } else if (p.id === 'terminal') {
    if (layout.showSidePanel.value) layout.showSidePanel.value = false
    if (layout.showBottomPanel.value) layout.showBottomPanel.value = false
  }
  p.onClick?.()
}

// 抽屉里点面板：先收起抽屉再执行注册的 onClick（onClick 内部可能打开
// 侧栏 drawer/主区视图；抽屉的遮罩不挡操作）。与底栏入口同纪律：目标区域
// 外的覆盖层先收，避免主区视图被终端/侧栏盖住
function onSheetPanel(p: PanelDef): void {
  sheetOpen.value = false
  if (p.controls === 'side-panel') {
    if (layout.showBottomPanel.value) layout.showBottomPanel.value = false
  } else if (p.id === 'git' || p.id === 'terminal') {
    if (layout.showSidePanel.value) layout.showSidePanel.value = false
  } else {
    if (layout.showSidePanel.value) layout.showSidePanel.value = false
    if (layout.showBottomPanel.value) layout.showBottomPanel.value = false
  }
  p.onClick?.()
}

function onSheetAddProject(): void {
  sheetOpen.value = false
  emit('addProject')
}

function onSheetSettings(): void {
  sheetOpen.value = false
  emit('openSettings')
}

function onSheetKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && sheetOpen.value) sheetOpen.value = false
}
onMounted(() => window.addEventListener('keydown', onSheetKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onSheetKeydown))
</script>

<template>
  <!-- 单一根节点：父级 Layout 的 scoped .ide-rail（宽度/order）依赖子组件
       根元素继承父 scope id——多根片段会静默失去该规则，故桌面/窄屏分支
       与 Teleport 都收在同一个 .ide-rail 根内 -->
  <div
    class="ide-rail"
    :class="{ 'ide-rail-narrow': narrow }"
    role="navigation"
    :aria-label="t('layout.activityBar')"
  >
    <!-- 窄屏底部切换器（P-20261019-7）：高频三入口 + 更多抽屉。
         按钮 data-testid 与桌面 rail 同源（rail-files/rail-changes/rail-terminal），
         e2e 与命令面板的既有锚点不因形态切换而分叉 -->
    <template v-if="narrow">
      <button
        v-for="p in narrowPrimaryPanels"
        :key="p.id"
        class="narrow-rail-btn"
        :class="{ active: p.active?.() }"
        :data-testid="'rail-' + p.id"
        :title="panelLabel(p)"
        :aria-label="panelLabel(p)"
        :aria-expanded="p.active?.() ? 'true' : 'false'"
        :aria-controls="p.controls"
        @click="onNarrowPrimaryPanel(p)"
      >
        <NIcon size="20">
          <component :is="p.icon" />
        </NIcon>
        <span class="narrow-rail-label">{{ panelLabel(p) }}</span>
      </button>
      <button
        class="narrow-rail-btn"
        data-testid="rail-more"
        :title="t('layout.narrowMore')"
        :aria-label="t('layout.narrowMore')"
        :aria-expanded="sheetOpen ? 'true' : 'false'"
        @click="sheetOpen = true"
      >
        <NIcon size="20" data-icon-action="common.more">
          <EllipsisHorizontalOutline />
        </NIcon>
        <span class="narrow-rail-label">{{ t('layout.narrowMore') }}</span>
      </button>
    </template>

    <template v-else>
      <div class="rail-instance">
        <InstanceSwitcher
          :show-detail="showInstanceDetail"
          @expand="$emit('update:showInstanceDetail', true)"
          @collapse="$emit('update:showInstanceDetail', false)"
          @sessions="$emit('sessions')"
          @fleet="$emit('fleet')"
          @notify="$emit('notify')"
        />
      </div>
      <div class="rail-top">
        <button
          v-for="p in railButtons"
          :key="p.id"
          class="rail-btn"
          :data-testid="'rail-' + p.id"
          :class="{ active: p.active?.(), 'rail-dragging': dragId === p.id, 'rail-drop-target': overId === p.id && dragId !== p.id }"
          :title="p.titleKey ? t(p.titleKey) : p.id"
          :aria-label="p.titleKey ? t(p.titleKey) : p.id"
          :aria-expanded="p.active?.() ? 'true' : 'false'"
          :aria-controls="p.controls"
          :data-sc-selection-spring="p.onSelectionDragSpring ? p.id : undefined"
          draggable="true"
          @click="p.onClick?.()"
          @dragstart="onRailDragStart(p, $event)"
          @dragover="onRailDragOver(p, $event)"
          @dragleave="onRailDragLeave(p)"
          @drop.prevent="onRailDrop(p)"
          @dragend="onRailDragEnd"
        >
          <NIcon size="20">
            <component :is="p.icon" />
          </NIcon>
        </button>
      </div>

      <div class="rail-bottom">
        <button
          class="rail-btn"
          data-testid="rail-add-project"
          :title="t('layout.addProject')"
          :aria-label="t('layout.addProject')"
          @click="emit('addProject')"
        >
          <NIcon size="18" data-icon-action="common.new">
            <AddOutline />
          </NIcon>
        </button>
        <button
          class="rail-btn"
          data-testid="rail-settings"
          :title="t('layout.settings')"
          :aria-label="t('layout.settings')"
          @click="emit('openSettings')"
        >
          <NIcon size="18">
            <SettingsOutline />
          </NIcon>
        </button>
      </div>
    </template>

    <!-- 窄屏「更多」抽屉：其余 rail 面板 + 添加项目/设置 + 实例切换。
         Teleport 到 body，避免被 .ide-main 的 overflow 裁剪 -->
    <Teleport to="body">
      <Transition name="narrow-sheet">
        <div
          v-if="narrow && sheetOpen"
          class="narrow-sheet-mask"
          data-testid="rail-more-sheet"
          @click.self="sheetOpen = false"
        >
          <div
            class="narrow-sheet"
            role="dialog"
            aria-modal="true"
            :aria-label="t('layout.narrowPanels')"
          >
            <div class="narrow-sheet-head">
              <span class="narrow-sheet-title">{{ t('layout.narrowPanels') }}</span>
              <button
                class="narrow-sheet-close"
                :title="t('common.close')"
                :aria-label="t('common.close')"
                @click="sheetOpen = false"
              >
                <NIcon size="16">
                  <CloseOutline />
                </NIcon>
              </button>
            </div>
            <div class="narrow-sheet-grid">
              <button
                v-for="p in narrowMorePanels"
                :key="p.id"
                class="narrow-sheet-item"
                :class="{ active: p.active?.() }"
                :data-testid="'sheet-' + p.id"
                :title="panelLabel(p)"
                :aria-label="panelLabel(p)"
                @click="onSheetPanel(p)"
              >
                <NIcon size="20">
                  <component :is="p.icon" />
                </NIcon>
                <span class="narrow-sheet-item-label">{{ panelLabel(p) }}</span>
              </button>
            </div>
            <div class="narrow-sheet-actions">
              <div class="narrow-sheet-instance">
                <span class="narrow-sheet-action-label">{{ t('layout.narrowInstance') }}</span>
                <InstanceSwitcher
                  :show-detail="showInstanceDetail"
                  @expand="$emit('update:showInstanceDetail', true)"
                  @collapse="$emit('update:showInstanceDetail', false)"
                  @sessions="$emit('sessions')"
                  @fleet="$emit('fleet')"
                  @notify="$emit('notify')"
                />
              </div>
              <button
                class="narrow-sheet-action"
                data-testid="sheet-add-project"
                @click="onSheetAddProject"
              >
                <NIcon size="16" data-icon-action="common.new">
                  <AddOutline />
                </NIcon>
                <span>{{ t('layout.addProject') }}</span>
              </button>
              <button
                class="narrow-sheet-action"
                data-testid="sheet-settings"
                @click="onSheetSettings"
              >
                <NIcon size="16">
                  <SettingsOutline />
                </NIcon>
                <span>{{ t('layout.settings') }}</span>
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.ide-rail {
  width: 44px;
  background: var(--bg-panel);
  border-right: 1px solid var(--bg-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  flex-shrink: 0;
}
.rail-instance { padding: 6px 6px 2px; display: flex; justify-content: center; flex-shrink: 0; }
.rail-top {
  padding: var(--space-2) 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  flex: 1;
}
.rail-bottom {
  padding: var(--space-2) 0 var(--space-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
/* 热区放大后同步补间距（P-20261019-5）：coarse 档按钮盒 40px，2px 缝会让
   相邻图标命中区贴面——抬到 6px，竖排总量仍在侧栏高度内；实例入口同在
   44px 宽活动栏内，coarse 档 40px 盒需把左右 6px 内边距收到 2px 才不溢出 */
@media (pointer: coarse) {
  .rail-top, .rail-bottom { gap: 6px; }
  .rail-instance { padding-left: 2px; padding-right: 2px; }
}
.rail-btn {
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 6px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: color var(--motion-base);
  /* 最小热区（P-20261019-5）：图标视觉尺寸（20/18px）不动，按钮盒统一走
     全局底线（fine 28 / coarse 40）；活动栏 44px 宽可容纳 coarse 档 40px */
  min-width: var(--hit-target-min, 28px);
  min-height: var(--hit-target-min, 28px);
}
.rail-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.rail-btn.active { color: var(--accent-blue); }
.rail-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  background: var(--accent-blue);
  border-radius: 0 2px 2px 0;
}
/* 拖拽重排（P-20261003-252）反馈：源半透明、落点目标上缘插入线（insert-before
 * 语义的可视锚，颜色走主题变量） */
.rail-btn.rail-dragging { opacity: 0.4; }
.rail-btn.rail-drop-target::after {
  content: '';
  position: absolute;
  left: 4px;
  right: 4px;
  top: -2px;
  height: 2px;
  background: var(--accent-blue);
  border-radius: 2px;
}

/* ── 窄屏底部切换器（P-20261019-7）──
   层叠优先级用 .ide-rail.ide-rail-narrow 双类压过 layout.css 的 .ide-rail
   （侧栏宽度）与组件自身 v-else 分支的 44px 定宽；横条放在 ide-main 下方
   （layout.css 以 order 控制），高度 52px 给图标+文字两行留位 */
.ide-rail.ide-rail-narrow {
  order: 2;
  width: 100%;
  height: var(--narrow-rail-height, 52px);
  flex-direction: row;
  align-items: stretch;
  justify-content: space-around;
  border-right: none;
  border-top: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
  overflow: hidden;
}
.narrow-rail-btn {
  position: relative;
  flex: 1 1 0;
  min-width: 0;
  min-height: var(--hit-target-min, 28px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: var(--space-1) 2px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-ui);
  cursor: pointer;
  transition: color var(--motion-base), background var(--motion-base);
}
.narrow-rail-btn:hover,
.narrow-rail-btn:active { background: var(--bg-hover); color: var(--text-primary); }
.narrow-rail-btn:focus-visible { outline: 2px solid var(--accent-blue); outline-offset: -2px; }
.narrow-rail-btn.active { color: var(--accent-blue); }
/* 激活指示从桌面左侧竖条翻转为底栏顶部短横线 */
.ide-rail-narrow .narrow-rail-btn.active::before {
  content: '';
  position: absolute;
  left: 50%;
  top: 0;
  width: 24px;
  height: 2px;
  transform: translateX(-50%);
  background: var(--accent-blue);
  border-radius: 0 0 2px 2px;
}
.narrow-rail-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  line-height: 1.2;
  letter-spacing: 0.02em;
}

/* ── 「更多」抽屉（底部行动表）── */
.narrow-sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: flex-end;
  background: var(--overlay-mask);
}
.narrow-sheet {
  width: 100%;
  max-height: 78dvh;
  overflow-y: auto;
  padding: var(--space-3) var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
  background: var(--bg-panel);
  border-top: 1px solid var(--border-default);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  box-shadow: var(--shadow-pop-xl);
}
.narrow-sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: var(--space-2);
}
.narrow-sheet-title {
  font-size: var(--fs-small);
  font-weight: var(--fw-semibold);
  color: var(--text-primary);
}
.narrow-sheet-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--hit-target-min, 28px);
  min-height: var(--hit-target-min, 28px);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.narrow-sheet-close:hover { background: var(--bg-hover); color: var(--text-primary); }
.narrow-sheet-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-2);
}
.narrow-sheet-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 64px;
  padding: var(--space-2) var(--space-1);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-family: var(--font-ui);
  cursor: pointer;
  transition: color var(--motion-base), border-color var(--motion-base);
}
.narrow-sheet-item:hover { color: var(--text-primary); border-color: var(--border-strong); }
.narrow-sheet-item.active { color: var(--accent-blue); border-color: var(--brand-accent); background: var(--brand-accent-soft); }
.narrow-sheet-item-label {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-tiny);
  line-height: 1.3;
}
.narrow-sheet-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-3);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-default);
}
.narrow-sheet-instance,
.narrow-sheet-action {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--hit-target-min, 28px);
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-body);
  font-family: var(--font-ui);
  font-size: var(--fs-small);
  cursor: pointer;
  text-align: left;
}
.narrow-sheet-action:hover { background: var(--bg-hover); color: var(--text-primary); }
.narrow-sheet-action-label { flex: 1; }

/* 抽屉进出场：位移 + 遮罩淡入（时长走 motion token） */
.narrow-sheet-enter-active,
.narrow-sheet-leave-active { transition: opacity var(--motion-base) var(--ease-standard); }
.narrow-sheet-enter-active .narrow-sheet,
.narrow-sheet-leave-active .narrow-sheet { transition: transform var(--motion-base) var(--ease-emphasized); }
.narrow-sheet-enter-from,
.narrow-sheet-leave-to { opacity: 0; }
.narrow-sheet-enter-from .narrow-sheet,
.narrow-sheet-leave-to .narrow-sheet { transform: translateY(100%); }
@media (prefers-reduced-motion: reduce) {
  .narrow-sheet-enter-active .narrow-sheet,
  .narrow-sheet-leave-active .narrow-sheet { transition: none; }
}
</style>
