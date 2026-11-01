import { h } from 'vue'
import { NButton, useMessage } from 'naive-ui'
import { prApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'

/**
 * push 成功回执 toast（P-20261005-215）：五个推送入口（快捷推送/「提交并推送」
 * 连招/推送弹层/项目菜单推送/分支右键推送）共用的成功提示面——首推新分支时在
 * toast 上附「创建 PR」外链按钮（GitHub Desktop push 后弹 Create PR 同款收口），
 * 非首推保持裸成功文案零变化（PR 已建场景不重复打扰）。
 *
 * 「首推」事实由服务端随 push 回执下发（newBranch：push 前本地跟踪引用缺失，
 * server/git/remote.go PushResult）；字段缺失（旧服务端）按提案退化规则恒展示。
 * 按钮动作复用既有 POST /projects/:id/create-pr（PlatformAdapter 注册表按远端
 * host 出 GitHub/Gitea/GitLab/Gitee 形态 URL），新窗打开（外链惯例 noopener），
 * 与 TopBar 项目菜单 handleCreatePr 同语义收口，零新 API。
 */

/** push 回执 → 是否附「创建 PR」入口（纯决策可测）：newBranch 显式 false（服务端
 *  判定非首推）才隐藏；undefined（旧服务端无字段）恒展示 */
export function pushToastOffersCreatePr(newBranch?: boolean): boolean {
  return newBranch !== false
}

export function usePushPrToast(messageApi?: ReturnType<typeof useMessage>) {
  // messageApi 可选注入：PushDialog 等持离散 message 实例的面传入自己的实例，
  // 缺省用 provider 注入式 useMessage（与其余入口一致）
  const injected = useMessage()
  const message = messageApi ?? injected
  const { t } = useI18n()
  const projectStore = useProjectStore()

  /** 「创建 PR」按钮动作：create-pr 出 URL → 新窗打开。projectId 在 toast 生成
   *  时捕获（toast 存活期内用户可能切项目，点击须作用于推送当时的仓库） */
  async function openCreatePr(projectId: string) {
    if (!projectId) return
    try {
      const res = await prApi.create(projectId)
      if (res.data?.url) {
        window.open(res.data.url, '_blank', 'noopener')
        message.success(`${t('layout.prLinkGenerated')} (${res.data.platform})`)
      }
    } catch { /* 拦截器统一提示 */ }
  }

  /**
   * push 成功 toast：newBranch 判定见 pushToastOffersCreatePr。附按钮时时长放宽
   * 10s（行动化 toast 档，P-44 冲突动作 / P-194 hint 按钮同档），给点击留窗口；
   * 裸文案路径不传 options，与既有行为逐字节一致（5s 默认时长）。
   * @param opts.title 覆盖文案（分支右键推送沿用其「已推送 x → y」明细文案）
   */
  function toastPushSuccess(newBranch?: boolean, opts?: { title?: string }) {
    const title = opts?.title ?? t('layout.pushSuccess')
    if (!pushToastOffersCreatePr(newBranch)) {
      message.success(title)
      return
    }
    const pid = projectStore.currentProjectId || ''
    message.success(
      () => h('div', { style: 'display: flex; align-items: center; gap: 12px;' }, [
        h('span', null, title),
        pid && h(
          NButton,
          {
            size: 'tiny',
            quaternary: true,
            'data-testid': 'push-pr-link',
            onClick: () => void openCreatePr(pid),
          },
          () => t('layout.createPr'),
        ),
      ]),
      { duration: 10000 },
    )
  }

  return { toastPushSuccess, openCreatePr }
}
