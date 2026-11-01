import { ref } from 'vue'
import { settingsApi } from '../api/domains/system'

/**
 * 服务端路径分隔符：项目/克隆的路径拼接必须按运行服务的 OS，
 * 而非浏览器 OS——远程部署（Windows 浏览器 → Linux 服务）时
 * navigator.platform 会误导出反斜杠导致添加项目失败。
 * 从 settings 接口取 platform（runtime.GOOS），模块级缓存一次。
 */
const sep = ref('/')
let fetched = false

async function ensureServerSep(): Promise<string> {
  if (fetched) return sep.value
  fetched = true
  try {
    const res: any = await settingsApi.get({ silent: true })
    const platform = String(res.data?.platform || '')
    sep.value = platform.toLowerCase().startsWith('win') ? '\\' : '/'
  } catch {
    sep.value = '/'
  }
  return sep.value
}

// 同步取值：未拉取到时回退 '/'（Linux 部署是主要远程场景）；
// 组件挂载时先触发一次异步拉取，后续拼接拿到的都是准确值
export function serverPathSep(): string {
  void ensureServerSep()
  return sep.value
}
