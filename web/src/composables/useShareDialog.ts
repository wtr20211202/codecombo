import { h, ref } from 'vue'
import type { VNodeChild } from 'vue'
import { projectApi } from '../api/client'
import {
  shareApi, fetchShareAddressExtras, type ShareAddressExtras, type ShareInfo, type ShareMode, type ShareServiceStatus,
} from '../api/domains/share'
import { settingsApi } from '../api/domains/system'
import { buildShareAddressPlan, type ShareAddressPlan } from '../utils/shareAddress'
import { confirmDialog } from './useDialog'
import { shareTtlExpiresAt, type ShareDefaultTtl, type ShareTtlChoice } from '../utils/shareTtl'
import i18n from '../i18n'

// 分享创建流程 + 结果弹窗的模块级单例状态（与 useAgentTerminal 同范式）：
// 文件树右键等任意入口调 createShare 先弹创建弹层选模式（live 活视图 /
// frozen 冻结快照，P-20261003-320），确认后走完整创建链路——服务端敏感文件
// 扫描命中时弹警示确认框，确认后才带 override 二次请求；创建成功即 openResult
// 弹出短链卡片。"管理全部分享"跳转主区视图（usePanelLayout.showShareManager
// 驱动），弹窗宿主（App 层 ShareDialogsHost 挂载的 ShareResultDialog /
// ShareCreateDialog，P-20261108-1——首页/值班大屏等不经 Layout 的入口同样
// 弹得出）只消费状态
//
// 短链一律由 utils/shareAddress 的地址计划生成（P-20261020-2）：settings 的
// 分享外发基址/外部访问地址 + 当前地址/局域网候选与分享状态同批取，结果卡、
// 管理器、二维码与直播邀请通知共用同一口径。

const showResult = ref(false)
const resultShare = ref<ShareInfo | null>(null)
const resultUrl = ref('')
// 本次创建会话内已知的明文口令（P-20261020-6）：仅存活于结果卡打开期间，
// 供「复制邀请信息」使用；绝不落 localStorage/URL/日志，关闭结果卡即清空。
// 幂等重建命中既有记录时口令未知，保持空串（不提供邀请复制，避免给错口令）
const resultPassphrase = ref('')
/** 结果卡的可达性计划（徽标/提示数据源；null = 尚未生成） */
const resultPlan = ref<ShareAddressPlan | null>(null)

const EMPTY_STATUS: ShareServiceStatus = { running: false, port: 0, scheme: '' }

/** 创建流程的地址上下文：状态与地址两路并行取，失败各自降级（终端输出分享
 *  选项流 useTermShareDialog 同源复用） */
export async function loadAddressContext(): Promise<{ status: ShareServiceStatus; extras: ShareAddressExtras }> {
  const [statusRes, extras] = await Promise.all([
    shareApi.status(),
    fetchShareAddressExtras(),
  ])
  const status = (statusRes as unknown as { data?: ShareServiceStatus })?.data ?? EMPTY_STATUS
  return { status, extras }
}

export function planFor(token: string, status: ShareServiceStatus, extras: ShareAddressExtras): ShareAddressPlan {
  return buildShareAddressPlan(token, {
    currentHref: window.location.href,
    status,
    ...extras,
  })
}

// 创建弹层状态：目标（projectId/path/展示名/是否目录）+ 所选模式 + 可选访问口令
//（P-20261006-25，空串 = 不设门）+ 溯源水印开关（P-20261005-193，缺省开）
// + 一次性查看开关（P-20261006-27，缺省关——阅后即焚是 opt-in 的激进选项，
// 不能让「忘了取消勾选」把常规分享变成看一眼即死）
// isDir 供单文件 HTML 的「外部资源不会随文件生效」提示（P-20261020-4）：
// 单文件分享的边界就是该文件，创建弹层在发请求前就要把边界讲清楚
const showCreate = ref(false)
const createTarget = ref<{ projectId: string; path: string; name: string; isDir: boolean; paths?: string[] } | null>(null)
const createMode = ref<ShareMode>('live')
const createPassphrase = ref('')
const createWatermark = ref(true)
const createViewOnce = ref(false)
// 批量选择集的体积预估（P-20261008-1）：弹层打开时异步取 files-archive
// probe 的聚合规模（entries/bytes），用于「合计体积」展示与 200MB 上限预警。
// null = 预估中/失败（弹层退化为只显示项数，不阻断创建）
const createEstimate = ref<{ entries: number; bytes: number; truncated: boolean } | null>(null)
let estimateSeq = 0
// 有效期（P-20261020-5）：创建时显式可选。touched=false 表示用户没动过选择，
// 请求不发 ttl/expiresAt——服务端按 settings.shareDefaultTTL（live，缺省永久）
// 或 frozen 30 天默认兜底，默认值变更不需要前端跟随发版
const createTtlChoice = ref<ShareTtlChoice>('permanent')
const createTtlDate = ref<number | null>(null)
const createTtlTouched = ref(false)
// 服务端默认档镜像（仅用于弹层预选展示；真值仍以服务端创建结果为准）
const createTtlDefault = ref<ShareDefaultTtl>('permanent')

// 警示框逐条列出的命中文件上限：超出折叠为「另有 n 个」（全量清单已在
// 服务端返回，列表过长只会淹没重点）
const MAX_LISTED_FILES = 8

/** 敏感文件警示确认框：命中文件清单（超长折叠）+ 部分扫描标注。
 *  P-26 扫描警示流的共享实现：分享创建（默认键）与目录打包下载
 *  （fileTree.dirArchive.* 键）同款交互，仅文案键可换 */
export function confirmSensitiveFiles(
  warnings: string[],
  truncated: boolean,
  keys = {
    title: 'share.scan.warningTitle',
    intro: 'share.scan.warningIntro',
    more: 'share.scan.moreFiles',
    partial: 'share.scan.partialNote',
    confirm: 'share.scan.confirmShare',
  },
): Promise<boolean> {
  const t = i18n.global.t
  const total = warnings.length
  const shown = warnings.slice(0, MAX_LISTED_FILES)
  const muted = 'margin:6px 0 0;font-size:12px;'
  return confirmDialog({
    type: 'warning',
    title: t(keys.title),
    content: (): VNodeChild => h('div', null, [
      h('p', { style: 'margin:0 0 6px' }, t(keys.intro, { n: total })),
      h('ul', { style: 'margin:0;padding-left:18px;max-height:180px;overflow:auto;word-break:break-all' },
        shown.map(f => h('li', f))),
      total > shown.length
        ? h('p', { style: `${muted}color:var(--text-secondary)` }, t(keys.more, { n: total - shown.length }))
        : null,
      truncated
        ? h('p', { style: `${muted}color:var(--accent-orange)` }, t(keys.partial))
        : null,
    ]),
    confirmText: t(keys.confirm),
  })
}

/**
 * 敏感会话出域警示确认框（P-20261003-155）：会话被人工标记敏感时，导出输出
 * 与终端直播分享两条出域链在动作前弹「确认出域」——与 confirmSensitiveFiles
 * 同族交互（警示型 confirm，取消即不动、零副作用），仅文案不同
 */
export function confirmSensitiveSessionEgress(sessionName: string): Promise<boolean> {
  const t = i18n.global.t
  return confirmDialog({
    type: 'warning',
    title: t('terminal.sensitiveEgressTitle'),
    content: t('terminal.sensitiveEgressIntro', { name: sessionName }),
    confirmText: t('terminal.sensitiveEgressConfirm'),
  })
}

export function useShareDialog() {
  function openResult(share: ShareInfo, plan: ShareAddressPlan, passphrase = '') {
    resultShare.value = share
    resultPlan.value = plan
    resultUrl.value = plan.url
    resultPassphrase.value = passphrase
    showResult.value = true
  }

  /** 关闭即丢弃明文口令（内存单点）：之后没有任何路径可回显，符合
   *  「口令明文只存在于创建会话」的约束 */
  function clearResultSecret() {
    resultPassphrase.value = ''
  }

  function closeResult() {
    showResult.value = false
    clearResultSecret()
  }

  /** 一次创建请求：创建与地址上下文（子服务状态 + 分享基址/外部地址/候选）
   *  并行取——结果卡的短链与徽标由同一份快照生成（P-20261020-2） */
  async function requestCreate(projectId: string, path: string, override: boolean, mode: ShareMode = 'live', passphrase = '', watermark = true, viewOnce = false, ttl?: ShareTtlChoice, expiresAt?: string) {
    // 拦截器已解包 envelope：返回值即响应体 {data?, warnings?, scanTruncated?}
    const [created, context] = await Promise.all([
      shareApi.create(projectId, path, override, mode, passphrase, watermark, viewOnce, ttl, expiresAt),
      loadAddressContext(),
    ])
    const body = created as unknown as { data?: ShareInfo; warnings?: string[]; scanTruncated?: boolean }
    return {
      share: body?.data ?? null,
      warnings: body?.warnings ?? [],
      truncated: body?.scanTruncated === true,
      status: context.status,
      extras: context.extras,
    }
  }

  /**
   * 拉取服务端默认有效期用于弹层预选（P-20261020-5）。失败静默回落永久：
   * 用户没动过选择时请求本就不带 ttl，服务端仍按当前设置兜底；这里只是让
   * 弹层显示与服务端一致，不是数据源
   */
  async function loadCreateTtlDefault(): Promise<void> {
    try {
      // 拦截器已解包 envelope：返回值即 {data: SettingsData}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await settingsApi.get({ silent: true })
      const v = res?.data?.shareDefaultTTL
      if (v !== 'permanent' && v !== '1d' && v !== '7d' && v !== '30d') return
      createTtlDefault.value = v
      // 在途期间用户已改过选择 / 已切 frozen / 弹层已关：不覆盖用户意图
      if (showCreate.value && createMode.value !== 'frozen' && !createTtlTouched.value) {
        createTtlChoice.value = v
      }
    } catch { /* silent：回落 permanent */ }
  }

  /** 一次批量创建请求（P-20261008-1）：与单路径 create 同构，只是载荷用
   *  paths 集合且服务端固定 frozen 模式；敏感扫描 warnings/override 契约不变。
   *  地址上下文与创建并行取（P-20261020-2），结果卡与管理器同一口径 */
  async function requestCreateBatch(projectId: string, paths: string[], override: boolean, passphrase = '', watermark = true) {
    const [created, context] = await Promise.all([
      shareApi.createBatch(projectId, paths, override, passphrase, watermark),
      loadAddressContext(),
    ])
    const body = created as unknown as { data?: ShareInfo; warnings?: string[]; scanTruncated?: boolean }
    return {
      share: body?.data ?? null,
      warnings: body?.warnings ?? [],
      truncated: body?.scanTruncated === true,
      status: context.status,
      extras: context.extras,
    }
  }

  /** 创建成功收尾：按统一地址计划拼短链并弹结果卡；passphrase 仅随本次
   *  创建会话传入，结果卡关闭后由 clearResultSecret 丢弃 */
  function openCreated(res: Awaited<ReturnType<typeof requestCreate>>, passphrase = '') {
    if (res.share) openResult(res.share, planFor(res.share.token, res.status, res.extras), passphrase)
  }

  /** 批量选择集规模预估（只读 probe，失败静默退化为「仅项数」展示）。
   *  序号守卫：连续打开不同选择集时只认最后一次的响应（防旧预估盖新目标） */
  async function loadBatchEstimate(projectId: string, paths: string[]): Promise<void> {
    const seq = ++estimateSeq
    createEstimate.value = null
    try {
      const res = (await projectApi.filesArchiveProbe(projectId, paths)) as unknown as {
        data?: { entries?: number; bytes?: number; truncated?: boolean }
      }
      if (seq !== estimateSeq) return
      createEstimate.value = {
        entries: res?.data?.entries ?? paths.length,
        bytes: res?.data?.bytes ?? 0,
        truncated: res?.data?.truncated === true,
      }
    } catch {
      if (seq === estimateSeq) createEstimate.value = null
    }
  }

	/**
	 * 创建分享入口：先弹创建弹层选模式（live 活视图 / frozen 冻结快照），
	 * 确认后进 confirmCreate 完整链路。name 供弹层展示目标（文件树入口传
	 * 末段名/项目名，缺省回落 path 末段）；isDir 决定单文件 HTML 提示是否
	 * 出现（P-20261020-4），缺省 false 与「单文件」语义一致。口令/水印/
	 * 一次性开关每次打开重置（弹层是单例，残留会把上一目标的选择带给下一目标）
	 */
	function createShare(projectId: string, path: string, name = '', isDir = false): void {
		if (!projectId) return
		createTarget.value = {
			projectId,
			path,
			name: name || (path ? path.split('/').pop() || path : ''),
			isDir,
		}
		createMode.value = 'live'
		createPassphrase.value = ''
		createWatermark.value = true
		createViewOnce.value = false
		createEstimate.value = null
		estimateSeq++ // 作废上一批的预估响应
		// 有效期回到「未触碰」：预选服务端默认档（拉取前先显示已缓存的镜像）
		createTtlChoice.value = createTtlDefault.value
		createTtlDate.value = null
		createTtlTouched.value = false
		void loadCreateTtlDefault()
		showCreate.value = true
	}

	/**
	 * 批量分享入口（P-20261008-1）：文件树多选 ≥2 右键「分享选中」。MVP 仅
	 * frozen 模式（多路径定格评审包；live 多锚定根语义留注记不做）——模式在
	 * 这里直接置 frozen，弹层只展示冻结语义与集合清单。展示名取首项 basename
	 * + 其余计数（服务端同口径兜底）；体积预估异步取 files-archive probe
	 */
	function createShareBatch(projectId: string, paths: string[]): void {
		if (!projectId || paths.length === 0) return
		const first = paths[0] ?? ''
		const name = first.split('/').pop() || first
		createTarget.value = {
			projectId,
			path: '',
			name: paths.length > 1 ? `${name} +${paths.length - 1}` : name,
			isDir: false,
			paths: [...paths].sort(),
		}
		createMode.value = 'frozen'
		createPassphrase.value = ''
		createWatermark.value = true
		createViewOnce.value = false
		showCreate.value = true
		void loadBatchEstimate(projectId, paths)
	}

	/**
	 * 创建弹层确认后的完整链路：首次请求不带 override——服务端敏感文件扫描
	 * 命中时返回 warnings 且不创建（frozen 的半成品副本由服务端一并丢弃），
	 * 弹警示框列出命中文件；用户「仍然分享」后才带 override 二次请求真正
	 * 创建（取消则无事发生）。可选口令/水印/一次性开关随两次请求同参
	 *（P-20261006-25 / P-20261005-193 / P-20261006-27）
	 */
	async function confirmCreate(): Promise<void> {
		const target = createTarget.value
		if (!target) return
		// 有效期（P-20261020-5）：用户主动改过才显式携带；未改 = 交给服务端默认
		// （默认值变更对旧客户端也是增量语义）。自定义日期未选 = 无效提交
		let ttl: ShareTtlChoice | undefined
		let expiresAt: string | undefined
		if (createTtlTouched.value) {
			if (createTtlChoice.value === 'custom') {
				const iso = shareTtlExpiresAt('custom', createTtlDate.value)
				if (!iso) return
				expiresAt = iso
			} else {
				ttl = createTtlChoice.value
			}
		}
		showCreate.value = false
		const batch = target.paths && target.paths.length > 0
		// 批量仅 frozen（服务端拒绝 live；弹层展示即此语义），单路径走所选模式
		const mode: ShareMode = batch ? 'frozen' : createMode.value
		const passphrase = createPassphrase.value
		const watermark = createWatermark.value
		// frozen 与一次性互斥（服务端 400）：创建弹层已禁用该勾选（frozen
		// 选中时），此处兜底不把 true 发出去——状态残留/编程调用双保险
		const viewOnce = mode === 'frozen' ? false : createViewOnce.value
		const request = (override: boolean) => batch
			? requestCreateBatch(target.projectId, target.paths!, override, passphrase, watermark)
			: requestCreate(target.projectId, target.path, override, mode, passphrase, watermark, viewOnce, ttl, expiresAt)
		try {
			const first = await request(false)
			if (first.share) {
				openCreated(first, passphrase)
				return
			}
			// 无 data 且无 warnings：异常形态（正常警告流必有 warnings），静默收场
			if (!first.warnings.length) return
			const go = await confirmSensitive(first.warnings, first.truncated)
			if (!go) return
			openCreated(await request(true), passphrase)
		} catch { /* 拦截器处理 */ }
	}

	function cancelCreate(): void {
		showCreate.value = false
	}

	/**
	 * 分享会话回放（P-20261004-103）：把一次录制的 cast 以只读回放页短链
	 * 分享出去（异步 walkthrough——教学/复盘/展示）。服务端在创建时刻快照
	 * cast（录制继续写不影响访客），默认 1 小时 TTL。敏感模式扫描命中且未
	 * 确认时响应不带 data 只带 warnings（行号清单，不含命中原文），弹
	 * 「仍然分享」确认框后带 override 二次请求（P-97 同语义；即使确认，
	 * 落盘快照仍会兜底遮蔽）。同一录制重复分享恒同链。
	 */
	async function createRecordingShare(recordingId: string): Promise<void> {
		if (!recordingId) return
		try {
			const [firstRaw, context] = await Promise.all([
				shareApi.createCast(recordingId),
				loadAddressContext(),
			])
			let created = firstRaw as unknown as { data?: ShareInfo; warnings?: string[]; scanTruncated?: boolean }
			if (!created?.data && created?.warnings?.length) {
				const go = await confirmSensitiveFiles(created.warnings, created.scanTruncated === true, {
					title: 'share.cast.scanWarningTitle',
					intro: 'share.cast.scanWarningIntro',
					more: 'share.cast.scanWarningMore',
					partial: 'share.cast.scanWarningPartial',
					confirm: 'share.cast.scanWarningConfirm',
				})
				if (!go) return
				created = await shareApi.createCast(recordingId, true) as unknown as { data?: ShareInfo; warnings?: string[]; scanTruncated?: boolean }
			}
			if (created?.data) {
				openResult(created.data, planFor(created.data.token, context.status, context.extras))
			}
		} catch { /* 拦截器处理 */ }
	}

	/**
	 * 会话回放只读分享（P-20261003-77）：把一条 Claude 会话的完整时间线
	 *（含思考块/工具详情）分享为只读访客页。服务端在创建时刻快照条目并做
	 * P-108 敏感值遮蔽（快照即净本，访客无「显示原文」出口），默认 24h TTL。
	 * 同一会话重复分享恒同链（倒计时不续期，重分享跟进新增回合）；会话不存在
	 * → 404、无可回放条目 → 400（拦截器 toast 具体原因）
	 */
	async function createSessionShare(sessionId: string): Promise<void> {
		if (!sessionId) return
		try {
			const [createdRaw, context] = await Promise.all([
				shareApi.createSession(sessionId),
				loadAddressContext(),
			])
			const created = createdRaw as unknown as { data?: ShareInfo }
			if (created?.data) {
				openResult(created.data, planFor(created.data.token, context.status, context.extras))
			}
		} catch { /* 拦截器处理 */ }
	}

  /** 敏感文件警示确认框：清单渲染收口在模块级 confirmSensitiveFiles
   *  （目录打包下载 P-20261002-115 同款复用），这里只传分享默认文案键 */
  function confirmSensitive(warnings: string[], truncated: boolean): Promise<boolean> {
    return confirmSensitiveFiles(warnings, truncated)
  }

	return {
    showResult, resultShare, resultUrl, resultPassphrase, resultPlan, openResult, closeResult, clearResultSecret,
    showCreate, createTarget, createMode, createPassphrase, createWatermark, createViewOnce, createEstimate,
    createTtlChoice, createTtlDate, createTtlTouched, createTtlDefault,
    createShare, createShareBatch, confirmCreate, cancelCreate,
    // 直播/输出快照创建入口已迁 useTermShareDialog（P-20261106-9 选项弹层；
    // 它单向依赖本模块的结果卡/地址原语，本模块不反向 import——无环）
    createRecordingShare, createSessionShare,
  }
}
