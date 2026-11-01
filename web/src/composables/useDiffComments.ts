import { ref } from 'vue'
import { useUIStateStore } from '../stores/uiState'
import { useInstanceStore } from '../stores/instance'
import {
  normalizeDiffComments,
  capDiffComments,
  reconcileCommentDrift,
  newDiffCommentId,
  DIFF_COMMENT_MAX_TEXT,
  type DiffComment,
} from '../utils/diffComments'

/**
 * diff 审阅留言（P-20261003-279）：产出 diff 的行级留言状态域——多轮审阅的
 * 「这里要改」沉淀，下次打开同一文件的产出 diff 还在。
 *
 * 为什么模块级单例（useEditorBookmarks / useEditorNavHistory 同范式）：消费方
 * 是 DiffEditor（深层叶组件，分屏双组可各挂一个实例），useOpenFiles 是 shell
 * 实例级组合式拿不到；同热区多实例须共享同一份状态。
 *
 * 状态模型：内存权威（byProject），uiState `diffComments` 命名空间持久化——
 * 首次消费前懒加载一次（ensureLoaded），此后写内存 + 落盘（用户动作即时写、
 * 漂移和解防抖写）。锚点 = 文件相对路径 + 右侧行号（只收「右侧=工作区版本」
 * 的 diff 形态，守卫在消费方 DiffEditor，P-57/P-208 同口径）；行锚点漂移容忍
 * 在 utils/diffComments.reconcileCommentDrift（内容锚匹配找回），本模块只做
 * 状态搬运。每项目总条数上限 DIFF_COMMENTS_MAX_PER_PROJECT，超出按 createdAt
 * 最旧先淘汰（防 uiState 膨胀）。
 */

const byProject = ref<Record<string, Record<string, DiffComment[]>>>({})
/** 状态版本号：DiffEditor watch 它在任意变更（含另一分屏组的动作）后重放装饰 */
const version = ref(0)
let loaded = false
let loadPromise: Promise<void> | null = null
/** 内存缓存归属的实例会话（instanceId）：跨实例切换后强制重载，防旧实例
 *  状态写进新实例的持久化槽（useEditorBookmarks 同款） */
let sessionKey = ''
let saveTimer: ReturnType<typeof setTimeout> | null = null

/** 懒加载（首次消费前从 uiState 拉一次）：实例切换后重拉，失败回落内存现状。
 *  装载边界逐表形状防御再归一——不依赖 store 读取端的归一保真 */
function ensureLoaded(): Promise<void> {
  const key = useInstanceStore().currentInstanceId
  if (loaded && key === sessionKey) return Promise.resolve()
  if (!loadPromise || sessionKey !== key) {
    sessionKey = key
    loaded = false
    loadPromise = useUIStateStore().getDiffComments()
      .then((all) => {
        for (const files of Object.values(all)) {
          for (const [p, list] of Object.entries(files)) files[p] = normalizeDiffComments(list)
        }
        byProject.value = all
        loaded = true
        version.value++
      })
      .catch(() => { loaded = true })
  }
  return loadPromise
}

/** 持久化（delay=0 即时 / >0 防抖——漂移和解随内容刷新高频触发时不打一串
 *  GET+PATCH；快照为纯数据拷贝，与内存响应式解耦） */
function schedulePersist(delay: number): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void useUIStateStore().saveDiffComments(JSON.parse(JSON.stringify(byProject.value)))
  }, delay)
}

/** 某文件的留言表（行升序；未加载/无留言返回空表。渲染端直读） */
function commentsFor(projectId: string, path: string): DiffComment[] {
  if (!projectId || !path) return []
  return byProject.value[projectId]?.[path] || []
}

/** 指定行上的留言（无则 undefined；菜单可用性与动作定位用） */
function commentAt(projectId: string, path: string, line: number): DiffComment | undefined {
  return commentsFor(projectId, path).find((c) => c.line === line)
}

/** 新增留言（一行一条——同行再调返回 false，走 editComment 改文）。
 *  即时落盘；超上限按最旧先淘汰 */
function addComment(projectId: string, path: string, line: number, text: string, lineText: string): boolean {
  if (!projectId || !path || !(line >= 1)) return false
  const body = text.trim()
  if (!body || body.length > DIFF_COMMENT_MAX_TEXT) return false
  const files = (byProject.value[projectId] ??= {})
  const list = (files[path] ??= [])
  if (list.some((c) => c.line === line)) return false
  list.push({
    id: newDiffCommentId(),
    line,
    text: body,
    lineText: lineText.trim(),
    createdAt: Date.now(),
    resolved: false,
  })
  files[path] = capDiffComments(list)
  version.value++
  schedulePersist(0)
  return true
}

/** 改文（编辑入口）：id 不存在返回 false，同文幂等返回 true。即时落盘 */
function editComment(projectId: string, path: string, id: string, text: string): boolean {
  const body = text.trim()
  if (!body || body.length > DIFF_COMMENT_MAX_TEXT) return false
  const c = commentsFor(projectId, path).find((x) => x.id === id)
  if (!c) return false
  if (c.text === body) return true
  c.text = body
  version.value++
  schedulePersist(0)
  return true
}

/** 解除（已处理勾选）/撤销解除：id 不存在返回 false，同态幂等返回 true。即时落盘 */
function setCommentResolved(projectId: string, path: string, id: string, resolved: boolean): boolean {
  const c = commentsFor(projectId, path).find((x) => x.id === id)
  if (!c) return false
  if (c.resolved === resolved) return true
  c.resolved = resolved
  version.value++
  schedulePersist(0)
  return true
}

/** 删除留言。即时落盘 */
function removeComment(projectId: string, path: string, id: string): boolean {
  const files = byProject.value[projectId]
  const list = files?.[path]
  if (!list) return false
  const at = list.findIndex((x) => x.id === id)
  if (at < 0) return false
  list.splice(at, 1)
  if (list.length === 0) {
    delete files![path]
    if (Object.keys(files!).length === 0) delete byProject.value[projectId]
  }
  version.value++
  schedulePersist(0)
  return true
}

/** 行锚点漂移和解（diff 重开/内容刷新时调用）：越界收敛 + 内容锚找回，
 *  变更才版本递增 + 防抖落盘（重开是低频动作，防抖只为内容刷新连发的窗口） */
function reconcileDrift(projectId: string, path: string, lineCount: number, getLine: (n: number) => string): void {
  if (!projectId || !path) return
  const list = byProject.value[projectId]?.[path]
  if (!list || list.length === 0) return
  const r = reconcileCommentDrift(list, lineCount, getLine)
  if (!r.changed) return
  byProject.value[projectId]![path] = r.comments
  version.value++
  schedulePersist(1500)
}

export function useDiffComments() {
  return {
    ensureLoaded,
    commentsFor,
    commentAt,
    addComment,
    editComment,
    setCommentResolved,
    removeComment,
    reconcileDrift,
    version,
  }
}
