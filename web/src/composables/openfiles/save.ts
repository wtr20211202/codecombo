/**
 * useOpenFiles 域拆分（P-20261003-98）：保存链域——单文件/全部保存、baseHash
 * 冲突检测与三选对话框、远程写回分支（P-20261003-15）、编码重载/转码保存
 * （P-20261002-146）。本地与远程共用 writeOpenFile 单一入口（分流
 * writeRemoteOpenFile），冲突裁决的四条出路（覆盖/读盘/读远端/两侧对比）分别
 * 接本域重读函数与 diff 域对比入口。从 useOpenFiles.ts 原地迁出，行为零变化。
 */
import { h } from 'vue'
import { NButton } from 'naive-ui'
import { useChangesStore } from '../../stores/changes'
import { projectApi, remoteHostApi } from '../../api/client'
import { AppError } from '../../api/error-types'
import {
  isRemoteEditorPath, isSensitiveRemotePath, parseRemoteEditorPath, utf8ToBase64,
} from '../../utils/remoteEditorPath'
import { encodingLabel } from '../../utils/fileEncoding'
import { OPS_FILES_SAVED } from '../../utils/opsEvents'
import { confirmDialog } from '../useDialog'
// 全部保存链格式化前置（P-20261004-139）：零依赖注册表（monacoViewStateMoves
// 同款跨层模式），「格式化文档」实现由 MonacoEditor 挂载期反向注册
import { runEditorFormatter } from '../../views/editor/editorFormatters'
import type { OpenFilesCtx } from './context'
import { isUntitledPath } from './types'
import type { OpenFile, WriteFileResult } from './types'

export function createSave(ctx: OpenFilesCtx): void {
  const { projectStore, notificationStore, message, dialog } = ctx

  /** 保存当前文件 */
  ctx.saveCurrentFile = async function saveCurrentFile() {
    const file = ctx.currentFile.value
    if (!file) return
    // 未命名草稿拦截：untitled://N 非真实路径，不能走 writeOpenFile，转另存为
    if (isUntitledPath(file.path)) {
      await ctx.saveUntitledAs(file)
      return
    }
    // 远程伪路径不经项目守卫（寻址远端主机与项目正交），writeOpenFile 内部分流
    if (!projectStore.currentProjectId && !isRemoteEditorPath(file.path)) return
    // 先捕获文件对象再异步：对话框悬挂期间用户切 tab 不串写别的文件
    //（共享对象模型下同路径全工程一份，按对象写回天然跨组同步）
    await ctx.writeOpenFile(file)
  }

  /** 全部保存（P-20261002-101）：未保存清单（getUnsavedFiles，双组覆盖 + 共享对象
   *  去重）串行逐个保存——await 链保证写请求不并发，409 冲突对话框 / untitled
   *  另存为对话框逐个裁决不互相打架；单个失败累积计数后继续下一个。
   *  完成 toast 汇总（成功 n / 失败 m），清单为空静默返回。
   *  成败以保存后脏位判定：成功路径 originalContent 对齐内存内容；409 待裁决、
   *  写失败、另存为取消均保持脏位 → 计失败（用户处置后可再次触发补存）。
   *  格式化前置（P-20261004-139，对标 VS Code Save All 逐文件格式化）：每个脏
   *  文件保存前查格式化注册表 await 调用——文件正被 Monaco 编辑器显示且开关
   *  开启才真格式化（判定在编辑器侧实现内，与单文件链 formatThenSave 同源），
   *  后台标签/diff/无 formatter 语言 = 注册表 no-op 直接保存。格式化编辑事务经
   *  onDidChangeModelContent → updateContent 同步落 file.content，保存链读到的
   *  即格式化后内容；失败在实现内降级不阻断保存。afterDelay 自动保存不经本链
   *  维持不格式化（VS Code 同语义） */
  ctx.saveAllFiles = async function saveAllFiles() {
    const unsaved = ctx.getUnsavedFiles().slice()
    if (unsaved.length === 0) return { saved: 0, failed: 0 }
    let saved = 0
    let failed = 0
    for (const file of unsaved) {
      await runEditorFormatter(file.path)
      if (isUntitledPath(file.path)) await ctx.saveUntitledAs(file)
      else await ctx.writeOpenFile(file, { toast: false })
      if (file.content !== file.originalContent) failed++
      else saved++
    }
    if (failed > 0) {
      message.warning(ctx.t('layout.saveAll.doneWithFail', { saved: String(saved), failed: String(failed) }))
    } else {
      message.success(ctx.t('layout.saveAll.done', { saved: String(saved) }))
    }
    return { saved, failed }
  }

  /** 单文件保存流。带 baseHash（force=false）= 冲突检测模式：409 时弹三选；
   *  force = 用户在冲突对话框里明确选择覆盖后的重试，不带 baseHash 直写；
   *  toast=false（全部保存批量链 P-20261002-101 用）：成功提示由批量汇总 toast
   *  代替，防 N 个文件 N+1 条 toast 刷屏。失败路径提示不受影响——汇总 toast 只有
   *  计数，哪个文件失败仍需就地可见。
   *  返回 WriteFileResult：自动保存链（runAutoSave）据此在 conflict 时熔断重试。
   *  远程文件（remote: 伪路径）分流至 writeRemoteOpenFile（保存链复用同一入口，
   *  saveAllFiles/编码徽标等既有调用方零改动覆盖远程签） */
  ctx.writeOpenFile = async function writeOpenFile(file, opts): Promise<WriteFileResult> {
    if (isRemoteEditorPath(file.path)) return writeRemoteOpenFile(file, opts)
    if (!projectStore.currentProjectId) return 'error'
    const projectId = projectStore.currentProjectId
    const detect = !opts?.force && !!file.baseHash
    try {
      const res: any = await projectApi.writeFile(
        projectId, file.path, file.content,
        // 冲突检测模式静默发请求：409 是预期分支（弹处置对话框），不能让
        // 拦截器再叠一条错误 toast；非检测模式保持历史行为（拦截器弹错误文案）
        detect ? { silent: true } : { errorLabel: 'file.saveFail' },
        file.encoding,
        detect ? file.baseHash : undefined,
      )
      applySaved(file, res)
      if (opts?.toast !== false) message.success(ctx.t('layout.fileSaved'))
      // 保存落盘后刷新变更计数：与终端 OSC 'D' 触发同语义——否则状态栏
      // 变更数滞留至窗口重新聚焦（同窗口编辑保存的场景无其他刷新触发）
      void useChangesStore().fetchStatus(projectId)
      // 保存成功广播（P-20261003-14）：编辑器 gutter 变更条等磁盘状态消费方刷新
      window.dispatchEvent(new CustomEvent(OPS_FILES_SAVED, { detail: { paths: [file.path] } }))
      return 'saved'
    } catch (err) {
      if (detect && isConflictError(err)) {
        showConflictDialog(file)
        return 'conflict'
      }
      // 检测模式请求是 silent 的，拦截器不弹 toast：这里补齐与历史一致的一次
      // 错误提示（文案同 errorLabel 链路），非检测模式拦截器已弹、不重复
      if (detect && err instanceof AppError && err.userMessage) message.error(err.userMessage)
      // 拦截器已写 Console
      notificationStore.add({
        type: 'error',
        category: 'error',
        title: ctx.t('layout.saveFail'),
        body: file.path,
        projectId,
        projectName: projectStore.currentProject?.name,
      })
      return 'error'
    }
  }

  /** 远程文件保存回写链（P-20261003-15）：PUT content 端点 base64 直传字节，
   *  baseHash 冲突检测与本地保存同语义（409 → 三选对话框）；主机不可达类失败
   *  → 离线只读降级（横幅 + 重试，恢复入口可达）。敏感系统路径（/etc /boot）
   *  写入前确认——误覆盖远程系统配置的代价远大于多按一次确认；force（冲突
   *  覆盖重试）不重复确认 */
  async function writeRemoteOpenFile(file: OpenFile, opts?: { force?: boolean; toast?: boolean }): Promise<WriteFileResult> {
    const remote = parseRemoteEditorPath(file.path)
    if (!remote) return 'error'
    if (!opts?.force && isSensitiveRemotePath(remote.rpath)) {
      const ok = await confirmDialog({
        type: 'warning',
        title: ctx.t('editor.remote.sensitiveTitle'),
        content: ctx.t('editor.remote.sensitiveBody', { path: remote.rpath }),
      })
      if (!ok) return 'error'
    }
    const detect = !opts?.force && !!file.baseHash
    try {
      const res = await remoteHostApi.files.writeContent(
        remote.hostId, remote.rpath, utf8ToBase64(file.content),
        {
          baseHash: detect ? file.baseHash : undefined,
          encoding: file.encoding || undefined,
          // 冲突检测模式静默发请求（409 是预期分支）；非检测模式走拦截器
          // errorLabel 与本地保存同文案
          config: detect ? { silent: true } : { errorLabel: 'layout.saveFail' },
        },
      ) as unknown as { hash?: string }
      applySaved(file, res)
      file.remoteOffline = false
      if (opts?.toast !== false) message.success(ctx.t('layout.fileSaved'))
      // 「最近远程」候选（P-20261004-137）：保存成功同样置顶——常改的远端配置
      // 在 Quick Open 里保持最近位（打开链已记录，此处仅刷新环形序）
      ctx.hooks.onPushRemoteRecent?.({
        hostId: remote.hostId, rpath: remote.rpath, name: remote.name, ts: Date.now(),
      })
      // 保存成功广播：消费方按路径守卫（gutter 变更条对 remote: 伪路径直接清空）
      window.dispatchEvent(new CustomEvent(OPS_FILES_SAVED, { detail: { paths: [file.path] } }))
      return 'saved'
    } catch (err) {
      if (detect && isConflictError(err)) {
        showConflictDialog(file)
        return 'conflict'
      }
      // 主机不可达/已删（拨号失败 502、主机不存在 404）→ 离线降级：编辑器
      // 只读 + 顶横幅可重试，防止在不可回写状态下继续盲编辑
      const appErr = err instanceof AppError ? err : null
      if (!appErr || appErr.status === 502 || appErr.status === 404) file.remoteOffline = true
      // 404 = 主机记录已删：惰性清最近远程死条目（P-20261004-137，打开链同口径）
      if (appErr?.status === 404) ctx.hooks.onRemoveRemoteRecent?.(remote.hostId, remote.rpath)
      // 检测模式请求是 silent 的，拦截器不弹 toast：这里补一次错误提示
      if (detect && appErr?.userMessage) message.error(appErr.userMessage)
      notificationStore.add({
        type: 'error',
        category: 'error',
        title: ctx.t('layout.saveFail'),
        body: file.path,
      })
      return 'error'
    }
  }

  /** 保存成功的统一收尾：脏基线对齐 + 新磁盘 hash 作为下次保存的检测基线。
   *  内容已落盘，草稿即失去存在意义——保存成功清草稿（含挂起防抖写入）。
   *  同语义解除自动保存 409 熔断（含覆盖裁决直写成功：冲突已由用户裁决消除） */
  function applySaved(file: OpenFile, res?: { hash?: unknown }) {
    file.originalContent = file.content
    if (typeof res?.hash === 'string' && res.hash) file.baseHash = res.hash
    ctx.clearFileDraft(projectStore.currentProjectId, file.path)
    ctx.autoSaveBlocked.delete(file.path)
  }

  function isConflictError(err: unknown): boolean {
    return err instanceof AppError && err.status === 409
  }

  /** 脏点「保存并关闭」（P-20261003-138，对标 VS Code 点脏点顺手保存的微交互）：
   *  保存该文件并关闭其标签。仅脏文件渲染脏点（渲染面 v-if 守卫），此处再防御
   *  一次净态；关闭不走 closeFileInGroup 的「放弃更改」确认——本链语义是保存，
   *  确认弹窗与确认按钮都用「保存并关闭」明确文案。保存走 writeOpenFile 单一
   *  入口（409 冲突三选对话框天然兜底），保存未落定（失败/冲突待裁决）不关标签：
   *  丢改动的代价远大于让用户再点一次关闭。untitled 草稿的「保存」即另存为
   *  转正（promptDialog 本身是明确的一次确认，不再叠确认框），转正成功才关闭 */
  ctx.saveCloseFileInGroup = async function saveCloseFileInGroup(gi, index) {
    const g = ctx.groupAt(gi)
    const file = g.files[index]
    if (!file || file.isDiff) return
    if (isUntitledPath(file.path)) {
      await ctx.saveUntitledAs(file)
      // 另存为取消/失败保持原状（脏态未对齐）；转正成功 = originalContent 对齐
      if (!isUntitledPath(file.path) && file.content === file.originalContent) {
        await closeByLocating(file.path)
      }
      return
    }
    if (file.content === file.originalContent) return
    const ok = await confirmDialog({
      type: 'warning',
      title: ctx.t('layout.saveCloseTab'),
      content: ctx.t('layout.saveCloseConfirmBody', { name: file.name }),
      confirmText: ctx.t('layout.saveCloseTab'),
    })
    if (!ok) return
    // 弹窗悬挂期间可能已被他途关闭（× 放弃流/批量关闭）：以打开集现状为准
    if (!ctx.findOpenFile(file.path)) return
    if (await ctx.writeOpenFile(file) !== 'saved') return
    // 确认/保存网络往返期间 tab 可能被拖拽重排或邻签关闭：入参 index 已不可信，
    // 按对象身份重定位关闭位（同路径全工程一份对象，path 即身份）；找不到即已
    // 被他途关闭，不动
    await closeByLocating(file.path)
  }

  /** 按路径重定位关闭位（悬挂期 index 漂移防御，见 saveCloseFileInGroup 注） */
  async function closeByLocating(path: string) {
    const loc = ctx.findOpenFile(path)
    if (loc) await ctx.closeFileInGroup(loc.gi, loc.idx)
  }

  /** tab/编辑器右键「放弃未保存修改」（P-20261005-156，VS Code Revert File
   *  对位）：脏 buffer 一键回磁盘/远端当前内容。执行链与 409 冲突对话框的
   *  「加载磁盘/远端版本」完全同一全链（loadDiskVersion/loadRemoteVersion：
   *  读盘回填 + 草稿作废 + baseHash 刷新 + 熔断解除）——本入口只是把该能力
   *  从「等冲突」变常规可达。仅脏文件可达（菜单渲染面守卫，此处再防御）；
   *  untitled 草稿无磁盘/远端基线不提供（另存为/关闭链处置）；本地签走
   *  loadDiskVersion、远程伪路径走 loadRemoteVersion 孪生。确认弹窗明确
   *  丢失警示（与脏点保存关闭 saveCloseFileInGroup 同款确认惯例） */
  ctx.revertFileInGroup = async function revertFileInGroup(gi, index) {
    const g = ctx.groupAt(gi)
    const file = g.files[index]
    if (!file || file.isDiff || isUntitledPath(file.path)) return
    if (file.content === file.originalContent) return
    const remote = isRemoteEditorPath(file.path)
    const ok = await confirmDialog({
      type: 'warning',
      title: ctx.t('files.revert.menu'),
      content: remote
        ? ctx.t('files.revert.bodyRemote', { name: file.name })
        : ctx.t('files.revert.body', { name: file.name }),
      confirmText: ctx.t('files.revert.menu'),
    })
    if (!ok) return
    // 确认悬挂期间可能已被他途关闭或自动保存落盘回净态：以打开集现状为准，
    // 净态放弃无意义（读盘只会重放一条成功提示徒增困惑）
    if (!ctx.findOpenFile(file.path)) return
    if (file.content === file.originalContent) return
    if (remote) await loadRemoteVersion(file)
    else await loadDiskVersion(file)
  }

  /** 保存冲突三选对话框：文件被外部（agent/其他会话）改写后用户的保存被
   *  服务端 409 拒绝，给出覆盖 / 加载远端或磁盘 / 并排对比三条出路（均可取消）。
   *  远程文件（remote: 伪路径）走远端语义：加载/对比读远端 content 端点 */
  function showConflictDialog(file: OpenFile) {
    const remote = isRemoteEditorPath(file.path)
    const d = dialog.warning({
      title: ctx.t('files.conflict.title'),
      content: remote
        ? ctx.t('files.conflict.remoteBody', { name: file.name })
        : ctx.t('files.conflict.body', { name: file.name }),
      // 自渲染按钮区（naive-ui：提供 action 即替代默认正/负按钮）：
      // 三个处置并列 + 右上 ⨉/遮罩/ESC 可取消，不做任何隐式选择
      action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;' }, [
        h(NButton, {
          size: 'small',
          onClick: () => { d.destroy(); if (remote) void loadRemoteVersion(file); else void loadDiskVersion(file) },
        }, () => (remote ? ctx.t('files.conflict.loadRemote') : ctx.t('files.conflict.loadDisk'))),
        h(NButton, {
          size: 'small',
          onClick: () => { d.destroy(); if (remote) void ctx.openRemoteConflictDiff(file); else ctx.openConflictDiff(file) },
        }, () => (remote ? ctx.t('files.conflict.compareRemote') : ctx.t('files.conflict.compare'))),
        h(NButton, { size: 'small', type: 'warning', onClick: () => { d.destroy(); void ctx.writeOpenFile(file, { force: true }) } },
          () => ctx.t('files.conflict.overwrite')),
      ]),
    })
  }

  /** 放弃未保存修改、读入磁盘当前内容（编码与检测基线一并刷新） */
  async function loadDiskVersion(file: OpenFile) {
    if (!projectStore.currentProjectId) return
    try {
      const res: any = await projectApi.readFile(projectStore.currentProjectId, file.path, { silent: true })
      const fresh = typeof res?.data === 'string' ? res.data : ''
      file.content = fresh
      file.originalContent = fresh
      file.encoding = typeof res?.encoding === 'string' ? res.encoding : ''
      file.baseHash = typeof res?.hash === 'string' ? res.hash : ''
      // 用户明确放弃未保存内容改读磁盘：草稿一并作废（重开不应再提示恢复）
      ctx.clearFileDraft(projectStore.currentProjectId, file.path)
      // 回净态即冲突裁决完成：解除自动保存熔断（此后编辑恢复正常自动保存）
      ctx.autoSaveBlocked.delete(file.path)
      message.success(ctx.t('files.conflict.loaded'))
    } catch { /* 文件可能已被删除/移走：保留内存现状，与外部改写重载同语义 */ }
  }

  /** 放弃未保存修改、读入远端当前内容（远程冲突对话框「加载远端版本」，
   *  loadDiskVersion 的远端孪生）。拉取失败（主机不可达）→ 离线降级横幅，
   *  内存现状保留 */
  async function loadRemoteVersion(file: OpenFile) {
    const remote = parseRemoteEditorPath(file.path)
    if (!remote) return
    try {
      const res = await remoteHostApi.files.content(remote.hostId, remote.rpath, { silent: true }) as unknown as { data?: string; encoding?: string; hash?: string }
      const fresh = typeof res?.data === 'string' ? res.data : ''
      file.content = fresh
      file.originalContent = fresh
      file.encoding = typeof res?.encoding === 'string' ? res.encoding : ''
      file.baseHash = typeof res?.hash === 'string' ? res.hash : ''
      file.remoteOffline = false
      // 用户明确放弃未保存内容改读远端：回净态解除自动保存熔断（远程虽不
      // 自动保存，熔断集复用同一路径，顺手对齐）
      ctx.autoSaveBlocked.delete(file.path)
      message.success(ctx.t('files.conflict.loadedRemote'))
    } catch {
      file.remoteOffline = true
    }
  }

  // ── 编码指示与转码（P-20261002-146）：Breadcrumb 徽标菜单的两组动作。
  // 转码链路复用 P-7 既有原语——读侧 ReadFile 自带探测解码（decodeText），
  // 写侧 WriteFile 的 encoding 参数按指定编码落盘（encodeText），本层只做
  // 编码标签的编排（固化/回滚），不引入新的网络形态

  /** 重新以指定编码载入：重读磁盘（ReadFile 探测解码）+ 把用户指定的编码
   *  固化为该文件的保存编码（此后保存按该编码落盘，即转码载入语义）。
   *  有未保存修改先确认放弃（同 VS Code Reopen with Encoding），取消不动。
   *  草稿作废 + 解除自动保存熔断，与 loadDiskVersion 同收尾 */
  ctx.reloadFileWithEncoding = async function reloadFileWithEncoding(encoding) {
    const file = ctx.currentFile.value
    // diff 伪文件/未命名草稿/远程伪路径无项目磁盘对应物，徽标本身不渲染，此处防御兜底
    if (!file || file.isDiff || isUntitledPath(file.path) || isRemoteEditorPath(file.path)) return
    if (!projectStore.currentProjectId) return
    if (file.content !== file.originalContent) {
      const ok = await confirmDialog({
        type: 'warning',
        title: ctx.t('files.encoding.reloadDirtyTitle'),
        content: ctx.t('files.encoding.reloadDirtyBody', { name: file.name }),
      })
      if (!ok) return
    }
    const projectId = projectStore.currentProjectId
    try {
      const res: any = await projectApi.readFile(projectId, file.path, { silent: true })
      const fresh = typeof res?.data === 'string' ? res.data : ''
      file.content = fresh
      file.originalContent = fresh
      // 用户指定覆盖服务端探测：徽标随之展示所选编码，保存按所选编码落盘
      file.encoding = encoding
      file.baseHash = typeof res?.hash === 'string' ? res.hash : ''
      // 重载放弃未保存内容：草稿作废 + 回净态解除熔断（loadDiskVersion 同语义）
      ctx.clearFileDraft(projectId, file.path)
      ctx.autoSaveBlocked.delete(file.path)
      message.success(ctx.t('files.encoding.reloaded', { enc: encodingLabel(encoding) }))
    } catch { /* 文件可能已被删除/移走：保留内存现状，编码标签不动 */ }
  }

  /** 转为指定编码保存（转码）：当前内容按指定编码落盘（WriteFile encoding
   *  回传链路），成功后该文件即此编码（后续保存沿用）。指定即当前编码 = 按
   *  原编码保存，走既有保存链不转码。409 待裁决/写失败回滚编码标签——内存
   *  标签与磁盘实际编码分叉会让之后的普通保存静默转码（防错码写坏文件） */
  ctx.saveFileWithEncoding = async function saveFileWithEncoding(encoding) {
    const file = ctx.currentFile.value
    if (!file || file.isDiff || isUntitledPath(file.path) || isRemoteEditorPath(file.path)) return
    if (!projectStore.currentProjectId) return
    if ((file.encoding || '') === encoding) {
      await ctx.writeOpenFile(file)
      return
    }
    const prev = file.encoding
    file.encoding = encoding
    const result = await ctx.writeOpenFile(file, { toast: false })
    if (result === 'saved') {
      message.success(ctx.t('files.encoding.savedAs', { enc: encodingLabel(encoding) }))
    } else {
      file.encoding = prev
    }
  }
}
