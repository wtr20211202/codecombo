
/** diff 文件条目（路径/名称/变更类型） */
export interface DiffFile {
  path: string
  name: string
  status: string
}

/** 路径树节点：目录或文件 */
export interface DiffTreeNode {
  name: string
  path: string
  isDir: boolean
  children: DiffTreeNode[]
  file?: DiffFile
}

/** 构建路径树（目录优先、同层按名称排序） */
export function buildDiffTree(files: DiffFile[]): DiffTreeNode[] {
  const root: DiffTreeNode[] = []
  for (const file of files) {
    const parts = file.path.split('/')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!
      const isLast = i === parts.length - 1
      if (isLast) {
        current.push({ name: part, path: file.path, isDir: false, children: [], file })
      } else {
        const existing = current.find(n => n.isDir && n.name === part)
        if (existing) { current = existing.children }
        else {
          const dir: DiffTreeNode = { name: part, path: parts.slice(0, i + 1).join('/'), isDir: true, children: [] }
          current.push(dir)
          current = dir.children
        }
      }
    }
  }
  function sortTree(nodes: DiffTreeNode[]) {
    nodes.sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name) })
    for (const n of nodes) { if (n.isDir) sortTree(n.children) }
  }
  sortTree(root)
  return root
}

export interface FlatDiffRow {
  name: string
  path: string
  isDir: boolean
  children: DiffTreeNode[]
  file?: DiffFile
  depth: number
}

/** 展平树为可见行（目录未展开的子树跳过） */
export function flattenDiffTree(nodes: DiffTreeNode[], expanded: Set<string>, depth = 0): FlatDiffRow[] {
  const result: FlatDiffRow[] = []
  for (const node of nodes) {
    result.push({ name: node.name, path: node.path, isDir: node.isDir, children: node.children, file: node.file, depth })
    if (node.isDir && expanded.has(node.path)) {
      result.push(...flattenDiffTree(node.children, expanded, depth + 1))
    }
  }
  return result
}
