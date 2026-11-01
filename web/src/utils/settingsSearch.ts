import type { Component } from 'vue'
import {
  SettingsOutline, ColorPaletteOutline, GitBranchOutline, CloudOutline,
  ShieldCheckmarkOutline, NotificationsOutline, InformationCircleOutline,
  TerminalOutline, RocketOutline, PulseOutline, TimeOutline, KeyOutline,
  EyeOutline, GlobeOutline, SwapHorizontalOutline,
} from '@vicons/ionicons5'

/**
 * 设置分区元数据（P-20261001-9）：分区键、图标、标题词条、搜索关键词词条的
 * 单一事实来源。SettingsModal 左栏（tab 顺序 = 此处键序）与 useQuickNav
 * 「打开设置：<分区>」直达命令都从这里派生，新增分区只改这一处 + 两个 locale。
 *
 * 关键词表（zh/en 双语，settingsSearch.keywords.<key>）与分区功能同步维护——
 * 新增分区时在此补键，并在两个 locale 的 settingsSearch.keywords 下补词条。
 */
export const SETTINGS_TAB_KEYS = [
  'general', 'appearance', 'terminal', 'git', 'remote', 'remoteaccess', 'security',
  'migration', 'notifications', 'deploy', 'monitor', 'about', 'agentcron', 'sentinel', 'keymap',
] as const
// 新分区可按语义插到任意位置：e2e 已统一走 data-testid 语义锚点定位分区
// （settings-nav-<key> 导航项 / settings-pane-<key> 内容容器，SettingsModal 从
// 本表派生，P-20261002-151）；再用位置索引 nth(N) 会被 check-e2e-conventions
// 的 nth-positional-anchor 规则警告
export type SettingsTabKey = (typeof SETTINGS_TAB_KEYS)[number]

/** 分区 → 标题 i18n key（security 在 settingsTabs 下无独立词条，标题走 settings.securityTitle） */
export const SETTINGS_TAB_LABEL_KEYS: Record<SettingsTabKey, string> = {
  general: 'settingsTabs.general',
  appearance: 'settingsTabs.appearance',
  terminal: 'settingsTabs.terminal',
  agentcron: 'settingsTabs.agentcron',
  sentinel: 'settingsTabs.sentinel',
  git: 'settingsTabs.git',
  remote: 'settingsTabs.remote',
  remoteaccess: 'settingsTabs.remoteaccess',
  security: 'settings.securityTitle',
  migration: 'settingsTabs.migration',
  notifications: 'settingsTabs.notifications',
  deploy: 'settingsTabs.deploy',
  monitor: 'settingsTabs.monitor',
  about: 'settingsTabs.about',
  keymap: 'settingsTabs.keymap',
}

/** 分区 → 图标（SettingsModal 左栏与命令面板直达命令共用同一套） */
export const SETTINGS_TAB_ICONS: Record<SettingsTabKey, Component> = {
  general: SettingsOutline,
  appearance: ColorPaletteOutline,
  terminal: TerminalOutline,
  agentcron: TimeOutline,
  sentinel: EyeOutline,
  git: GitBranchOutline,
  remote: CloudOutline,
  remoteaccess: GlobeOutline,
  security: ShieldCheckmarkOutline,
  migration: SwapHorizontalOutline,
  notifications: NotificationsOutline,
  deploy: RocketOutline,
  monitor: PulseOutline,
  about: InformationCircleOutline,
  keymap: KeyOutline,
}

/** 分区 → 搜索关键词 i18n key（分区标题词由消费方并入 haystack，不重复收录） */
export function settingsKeywordKey(tab: SettingsTabKey): string {
  return `settingsSearch.keywords.${tab}`
}

/**
 * 词条→控件锚点（P-20261003-39）：分区级过滤命中后滚动定位到具体控件行的
 * 「最后一跳」。渐进配置——只给高频分区/词条配锚点，未配的词条保持分区级
 * 过滤现状（降级安全）；锚点词并入分区 haystack 参与匹配（与 keywords 同一套
 * 子串语义：查询词 ⊆ 词条即命中，zh/en 混排空格分隔）。controlId 复用
 * P-20261002-151 的 data-testid 语义命名——新分区行配 testid 时顺路在此补一条。
 */
export interface SettingsControlAnchor {
  /** 锚点词：查询词为其子串时滚动定位到 controlId */
  match: string
  /** 目标控件行 data-testid（须存在于对应分区 pane 内，缺失时静默降级为分区级过滤） */
  controlId: string
}

export const SETTINGS_CONTROL_ANCHORS: Partial<Record<SettingsTabKey, SettingsControlAnchor[]>> = {
  general: [
    { match: '审批模式 approval mode', controlId: 'settings-agent-approval-mode' },
    { match: '审批超时 approval timeout', controlId: 'settings-approval-timeout-min' },
    { match: '录制 recording', controlId: 'settings-approval-recording' },
    { match: '用户现场 ui snapshot 现场上报', controlId: 'settings-ui-snapshot' },
    { match: '守护 agent guard', controlId: 'settings-agent-guard' },
    { match: '会话启动上下文 session context 笔记 todo git 状态 注入', controlId: 'settings-session-context' },
    { match: '上下文警示 阈值 低余量 接力 context warn threshold relay', controlId: 'settings-context-warn-threshold' },
    { match: '任务模板 task template', controlId: 'settings-agent-task-templates' },
    { match: '自定义智能体 custom agents', controlId: 'settings-custom-agents' },
    { match: '项目规则 project rules CLAUDE.md AGENTS.md cursorrules', controlId: 'settings-project-rules' },
    { match: '导出配置 导入配置 export import 迁移 transfer 设置迁移', controlId: 'settings-transfer' },
  ],
  appearance: [
    { match: '保存时格式化 format on save', controlId: 'settings-format-on-save' },
    { match: '括号 括号对 彩色 bracket color colorization', controlId: 'settings-bracket-color' },
    { match: 'tab git 着色 git status tab decorations 未跟踪', controlId: 'settings-git-status-tabs' },
    { match: '密度 density', controlId: 'settings-ui-density' },
    { match: '文件树 嵌套 同名族 file nesting', controlId: 'settings-file-nesting' },
    { match: '泳道 拓扑图 graph lane 拓扑 提交图', controlId: 'settings-graph-lanes' },
    { match: 'diff 色板 色弱 色盲 colorblind 可访问性 accessibility 蓝橙', controlId: 'settings-diff-palette' },
    { match: '终端字体 字体 连字 等宽字体名 mono monospace terminal font ligatures', controlId: 'settings-terminal-font-family' },
  ],
  terminal: [
    { match: '字体大小 字号 font size', controlId: 'settings-terminal-font-size' },
    { match: '光标 cursor 闪烁 blink 形态 竖条 下划线 block bar underline', controlId: 'settings-terminal-cursor' },
    { match: '滚动缓冲 滚动 回滚 历史行数 scrollback', controlId: 'settings-terminal-scrollback' },
    { match: '默认 shell default shell', controlId: 'settings-terminal-default-shell' },
    { match: '选中即复制 复制 copy on select', controlId: 'settings-terminal-copy-on-select' },
    { match: '高危命令粘贴预检 危险命令 paste precheck dangerous', controlId: 'settings-terminal-paste-precheck' },
    { match: '背压 丢帧 自愈 backpressure dropped diagnostics', controlId: 'settings-terminal-backpressure' },
  ],
  git: [
    { match: '用户名 user name', controlId: 'settings-git-user-name' },
    { match: '邮箱 email user email', controlId: 'settings-git-user-email' },
    { match: 'gitignore gitattributes 换行', controlId: 'settings-git-ignore-files' },
  ],
  remote: [
    { match: '添加远程 新增远程 remote add origin', controlId: 'settings-remote-add' },
  ],
  // 远程接入（P-20261019-11）：公网访问/反向隧道/VPS 中继控制面直达
  remoteaccess: [
    { match: '远程接入 反向隧道 内网穿透 VPS 中继 公网 手机 relay tunnel reverse ssh', controlId: 'settings-remote-access-status' },
  ],
  // 换机迁移（P-20261003-147）：配置包导出/导入向导直达
  migration: [
    { match: '换机 迁移 迁实例 migration scpkg 配置包 全量包 轻装包', controlId: 'settings-migration' },
  ],
  security: [
    { match: '保留期 retention 留存', controlId: 'settings-retention' },
    { match: 'agent token 令牌', controlId: 'egress-row-agent-token' },
    { match: '审计 audit 日志', controlId: 'egress-row-audit' },
    { match: '锁定 锁 faillock lock', controlId: 'ingress-row-lock' },
    // P-20261006-49 修改标记分区补全顺路的锚点补齐：TLS/锁定行此前不可经搜索直达
    { match: 'TLS HTTPS 启用 传输加密', controlId: 'settings-tls-enable' },
    { match: '实例间校验 强校验 TOFU 指纹 verify peer', controlId: 'settings-tls-verify-peer' },
    { match: '自动锁定 锁定时长 解锁有效期 token TTL', controlId: 'settings-lock-autolock' },
  ],
  notifications: [
    { match: '等待音效 音效 声音 sound', controlId: 'settings-notification-sound' },
    { match: '外部推送 webhook bark ntfy', controlId: 'settings-notification-webhook' },
    { match: '免打扰 时段 静默 dnd', controlId: 'settings-notification-dnd' },
  ],
}

/** 分区锚点词并入搜索 haystack（空格连接；未配锚点的分区返回空串） */
export function settingsAnchorWords(tab: SettingsTabKey): string {
  return (SETTINGS_CONTROL_ANCHORS[tab] ?? []).map(a => a.match).join(' ')
}

// === 拼音首字母检索（P-20261003-220）：中文设置名输「tz」即命中「通知」分区 ===
// 自建「语料用字 → 拼音首字母」映射而非引入拼音字典依赖：词条语料封闭（分区别名
// 关键词 + 控件锚点，去重约 200 字），整本拼音库（百 KB 级、且运行时多音字歧义
// 依旧要人工裁决）换不来等值收益。多音字策略：字表按语料语境取常用读（`行` 取
// 名词读 háng——换行/行数恰为该读），`运行`族读 xíng 走词级覆写；语料新增用字时
// 覆盖守卫测试（__tests__/utils/settingsSearch.test.ts 语料覆盖守卫）即红，按该字
// 读音补一格即可。注：不静态 import zh-CN 语料做运行时推导——语言包是懒加载
// chunk（i18n/index.ts），静态引入会把全量语言包拖回主链。
const PINYIN_INITIALS: Record<string, string> = {
  上: 's', 中: 'z', 主: 'z', 义: 'y', 于: 'y', 交: 'j', 亮: 'l', 仓: 'c', 现: 'x', 场: 'c', 报: 'b',
  令: 'l', 任: 'r', 份: 'f', 会: 'h', 传: 'c', 位: 'w', 体: 't', 依: 'y',
  保: 'b', 值: 'z', 健: 'j', 光: 'g', 免: 'm', 全: 'q', 关: 'g', 兵: 'b',
  内: 'n', 凑: 'c', 凭: 'p', 出: 'c', 分: 'f', 划: 'h', 则: 'z', 制: 'z',
  前: 'q', 务: 'w', 动: 'd', 势: 's', 化: 'h', 匹: 'p', 占: 'z', 历: 'l',
  发: 'f', 取: 'q', 变: 'b', 台: 't', 史: 's', 号: 'h', 名: 'm', 后: 'h',
  告: 'g', 周: 'z', 哨: 's', 器: 'q', 回: 'h', 固: 'g', 图: 't', 地: 'd',
  堆: 'd', 声: 's', 备: 'b', 复: 'f', 外: 'w', 字: 'z', 存: 'c', 守: 's',
  安: 'a', 完: 'w', 定: 'd', 审: 's', 密: 'm', 小: 'x', 布: 'b', 平: 'p',
  序: 'x', 库: 'k', 度: 'd', 康: 'k', 建: 'j', 式: 's', 录: 'l', 快: 'k',
  成: 'c', 户: 'h', 打: 'd', 扰: 'r', 批: 'p', 抓: 'z', 护: 'h', 拉: 'l',
  按: 'a', 换: 'h', 据: 'j', 捷: 'j', 控: 'k', 推: 't', 提: 't', 改: 'g',
  放: 'f', 数: 's', 方: 'f', 日: 'r', 时: 's', 智: 'z', 暗: 'a', 期: 'q',
  本: 'b', 机: 'j', 板: 'b', 构: 'g', 标: 'b', 格: 'g', 桌: 'z', 模: 'm',
  正: 'z', 死: 's', 每: 'm', 水: 's', 测: 'c', 滚: 'g', 父: 'f', 版: 'b',
  生: 's', 用: 'y', 界: 'j', 留: 'l', 白: 'b', 监: 'j', 盘: 'p', 目: 'm',
  知: 'z', 磁: 'c', 示: 's', 程: 'c', 空: 'k', 端: 'd', 符: 'f', 箱: 'x',
  类: 'l', 系: 'x', 紧: 'j', 终: 'z', 绑: 'b', 统: 't', 编: 'b', 缩: 's',
  置: 'z', 署: 's', 能: 'n', 自: 'z', 色: 's', 行: 'h', 装: 'z', 观: 'g',
  规: 'g', 触: 'c', 言: 'y', 警: 'j', 计: 'j', 订: 'd', 认: 'r', 记: 'j',
  试: 's', 话: 'h', 语: 'y', 赖: 'l', 超: 'c', 趋: 'q', 跑: 'p', 辑: 'j',
  输: 's', 运: 'y', 远: 'y', 连: 'l', 送: 's', 选: 'x', 通: 't', 邮: 'y',
  部: 'b', 配: 'p', 醒: 'x', 量: 'l', 链: 'l', 锁: 's', 键: 'j', 长: 'c',
  间: 'j', 阅: 'y', 阈: 'y', 隔: 'g', 面: 'm', 音: 'y', 顶: 'd', 项: 'x',
  题: 't', 默: 'm', 入: 'r', 导: 'd', 牌: 'p', 钥: 'y',
  // P-20261003-242 锚点词新增用字（着色/未跟踪）
  着: 'z', 未: 'w', 跟: 'g', 踪: 'z',
  // P-20261005-207 定时任务接力关键词新增用字（接力/续命）
  接: 'j', 力: 'l', 续: 'x', 命: 'm',
  // P-20261004-47 背压诊断锚点词新增用字（背压/丢帧/自愈）
  背: 'b', 压: 'y', 丢: 'd', 帧: 'z', 愈: 'y',
  // P-20261004-66 替换历史关键词新增用字（替/还原）
  替: 't', 还: 'h', 原: 'y',
  // P-20261005-191 高危命令粘贴预检锚点词新增用字（高危/粘贴/预检/危险）
  高: 'g', 危: 'w', 粘: 'n', 贴: 't', 预: 'y', 检: 'j', 险: 'x',
  // P-20261005-4 设置导出/导入锚点词新增用字（设置迁移）
  迁: 'q', 移: 'y', 设: 's',
  // P-20261005-1 锚点扩容新增用字（字体大小/滚动缓冲/选中/等待音效/时段/静默/
  // 添加/新增/审计日志——覆盖守卫测试即钉此清单）
  大: 'd', 缓: 'h', 冲: 'c', 即: 'j', 等: 'd', 待: 'd', 效: 'x',
  段: 'd', 静: 'j', 添: 't', 加: 'j', 新: 'x', 增: 'z', 志: 'z',
  // P-20261005-227 等宽字体名锚点词新增用字（等宽）
  宽: 'k',
  // P-20261005-224 项目仪表盘默认落点锚点词新增用字（仪表盘/落点）
  仪: 'y', 表: 'b', 落: 'l', 点: 'd',
  // P-20261006-47 会话启动上下文锚点词新增用字（启动/上下文/笔记/状态/注入）+ P-20261006-33 低余量阈值用字 + P-20261006-29 泳道/拓扑用字
  启: 'q', 下: 'x', 笔: 'b', 状: 'z', 态: 't', 文: 'w', 注: 'z', 低: 'd', 余: 'y', 泳: 'y', 道: 'd', 拓: 't', 扑: 'p',
  // P-20261006-49 安全分区锚点词新增用字（实例/证书校验/强/指纹/解锁/有效期）
  实: 's', 例: 'l', 证: 'z', 校: 'j', 验: 'y', 强: 'q', 指: 'z', 纹: 'w', 解: 'j', 有: 'y',
  // P-20261003-23 入站 Hook 关键词新增用字（入站/事件/集成）
  站: 'z', 事: 's', 集: 'j',
  // P-20261006-9 括号对彩色化锚点词新增用字（括/彩/对）+ P-20261006-21 文件树同名族嵌套用字（件/树/嵌/套/同/族）
  括: 'k', 彩: 'c', 对: 'd', 件: 'j', 树: 's', 嵌: 'q', 套: 't', 同: 't', 族: 'z',
  // P-20261005-212 光标偏好锚点词新增用字（闪烁/竖条/下划线/形态）
  闪: 's', 烁: 's', 竖: 's', 条: 't', 线: 'x', 形: 'x',
  // P-20261006-5 diff 色板锚点词新增用字（色弱/色盲/可访问性/蓝橙）
  弱: 'r', 盲: 'm', 可: 'k', 访: 'f', 问: 'w', 性: 'x', 蓝: 'l', 橙: 'c',
  // P-20261019-11 远程接入分区锚点词新增用字（反向隧道/内网穿透/中继/公网/手机）
  反: 'f', 向: 'x', 隧: 's', 网: 'w', 穿: 'c', 透: 't', 继: 'j', 公: 'g', 手: 's',
  // P-20261008-15 服务日志关键词新增用字（服/排障）
  服: 'f', 排: 'p', 障: 'zh',
  // P-20261008-14 快捷键分区编辑器域词条新增用字（书签键）
  书: 's', 签: 'q',
  // P-20261003-147 迁移分区关键词新增用字（换机迁移/配置包/全量包/轻装包/口令信封/整机搬家）
  轻: 'q', 包: 'b', 口: 'k', 信: 'x', 封: 'f', 整: 'zh', 搬: 'b', 家: 'j',
}
/** 多音字词级覆写（整词命中优先于逐字表）：`行` 的 xíng 读法仅出现在 `运行`族 */
const PINYIN_WORD_INITIALS: Record<string, string> = {
  运行: 'yx', 运行时: 'yxs', 运行时长: 'yxsc',
}

/**
 * 文本 → 空格分隔的拼音首字母串：每个含汉字的词一组（'通知 桌面' → 'tz zm'）。
 * 纯英文词不产出（英文走既有子串匹配、天然前缀可搜）；含未收录字符的词整词跳过
 * （宁缺毋错，覆盖守卫保证语料内的词不缺席）。消费侧对返回值用与既有 haystack
 * 相同的 includes 子串语义匹配，中文首字母查询与英文查询共用同一条过滤路径。
 * 量级：每次键入 13 分区 × 数百字 Map 查表，亚毫秒级，无需 memo。
 */
export function pinyinInitials(text: string): string {
  const words: string[] = []
  for (const token of text.split(/\s+/)) {
    if (!token) continue
    const overridden = PINYIN_WORD_INITIALS[token]
    if (overridden !== undefined) {
      words.push(overridden)
      continue
    }
    let initials = ''
    for (const ch of token) {
      const ini = PINYIN_INITIALS[ch]
      if (ini === undefined) {
        initials = ''
        break
      }
      initials += ini
    }
    if (initials) words.push(initials)
  }
  return words.join(' ')
}
