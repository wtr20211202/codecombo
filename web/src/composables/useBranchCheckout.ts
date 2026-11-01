import { h } from 'vue'
import { NButton, useDialog, useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useChangesStore } from '../stores/changes'
import { useNotificationStore } from '../stores/notification'
import { branchApi } from '../api/client'
import type { AutoStashResult, RecoverableStashHint } from '../api/client'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'
import type { StashRecoverPayload } from './useStashRecover'

/**
 * 分支检出统一链路（P-20261002-102 自 GitBranchesSection 抽出共享）：
 * Git 分支树右键「切换到」与命令面板 checkout:<name> 两条入口共用，
 * 保证脏区预警/成功提示/外部变更广播行为一致。
 */

/** checkout 前脏工作区预警（P-20261002-19）：git CLI 只会拒绝真冲突的切换，
 *  可携带的未提交修改会静默跟着切到目标分支——用户常忘了自己有未提交改动就切走，
 *  在错误分支上继续改半天才发现。预检只读 changes store 已加载数据（files 非空即
 *  弹确认，取消不动）：列表为空（无修改或尚未加载）都静默放行，不额外发请求、
 *  不阻塞切换。 */
export function useBranchCheckout() {
  const { t } = useI18n()
  const message = useMessage()
  const dialog = useDialog()
  const changesStore = useChangesStore()
  const notificationStore = useNotificationStore()

  /** 恢复提示（P-20261006-48）：响应携带 recoverableStash（检出目标分支上留有
   *  切走前的 autoStash 条目）时——就地 toast 点名 + 落通知中心条目（行内「恢复」
   *  按钮经 actionInlineLabel 注册表渲染，点击经 pendingAction 分发回
   *  useStashRecover 恢复链）。files 为 0（服务端计数探测降级）时落计数缺省文案 */
  function hintRecoverableStash(projectId: string, rec: RecoverableStashHint) {
    const title = rec.files > 0
      ? t('git.autoStashRecoverable', { count: rec.files })
      : t('git.autoStashRecoverablePlain')
    message.info(title)
    const payload: StashRecoverPayload = { projectId, branch: rec.branch, message: rec.message }
    void notificationStore.add({
      type: 'info',
      category: 'git',
      title,
      body: t('git.autoStashRecoverableBody', { branch: rec.branch }),
      projectId,
      action: 'stash-recover',
      actionPayload: JSON.stringify(payload),
    })
  }

  /** 脏工作区预警确认（确认三选）：①自动暂存并恢复（P-20261003-203，调用方
   *  提供 runAutoStash 闭包时才渲染）——②仍要切换（携带修改，git 默认行为）——
   *  ③取消（不动）。空列表静默放行。naive-ui 无中键，三选走自渲染 action
   *  按钮区（save.ts 保存冲突三选对话框同款先例），⨉/遮罩/ESC 仍可取消 */
  function confirmDirtyCheckout(name: string, run: () => Promise<void>, runAutoStash?: () => Promise<void>) {
    const dirtyCount = changesStore.files.length
    if (dirtyCount === 0) { void run(); return }
    const d = dialog.warning({
      title: t('git.dirtyWarnTitle'),
      content: t('git.dirtyWarnContent', { count: dirtyCount, branch: name }),
      action: () => h('div', { style: 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;' }, [
        ...(runAutoStash
          ? [h(NButton, { size: 'small', onClick: () => { d.destroy(); void runAutoStash() } }, () => t('git.dirtyWarnAutoStashBtn'))]
          : []),
        h(NButton, { size: 'small', type: 'warning', onClick: () => { d.destroy(); void run() } }, () => t('git.dirtyWarnBtn')),
        h(NButton, { size: 'small', onClick: () => { d.destroy() } }, () => t('common.cancel')),
      ]),
    })
  }

  /** 原链路：确认后直接 checkout，修改随 git 默认行为携带 */
  async function doCheckout(projectId: string, name: string, onCheckedOut?: () => void) {
    try {
      // 拦截器解包后运行时值即响应体 { message, recoverableStash? }（axios 泛型
      // 形态有出入，显式收口——doCheckoutAutoStash 同款注记）
      const res = await branchApi.checkout(projectId, name) as unknown as { recoverableStash?: RecoverableStashHint }
      message.success(t('git.checkedOut', { name }))
      if (res?.recoverableStash) hintRecoverableStash(projectId, res.recoverableStash)
      onCheckedOut?.()
      window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
    } catch { /* 拦截器处理 */ }
  }

  /** 自动暂存链路（P-20261003-203）：stash → checkout → stash pop 由服务端一次
   *  完成（失败路径在服务端还原现场，宁多勿丢）。pop 冲突不是失败——切换已成功
   *  且 stash 条目保留（git pop 冲突不 drop 语义），明确提示变更未丢、可切回原
   *  分支恢复或经 stash 面板处置 */
  async function doCheckoutAutoStash(projectId: string, name: string, onCheckedOut?: () => void) {
    try {
      // 拦截器解包后运行时值即响应体 { message, autoStash, recoverableStash? }，
      // 与 axios 泛型形态有出入（同 useStashSection 的 res 解包先例），此处显式
      // 收口为结构化类型
      const res = await branchApi.checkout(projectId, name, true) as unknown as { autoStash?: AutoStashResult, recoverableStash?: RecoverableStashHint }
      if (res?.autoStash?.stashKept) {
        message.warning(t('git.autoStashKept', { name }))
      } else {
        message.success(t('git.checkedOutAutoStash', { name }))
      }
      if (res?.recoverableStash) hintRecoverableStash(projectId, res.recoverableStash)
      onCheckedOut?.()
      window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
    } catch { /* 拦截器处理 */ }
  }

  /** 检出分支：脏区预警（确认三选）→ checkout → 成功提示 + onCheckedOut 回调
   *  （调用方刷新各自的分支清单）+ 外部变更广播（文件树/打开中的编辑器随检出
   *  重读）；stash 面板列表沿 CommitPanel 页签切换/刷新按钮既有重拉节奏 */
  function checkoutBranch(projectId: string, name: string, onCheckedOut?: () => void) {
    confirmDirtyCheckout(
      name,
      () => doCheckout(projectId, name, onCheckedOut),
      () => doCheckoutAutoStash(projectId, name, onCheckedOut),
    )
  }

  return { confirmDirtyCheckout, checkoutBranch }
}
