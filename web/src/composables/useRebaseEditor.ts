/**
 * useRebaseEditor —— 交互式 rebase 编辑器逻辑（P-20261003-324 提交整理：
 * 重排/squash/drop/reword 可视化）。纯状态与纯函数，i18n 文案以 key 形式
 * 返回（组件层翻译），保证可在 jsdom 单测。
 *
 * 序契约：steps 按应用序（最老在前）——与 GET /rebase/todo 返回序、git
 * rebase todo 文件同向，「取列表 → 编辑 → 提交执行」全程零翻转。
 */
import { computed, ref } from 'vue'
import { rebaseApi } from '@/api/client'
import type { RebaseStep, RebaseStepAction } from '../api/domains/git'
import type { AppError } from '../api/error-types'

export type { RebaseStep, RebaseStepAction }

/** 计划步数上限：与服务端 git.MaxRebasePlanSteps 同值（提案：限制误操作半径） */
export const REBASE_EDITOR_MAX_STEPS = 20

export interface RebaseEditorStep {
  hash: string
  msg: string
  action: RebaseStepAction
  /** reword 行内编辑的新消息（切到 reword 时预填原消息） */
  newMessage: string
}

export interface RebasePreviewRow {
  hash: string
  /** 最终提交消息首行（reword 取编辑后的新消息） */
  subject: string
  /** squash 并入本条的消息首行（按并入顺序） */
  squashed: string[]
}

export interface RebaseExecuteResult {
  ok: boolean
  /** 409 拒绝：区间含已推送提交，须确认后携 confirmPushed 重试 */
  pushed?: boolean
  remoteBranches?: string[]
  /** 拦截器映射的本地化文案（失败路径静默时由组件自行展示） */
  userMessage?: string
}

export function useRebaseEditor() {
  const show = ref(false)
  const loading = ref(false)
  const executing = ref(false)
  /** rebase 基准；空串 = 根提交区间（--root 全历史） */
  const onto = ref('')
  const steps = ref<RebaseEditorStep[]>([])

  /** 打开编辑器：commit 为「整理自此提交起」的目标提交，服务端换算区间基准 */
  async function open(projectId: string, commit: string) {
    if (!projectId || !commit) return
    show.value = true
    loading.value = true
    steps.value = []
    onto.value = ''
    try {
      // 拦截器已解包 response.data：此处为 { data: 步骤列表, onto: 换算后的基准 }
      const res = await rebaseApi.getTodo(projectId, '', commit) as unknown as { data?: RebaseStep[]; onto?: string }
      onto.value = res?.onto || ''
      const list: RebaseStep[] = Array.isArray(res) ? res : res?.data || []
      steps.value = list.map((s: RebaseStep) => ({
        hash: s.hash,
        msg: s.msg,
        action: s.action,
        newMessage: s.action === 'reword' ? s.newMessage || s.msg : s.msg,
      }))
    } catch {
      /* 拦截器已提示；弹层内空列表由组件渲染错误态 */
      steps.value = []
    } finally {
      loading.value = false
    }
  }

  /** 行动作切换：切到 reword 时预填原消息作为编辑起点 */
  function setAction(index: number, action: RebaseStepAction) {
    const s = steps.value[index]
    if (!s) return
    s.action = action
    if (action === 'reword' && !s.newMessage) s.newMessage = s.msg
  }

  function move(index: number, delta: number) {
    moveRebaseStep(steps.value, index, delta)
  }

  /** 形态校验错误 key（null = 可执行） */
  const validationError = computed(() => rebaseEditorValidationError(steps.value))

  /** 结果序列预览（含 drop 摘出），实时反映行内编辑 */
  const preview = computed(() => rebaseEditorPreview(steps.value))

  function close() {
    show.value = false
  }

  return { show, loading, executing, onto, steps, validationError, preview, open, setAction, move, close }
}

/** 首行摘要（squash 预览/reword 展示共用） */
export function firstLine(s: string): string {
  return (s || '').split('\n')[0]!.trim()
}

/** 编辑器形态校验错误 key（null = 可执行）；与服务端校验同规，提前到输入侧反馈 */
export function rebaseEditorValidationError(steps: Array<Pick<RebaseEditorStep, 'action' | 'newMessage'>>): string | null {
  if (steps.length === 0) return 'rebase.editor.errorEmpty'
  const effective = steps.filter(s => s.action !== 'drop')
  if (effective.length === 0) return 'rebase.editor.errorAllDropped'
  if (effective[0]!.action === 'squash') return 'rebase.editor.errorSquashFirst'
  if (effective.some(s => s.action === 'reword' && !s.newMessage.trim())) return 'rebase.editor.errorRewordEmpty'
  return null
}

/** 结果序列预览：drop 摘出、squash 并入上一条（与服务端 buildRebaseTodo 同规） */
export function rebaseEditorPreview(steps: Array<Pick<RebaseEditorStep, 'hash' | 'msg' | 'action' | 'newMessage'>>): { rows: RebasePreviewRow[]; dropped: string[] } {
  const rows: RebasePreviewRow[] = []
  const dropped: string[] = []
  for (const s of steps) {
    if (s.action === 'drop') {
      dropped.push(firstLine(s.msg))
      continue
    }
    const subject = s.action === 'reword' ? firstLine(s.newMessage) : firstLine(s.msg)
    if (s.action === 'squash' && rows.length > 0) {
      rows[rows.length - 1]!.squashed.push(subject)
    } else {
      rows.push({ hash: s.hash, subject, squashed: [] })
    }
  }
  return { rows, dropped }
}

/** 相邻行交换（上移/下移按钮，MVP 免拖拽库），越界为幂等空操作 */
export function moveRebaseStep(steps: RebaseEditorStep[], index: number, delta: number): void {
  const target = index + delta
  if (index < 0 || target < 0 || target >= steps.length) return
  const a = steps[index]!
  const b = steps[target]!
  steps[index] = b
  steps[target] = a
}

/**
 * 执行计划。首次调用不带 confirmPushed 且 silent——区间含已推送提交时服务端
 * 409 拒绝（拦截器不弹 toast），调用方展示影响面确认后携 confirmPushed 重试
 */
export async function executeRebasePlan(
  projectId: string,
  onto: string,
  steps: RebaseEditorStep[],
  confirmPushed: boolean,
): Promise<RebaseExecuteResult> {
  const actions: RebaseStep[] = steps.map(s => ({
    action: s.action,
    hash: s.hash,
    msg: s.msg,
    ...(s.action === 'reword' ? { newMessage: s.newMessage.trim() } : {}),
  }))
  try {
    await rebaseApi.interactive(projectId, onto, actions, confirmPushed, { silent: !confirmPushed })
    return { ok: true }
  } catch (e) {
    const err = e as AppError
    if (err?.status === 409 && err?.data) {
      return { ok: false, pushed: true, remoteBranches: (err.data as { remoteBranches?: string[] }).remoteBranches || [] }
    }
    return { ok: false, userMessage: err?.userMessage }
  }
}
