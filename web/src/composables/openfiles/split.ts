/**
 * useOpenFiles 域拆分（P-20261003-98）：分屏双组域（P-13 + P-20261002-93/94/38）。
 * 开合/切换收口与跨组拖签编排。从 useOpenFiles.ts 原地迁出，行为零变化。
 */
import { nextTick } from 'vue'
// 远程伪路径判定（P-20261004-137）：分屏打开守卫对远程签放行
import { isRemoteEditorPath } from '../../utils/remoteEditorPath'
// 跨组拖签移动的视图快照迁移（P-20261003-38）：零依赖注册表，monaco.Uri 推导
// 留在编辑器侧（懒加载约束，monacoModelOpenSet 同款模式），主 chunk 不拖 monaco
import { moveMonacoViewStateBetweenGroups } from '../../views/editor/monacoViewStateMoves'
import type { OpenFilesCtx } from './context'
import type { SplitDirection } from './types'

export function createSplit(ctx: OpenFilesCtx): void {
  const splitOpen = ctx.splitOpen
  const activeGroup = ctx.activeGroup
  const splitDirection = ctx.splitDirection

  // --- 分屏（双组 MVP） ---
  /** 在分屏组打开文件：先置 splitOpen 并把活跃组切到分屏组（视线跟随新内容），
   *  随后走 openFileInto 既有链路（组 0 已有 → 共享对象；已开 → 激活；否则新加载）。
   *  方向（P-20261005-230）：显式传入时落该方向（「在右侧/下方分屏打开」对文案
   *  承诺负责）；缺省时已开分屏保持当前方向（quick-open/树右键往现有对照组加签
   *  不惊动布局），未开则落横向（P-13「右侧」既有语义，关屏后无方向重开也走此路） */
  async function openInSplit(file: { path: string; name: string }, direction?: SplitDirection) {
    if (direction) splitDirection.value = direction
    else if (!splitOpen.value) splitDirection.value = 'horizontal'
    splitOpen.value = true
    activeGroup.value = 1
    await ctx.openFileInto(1, file)
  }
  ctx.openInSplit = openInSplit

  /** 通过路径字符串在分屏打开（方向语义同 openInSplit） */
  ctx.openInSplitByPath = async function openInSplitByPath(filePath, direction) {
    // 远程伪路径不属项目上下文（openFileByPath 同口径，P-20261004-137）：
    // Quick Open 远程条目 Ctrl+Enter 同样可进分屏对照；本地路径维持原守卫
    if (!ctx.projectStore.currentProjectId && !isRemoteEditorPath(filePath)) return
    const name = filePath.split('/').pop() || filePath
    await openInSplit({ path: filePath, name }, direction)
  }

  /** 分屏组清单恢复（P-20261002-94）：boot 按持久化路径批量开进分屏组。
   *  串行约束由调用方（useLayoutBootstrap）保证——主组 opens 全部落地后才调，
   *  主组占位先行使共享对象复用生效，不会双组建 model。清单恢复属「现场还原」
   *  而非用户新开动作：直写 splitOpen + openFileInto，不动 activeGroup（焦点
   *  留在主组，与既有开合恢复语义一致）。已删/不可开文件静默跳过（silent 打开，
   *  不逐文件弹拦截器错误），统一一条降级 toast 汇报数量；活跃位按 activeFile
   *  落（不可恢复 = 保持最后打开位） */
  ctx.restoreSplitFromPaths = async function restoreSplitFromPaths(paths, activeFile) {
    if (paths.length === 0) return
    splitOpen.value = true
    let failed = 0
    for (const p of paths) {
      const name = p.split('/').pop() || p
      await ctx.openFileInto(1, { path: p, name }, { silent: true })
      // 打不开（已删/超限拒开）：占位已被摘除——按此计数（共享对象在任一组即算恢复）
      if (!ctx.findOpenFile(p)) failed++
    }
    if (failed > 0) ctx.message.warning(ctx.t('layout.splitRestoreUnavailable', { n: String(failed) }))
    if (activeFile) {
      const g1 = ctx.groups.value[1]!
      const idx = g1.files.findIndex(f => f.path === activeFile)
      if (idx >= 0) g1.activeIndex = idx
    }
  }

  /** 关闭分屏：组 1 文件并回组 0 尾部（组 0 已有的路径是同一共享对象，跳过防重），
   *  组 1 清空复位、活跃组回组 0 */
  function closeSplit() {
    const g0 = ctx.groups.value[0]!
    const g1 = ctx.groups.value[1]!
    const g0Paths = new Set(g0.files.map(f => f.path))
    for (const f of g1.files) {
      if (!g0Paths.has(f.path)) g0.files.push(f)
    }
    g1.files = []
    g1.activeIndex = -1
    splitOpen.value = false
    if (activeGroup.value === 1) activeGroup.value = 0
    if (g0.activeIndex >= g0.files.length) g0.activeIndex = g0.files.length - 1
  }
  ctx.closeSplit = closeSplit

  /** 跨组拖签移动/复制（P-20261003-38）：EditorGroupPane 落对侧组经 emit 链转调。
   *  copy=false（默认）为移动语义：同一 OpenFile 对象原样迁组——内容/脏态/undo
   *  栈不经任何重载自然延续；copy=true（Alt 修饰）只开不关：共享对象两组成签
   *  （openInSplit 同链路）。视图快照（滚动/光标）随签迁移：源组编辑器切走/
   *  卸载时落下的实时快照先落源组桶，再整条搬到目标组桶。
   *  源组收组沿用既有规则：组 1 搬空即 closeSplit（组 0 永不收）。
   *  时序说明：摘源组与落目标组分两段渲染，但两段都由微任务衔接（nextTick），
   *  中间无绘制帧，肉眼原子；分段是为了让源组的实时快照先于目标组恢复落桶 */
  ctx.moveTabToGroup = async function moveTabToGroup(fromGi, path, toGi, copy = false) {
    if (fromGi === toGi) return
    const from = ctx.groupAt(fromGi)
    const idx = from.files.findIndex(f => f.path === path)
    if (idx < 0) return
    const file = from.files[idx]!
    if (copy) {
      // 目标组已开（共享对象下同路径至多一份，理论不可达）则仅激活
      activeGroup.value = toGi
      await ctx.openFileInto(toGi, file)
      return
    }
    // 先摘源组：不经未保存确认（对象即将在目标组复生，内容不丢）；不入关闭栈
    //（目标组马上还开着，「关闭」不成立，pushClosedFileFromGroup 语义同款）
    from.files.splice(idx, 1)
    if (from.activeIndex >= from.files.length) from.activeIndex = from.files.length - 1
    else if (from.activeIndex > idx) from.activeIndex--
    else if (from.activeIndex === idx) from.activeIndex = Math.min(idx, from.files.length - 1)
    if (fromGi === 1 && splitOpen.value && from.files.length === 0) closeSplit()
    // 等源组编辑器把该文件的实时视图状态快照进源组桶（切 tab 走 path watcher、
    // 组空走 onBeforeUnmount，都是本 tick 渲染的副产物）
    await nextTick()
    moveMonacoViewStateBetweenGroups(fromGi, toGi, path)
    // 同一对象直插目标组（openFileInto 的共享分支要求对象仍在某组，此处已摘除；
    // 直插同时保证脏内容/undo 不经任何重载）。同路径已在目标组理论上不可达
    //（全组单对象不变量），命中仅激活防御
    const g = ctx.groupAt(toGi)
    const existIdx = g.files.findIndex(f => f.path === path)
    if (existIdx >= 0) {
      g.activeIndex = existIdx
    } else {
      g.files.push(file)
      g.activeIndex = g.files.length - 1
    }
    activeGroup.value = toGi
  }

  /** 分屏键盘开关（Ctrl/Cmd+\，P-20261002-93 对标 VS Code split editor）：
   *  未分屏时以活跃组当前文件开右侧分屏（与「在右侧分屏打开」同链路 openInSplit），
   *  已分屏时关闭分屏（同「关闭分屏」链路 closeSplit）；无活跃文件（欢迎页/空组）
   *  时 no-op——分屏必须有内容一侧。显式落横向：键位文案承诺「右侧」，纵向开着时
   *  关屏再开仍回 P-13 既有形态 */
  ctx.toggleSplit = async function toggleSplit() {
    if (splitOpen.value) {
      closeSplit()
      return
    }
    const f = ctx.currentFile.value
    if (f) await openInSplit(f, 'horizontal')
  }

  /** 下方分屏/方向切换（P-20261005-230，VS Code orthogonal split 对称，键位走
   *  keymap splitDown）：三态与终端 splitTab toggle 语义同构——未分屏以活跃文件
   *  开纵向分屏；已开异方向（横向）切纵向——双组仅排列轴翻转，两组清单/活跃位/
   *  Monaco 实例零重建（对照位原样保留）；同向（纵向）再按取消拆分。无活跃文件
   *  未分屏时 no-op（同 toggleSplit 门） */
  ctx.splitDown = async function splitDown() {
    if (splitOpen.value) {
      if (splitDirection.value === 'vertical') closeSplit()
      else splitDirection.value = 'vertical'
      return
    }
    const f = ctx.currentFile.value
    if (f) await openInSplit(f, 'vertical')
  }

  /** 切换活跃编辑器组（Ctrl/Cmd+Shift+\，0<->1）：未分屏时组 1 未渲染，
   *  no-op——把活跃组指到不可见空组会让 currentFile 悬空 */
  ctx.focusOtherGroup = function focusOtherGroup() {
    if (!splitOpen.value) return
    activeGroup.value = activeGroup.value === 0 ? 1 : 0
  }
}
