// useDiagHist —— 远程主机最近诊断趋势摘要共享单例（P-20261002-18）
//
// 诊断是低频人工动作，不做周期轮询：模块级共享 map + 手动刷新。
// 消费方：
// - 远程控制台主机列表（RemoteHostList）：卡片显示最近诊断时间，悬停看趋势；
// - DiagnoseDialog：每次诊断完成后 refresh，保证侧栏与新落盘的快照一致。
import { ref } from 'vue'
import { diagHistApi, type DiagHistSummary } from '../api/client'

const diagHistMap = ref<Record<string, DiagHistSummary>>({})
let fetching = false

async function fetchDiagHist() {
  if (fetching) return
  fetching = true
  try {
    // 响应拦截器已解包：res 即响应体 { data: { <hostId>: DiagHistSummary } }
    const res = await diagHistApi.summary({ silent: true }) as unknown as {
      data?: Record<string, DiagHistSummary>
    }
    diagHistMap.value = res.data || {}
  } catch { /* silent：锁定态/网络抖动保留上次结果 */ }
  finally {
    fetching = false
  }
}

/** 共享诊断趋势摘要：diagHistMap[id] 缺省视为无历史（卡片不显示诊断时间） */
export function useDiagHist() {
  return { diagHistMap, refresh: fetchDiagHist }
}
