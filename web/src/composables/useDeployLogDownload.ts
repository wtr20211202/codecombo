// 部署日志留档下载（P-20261003-142）：DeployDialog（进度区/历史行）与通知中心
// 行内入口共用的下载链。日志只驻内存（服务端终态 1h 窗），窗内直出 txt 附件、
// 窗外 410 携稳定标记 `deploy log expired`——blob 响应的错误体拦截器读不出
// 原文（error.response.data 是 Blob），过期语义在此就地解析给「明确不可下载」
// 提示（长期留档落盘为二阶段）；其余错误回退拦截器生成的 userMessage。
// 下载名客户端合成（axios 不透 Content-Disposition，导出族同约定）
import { useMessage } from 'naive-ui'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import { useI18n } from './useI18n'
import { deployApi } from '../api/domains/deploy'
import { AppError } from '../api/error-types'
import { exportFileName } from '../utils/exportFileName'

// 服务端稳定标记（server/deploy/logexport.go LogExpiredMarker，对外契约——
// 改措辞须两侧同步）
export const DEPLOY_LOG_EXPIRED_RE = /deploy log expired/i

/**
 * @param message 消息 API 显式注入：通知中心不经 NMessageProvider 挂载
 *（discrete API 同范式），传入其离散 message；缺省走组件树 useMessage()
 */
export function useDeployLogDownload(message?: MessageApiInjection) {
  const messageApi = message ?? useMessage()
  const { t } = useI18n()

  /** 下载一次部署日志；hostLabel 仅用于合成可读下载名（可缺省回退任务 id） */
  async function downloadLog(taskId: string, hostLabel = ''): Promise<void> {
    try {
      const blob = (await deployApi.downloadLog(taskId)) as unknown as Blob
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFileName(hostLabel || taskId, new Date(), 'txt', 'deploy')
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      messageApi.success(t('deploy.logDownload.done'))
    } catch (e) {
      const err = e as AppError | undefined
      // 410 过期（1h 内存窗外）：blob 错误体就地解析，给明确「不可下载」提示
      if (err?.data instanceof Blob && DEPLOY_LOG_EXPIRED_RE.test(await err.data.text())) {
        messageApi.warning(t('deploy.logDownload.expired'), { duration: 6000 })
        return
      }
      messageApi.error(err?.userMessage || t('deploy.logDownload.failed'))
    }
  }

  return { downloadLog }
}
