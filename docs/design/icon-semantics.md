# 动作图标语义（P-20261022-1）与目的地导航图标（P-20261022-2）

> 机器可读事实源：[`web/src/utils/actionIcons.ts`](../../web/src/utils/actionIcons.ts)（`ACTION_ICONS` 动作段 + `NAV_ICONS` 目的地段 + `FORBIDDEN_ICON_PAIRS` 禁配对）  
> 防回潮门禁：[`web/scripts/check-icon-semantics.mjs`](../../web/scripts/check-icon-semantics.mjs)（`npm run check:icon-semantics`）  
> 感知相似度排查工具：[`web/scripts/icon-similarity-report.mjs`](../../web/scripts/icon-similarity-report.mjs)（`npm run icon:report`，按需手跑不入 check 链，报告落 `.goal-enhance/`）  
> 相关纪律：icon-only 按钮 `title`/`aria-label`（P-20261005-213）、最小热区（P-20261019-5）——本文件不改变它们的规则。

## 1. 问题与目标

用户在实际使用中反馈「有些图标很相似，不同功能用了相似图标」。盘点确认两类问题并存：

1. **同一动作跨页面换图形**：「更多」在顶栏/活动栏/分享管理器用实心 `EllipsisHorizontal`，远程主机列表/卡片用描边 `EllipsisHorizontalOutline`；pull 在顶栏用 `RefreshOutline`、Git 面板用 `CloudDownloadOutline`；聊天族三套图形按文件各取所需。
2. **不同动作共用近似图形**：`CloudDownloadOutline` 一图四义（clone / fetch / fetchAll / pull）、`SyncOutline` 一图四义（轮换分享链接 / 监控轮播 / 远程诊断对比 / 远程 Git 对比）、分享管理器「更多」菜单里重新分享/刷新快照/轮换链接三枚环形箭头相邻（轮换不可逆，误点代价最高）、`CreateOutline` 铅笔既表示编辑又被借去表示「已写文件数」。

14px 工具条与纯图标按钮上，这些差异几乎不可辨。目标是把「动作 → 图标」从口口相传变成**唯一注册表 + 静态门禁**：首批锁定高争议动作，后续新增图标必须登记归类，新增违规直接失败。

装饰性图标（类型徽标、状态点、方向箭头、外观预览等）不承载动作语义，登记在 `NON_ACTION_ICONS` 白名单即可，不进入动作映射表。

## 2. 盘点口径（实施时实测）

| 指标 | 提案产生时点 | P-20261022-1 实施时 |
| --- | --- | --- |
| `@vicons/ionicons5` import 语句 | 137 | 138 |
| 按导入名计的图标引用 | 644 | 688 |
| 不同图标名 | 133 | 125（另有 4 个禁用变体清零） |
| 动作键 | — | 41 |
| 非动作白名单 | — | 85 |
| 邻接冲突族 | — | 4 |

数量差异来自期间其他提交的增删（例如 `AddCircleOutline`/`SyncOutline`/`ReloadOutline`/`EllipsisHorizontal` 清零、新增 pull/clone/merge 图形）；门禁用数量下限（动作 ≥35、非动作 ≥80、邻接族 ≥3、动作标注 ≥10）防解析器失明，而不是锁死单点数字。

## 3. 动作映射总表

选型原则：**一动作一图形**；优先选择「动作动词 → 图形隐喻」直观、且与同屏邻位动作形状差异最大的一枚。所有图形均来自既有 `@vicons/ionicons5`（MIT），零新增依赖。

### 3.1 通用（工具栏 / 右键菜单 / 文件树）

| 动作键 | 图标 | 选型理由 / 例外 |
| --- | --- | --- |
| `common.more` | `EllipsisHorizontalOutline` | 所有「更多」统一描边形态；实心 `EllipsisHorizontal` 禁用（同屏混用会让人以为层级不同） |
| `common.refresh` | `RefreshOutline` | 刷新当前视图/列表；与 retry（失败后重试）区分 |
| `common.retry` | `ArrowRedoOutline` | 失败重试/重启进程；不再用第二枚环形箭头 `ReloadOutline`，避免与刷新混淆 |
| `common.delete` | `TrashOutline` | 删除/撤销分享/移除项目同一破坏性动作族；红色仅由调用方 `type="error"` 表达 |
| `common.recycleBin` | `TrashBinOutline` | **回收站入口**是导航动作（可恢复），不是删除动作；与 `TrashOutline` 靠桶形区分 |
| `common.edit` | `CreateOutline` | 编辑/重命名/备注/队列项编辑 |
| `common.new` | `AddOutline` | 新建文件/项目/条目；圆形加号 `AddCircleOutline` 属同一动作的第二形态，已清零 |
| `common.copy` | `CopyOutline` | 复制链接/路径/报告 |
| `common.close` | `CloseOutline` | 关闭面板/弹层/清除搜索 |
| `common.search` | `SearchOutline` | 搜索/过滤入口 |
| `common.open` | `OpenOutline` | 打开/新标签查看/PR 跳转 |
| `common.download` | `DownloadOutline` | 下载/导出（与云同步 fetch 的「云」图形区分） |
| `common.hide` | `EyeOffOutline` | 隐藏/忽略 |
| `common.preview` | `EyeOutline` | 预览/显示 |
| `common.pin` | `PinOutline` | 钉选/固定 |
| `common.lock` | `LockClosedOutline` | 锁定 |
| `common.unlock` | `LockOpenOutline` | 解锁/布局锁开关展开态 |

### 3.2 Git

| 动作键 | 图标 | 选型理由 / 例外 |
| --- | --- | --- |
| `git.fetch` | `CloudDownloadOutline` | 「把远端变化取到本地引用」——fetch/fetchAll 唯一保留 CloudDownload 的动作 |
| `git.pull` | `ArrowDownCircleOutline` | 向下箭头 = 拉取并合并到当前分支；**CloudDownload 不再表示 pull**（顶栏/Git 面板/命令面板统一） |
| `git.push` | `CloudUploadOutline` | 上行云箭头 = 推送 |
| `git.clone` | `DuplicateOutline` | 复制仓库 = 克隆；不再借用 CloudDownload |
| `git.branch` | `GitBranchOutline` | 分支/分支切换/当前分支 |
| `git.network` | `GitNetworkOutline` | 远程/网络/多实例拓扑 |
| `git.compare` | `GitCompareOutline` | 对比/差异（远程诊断对比、远程 Git 对比同用此枚） |
| `git.commit` | `GitCommitOutline` | 提交 |
| `git.merge` | `GitMergeOutline` | 合并（注册表预留；当前合并入口以文字/其他控件呈现） |
| `git.pr` | `GitPullRequestOutline` | 创建 PR |

### 3.3 分享

| 动作键 | 图标 | 选型理由 / 例外 |
| --- | --- | --- |
| `share.reshare` | `RepeatOutline` | 重新分享（生成新分享，旧链接仍可用）——循环箭头语义 |
| `share.rotate` | `KeyOutline` | **轮换链接会让旧链接立即失效（不可逆）**：改用钥匙（换钥匙）而非第四枚环形箭头，与同菜单的刷新/重新分享拉开形状差异 |
| `share.qr` | `QrCodeOutline` | 二维码 |
| `share.directApprove` | `HandLeftOutline` | 直通输入握手（P-20261024-1）批准/收回（P-20261024-1）：举手 = 请求/持权中；批准与收回是同域反向动作，菜单文案区分方向，图形同一枚保持「握手域」辨识 |

分享管理器「更多」菜单允许 `RefreshOutline`（刷新快照）与 `RepeatOutline`（重新分享）共存：两项都有文字标签，且轮换已改为非环形 `KeyOutline`，不再出现三枚环形箭头相邻。

### 3.4 聊天三态（按场景固定一枚）

| 动作键 | 图标 | 场景 |
| --- | --- | --- |
| `chat.sessions` | `ChatbubblesOutline` | 会话/多路对话（智能体会话、分享类型 `session`、值班大屏会话卡） |
| `chat.comment` | `ChatbubbleEllipsesOutline` | 行内评论/留言/问智能体/消息计数（单对话气泡） |
| `chat.queue` | `ChatboxEllipsesOutline` | 队列消息（排队指令入口；方框 = 待发队列） |

### 3.5 会话台账 / 通知 / 导航

| 动作键 | 图标 | 选型理由 / 例外 |
| --- | --- | --- |
| `claude.filesWritten` | `DocumentTextOutline` | 「已写文件数」是计数指标，用文档图形；**铅笔 `CreateOutline` 只表示编辑** |
| `notify.center` | `NotificationsOutline` | 通知中心 |
| `notify.markAllRead` | `CheckmarkDoneOutline` | 全部标记已读 |
| `notify.dnd` | `MoonOutline` | 免打扰 |
| `nav.home` | `HomeOutline` | 返回首页 |
| `nav.back` | `ArrowBackOutline` | 返回 |
| `nav.settings` | `SettingsOutline` | 设置 |
| `nav.help` | `HelpCircleOutline` | 帮助 |

### 3.6 已知例外（有意保留）

- `KeyOutline` 同时用于许可证面板：静态信息入口，不与分享管理器同屏；动作注册表只把 `share.rotate` 视为「动作」，许可证面板按非动作白名单登记。（P-20261022-2 起快捷键帮助不再借用 `KeyOutline`——目的地注册后随 `NAV_ICONS['shortcuts']` 统一为 `FlashOutline`。）
- `DocumentTextOutline` 同时用于变更日志入口（Git 面板）：与「已写文件数」不同屏、不同语义域，且注册表只约束动作值；若未来同屏出现，应拆分图形。
- `RefreshOutline` 仍是列表/分支引用的刷新图形（Git 分支刷新、文件树刷新等），与 `common.retry` 的失败重试语义区分。
- 终端 pane 的「清屏重启」与 DSH「重启进程」使用 `ArrowRedoOutline`（`common.retry`）：语义是重试启动，不是刷新。

## 4. 目的地导航图标（NAV_ICONS，P-20261022-2）

P-20261022-1 收口的是动作映射面，但**导航/目的地图标（活动栏 rail 面板、首页工具条）不在登记面**——用户实测仍有残留：git 面板与分享管理在 20px 深色 rail 同属「圆点+连线」族几乎不可辨、首页帮助中心与快捷键两枚完全相同的问号相邻、`SpeedometerOutline` 一图两目的地（仪表盘面板 × 值班大屏）。NAV_ICONS 把目的地图标纳入注册面：

- **一图一目的地**：同一图形不得对应两个不同目的地（门禁 R6a-4）；
- **多入口同图是正确一致性**：同一目的地的 rail 按钮、底部 tab、首页工具条入口共用同一键（如 `git` 同时是 rail 面板与底部 tab）；
- **动作段与 nav 段允许同图但须注记**（见下表「同图注记」列）；
- 键 = 目的地 id：面板键与 `panels/registry.ts` 的 `PanelDef.id` 一致（门禁 R6a-1 据此对账），首页工具条目的地为平铺 kebab id。

### 4.1 目的地总表

| 键 | 图标 | 面 | 选型理由 / 同图注记 |
| --- | --- | --- | --- |
| `dashboard` | `SpeedometerOutline` | rail | 仪表盘本义，**值班大屏已让出此图**（首批三组修复） |
| `files` | `FolderOutline` | rail+bottom | 文件树（装饰/目的地面注记） |
| `changes` | `CheckmarkOutline` | rail | 提交面板 |
| `todos` | `ClipboardOutline` | rail | TODO 清单 |
| `stream` | `PulseOutline` | rail | 实时变更流 |
| `env` | `ServerOutline` | rail | 项目环境画像 |
| `git` | `GitBranchOutline` | rail+bottom | Git 面板；**禁止与 ShareSocialOutline 同屏**（§5 禁配对） |
| `terminal` | `TerminalOutline` | rail+bottom | 终端 |
| `notes` | `DocumentTextOutline` | rail | 项目笔记；同图注记：动作 `claude.filesWritten` |
| `agent-terminal` | `ChatbubblesOutline` | rail + 首页工具条 | 终端会话管理（多入口同键）；同图注记：动作 `chat.sessions` |
| `share-manager` | `LinkOutline` | rail | **首批修复**：链接 = 分享的核心交付物；原 `ShareSocialOutline` 与 git 分支同属「圆点+连线」族 |
| `remote-console` | `GlobeOutline` | rail + 首页工具条 | 远程控制台（多入口同键） |
| `preview` | `EyeOutline` | bottom | 端口预览；同图注记：动作 `common.preview` |
| `problems` | `AlertCircleOutline` | bottom | 问题面板 |
| `console` | `AlbumsOutline` | bottom | 控制台 |
| `monitor` | `TvOutline` | 首页工具条 | **首批修复**：值班大屏盯屏/大屏隐喻；`SpeedometerOutline` 归还仪表盘专用 |
| `theme` | `ColorPaletteOutline` | 首页工具条 | 主题循环 |
| `notification-center` | `NotificationsOutline` | 首页工具条 | 同图注记：动作 `notify.center` |
| `help-center` | `HelpCircleOutline` | 首页工具条 | 同图注记：动作 `nav.help` |
| `shortcuts` | `FlashOutline` | 首页工具条 | **首批修复**：闪电 = 快捷；原与帮助中心共用 `HelpCircleOutline` 两枚问号相邻。与 fleet 批量动作同图（跨屏不同面、fleet 恒带文字），注记接受 |
| `lock` | `LockClosedOutline` | 首页工具条 | 进入锁定屏；同图注记：动作 `common.lock` |
| `settings` | `SettingsOutline` | 首页工具条 | 同图注记：动作 `nav.settings` |

品牌图标（`DshIcon`）独占图形零混淆面，不走 NAV_ICONS，登记在 `BRAND_NAV_ICONS`（门禁对账豁免）。TopBar/实例菜单的 icon-only 按钮多为既有动作键（`nav.home`/`nav.help`/`share.qr`/`common.lock`/`notify.center` 等），由动作段覆盖；实例菜单当前零图标。

## 5. 感知相似度禁配对（P-20261022-2）

邻接族（§7）是人工维护的小集合，明确不做视觉相似度启发式——相似对只能靠用户撞上。P-20261022-2 落地全量排查工具 [`icon-similarity-report.mjs`](../../web/scripts/icon-similarity-report.mjs)：把 src 实际导入的全部 ionicons 图标按 **20px 黑底白线**（rail/工具条真实观感）批量光栅化，两两算归一化互相关（NCC，亮度/对比度不变量），**≥0.85 高危 / 0.70~0.85 观察**，输出「图标对 / 相似度 / 各自承载的动作与目的地 / 共现面」。报告落 `.goal-enhance/icon-similarity-<date>.md` 供人工终审；新增图标前后各跑一次即可发现近似对，不再依赖用户撞上。

### 5.1 已知边界（为什么终审不可省）

- ionicons5 Outline 族共享圆环语法，圆形图标天然 NCC 偏高——高危档不自动等于必改；
- NCC 是形状相似度启发式，不是「人眼难辨」判定；
- **「同语法不同布局」的风格相似对超出像素启发式可达范围**：用户红框实锚的 git 分支 × 分享网络两枚「圆点+连线」图，实测像素/墨量分布相关均 <0.5——该类只能靠人工审查与用户反馈发现，回潮由 `FORBIDDEN_ICON_PAIRS` 静态禁配对兜住；
- 共现面只标注静态可达同屏，运行期互斥视图的先后同屏由人工终审裁量。

### 5.2 全量排查结果与终审分档（2026-10-22，125 枚图标 / 7750 对比）

**必改档（已在本提案修复 + 入静态禁配对）**——三组用户实锚冲突，均为确定性冲突而非像素相似：

| 冲突 | 类型 | 修复 | 防回潮 |
| --- | --- | --- | --- |
| git 分支 × 分享网络（rail 同屏） | 同语法异布局（NCC 不可达） | share-manager 换 `LinkOutline` | `FORBIDDEN_ICON_PAIRS`（R6b） |
| 帮助中心 × 快捷键（首页相邻同图） | 同图两目的地 | 快捷键换 `FlashOutline` | R6a-4 一图一目的地 |
| 仪表盘面板 × 值班大屏（同图） | 同图两目的地 | 值班大屏换 `TvOutline` | R6a-4 一图一目的地 |

**接受档（高危 12 对，豁免登记）**：

| 图形对 | NCC | 豁免理由 |
| --- | --- | --- |
| `Checkmark` × `CheckmarkOutline` | 1.000 | vicons 包内两枚导出 SVG 路径完全相同（同一字形双名），零感知差异；状态符号非动作面 |
| `Contract` × `ContractOutline` | 1.000 | 同上；命令面板项恒带文字 |
| `LockClosedOutline` × `LockOpenOutline` | 0.977 | 锁/解锁强惯例态对；TopBar/TerminalPane 为同位互斥态（同一按钮状态切换，从不同屏） |
| `AlertCircleOutline` × `TimeOutline` | 0.934 | 两处同文件用法均为 done/failed/waiting 状态三态指示器（互斥态 + 文字伴随） |
| `CreateOutline` × `OpenOutline` | 0.906 | 共享方框语法但动宾搭配明确（铅笔=编辑、外开箭头=打开）；首批映射锁定，出现处均伴随文字菜单 |
| `AlertCircleOutline` × `ArrowDownCircleOutline` | 0.900 | 圆环语法跨面（问题 bottom-tab × Git 拉取），无同屏相邻场景 |
| `CloseCircleOutline` × `PlayCircleOutline` | 0.896 | 圆环语法跨面，圈内符号承担区分 |
| `ArrowDownCircleOutline` × `TimeOutline` | 0.880 | 同文件出现处为命令面板项（恒带文字） |
| `CopyOutline` × `DuplicateOutline` | 0.860 | 同「双矩形」语法；copy 恒伴随路径/SHA 文本，clone 恒在 Git 同步区 |
| `AlertCircleOutline` × `PlayCircleOutline` | 0.859 | 圆环语法跨面 |
| `PlayCircleOutline` × `TimeOutline` | 0.858 | 分享管理列表行内状态图标，恒伴随文字行 |
| `PlayOutline` × `PlaySkipForwardOutline` | 0.850 | 播放器通用惯例（播放/下一曲），伴随 tooltip |

**接受档补注（观察档中的强惯例态对）**：`FolderOpenOutline` × `FolderOutline`（0.830，文件树展开/收起同位互斥）、`EyeOffOutline` × `EyeOutline`（0.773，显隐同位互斥，首批锁定 `common.hide`/`common.preview`）。

**观察档（其余 17 对，0.70~0.85，挂起复核）**：共性为圆环语法共享 + 出现处伴随文字或互斥态，无 icon-only 相邻独立动作对（清单见 `.goal-enhance/icon-similarity-2026-10-22.md`）。后续报告复看时若某对出现在新的 icon-only 相邻场景，升级终审。

### 5.3 禁配对清单与同图注记面

- `FORBIDDEN_ICON_PAIRS`（actionIcons.ts）：终审必改档的图形对静态入库，门禁 R6b 拦截 rail/NAV 注册面共现（硬失败）与同 `.vue` 文件共现（基线外失败）；`.ts` 渲染函数层共现由报告工具巡检（菜单/命令项的文字消歧场景不入静态面）。
- 动作段 × nav 段同图注记面（§4.1 表）：`HelpCircleOutline`/`NotificationsOutline`/`SettingsOutline`/`LockClosedOutline`/`ChatbubblesOutline`/`GlobeOutline`/`EyeOutline`/`DocumentTextOutline`/`GitBranchOutline`——超出清单的新同图须先补注记再合入（单测锁定）。

## 6. 禁用变体

| 禁用图标 | 原因 | 替代 |
| --- | --- | --- |
| `EllipsisHorizontal`（实心） | 与描边「更多」同屏混用产生层级错觉 | `common.more` → `EllipsisHorizontalOutline` |
| `SyncOutline` | 一图四义（轮换/轮播/诊断对比/Git 对比） | 轮换 → `share.rotate`；对比 → `git.compare`；轮播 → `PlaySkipForwardOutline`（非动作白名单） |
| `ReloadOutline` | 第三枚环形箭头，与刷新/重试难辨 | `common.retry` → `ArrowRedoOutline` |
| `AddCircleOutline` | 「新增」的第二形态 | `common.new` → `AddOutline` |

门禁按**导入名**全局拦截；基线 `web/scripts/icon-semantics-baseline.json` 落地时为零条。确需装饰性使用也必须先走基线评审并写理由，不直接放行。

## 7. 邻接冲突族

定义：同一 `.vue` 文件的**两个 icon-only 按钮**分别使用同族的不同图形 → 违规。带文字标签的按钮/菜单由文字消歧，不参与该规则（避免把「刷新」「重新分享」这类有文字的菜单项误报）。

| 族 | 图形 | 说明 |
| --- | --- | --- |
| `refresh-ring` | `RefreshOutline` / `SyncOutline` / `ReloadOutline` / `RepeatOutline` | 四枚环形箭头在 14px 下几乎同形 |
| `more-dots` | `EllipsisHorizontal` / `EllipsisHorizontalOutline` | 实心/描边 |
| `chat-bubbles` | `ChatbubblesOutline` / `ChatbubbleEllipsesOutline` / `ChatboxEllipsesOutline` | 三套聊天气泡 |
| `trash-cans` | `TrashOutline` / `TrashBinOutline` | 删除桶/回收站桶 |

族表是人工维护的「已确认难辨」集合，门禁 R5 本身不做视觉相似度启发式——系统性排查由 §5 的 `icon-similarity-report.mjs` 按需承担；新增近似图形时先跑报告自查，再在此登记，最后考虑门禁。带文字菜单、非 `button` 容器的自定义行操作不在邻接面内（已知边界，见脚本头注）。

## 8. 使用与新增流程

1. 新动作先查本表；有现成动作键就直接复用 `ACTION_ICONS['域.动作']`（模板 `import { ACTION_ICONS }` / `h()` 菜单取组件）。
2. 确属新动作：在 `actionIcons.ts` 增加一行 `'域.动作': IconName`，同步更新本文件选型理由；需要时加入邻接族与禁用变体。
3. **新增目的地（rail 面板/底部 tab/首页工具条按钮）**：图标必须登记 `NAV_ICONS`（面板键 = `PanelDef.id`），并在 `panels/registry.ts` 同处引用同一组件——两处漂移门禁 R6a-1 直接失败；新图形入表前先跑 `npm run icon:report` 自查占用与相似对。
4. 新增/更换图标必须落到 `ACTION_ICONS` / `NAV_ICONS` / `NON_ACTION_ICONS` / `BRAND_NAV_ICONS` 之一，否则 `npm run check:icon-semantics` 直接失败。
5. 模板里的动作图标可加 `data-icon-action="域.动作"` 标注（首批已覆盖 28 处），目的地图标加 `data-icon-nav="键"` 标注（`data-nav-surface` 声明面内 icon-only 按钮强制）：门禁会校验「标注键 → 注册表图形」的一致性，防止只改键不改图形。
6. 图标替换是纯视觉变更：不改 `data-testid`/文案/i18n 键；改完跑定向 e2e 与 `npm run check`；感知相似度变化用 `npm run icon:report` 复核并更新 §5 终审表。

## 9. 门禁

`web/scripts/check-icon-semantics.mjs`（零依赖，Node 原生 ESM）：

- **R1 注册表契约**：动作键命名/唯一、不同动作不共用组件、禁用变体不得混入映射、所有图形真实存在。
- **R2 分类完备**：`src` 内每个 `@vicons/ionicons5` 导入名必须已分类（动作/nav/非动作/品牌四段之一）。
- **R3 禁用变体**：导入名全局拦截，基线外命中即失败。
- **R4 动作标注**：`data-icon-action` 标注块必须恰含注册表指定图形；标注数量下限防解析失明。
- **R5 邻接冲突**：同文件 icon-only 按钮的邻接族冲突。
- **R6 目的地 nav（P-20261022-2）**：
  - **R6a-1 rail 完整性**：`panels/registry.ts` 每个 `registerPanel` 的 id 必须在 `NAV_ICONS` 登记同图（品牌组件按 `BRAND_NAV_ICONS` 豁免），缺登记/图形漂移即失败——注册表对账，不可基线化；
  - **R6a-2 nav 标注**：`data-icon-nav` 标注块必须恰含 `NAV_ICONS` 指定图形；
  - **R6a-3 nav 面完整性**：文件内 `data-nav-surface` 声明面（首页工具条）的 icon-only 按钮必须被 `data-icon-nav` 覆盖；
  - **R6a-4 一图一目的地**：`NAV_ICONS` 内同一图形对应两个键即失败；
  - **R6b 禁配对**：`FORBIDDEN_ICON_PAIRS` 的 rail/NAV 注册面共现 = 硬失败（不可基线化）；同 `.vue` 文件共现 = 基线外失败（`.ts` 层由 `icon-similarity-report.mjs` 巡检）。
- `--self-test`：注册表解析、禁用/未分类/键缺失/图形漂移/邻接红绿 + R6 的 nav 对账/一图两目的地/nav 标注/面完整性/禁配对共 27 项夹具断言。
- `--update-baseline`：治理逃逸口；重建后 stale 条目自动修剪。注册表自身错误（R1/R6a-1/R6b-rail）不可基线化。

## 10. 视觉验收

- icon-only 按钮专项 e2e（`icon-semantics.spec.ts`）覆盖：TopBar 更多/拉取/推送、GitPanel 快捷 fetch/pull/push、ShareManager 轮换菜单、FileTree 回收站/刷新、活动栏更多与新建项目的动作标注与图形契约。
- 14/16/20px × 深/浅主题的图标画廊由同一 spec 以真实注册表组件渲染（**动作段 + nav 段分区**，P-20261022-2 起首批三组消歧与邻位目的地的形状对比在画廊直接可查；测试端 SSR，不新增产品路由），截图基线随 spec 提交。
- TopBar/GitPanel/ShareManagerView/FileTree 四张整页截图是后续视觉回归的候选面；当前受共享 e2e 实例数据漂移影响未固化为基线，改由动作标注 + 上述画廊守形状契约。人工复核 14px 下的首批 6 组映射仍是合入前要求。

## 11. 许可与依赖

全部图标来自既有 `@vicons/ionicons5`（MIT，见 `docs/license-audit-20261006.md`）；注册表、门禁、画廊均为仓库内代码，零新增 npm/Go 依赖，无落盘/schema/协议变更。感知相似度报告工具只依赖既有开发面（`@playwright/test` devDependency 渲染 + `vue`/`@vue/server-renderer` SSR——icon 画廊 e2e 同款基建），报告落 `.goal-enhance/`（gitignored），不进 CI check 链。
