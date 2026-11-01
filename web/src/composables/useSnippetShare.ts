import { computed, ref } from 'vue'
import {
  shareApi, fetchShareAddressExtras, SNIPPET_MAX_BYTES,
  type ShareAddressExtras, type ShareInfo, type ShareServiceStatus,
} from '../api/domains/share'
import { buildShareAddressPlan, type ShareAddressPlan } from '../utils/shareAddress'
import { useShareDialog } from './useShareDialog'

// 文本片段分享流程（P-20261002-71）：终端右键/编辑器右键/命令面板三入口
// 统一走 openShareSnippet——弹窗内确认「将公开此文本」后创建，成功复用
// useShareDialog 的短链结果卡。模块级单例状态（与 useShareDialog 同范式），
// 弹窗宿主（Layout 挂载的 ShareSnippetDialog）只消费状态

const showDialog = ref(false)
const draftContent = ref('')
const draftName = ref('')
// 片段访问口令（P-20261020-6）：终端选区/交接文档常是最敏感的文本——可选
// 口令让片段不再只能「公开或一次性」。空串 = 不设门（旧行为零变化）
const draftPassphrase = ref('')
const draftViewOnce = ref(false)
const submitting = ref(false)

/** 字节计数（服务端上限按字节）：TextEncoder 逐次新建成本可忽略（≤32KB 文本），
 *  放 computed 随草稿联动而非每次输入全量重算 UI */
const byteLength = computed(() => new TextEncoder().encode(draftContent.value).length)
const overLimit = computed(() => byteLength.value > SNIPPET_MAX_BYTES)

export function useSnippetShare() {
  const { openResult } = useShareDialog()

  /** 打开片段分享弹窗（prefill = 终端选区/编辑器选区；空 = 命令面板裸开）。
   *  一次性开关与口令每次打开重置（模块级单例，残留会把上一目标的选择
   *  带给下一目标，口令残留更是安全面） */
  function openShareSnippet(prefill = '') {
    draftContent.value = prefill
    draftName.value = ''
    draftPassphrase.value = ''
    draftViewOnce.value = false
    showDialog.value = true
  }

  function closeDialog() {
    showDialog.value = false
    // 关闭即丢弃草稿口令：成功路径已把明文交给结果卡单例，失败路径重开时
    // 重新输入（不留驻模块级状态）
    draftPassphrase.value = ''
  }

  /** 创建请求：创建与地址上下文（子服务状态 + 分享基址/外部地址/候选）
   *  并行取，与 useShareDialog.requestCreate 同构；结果卡的 URL 与徽标
   *  由同一份地址计划生成（P-20261020-2）。viewOnce 一次性查看
   *  （P-20261006-27）可选透传，缺省 false 不发字段（旧对端兼容）；
   *  passphrase 片段访问口令（P-20261020-6），空串缺省不发字段 */
  async function requestCreate(content: string, name: string, viewOnce = false, passphrase = '') {
    const [createdRaw, statusRes, extras] = await Promise.all([
      shareApi.createSnippet(content, name, passphrase, true, viewOnce),
      shareApi.status(),
      fetchShareAddressExtras(),
    ])
    const created = createdRaw as unknown as { data?: ShareInfo }
    const status = (statusRes as unknown as { data?: ShareServiceStatus })?.data
      ?? { running: false, port: 0, scheme: '' as const }
    const plan: ShareAddressPlan | null = created?.data
      ? buildShareAddressPlan(created.data.token, {
          currentHref: window.location.href,
          status,
          ...extras,
        })
      : null
    return {
      share: created?.data ?? null,
      status,
      extras: extras as ShareAddressExtras,
      plan,
    }
  }

  /** 提交创建：客户端先行校验（空/超限），成功即弹短链结果卡并把本次明文
   *  口令交给结果卡单例（仅存活到结果卡关闭） */
  async function submitSnippet(): Promise<boolean> {
    if (submitting.value) return false
    if (!draftContent.value.trim()) return false
    if (overLimit.value) return false
    submitting.value = true
    try {
      const passphrase = draftPassphrase.value
      const res = await requestCreate(draftContent.value, draftName.value.trim(), draftViewOnce.value, passphrase)
      const plan = res.plan
      if (!res.share || !plan) return false
      showDialog.value = false
      openResult(res.share, plan, passphrase)
      return true
    } catch {
      return false
    } finally {
      submitting.value = false
    }
  }

  return {
    showDialog,
    draftContent,
    draftName,
    draftPassphrase,
    draftViewOnce,
    submitting,
    byteLength,
    overLimit,
    maxBytes: SNIPPET_MAX_BYTES,
    openShareSnippet,
    closeDialog,
    submitSnippet,
    // requestCreate 导出供自宿主渲染结果的调用方复用（P-20261005-148 值班
    // 交接包弹窗：创建+子服务状态并行取同原语，结果卡由调用方自渲染——
    // ShareResultDialog 只挂 Layout，独立路由宿主够不到）
    requestCreate,
  }
}
