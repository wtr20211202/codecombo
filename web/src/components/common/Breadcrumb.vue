<script setup lang="ts">
// 编辑器路径面包屑：显示当前文件的路径分段
// 右键菜单支持：复制路径、复制相对路径、在文件树中显示、在此目录打开终端
// 同级导航（P-20261002-128）：非末段（目录段）可点击，弹出该目录单层子项
// （VS Code 式两次点击切深层同级），选目录→文件树定位展开、选文件→打开
import { computed, inject, ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { NIcon } from 'naive-ui'
import { ChevronDownOutline, ChevronForwardOutline, CopyOutline, FolderOpenOutline, DocumentTextOutline, TerminalOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { isUntitledPath, UNTITLED_PATH_PREFIX } from '../../composables/useOpenFiles'
import { isRemoteEditorPath, parseRemoteEditorPath, remoteHostDisplayName } from '../../utils/remoteEditorPath'
import { parseDiffKey } from '../../utils/diffTabKey'
import { INDEX_REF } from '../../utils/changeDiffBaseline'
import { useProjectStore } from '../../stores/project'
import { projectApi } from '../../api/client'
import SymbolCrumb from './SymbolCrumb.vue'

const props = defineProps<{
  /** 完整路径，例如 "src/components/Foo.vue" */
  path?: string
  /** 是否为 diff 视图 */
  isDiff?: boolean
  /** 符号段（P-20261005-195）：光标所在符号祖先链 + 尾段同层符号；
   *  空链 = 无符号 provider（Go 等基础语言）或光标在符号外，不渲染空段 */
  symbolChain?: { name: string; kind: number; line: number }[]
  symbolSiblings?: { name: string; kind: number; line: number }[]
}>()

const emit = defineEmits<{
  (e: 'reveal-in-tree'): void
  /** 符号段同层跳转（P-20261005-195）：目标符号起始行，宿主转编辑器定点 */
  (e: 'symbol-nav', line: number): void
}>()

const { t } = useI18n()

interface Crumb { name: string; path: string; isLast: boolean; isCompare?: boolean; isRemote?: boolean }

// diff 标签伪键解析收口 utils/diffTabKey（与 DiffEditor「在编辑器打开」守卫同一
// 事实源）：伪键整段渲染会把内部符号泄漏给用户，解析为「oldRef ↔ newRef」
// 比较标签 + 真实文件路径分段

// ref 展示：HEAD 有语义保留原样，伪 ref（clipboard=剪贴板内存源）走 i18n 映射，
// 两文件互比伪 ref（cmpto-<encodeURIComponent(基准路径)>@<ts>，P-20261002-75）
// 解码回基准路径，草稿预览伪 ref（draft-<ts>，P-20261004-71）映射为草稿侧标签
// （草稿写入时间提示条已在展示，面包屑不重复），commit sha 截前 8 位（与
// diffOldLabel 同规则）
function shortRef(r: string): string {
  if (r === 'HEAD') return r
  if (r === 'clipboard') return t('changes.clipboard')
  // 索引伪 ref（P-20261004-42 变更基线分流）：暂存区侧标签
  if (r === INDEX_REF) return t('changes.index')
  if (r.startsWith('cmpto-')) {
    const dec = decodeURIComponent(r.slice(6).split('@')[0] || '')
    return dec.split('/').pop() || dec
  }
  if (r.startsWith('draft-')) return t('editor.draft.diffRefLabel')
  return r.slice(0, 8)
}

// 路径分段
const segments = computed(() => {
  if (!props.path) return [] as Crumb[]
  const normalized = props.path.replace(/\\/g, '/')
  // 未命名草稿（P-20261002-24）：path 是 untitled://N 内部键，直接分段渲染会
  // 泄漏内部符号（同 diff: 键同理），整段映射为「草稿 N」显示名
  if (isUntitledPath(normalized)) {
    const n = Number(normalized.slice(UNTITLED_PATH_PREFIX.length)) || 0
    return [{ name: t('editor.untitled.name', { n }), path: '', isLast: true }]
  }
  // 远程伪路径（P-20261003-15）：解析为「主机名（不可导航）+ 远端路径分段」，
  // hostId 不外泄给展示层；同级导航（项目 fileTree 寻址）对远端路径不适用，
  // 全部段标记 isRemote 摘除点击态
  if (isRemoteEditorPath(normalized)) {
    const remote = parseRemoteEditorPath(normalized)
    if (remote) {
      const parts = remote.rpath.split('/').filter(Boolean)
      const segs: Crumb[] = parts.map((name, idx) => ({
        name, path: '', isLast: idx === parts.length - 1, isRemote: true,
      }))
      return [
        { name: remoteHostDisplayName(remote.hostId), path: '', isLast: false, isCompare: true, isRemote: true },
        ...segs,
      ]
    }
  }
  let effective = normalized
  let compareLabel = ''
  if (props.isDiff) {
    const key = parseDiffKey(normalized)
    if (key) {
      effective = key.filePath
      // 两文件互比（cmpto- 伪 ref）：两侧都是工作区文件，右标签取目标文件名
      // （「工作区/短 hash」是 ref 语义，不适用）
      const newLabel = key.oldRef.startsWith('cmpto-')
        ? (key.filePath.split('/').pop() || key.filePath)
        : (key.newRef === 'wt' ? t('changes.working') : shortRef(key.newRef))
      compareLabel = `${shortRef(key.oldRef)} ↔ ${newLabel}`
    }
  }
  const parts = effective.split('/').filter(Boolean)
  let acc = ''
  const segs: Crumb[] = parts.map((name, idx) => {
    acc = acc ? `${acc}/${name}` : name
    return { name, path: acc, isLast: idx === parts.length - 1 }
  })
  return compareLabel ? [{ name: compareLabel, path: '', isLast: false, isCompare: true }, ...segs] : segs
})

// 复制路径用真实文件路径，不暴露内部键
const effectivePath = computed(() => {
  const segs = segments.value.filter(s => !s.isCompare)
  return segs.map(s => s.name).join('/')
})

// 右键菜单
const showMenu = ref(false)
const menuX = ref(0)
const menuY = ref(0)
// 「在此目录打开终端」的目标目录（P-20261005-192）：项目相对路径，'' = 项目根。
// 右键落在目录段 = 该目录；落在其余区域（末段文件名/空白）= 当前文件所在目录
//（VS Code「Open in Integrated Terminal」同款取所在目录语义）。null = 无目标
// （远程伪路径等），菜单隐藏该项
const menuDir = ref<string | null>(null)
// 动作走 Layout 桥（useLayoutBridge provide），与 revealInFileTree 同款可选注入
// ——不在 Layout 树下（单测/独立渲染）时无注入：菜单项整体隐藏而非置灰
const openTerminalInDirAction = inject<((relDir: string) => void) | undefined>('openTerminalInDir', undefined)

function openMenu(e: MouseEvent, segDir?: string) {
  e.preventDefault()
  if (segDir !== undefined) {
    // 目录段右键（onCrumbContextMenu 传入段路径）：非末段即目录，
    // 段 path 即项目相对目录
    menuDir.value = segDir
  } else if (isRemoteEditorPath(props.path?.replace(/\\/g, '/') || '')) {
    // 远程伪路径不在本机项目树内，无「在此打开终端」落点
    menuDir.value = null
  } else {
    // 其余区域 = 当前文件所在目录：倒数第二段（文件在根下/草稿单段 = '' 项目根）
    const segs = segments.value.filter(s => !s.isCompare && !s.isRemote)
    menuDir.value = segs.length >= 2 ? segs[segs.length - 2]!.path : ''
  }
  menuX.value = e.clientX
  menuY.value = e.clientY
  showMenu.value = true
}

function closeMenu() {
  showMenu.value = false
}

function openTerminalHere() {
  if (!openTerminalInDirAction || menuDir.value === null) return
  openTerminalInDirAction(menuDir.value)
  closeMenu()
}

// 目录段右键（P-20261005-192）：非末段目录段拦截并定向该目录；末段文件名/
// 比较标签/远程段放行冒泡给条栏 openMenu（取当前文件所在目录语义）。不能在
// 模板用 `@contextmenu.stop="cond && openMenu(...)"`——.stop 修饰符无论表达式
// 真假都拦截冒泡，末段右键会吞掉条栏菜单
function onCrumbContextMenu(e: MouseEvent, seg: Crumb) {
  if (seg.isLast || seg.isCompare || seg.isRemote || !seg.path) return
  e.stopPropagation()
  openMenu(e, seg.path)
}

function copyFull() {
  if (effectivePath.value) void copyText(effectivePath.value)
  closeMenu()
}

function copyRelative() {
  // 取从最后两个段开始的相对路径（比较标签不参与）
  const segs = segments.value.filter(s => !s.isCompare)
  if (segs.length === 0) return
  const start = Math.max(0, segs.length - 3)
  void copyText(segs.slice(start).map(s => s.name).join('/'))
  closeMenu()
}

function revealInTree() {
  emit('reveal-in-tree')
  closeMenu()
}

// ── 同级导航弹层（P-20261002-128）────────────────────────────
// 动作走 Layout 桥（useLayoutBridge）provide 的两个入口，CommitPanel/CommitDiffFiles
// 同款可选注入——不在 Layout 树下（单测/独立渲染）时降级为 no-op，弹层仍可展示
const revealInFileTreeAction = inject<((path: string) => void) | undefined>('revealInFileTree', undefined)
const openFileInEditorAction = inject<((path: string) => void) | undefined>('openFileInEditor', undefined)

// 弹层子项：服务端 file-tree 已「目录优先 + 名称排序」（tree.go），前端原样消费不二次排序
interface SibEntry { name: string; path: string; isDir: boolean }

const sibSegPath = ref('') // 弹层对应的目录段路径（'' = 关闭）
const sibX = ref(0)
const sibY = ref(0)
const sibEntries = ref<SibEntry[]>([])
const sibLoading = ref(false)

// 可点击段 = 非末段目录（比较标签/末段文件/草稿单段/远程段均不参与）
function isClickable(seg: Crumb): boolean {
  return !seg.isLast && !seg.isCompare && !seg.isRemote
}

// 当前文件的真实相对路径（比较标签不参与）：弹层内高亮命中项
const currentFilePath = computed(() => {
  const segs = segments.value.filter(s => !s.isCompare)
  return segs.length ? segs[segs.length - 1]!.path : ''
})

async function toggleSiblings(seg: Crumb, e: MouseEvent) {
  if (!isClickable(seg)) return
  e.stopPropagation()
  if (sibSegPath.value === seg.path) {
    closeSiblings()
    return
  }
  sibSegPath.value = seg.path
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  // 右缘防溢出：按弹层最大宽度收紧锚点
  sibX.value = Math.max(4, Math.min(rect.left, window.innerWidth - 340))
  sibY.value = rect.bottom + 4
  sibEntries.value = []
  sibLoading.value = true
  const projectId = useProjectStore().currentProjectId
  if (!projectId) {
    sibLoading.value = false
    return
  }
  try {
    const res: any = await projectApi.fileTree(projectId, seg.path)
    // 响应返回时用户已切段/关闭：丢弃过期结果
    if (sibSegPath.value === seg.path) sibEntries.value = (res.data || []) as SibEntry[]
  } catch {
    if (sibSegPath.value === seg.path) sibEntries.value = []
  } finally {
    if (sibSegPath.value === seg.path) sibLoading.value = false
  }
}

function closeSiblings() {
  sibSegPath.value = ''
  sibLoading.value = false
}

function selectSibling(entry: SibEntry) {
  closeSiblings()
  if (entry.isDir) revealInFileTreeAction?.(entry.path)
  else openFileInEditorAction?.(entry.path)
}

function handleClickOutside(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (showMenu.value) {
    // 简单实现：点击不在菜单内即关闭
    const menu = document.querySelector('.breadcrumb-menu')
    if (menu && !menu.contains(target)) closeMenu()
  }
  if (sibSegPath.value) {
    // 点在「本实例」可点击段上交给 toggleSiblings 处理（否则同段「再点收起」会被
    // 先关后开打断）；限定本组件滚动容器——分屏双组各挂一份监听，勿误认他组段
    const sib = document.querySelector('.breadcrumb-sib-menu')
    const ownClickable = !!(target instanceof Element)
      && !!target.closest('.crumb.clickable')
      && !!crumbRef.value?.contains(target)
    if (!(sib && sib.contains(target)) && !ownClickable) closeSiblings()
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && (showMenu.value || sibSegPath.value)) {
    closeMenu()
    closeSiblings()
  }
}

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
})

// 滚动到末尾，确保最后一节可见
const crumbRef = ref<HTMLElement | null>(null)
async function scrollToEnd() {
  await nextTick()
  if (crumbRef.value) crumbRef.value.scrollLeft = crumbRef.value.scrollWidth
}
onMounted(() => scrollToEnd())
// 当 path 变化时滚到末尾
import { watch } from 'vue'
watch(() => props.path, () => scrollToEnd())
</script>

<template>
  <div
    v-if="props.path"
    class="breadcrumb-bar"
    @contextmenu="openMenu"
  >
    <div
      ref="crumbRef"
      class="breadcrumb-scroll"
    >
      <n-icon
        size="11"
        class="breadcrumb-folder-icon"
      >
        <FolderOpenOutline />
      </n-icon>
      <template
        v-for="(seg, idx) in segments"
        :key="idx"
      >
        <span
          class="crumb"
          :class="{ active: seg.isLast, diff: props.isDiff && seg.isLast, compare: seg.isCompare, clickable: isClickable(seg) }"
          :title="seg.isCompare ? undefined : seg.path"
          @click="toggleSiblings(seg, $event)"
          @contextmenu="onCrumbContextMenu($event, seg)"
        >
          <n-icon
            v-if="seg.isLast"
            size="11"
            class="crumb-doc-icon"
          ><DocumentTextOutline /></n-icon>
          <span class="crumb-label">{{ seg.name }}</span>
          <n-icon
            v-if="isClickable(seg)"
            size="9"
            class="crumb-caret"
          ><ChevronDownOutline /></n-icon>
        </span>
        <n-icon
          v-if="!seg.isLast"
          size="10"
          class="crumb-sep"
        >
          <ChevronForwardOutline />
        </n-icon>
      </template>
      <!-- 符号段（P-20261005-195）：路径层之后的符号层，链空不渲染 -->
      <SymbolCrumb
        :chain="symbolChain || []"
        :siblings="symbolSiblings || []"
        @navigate="emit('symbol-nav', $event)"
      />
    </div>

    <!-- 额外操作槽位（由父组件提供，如大纲按钮） -->
    <div
      v-if="$slots.extra"
      class="breadcrumb-extra"
    >
      <slot name="extra" />
    </div>

    <!-- 右键菜单 -->
    <transition name="fade-fast">
      <div
        v-if="showMenu"
        class="breadcrumb-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
      >
        <button
          class="menu-item"
          @click="copyFull"
        >
          <n-icon size="12">
            <CopyOutline />
          </n-icon>
          <span>{{ t('breadcrumb.copyPath') }}</span>
        </button>
        <button
          class="menu-item"
          @click="copyRelative"
        >
          <n-icon size="12">
            <CopyOutline />
          </n-icon>
          <span>{{ t('breadcrumb.copyRelativePath') }}</span>
        </button>
        <div class="menu-divider" />
        <button
          class="menu-item"
          @click="revealInTree"
        >
          <n-icon size="12">
            <FolderOpenOutline />
          </n-icon>
          <span>{{ t('breadcrumb.revealInTree') }}</span>
        </button>
        <!-- 在此目录打开终端（P-20261005-192）：目录段右键 = 该目录；其余区域 =
             当前文件所在目录。动作未注入（非 Layout 树）或无目标（远程伪路径）
             时隐藏整项 -->
        <button
          v-if="openTerminalInDirAction && menuDir !== null"
          class="menu-item"
          data-testid="breadcrumb-open-terminal"
          @click="openTerminalHere"
        >
          <n-icon size="12">
            <TerminalOutline />
          </n-icon>
          <span>{{ t('breadcrumb.openTerminalHere') }}</span>
        </button>
      </div>
    </transition>

    <!-- 同级导航弹层（P-20261002-128）：点目录段列出该目录单层子项，
         目录在前文件在后（服务端序），当前文件命中项高亮 -->
    <transition name="fade-fast">
      <div
        v-if="sibSegPath"
        class="breadcrumb-sib-menu"
        :style="{ left: sibX + 'px', top: sibY + 'px' }"
      >
        <div
          v-if="sibLoading"
          class="sib-hint"
        >
          {{ t('breadcrumb.siblingLoading') }}
        </div>
        <template v-else-if="sibEntries.length">
          <button
            v-for="entry in sibEntries"
            :key="entry.path"
            class="sib-item"
            :class="{ current: entry.path === currentFilePath }"
            :title="entry.path"
            @click="selectSibling(entry)"
          >
            <n-icon
              size="12"
              class="sib-icon"
              :class="{ 'is-dir': entry.isDir }"
            >
              <FolderOpenOutline v-if="entry.isDir" />
              <DocumentTextOutline v-else />
            </n-icon>
            <span class="sib-name">{{ entry.name }}</span>
          </button>
        </template>
        <div
          v-else
          class="sib-hint"
        >
          {{ t('breadcrumb.siblingEmpty') }}
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.breadcrumb-bar {
  position: relative;
  display: flex;
  align-items: center;
  height: 26px;
  padding: 0 12px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 11px;
  user-select: none;
  flex-shrink: 0;
}

.breadcrumb-scroll {
  display: flex;
  align-items: center;
  gap: 3px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
}

.breadcrumb-extra {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  flex-shrink: 0;
}

.breadcrumb-outline-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  width: 22px;
  height: 20px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--motion-base);
}
.breadcrumb-outline-btn:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.breadcrumb-scroll::-webkit-scrollbar {
  display: none;
}

.breadcrumb-folder-icon {
  color: var(--text-muted);
  flex-shrink: 0;
  margin-right: 2px;
}

.crumb {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 5px;
  border-radius: 3px;
  color: var(--text-muted);
  cursor: default;
  white-space: nowrap;
  flex-shrink: 0;
  font-family: var(--font-mono);
  transition: background var(--motion-fast);
}

.crumb:hover {
  background: var(--bg-hover);
}

.crumb.active {
  color: var(--text-primary);
  font-weight: 500;
}

.crumb.diff.active {
  color: var(--brand-accent);
}

/* diff 标签的「oldRef ↔ newRef」比较标签：品牌色弱化呈现，非导航段 */
.crumb.compare {
  color: var(--brand-accent);
  opacity: 0.75;
}
.crumb.compare + .crumb-sep {
  color: var(--brand-accent);
  opacity: 0.5;
}

.crumb-doc-icon {
  color: var(--brand-accent);
}

.crumb-label {
  font-size: 11px;
}

.crumb-sep {
  color: var(--text-dim);
  flex-shrink: 0;
  opacity: 0.7;
}

/* 可点击段（同级导航）：指针手势 + hover 显 ▾ 提示可展开 */
.crumb.clickable {
  cursor: pointer;
}
.crumb.clickable:hover {
  color: var(--text-body);
}
.crumb-caret {
  color: var(--text-dim);
  opacity: 0;
  transition: opacity var(--motion-base);
}
.crumb.clickable:hover .crumb-caret {
  opacity: 1;
}

/* 同级导航弹层 */
.breadcrumb-sib-menu {
  position: fixed;
  z-index: 9999;
  min-width: 200px;
  max-width: 340px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-strong);
  padding: 4px 0;
}

.sib-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-body);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-mono);
  transition: background var(--motion-fast);
}

.sib-item:hover {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}

/* 当前打开文件命中项：品牌色标记（VS Code 式当前位置高亮） */
.sib-item.current {
  color: var(--brand-accent);
  font-weight: 500;
}

.sib-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}
.sib-icon.is-dir {
  color: var(--accent-blue-light);
}

.sib-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sib-hint {
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-muted);
}

/* 右键菜单 */
.breadcrumb-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  box-shadow: var(--shadow-strong);
  padding: 4px 0;
}

.menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  color: var(--text-body);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  font-family: var(--font-ui);
  transition: background var(--motion-fast);
}

.menu-item:hover {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}

.menu-divider {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}

.fade-fast-enter-active,
.fade-fast-leave-active {
  transition: opacity var(--motion-base), transform var(--motion-base);
}

.fade-fast-enter-from,
.fade-fast-leave-to {
  opacity: 0;
  transform: scale(0.96);
}
</style>
