import { useDialog } from 'naive-ui'
import { remoteApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { useGitOpsStore } from '../stores/gitOps'
import { useI18n } from './useI18n'

/**
 * 推送流共享：P-10 落后预检三态弹层自 GitPanel 抽出 + 当前分支直推执行段。
 * GitPanel 快捷推送与变更面板「提交并推送」连招（P-20261003-84）同源复用，
 * 预检语义零分叉：behind>0 → 主操作=先去拉取（调用方自接拉取流）/ 次操作=
 * 仍要推送交 git 兜底 / 遮罩·Esc 关闭=不推不拉。
 *
 * 预检与直推拆成两段而非一个整体入口：在飞闸要精确罩住网络请求段——预检弹层
 * 期间弹层自身已模态挡操作，闸若横跨弹层会把「先去拉取」的拉取流也误拦。
 * 直推段的在飞闸记 gitOps store（P-20261005-211）：per 项目跨入口可见——任一
 * 入口推送在飞，GitPanel 快捷推送钮等同族按钮同步禁用+spinner，不重复触发。
 */

/** 预检用户决策 → 流向（纯函数可测）：true=先去拉取 / null=关层不推不拉 / false=仍要推送继续直推 */
export function mapPushBehindChoice(choice: boolean | null): 'pull-first' | 'dismissed' | 'continue' {
  if (choice === true) return 'pull-first'
  if (choice === null) return 'dismissed'
  return 'continue'
}

/** 推送失败原因提取（纯函数可测）：拦截器 AppError 的 userMessage（KNOWN_ERROR_I18N
 *  映射后的本地化文案）优先，rawMessage / 原生 message 兜底，全空用调用方兜底文案 */
export function pickPushFailReason(err: unknown, fallback: string): string {
  const e = err as { userMessage?: string; rawMessage?: string; message?: string } | null
  return e?.userMessage || e?.rawMessage || e?.message || fallback
}

/** 直推执行结果：pushed=成功（newBranch=服务端首推判定，P-20261005-215——本次
 *  推送新建远端分支时 true，旧服务端缺字段 undefined）；failed=失败（reason 为
 *  本地化原因文案） */
export type PushOutcome =
  | { action: 'pushed'; newBranch?: boolean }
  | { action: 'failed'; reason: string }

/** 失败提示策略：'toast'=拦截器按 push.fail 弹通用文案（快捷推送既有行为）；
 *  'silent'=吃掉拦截器 toast、原因带回由调用方合成最终文案（连招的「已提交，
 *  推送失败：<原因>」部分成功提示，不与通用文案叠两层） */
export type PushErrorMode = 'toast' | 'silent'

export function usePushFlow() {
  const dialog = useDialog()
  const { t } = useI18n()
  const projectStore = useProjectStore()
  const gitOps = useGitOpsStore()

  // 三态而非二值 confirm（P-20261003-10 原样语义）：主操作=取消并走拉取流；
  // 次操作=仍要推送交给 git；遮罩/Esc 关闭=不推不拉（不能把误关当成「仍要推送」）
  function confirmPushBehind(behind: number): Promise<boolean | null> {
    return new Promise((resolve) => {
      dialog.warning({
        title: t('git.pushBehindTitle'),
        content: t('git.pushBehindContent', { n: behind }),
        positiveText: t('git.pushBehindPullFirst'),
        negativeText: t('git.pushBehindPushAnyway'),
        onPositiveClick: () => resolve(true),
        onNegativeClick: () => resolve(false),
        onMaskClick: () => resolve(null),
        onEsc: () => resolve(null),
        onClose: () => resolve(null),
      })
    })
  }

  /**
   * 预检段：behind>0 时弹三态层并返回用户流向；behind≤0 直接放行（'continue'）。
   * @param getBehind 预检 behind 取值源——GitPanel 传 props 徽标、提交面板传共享
   *   aheadBehindMap（Layout useLayoutBridge provide，同一数据源两种取法）
   */
  async function precheckBehind(getBehind: () => number): Promise<'pull-first' | 'dismissed' | 'continue'> {
    const behind = getBehind() ?? 0
    if (behind <= 0) return 'continue'
    return mapPushBehindChoice(await confirmPushBehind(behind))
  }

  /**
   * 直推段：当前分支推送上游（git push 无参，与快捷推送同语义）。
   * @param errorMode 失败提示策略，见 PushErrorMode
   */
  async function pushCurrentBranch(errorMode: PushErrorMode = 'toast'): Promise<PushOutcome> {
    const pid = projectStore.currentProjectId || ''
    if (pid) gitOps.begin(pid, 'push') // 只罩请求段：预检弹层等待不算推送在飞
    try {
      // 拦截器解包后运行时值即响应体 { data, newBranch }（pull 回执 newCommits 同款 cast）
      const res = await remoteApi.push(
        projectStore.currentProjectId || '',
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        errorMode === 'silent' ? { silent: true } : { errorLabel: 'push.fail' },
      ) as unknown as { newBranch?: boolean } | undefined
      return { action: 'pushed', newBranch: res?.newBranch }
    } catch (e) {
      // 'toast' 模式拦截器已弹专属文案 + 写 Console，此处只回执不重复提示；
      // 'silent' 模式通用 toast 已吃掉（错误面板留痕不受影响），原因交调用方
      // 合成部分成功提示——不静默重试，失败如实呈现
      return { action: 'failed', reason: pickPushFailReason(e, t('errors.unknown')) }
    } finally {
      if (pid) gitOps.end(pid, 'push')
    }
  }

  return { confirmPushBehind, precheckBehind, pushCurrentBranch }
}
