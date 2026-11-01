// diff 标签伪键（diff:<oldRef>:<newRef>:<filePath>）解析与「右侧是否工作区版本」
// 判定。伪键由 useOpenFiles.openDiffView 产出（tab path 键），Breadcrumb 面包屑
// 解码展示、DiffEditor「在编辑器打开」守卫（P-20261003-57）共用同一事实源——
// 键格式改动只动这里（ref 含 'wt'/'HEAD'/commit sha/'clipboard'/'index'（暂存区，
// P-20261004-42 变更基线分流）/'conflict-<ts>'（冲突并排对比）/
// 'cmpto-<encodeURIComponent>@<ts>'/'draft-<ts>'
// （草稿对比预览，P-20261004-71），冒号
// 分段由 openDiffView 键模板保证——git stage-0 语法 ':0' 自带冒号，只能以
// index 字面量进键、取数层（openfiles/diff.ts toSnapshotRef）再映射）
import { isRemoteEditorPath } from './remoteEditorPath'

export interface DiffKey {
  oldRef: string
  newRef: string
  filePath: string
}

/** 解析 diff 标签伪键；非 diff: 键（普通文件/未命名草稿/远程直开签）返回 null。
 *  filePath 段取第二冒号之后全部（远程伪路径 remote:<hostId>:<path> 自带冒号，
 *  不截断） */
export function parseDiffKey(raw: string): DiffKey | null {
  if (!raw.startsWith('diff:')) return null
  const rest = raw.slice(5)
  const i1 = rest.indexOf(':')
  const i2 = rest.indexOf(':', i1 + 1)
  if (i1 <= 0 || i2 <= i1) return null
  return { oldRef: rest.slice(0, i1), newRef: rest.slice(i1 + 1, i2), filePath: rest.slice(i2 + 1) }
}

/** diff 右侧是否工作区版本：「看完 diff 顺手改工作区」动线只对该形态成立——
 *  wt=工作区对比（变更面板/审批 target 直开）、clipboard=剪贴板对比（右=真实
 *  文件）、cmpto-=两文件互比（右=目标工作区文件）；HEAD/commit sha 侧是历史
 *  版本、index 侧是暂存区内容（P-20261004-42），均与磁盘现状无对应关系，
 *  不适用（守卫置灰） */
export function diffRightIsWorkspace(key: DiffKey): boolean {
  return key.newRef === 'wt' || key.newRef === 'clipboard' || key.newRef.startsWith('cmpto-')
}

/** 「在编辑器打开」目标路径：diff 键存在、右侧为工作区版本、且不是远程伪路径
 *  （remote: 打开动线归远程编辑器，OPS_OPEN_FILE_AT 只寻址项目内相对路径）
 *  三关全过才返回真实文件路径，否则 null（调用方据 null 置灰按钮） */
export function diffWorkspaceTarget(raw: string): string | null {
  const key = parseDiffKey(raw)
  if (!key || !diffRightIsWorkspace(key)) return null
  if (isRemoteEditorPath(key.filePath)) return null
  return key.filePath
}
