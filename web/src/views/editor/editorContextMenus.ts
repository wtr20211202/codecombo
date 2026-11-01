import * as monaco from 'monaco-editor'
import type { useI18n } from '../../composables/useI18n'

/**
 * Monaco 右键菜单注册族（P-20261003-301 自 MonacoEditor.vue 的 onMounted 原样
 * 搬运）：Git 组（对比/剪贴板对比/本地历史/定位文件树）+ 片段组 + 分享组 +
 * 询问智能体组 + 本地历史组。动作注册在挂载期一次完成，路径切换不重挂——
 * 远程伪路径（remote:）项目域 Git/agent 面无意义，run 内守卫短路（语义原样）。
 * 未命名草稿（untitled://N，P-20261005-180 兑现 P-96「留待后续提案」）项目域
 * 动作双保险：'!scFileIsDraft' 上下文键摘菜单可见性（scFileCanRevert 同机制，
 * 草稿右键菜单无此族项）+ run 内 isUntitledDraft 短路（远程同口径）。
 * 各动作的实际行为经 handlers 回调（对应 MonacoEditor 持有的 egaRef/片段
 * composable/emit 链），本模块只负责注册面与分组编排。
 */

export interface EditorContextMenuHandlers {
  isRemotePath: () => boolean
  /** 未命名草稿判定（P-20261005-180）：untitled://N 纯内存 tab 无磁盘基线，
   *  项目域动作（Git 组/定位树/本地历史/选区询问/复制引用）查无此文件/无对比
   *  基准——与远程伪路径同口径在 run 内短路；可见性另经 scFileIsDraft 上下文
   *  键（MonacoEditor 创建维护）摘除，草稿右键不再出现整族死项 */
  isUntitledDraft: () => boolean
  /** egaRef.openCompare：与右上角快捷操作按钮同一套弹窗实例（不重复挂 NModal） */
  openCompare: () => void
  compareWithClipboard: () => void
  openFileHistory: () => void
  revealInTree: () => void
  openSaveSnippetModal: () => void
  openSnippetInsertPicker: () => void
  shareSelectionSnippet: () => void
  askSelectionAgent: () => void
  openLocalHistory: () => void
  /** 复制引用（路径:行，P-20261006-17）：光标行拼项目相对路径贴剪贴板，格式
   *  与 Quick Open 行号直达语法严格一致（粘贴即行级直达）；远程伪路径/未命名
   *  草稿的守卫在 MonacoEditor 的实现内收口（isRemotePath 之外的 untitled
   *  判定是编辑器域 computed） */
  copyReference: () => void
  /** 放弃未保存修改（P-20261005-156，VS Code Revert File 对位）：确认链与
   *  读盘回填在 useOpenFiles.revertFileInGroup；可见性由 scFileCanRevert 上下
   *  文键（脏文件才出）与 untitled 判定收口，远程伪路径不排除（分流
   *  loadRemoteVersion）——守卫口径与 Git 组的 isRemotePath 短路相反 */
  revertFile: () => void
  /** 改动来源（P-20261005-170）：该文件最近改动的归因账弹窗 */
  openFsAttribution: () => void
  /** 发送选中到终端（P-20261004-21）：确认链在 useEditorSendToTerminal，
   *  写入走 Layout provide 的 sendToTerminal 链 */
  sendSelectionToTerminal: () => void
}

export function registerEditorContextMenus(
  editor: monaco.editor.IStandaloneCodeEditor,
  t: ReturnType<typeof useI18n>['t'],
  h: EditorContextMenuHandlers,
) {
  // Git 右键菜单组：与右上角快捷操作按钮同一套弹窗实例（egaRef）。
  // 远程伪路径（remote:）项目域 Git 面无意义，run 内守卫短路（动作注册
  // 在挂载期一次完成，路径切换不重挂）；untitled 草稿同口径（P-20261005-180）
  // 且经 '!scFileIsDraft' 摘菜单项可见性（scFileCanRevert 同机制，run 短路
  // 保留为键值透传窗口期的双保险，revertFile/copyReference 先例）
  editor.addAction({
    id: 'sc-git.compare-ref',
    label: t('editor.ctxCompareRef'),
    contextMenuGroupId: '9_scgit',
    contextMenuOrder: 1,
    precondition: '!scFileIsDraft',
    run: () => { if (!h.isRemotePath() && !h.isUntitledDraft()) h.openCompare() },
  })
  editor.addAction({
    id: 'sc-git.compare-clipboard',
    label: t('editor.ctxCompareClipboard'),
    contextMenuGroupId: '9_scgit',
    contextMenuOrder: 2,
    precondition: '!scFileIsDraft',
    run: () => { if (!h.isRemotePath() && !h.isUntitledDraft()) void h.compareWithClipboard() },
  })
  editor.addAction({
    id: 'sc-git.file-history',
    label: t('editor.ctxFileHistory'),
    contextMenuGroupId: '9_scgit',
    contextMenuOrder: 3,
    precondition: '!scFileIsDraft',
    run: () => { if (!h.isRemotePath() && !h.isUntitledDraft()) h.openFileHistory() },
  })
  editor.addAction({
    id: 'sc-git.reveal-in-tree',
    label: t('changes.locateInTree'),
    contextMenuGroupId: '9_scgit',
    contextMenuOrder: 4,
    precondition: '!scFileIsDraft',
    run: () => { if (!h.isRemotePath() && !h.isUntitledDraft()) h.revealInTree() },
  })
  // 放弃未保存修改（P-20261005-156，VS Code Revert File 对位）：脏 buffer 一键
  // 回磁盘/远端当前内容——409 冲突对话框「加载磁盘版本」的常态入口。precondition
  // 挂 scFileCanRevert 自建上下文键（MonacoEditor 按 dirty prop + untitled 判定
  // 维护，脏文件才出菜单项，sc-ask.selection 的 editorHasSelection 同机制）；
  // 不做 isRemotePath 短路——远程伪路径同样可放弃（执行域分流 loadRemoteVersion），
  // 与本组其余动作的远程守卫口径相反（本条是 buffer 态动作非项目 git 面）
  editor.addAction({
    id: 'sc-git.revert-file',
    label: t('files.revert.menu'),
    contextMenuGroupId: '9_scgit',
    contextMenuOrder: 5,
    precondition: 'scFileCanRevert',
    run: () => { h.revertFile() },
  })

  // 代码片段右键菜单组（P-20261002-44）：保存选区为片段 / 插入片段。
  // 与 9_scgit 同区段相邻（Monaco 按 groupId 字典序排列分组）
  editor.addAction({
    id: 'sc-snippet.save-selection',
    label: t('snippet.code.saveSelection'),
    contextMenuGroupId: '9_scsnippet',
    contextMenuOrder: 1,
    run: () => h.openSaveSnippetModal(),
  })
  editor.addAction({
    id: 'sc-snippet.insert',
    label: t('snippet.code.insert'),
    contextMenuGroupId: '9_scsnippet',
    contextMenuOrder: 2,
    run: () => { h.openSnippetInsertPicker() },
  })

  // 文本片段分享右键菜单组（P-20261002-71）：选区一键变排障贴短链。
  // 与 9_scsnippet 同区段相邻（「存片段库」与「发短链」语义互补）
  editor.addAction({
    id: 'sc-share.share-selection',
    label: t('share.snippet.menuSelection'),
    contextMenuGroupId: '9_scshare',
    contextMenuOrder: 1,
    run: () => h.shareSelectionSnippet(),
  })

  // 选区询问智能体右键菜单项（P-20261002-122）：以选中代码为上下文新建
  // agent 会话（复用 P-28 发起链路）。precondition 挂 Monaco 内建
  // editorHasSelection（「Whether the editor has text selected」）——无选区
  // 时菜单项隐藏（standaloneCodeEditor 把 precondition 编为菜单项 when）。
  // 自成 9_scask 组（字典序居 9_scgit 前，Monaco 按 groupId 字典序排列分组），
  // 「问智能体」与 Git/片段/分享组语义独立便于后续扩展
  editor.addAction({
    id: 'sc-ask.selection',
    label: t('editor.ask.menuSelection'),
    contextMenuGroupId: '9_scask',
    contextMenuOrder: 1,
    // untitled 草稿内部键对 agent 同样无项目路径语义（canAskContextTab tab 侧
    // P-96 同款排除；'!scFileIsDraft' 与 editorHasSelection 并列编入菜单项 when）
    precondition: 'editorHasSelection && !scFileIsDraft',
    // 远程伪路径对 agent 无项目路径语义（EditorGroupPane canAskContextTab 同口径）
    run: () => { if (!h.isRemotePath() && !h.isUntitledDraft()) h.askSelectionAgent() },
  })

  // 本地文件语义右键菜单组（字典序居 9_scgit 与 9_scsnippet 之间——均非 git
  // 语义不混入 9_scgit 组）：本地文件历史查看/恢复入口（P-20261002-130）+
  // 复制引用（P-20261006-17，项目相对路径:光标行——「路径:行」直达生态的
  // 产出侧，格式即 Quick Open 的消费格式，复制即可粘贴直达；纯路径 copy-path
  // 在文件树/tab 右键并存不替换，用户按需选）
  editor.addAction({
    id: 'sc-file.local-history',
    label: t('files.history.menu'),
    contextMenuGroupId: '9_schistory',
    contextMenuOrder: 1,
    precondition: '!scFileIsDraft',
    run: () => { if (!h.isRemotePath() && !h.isUntitledDraft()) h.openLocalHistory() },
  })
  editor.addAction({
    id: 'sc-file.copy-reference',
    label: t('editor.ctxCopyReference'),
    contextMenuGroupId: '9_schistory',
    contextMenuOrder: 2,
    // 复制引用的 untitled 短路在 MonacoEditor.copyReference 实现内收口
    // （P-20261006-17：untitled 判定是编辑器域 computed），此处只补可见性——
    // 否则草稿菜单挂一项点击无任何反馈的死项
    precondition: '!scFileIsDraft',
    run: () => { if (!h.isRemotePath()) h.copyReference() },
  })

  // 改动来源右键菜单项（P-20261005-170）：该文件最近改动的归因账（谁/哪条
  // 命令改的）——与本地历史同组相邻（同为「这个文件发生了什么」的检视面）
  editor.addAction({
    id: 'sc-file.fs-attribution',
    label: t('files.attribution.menu'),
    contextMenuGroupId: '9_schistory',
    contextMenuOrder: 2,
    run: () => { if (!h.isRemotePath()) h.openFsAttribution() },
  })

  // 发送选中到终端（P-20261004-21）：选中的命令/SQL/脚本写当前活跃终端并回车
  // 执行（VS Code「Run Selection in Active Terminal」同场景）。precondition 挂
  // Monaco 内建 editorHasSelection（同 sc-ask.selection 先例）——无选区时菜单项
  // 隐藏。自成 9_scterm 组（字典序居 sc 组末尾），终端写入语义独立于 Git/片段/
  // 分享/询问各组成一体；确认链（敏感/多行/大文本）在 useEditorSendToTerminal，
  // 不远程守卫——远程文件选区发给本地终端同样是用户显式意图（bash/SQL 皆常见）
  editor.addAction({
    id: 'sc-term.send-selection',
    label: t('editor.sendToTerminal.menuSelection'),
    contextMenuGroupId: '9_scterm',
    contextMenuOrder: 1,
    precondition: 'editorHasSelection',
    run: () => { void h.sendSelectionToTerminal() },
  })
}
