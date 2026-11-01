/**
 * 批量重命名预览计算（P-20261003-283）纯函数：对多选集合逐项做「查找/替换串」
 * 字面替换（仅叶子名，路径其余段不动），产出改名前后对照与逐项非法标记。
 *
 * 非法红标复用 P-132 fileNameCompatIssue（Windows 保留设备名 / 段结尾点空格），
 * 另加批内自有三类：替换结果空名 / 含路径分隔符 / 与同父目录其他改名结果重名。
 * 磁盘侧重名（P-117 目标防护 409）预览不可见（不为此多发请求），由执行链
 * （useBatchRename）逐个跳过报告兜底——前端检测只做发现面，与上传同名检测
 * （P-20261003-230）同一分工哲学。
 */

import { fileNameCompatIssue, type FileNameIssue } from './fileNameCompat'

/** 非法类型：P-132 两类透传 + 批内自有三类 */
export type BatchRenameIssue = FileNameIssue | 'emptyName' | 'sepInName' | 'collision'

/** 单行预览：path=原路径；name/newName=叶子名前后；changed=查找串命中且名字有变 */
export interface BatchRenameRow {
  path: string
  name: string
  newName: string
  changed: boolean
  issue: BatchRenameIssue | null
}

/** 字面全量替换：不用正则——查找串按用户输入原样匹配（元字符无特殊义，
 *  结果可预期），大小写敏感（前端禁大小写不敏感路径假设） */
export function replaceAllLiteral(text: string, find: string, replace: string): string {
  if (!find) return text
  return text.split(find).join(replace)
}

/**
 * 计算批量重命名预览行。路径升序处理（父目录先于子项——父目录也改名时，
 * 执行链按同序先改父再以新父路径改子，此处排序即执行顺序的预演）。
 * 冲突检测只标「后到者」（与执行链先到先得一致）；自身非法（空名/分隔符/
 * P-132）优先标注——非法项不参与执行，也就不构成真实冲突。
 */
export function computeBatchRename(paths: string[], find: string, replace: string): BatchRenameRow[] {
  const rows: BatchRenameRow[] = []
  const sorted = [...paths].sort()
  // 同父目录改名的占用表：父前缀 + 新叶子名 → 先到行（跨父目录同名不冲突）
  const claimed = new Set<string>()
  for (const p of sorted) {
    const name = p.split('/').pop() || p
    const newName = replaceAllLiteral(name, find, replace)
    const row: BatchRenameRow = { path: p, name, newName, changed: find.length > 0 && newName !== name, issue: null }
    if (row.changed) {
      if (!newName) row.issue = 'emptyName'
      else if (newName.includes('/')) row.issue = 'sepInName'
      else if (fileNameCompatIssue(newName)) row.issue = fileNameCompatIssue(newName)
      else {
        const parent = p.slice(0, p.length - name.length)
        const key = parent + newName
        if (claimed.has(key)) row.issue = 'collision'
        else claimed.add(key)
      }
    }
    rows.push(row)
  }
  return rows
}
