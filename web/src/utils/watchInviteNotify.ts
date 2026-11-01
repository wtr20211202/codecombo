import i18n from '../i18n'
import { useNotificationStore } from '../stores/notification'
import { shareApi, fetchShareAddressExtras, resolveShareAddressPlan } from '../api/domains/share'
import type { WatchInviteDetail } from './opsEvents'

/**
 * 直播邀请通知链（P-20261005-165）：watch.invite 事件 → 形态复验 → 去重 →
 * 拼访客短链 → 通知中心入账（action='url'，点击新窗打开访客直播页）。
 * agent 开完终端直播（POST /api/share/terminal）后「请人来看」的 human-pull
 * 原语——直播投资的通知面收口。
 * 逻辑独立成纯函数模块：不持有视图状态，OpsChannelBridge 仅委托一行——
 * 与 previewPortNotify（P-20261002-70）/agentTaskNotify（P-20261002-15）同构。
 */

// —— url 形态复验（与服务端 opsentry.go isShareVisitorPath 同一白名单）——
// 服务端发布口已校验，此处防其它来源（同 previewPortNotify 复验口径）：
// 恰为 /s/<token>，token 段仅 [0-9a-zA-Z]——. / ? # @ % \ 等可构造穿越段/
// 路径拼接/query/编码绕过的字符在字符层面即拒，前缀锁死拒绝绝对 URL/
// 协议相对外链（//…）/伪协议。该值最终经 window.open 打开，白名单是唯一防线
export function isShareVisitorPath(url: string): boolean {
  const prefix = '/s/'
  if (typeof url !== 'string') return false
  if (url.length <= prefix.length || url.length > 80 || !url.startsWith(prefix)) return false
  for (let i = prefix.length; i < url.length; i++) {
    const c = url.charAt(i) // charAt 越界返回空串自然落拒（noUncheckedIndexedAccess 口径）
    const ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
    if (!ok) return false
  }
  return true
}

// 邀请文案展示上限：title/body 是 agent 自由文本，服务端尺寸墙 4096 字节兜底
// 入广播流，展示面再截 200（与 ops-notify type=notify 的 toast 截断同口径）
const TEXT_SLICE = 200

// —— 会话内去重：同 url+title+body 只入账一次（agent 重试/重复上报防通知
// 轰炸；agent 真要再拉一次人改文案即可）。指纹表模块级（多标签页各自一份）；
// 上限防长会话无界增长（同 previewPortNotify 指纹表惯例）
const reportedFingerprints = new Set<string>()
const FP_MAX = 200

function markReported(key: string): void {
  reportedFingerprints.add(key)
  if (reportedFingerprints.size > FP_MAX) {
    const first = reportedFingerprints.values().next()
    if (!first.done) reportedFingerprints.delete(first.value)
  }
}

// 测试钩子：清空模块级状态（用例间隔离）
export function resetWatchInviteNotifyStateForTest(): void {
  reportedFingerprints.clear()
}

/**
 * 通知链入口（OpsChannelBridge 对每个 watch.invite 事件调用一次）：
 * 非法 url 静默忽略（服务端已校验，此处防其它来源）；重复邀请整链跳过。
 * 返回 true = 本次已处理（入账），false = 忽略或去重命中。
 * 访客短链住独立端口分享子服务（server/share），相对路径在主服务 origin 下打开
 * 会 404——入账前经 GET /api/share/status 拼回绝对访客地址；status 不可得
 * （子服务未就绪/查询失败）降级原样入账相对路径，分享子服务恢复后点击仍可达
 */
export async function handleWatchInviteNotify(p: WatchInviteDetail): Promise<boolean> {
  if (!isShareVisitorPath(p.url)) return false
  const title = (p.title || '').trim().slice(0, TEXT_SLICE)
  const body = (p.body || '').trim().slice(0, TEXT_SLICE)
  // 去重打标同步先于任何 await：并发重放上只有首个完成入账
  const key = `${title}|${body}|${p.url}`
  if (reportedFingerprints.has(key)) return false
  markReported(key)

  const actionPayload = await resolveVisitorUrl(p.url)
  const t = (k: string, params?: Record<string, unknown>) => i18n.global.t(k, params as never)
  // 通知中心入账：后端失败 store.add 自动降级本地插入。归类 task（agent 上报链
  // 与预览端口直达同门类，「任务」子开关一并管辖）；动作 url → 通知 store
  // handleClick 直开新窗（不进 pendingAction 路由桥，P-20261007-15 既有语义）
  void useNotificationStore().add({
    type: 'info',
    category: 'task',
    title: title || t('notify.watchInvite.title'),
    body: body || t('notify.watchInvite.body'),
    action: 'url',
    actionPayload,
  })
  return true
}

/**
 * 访客短链拼装：走统一地址计划（P-20261020-2）——分享基址/外部访问地址 >
 * 当前非回环地址 > 局域网候选 > 旧 host:sharePort 回退；状态与地址上下文
 * 同时取，plan.url 为空（子服务未就绪/查询失败）时降级原样入账相对路径
 * （邀请事实本身仍值得入账；主应用同源代理恢复后点击仍可达）
 */
async function resolveVisitorUrl(path: string): Promise<string> {
  try {
    // 响应拦截器已解包：res 即 { data: ShareServiceStatus }（同 useShareDialog 断言惯例）
    const res = await shareApi.status() as unknown as { data?: { running: boolean; port: number; scheme: '' | 'http' | 'https' } }
    const status = res.data
    if (status) {
      // 通知点击发生在当前浏览器：显式清空局域网候选。回环入口下候选可能
      // 指向未监听/不可达的网卡（如 WSL vEthernet 172.26.x），点开即失败；
      // 候选只用于「发给别人」的分享链接（结果卡/管理器）。这里保留
      // sharePublicBaseUrl > externalAccessUrl > 当前 origin，回环无候选
      // 时走旧格式 host:sharePort（本机可达）——与 P-2 之前的通知口径一致
      const extras = await fetchShareAddressExtras()
      const plan = await resolveShareAddressPlan(path.slice('/s/'.length), status, {
        ...extras,
        addresses: [],
      })
      if (plan.url) return plan.url
    }
  } catch {
    // 静默降级：状态面不可得不算邀请失败
  }
  return path
}
