/**
 * 动作图标语义注册表（P-20261022-1 动作映射 / P-20261022-2 目的地 nav 段与禁配对）
 *
 * 动机：同产品内「更多」曾实心/描边并用、pull 曾用 Refresh/CloudDownload 两种图形、
 * CloudDownload 一图四义（clone/fetch/fetchAll/pull）、Sync 一图四义（分享轮换/轮播/
 * 诊断对比/Git 对比）——14px 工具条上几不可辨，轮换分享链接这类不可逆动作误点代价高。
 * P-20261022-2 补齐导航面：目的地图标一图一目的地（NAV_ICONS）+ 终审禁配对
 * （FORBIDDEN_ICON_PAIRS）——rail 是每屏常驻的最高频导航面，形状点错即进错面板。
 *
 * 纪律：业务代码需要这些动作时从本表取图标，不要随手换用「看起来差不多」的兄弟图形；
 * icon-only 按钮的 title/aria-label 纪律（P-20261005-213）与热区纪律（P-20261019-5）
 * 不变。新增动作键时同步维护 docs/design/icon-semantics.md 与
 * `npm run check:icon-semantics` 的邻接族表；新增目的地（rail 面板/首页工具条）时
 * 必须登记 NAV_ICONS；新增图标前的占用与相似对自查用
 * `node scripts/icon-similarity-report.mjs`（web/ 内，按需手跑）。
 *
 * 本文件被 `web/scripts/check-icon-semantics.mjs` 以文本形式解析（零依赖、无 TS 运行时），
 * 保持「一行一个 '键': IconName」与数组字面量格式——改格式需同步脚本解析器。
 */
import type { Component } from 'vue'
import {
  AddOutline,
  AlbumsOutline,
  AlertCircleOutline,
  ArrowBackOutline,
  ArrowDownCircleOutline,
  ArrowRedoOutline,
  ChatboxEllipsesOutline,
  ChatbubbleEllipsesOutline,
  ChatbubblesOutline,
  CheckmarkDoneOutline,
  CheckmarkOutline,
  ClipboardOutline,
  CloseOutline,
  CloudCircleOutline,
  CloudDownloadOutline,
  CloudUploadOutline,
  ColorPaletteOutline,
  CopyOutline,
  CreateOutline,
  DocumentTextOutline,
  DownloadOutline,
  DuplicateOutline,
  EllipsisHorizontalOutline,
  EyeOffOutline,
  EyeOutline,
  FlashOutline,
  FolderOutline,
  GitBranchOutline,
  GitCommitOutline,
  GitCompareOutline,
  GitMergeOutline,
  GitNetworkOutline,
  GitPullRequestOutline,
  GlobeOutline,
  HandLeftOutline,
  HelpCircleOutline,
  HomeOutline,
  KeyOutline,
  LinkOutline,
  LockClosedOutline,
  LockOpenOutline,
  MoonOutline,
  NotificationsOutline,
  OpenOutline,
  PinOutline,
  PulseOutline,
  QrCodeOutline,
  RefreshOutline,
  RepeatOutline,
  SearchOutline,
  ServerOutline,
  SettingsOutline,
  SpeedometerOutline,
  TerminalOutline,
  TrashBinOutline,
  TrashOutline,
  TvOutline,
} from '@vicons/ionicons5'

/**
 * 动作键 → 唯一图标组件。
 *
 * 键空间按域分段：common（跨页面通用）/ git / share / chat / claude / notify / nav。
 * 同一动作在所有页面必须取同一枚图形；同一文件里不得混用本表之外的近似变体。
 */
export const ACTION_ICONS = {
  // ---- 通用（工具栏 / 右键菜单 / 文件树） ----
  'common.more': EllipsisHorizontalOutline,
  'common.refresh': RefreshOutline,
  'common.retry': ArrowRedoOutline,
  'common.delete': TrashOutline,
  'common.recycleBin': TrashBinOutline,
  'common.edit': CreateOutline,
  'common.new': AddOutline,
  'common.copy': CopyOutline,
  'common.close': CloseOutline,
  'common.search': SearchOutline,
  'common.open': OpenOutline,
  'common.download': DownloadOutline,
  'common.hide': EyeOffOutline,
  'common.preview': EyeOutline,
  'common.pin': PinOutline,
  'common.lock': LockClosedOutline,
  'common.unlock': LockOpenOutline,

  // ---- Git ----
  'git.fetch': CloudDownloadOutline,
  'git.pull': ArrowDownCircleOutline,
  'git.push': CloudUploadOutline,
  'git.clone': DuplicateOutline,
  'git.branch': GitBranchOutline,
  'git.network': GitNetworkOutline,
  'git.compare': GitCompareOutline,
  'git.commit': GitCommitOutline,
  'git.merge': GitMergeOutline,
  'git.pr': GitPullRequestOutline,

  // ---- 分享 ----
  'share.reshare': RepeatOutline,
  'share.rotate': KeyOutline,
  'share.qr': QrCodeOutline,
  // 直通输入握手（P-20261024-1）：HandLeftOutline（举手 = 请求/持权中）——
  // 批准与收回是同域反向动作（菜单文案区分方向），图形同一枚保持「握手域」辨识
  'share.directApprove': HandLeftOutline,

  // ---- 聊天三态（按「会话 / 行内评论 / 队列消息」固定一枚）----
  'chat.sessions': ChatbubblesOutline,
  'chat.comment': ChatbubbleEllipsesOutline,
  'chat.queue': ChatboxEllipsesOutline,

  // ---- 会话台账 ----
  'claude.filesWritten': DocumentTextOutline,

  // ---- 通知 ----
  'notify.center': NotificationsOutline,
  'notify.markAllRead': CheckmarkDoneOutline,
  'notify.dnd': MoonOutline,

  // ---- 导航 ----
  'nav.home': HomeOutline,
  'nav.back': ArrowBackOutline,
  'nav.settings': SettingsOutline,
  'nav.help': HelpCircleOutline,
} as const satisfies Record<string, Component>

export type ActionKey = keyof typeof ACTION_ICONS

/**
 * 目的地（导航）图标注册表（P-20261022-2）。
 *
 * 动机：P-20261022-1 只登记了动作键，导航/目的地图标（rail 面板、首页工具条）不在
 * 登记面——活动栏 rail 同屏两枚「圆点+连线」族（git 分支 × 分享网络）在 20px 深色
 * 底上几乎不可辨、首页两个目的地共用 HelpCircle、Speedometer 一图两目的地，都是
 * 注册面缺位导致的确定性冲突。
 *
 * 纪律：**一图一目的地**——同一图形不得对应两个不同目的地；同一目的地的多入口
 * （rail 按钮 + 底部 tab + 首页工具条）同图是正确一致性，键共用即可。键 = 目的地 id：
 * 面板键与 `panels/registry.ts` 的 `PanelDef.id` 一致（门禁 R6a 据此对账），首页工具条
 * 目的地用平铺 kebab id。动作段与 nav 段允许同图（如 HelpCircle 既是 nav.help 动作
 * 又是 help-center 目的地——同一语义的动作入口与目的地），改动作选型时须回查本表。
 *
 * 品牌图标（DshIcon）不经 ionicons，见 BRAND_NAV_ICONS 豁免。
 *
 * 本文件被 `web/scripts/check-icon-semantics.mjs` 以文本形式解析，保持
 * 「一行一个 '键': IconName」格式。
 */
export const NAV_ICONS = {
  // ---- 活动栏 rail / 底部 tab 面板（键 = PanelDef.id） ----
  'dashboard': SpeedometerOutline,
  'files': FolderOutline,
  'changes': CheckmarkOutline,
  'todos': ClipboardOutline,
  'stream': PulseOutline,
  'env': ServerOutline,
  // 多实例同步中心（P-20261023-1）：CloudCircleOutline（云+环 = 实例对间搬运）。
  // 刻意不用 CloudUploadOutline——那是动作段 git.push 的图形（一图一目的地纪律，
  // nav 与动作同图须走同图注记评审）；云环与远程控制台的 Globe 亦拉开形状
  'sync': CloudCircleOutline,
  'git': GitBranchOutline,
  'terminal': TerminalOutline,
  'notes': DocumentTextOutline,
  'agent-terminal': ChatbubblesOutline,
  // 分享管理：LinkOutline（链接 = 分享的核心交付物）。原 ShareSocialOutline 与 git
  // 的 GitBranchOutline 在 20px 深色 rail 同属「圆点+连线」族难辨（用户红框实测，
  // P-20261022-2 首批）；该对已入 FORBIDDEN_ICON_PAIRS 禁回潮
  'share-manager': LinkOutline,
  'remote-console': GlobeOutline,
  'preview': EyeOutline,
  'problems': AlertCircleOutline,
  'console': AlbumsOutline,

  // ---- 首页工具条目的地（home-action-btn） ----
  // 值班大屏：TvOutline（盯屏/大屏隐喻）。原 SpeedometerOutline 与活动栏「仪表盘」
  // 面板一图两目的地，肌肉记忆互相污染（P-20261022-2 首批）；仪表盘归还 Speedometer 专用
  'monitor': TvOutline,
  'theme': ColorPaletteOutline,
  'notification-center': NotificationsOutline, // = 动作 notify.center（同图注记）
  'help-center': HelpCircleOutline, // = 动作 nav.help（同图注记）
  // 快捷键：FlashOutline（闪电 = 快捷）。原与帮助中心共用 HelpCircle——两个相邻按钮
  // 同图零区分（P-20261022-2 首批）。与 fleet 批量动作同图：跨屏不同面、fleet 恒带
  // 文字按钮，注记接受
  'shortcuts': FlashOutline,
  'lock': LockClosedOutline, // = 动作 common.lock（进入锁定屏目的地，同图注记）
  'settings': SettingsOutline, // = 动作 nav.settings（同图注记）
} as const satisfies Record<string, Component>

export type NavKey = keyof typeof NAV_ICONS

/**
 * 品牌目的地图标：非 ionicons 的品牌/自定义组件，独占图形零混淆面，不走 NAV_ICONS
 * （值类型须为 ionicons 导出）。门禁 R6a 对账 rail 面板时按此清单豁免。
 */
export const BRAND_NAV_ICONS = ['DshIcon'] as const

/**
 * 感知相似度禁配对（P-20261022-2 终审「必改」档）。
 *
 * 全量像素排查（web/scripts/icon-similarity-report.mjs）+ 人工终审得出的「确认难辨、
 * 不得同屏」图形对：门禁 R6b 拦截 rail/NAV 注册表与 .vue 文件内的同屏共现
 * （.ts 渲染函数层由报告工具巡检）。与 ADJACENCY_FAMILIES 的区别：族是「同语法
 * 近似变体」，这里是「终审裁定必须拉开」的具体对。
 */
export const FORBIDDEN_ICON_PAIRS = [
  // GitBranchOutline × ShareSocialOutline：两枚「圆点+连线」图在 20px 深色 rail 同屏
  // 几乎不可辨（用户红框实测）——分享管理已换 LinkOutline，该对禁止回潮
  ['GitBranchOutline', 'ShareSocialOutline'],
] as const


/**
 * 禁用变体 → 替代映射/原因。
 *
 * 这些图形曾承载多个动作或与另一态混用，现已从源码清零；门禁按「导入名」全局拦截，
 * 基线外的任何新增命中即失败。确属装饰性场景也先走基线评审，不直接放行。
 */
export const BANNED_ICON_VARIANTS = {
  EllipsisHorizontal: '更多统一描边 EllipsisHorizontalOutline（P-20261022-1）',
  SyncOutline: '四义拆分：轮换→share.rotate(KeyOutline)、对比→git.compare、轮播→PlaySkipForwardOutline',
  ReloadOutline: '重试/重启统一 common.retry(ArrowRedoOutline)，避免与刷新环箭头混淆',
  AddCircleOutline: '新增统一 common.new(AddOutline)，圆形加号是同一动作的第二形态',
} as const

/**
 * 邻接冲突族：同一文件的两个 icon-only 按钮里，若分别使用同族的不同图形即视为
 * 语义冲突（门禁静态检查，存量走基线）。只收「在 14px 下难以区分」的人工确认对，
 * 不做视觉相似度启发式；带文字标签的菜单/按钮不参与该规则（文字承担消歧）。
 */
export const ADJACENCY_FAMILIES = {
  'refresh-ring': ['RefreshOutline', 'SyncOutline', 'ReloadOutline', 'RepeatOutline'],
  'more-dots': ['EllipsisHorizontal', 'EllipsisHorizontalOutline'],
  'chat-bubbles': ['ChatbubblesOutline', 'ChatbubbleEllipsesOutline', 'ChatboxEllipsesOutline'],
  'trash-cans': ['TrashOutline', 'TrashBinOutline'],
} as const

/**
 * 非动作图标白名单：本表之外、也不在 ACTION_ICONS 的 ionicons5 图标视为未分类，
 * 门禁报错。装饰性图标（类型徽标/状态点/导航箭头等）与暂未纳入首批映射的动作
 * 都必须在盘点时登记到这里，防止新代码继续随手引入近似图形。
 *
 * 分组仅为人类审阅便利（门禁按集合处理）；顺序无意义。
 */
export const NON_ACTION_ICONS = [
  // 布局与导航装饰（折叠/展开/方向）
  'ChevronBackOutline',
  'ChevronDownOutline',
  'ChevronForwardOutline',
  'ChevronUpOutline',
  'ArrowUpOutline',
  'ArrowDownOutline',
  'ArrowForwardOutline',
  'ExpandOutline',
  'Contract',
  'ContractOutline',
  'ResizeOutline',
  'NavigateOutline',
  'ReorderTwoOutline',
  'GridOutline',
  // 文件/目录/编辑器类型徽标
  'FolderOutline',
  'FolderOpenOutline',
  'DocumentOutline',
  'ArchiveOutline',
  'BookOutline',
  'Bookmark',
  'BookmarkOutline',
  'ClipboardOutline',
  'TextOutline',
  'CodeSlashOutline',
  'Cube',
  'CubeOutline',
  'FlaskOutline',
  'LogoJavascript',
  'TerminalOutline',
  'EaselOutline',
  'LayersOutline',
  'AlbumsOutline',
  'BarChartOutline',
  'StatsChartOutline',
  // 状态与反馈
  'AlertCircleOutline',
  'WarningOutline',
  'InformationCircleOutline',
  'Checkmark',
  'CheckmarkOutline',
  'CheckmarkCircleOutline',
  'CloseCircleOutline',
  'RemoveCircleOutline',
  'Remove',
  'PulseOutline',
  'RadioOutline',
  'FlagOutline',
  'SparklesOutline',
  'FlashOutline',
  'SnowOutline',
  'SunnyOutline',
  'SpeedometerOutline',
  // 会话/自动化与运行控制
  'PaperPlaneOutline',
  'PauseOutline',
  'PlayOutline',
  'PlayCircleOutline',
  'PlaySkipForwardOutline',
  'StopOutline',
  'PersonCircleOutline',
  'ShieldCheckmarkOutline',
  'BuildOutline',
  'SaveOutline',
  'ServerOutline',
  'FunnelOutline',
  'LocateOutline',
  'ListOutline',
  'OptionsOutline',
  'GlobeOutline',
  'ShareSocialOutline',
  'TimeOutline',
  'CalendarOutline',
  'RocketOutline',
  'MedkitOutline',
  'PricetagOutline',
  'VideocamOutline',
  'VolumeOffOutline',
  'PhonePortraitOutline',
  'Checkbox',
  'CheckboxOutline',
  'Star',
  'StarOutline',
  'ArrowUndoOutline',
  'SwapHorizontalOutline',
  'SwapVerticalOutline',
  'ColorPaletteOutline',
  'CloudOutline',
] as const
