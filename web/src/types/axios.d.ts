import 'axios'

declare module 'axios' {
  interface AxiosRequestConfig {
    /** 后台/轮询请求：失败时不弹提示，仅写 Console */
    silent?: boolean
    /** 关键路径专属 i18n key：覆盖分类兜底文案 */
    errorLabel?: string
  }
}
