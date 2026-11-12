package agentops

// 内置能力域手册分节。新增后端能力：在自己的模块里 RegisterSection 一节
//（Order 决定章节顺序），/ops-manual 与 SKILL.md 自动包含。

func init() {
	RegisterSections(
		Section{
			ID: "meta", Title: "能力探测（对旧实例先探测再降级）", Order: 6,
			Summary: "调实例代理对端的新端点前先 GET /api/meta 看 capabilities，未声明即走逐项降级（公开免 token）",
			Body: `多实例异版本部署是常态：经实例代理（/proxy）调旧版本对端时，新端点会 404。
约定：调用不确定对端是否支持的端点前，先探测对端能力清单，未声明即走逐项降级路径。

- GET /api/meta                                版本与能力清单（公开只读，免 token）
  返回 {"version":{"version","commit","buildTime","apiVersion"},"capabilities":[...]}
  capabilities 为 kebab-case 端点家族名，已投用如：
  - "ahead-behind-all"  GET   /api/ahead-behind              全项目批量 ahead/behind
  - "fetch-all"         POST  /api/fetch-all                一键全部拉取
  - "bulk-agent"        POST  /api/terminals/bulk-agent     舰队批量发起 agent 会话
  - "notes-global"      /api/notes 族                        笔记库（项目无关的唯一笔记库，P-20261108-3 单库化——
                                                             旧对端可能仍声明已退役的 notes/notes-multi 项目笔记族）
  - "flat-file-list"    GET   /api/projects/:id/file-list    扁平文件清单
  - "file-history"      GET   /api/projects/:id/file/history 本地文件历史
  - "fs-attribution"    GET   /api/projects/:id/fs-attribution 文件改动来源归因
- GET /api/modules                             模块发现清单（公开只读，免 token）：
  能力面前缀按模块分组（粗粒度族，非全量端点表）——写集成/巡检脚本前先看
  这里有哪些能力族，与 /api/meta 的细粒度能力项互补

## 强制约定

- 未声明能力项的端点家族：改调逐项端点（如无 "ahead-behind-all" 就逐项目调
  GET /api/projects/:id/ahead-behind），不要对着旧对端白白发注定 404 的请求。
- 探测本身 404/失败 = 对端是旧版本：一律按全量降级处理，勿反复重试 /api/meta。

## 示例：批量端点探测降级

1) 探测对端能力（免 token）：
` + "```bash" + `
curl -s {{BASE}}/api/meta
# {"version":{"version":"1.2.0","commit":"...","buildTime":"...","apiVersion":"1.0.0"},
#  "capabilities":["ahead-behind-all","fetch-all","flat-file-list","notes-global","file-history"]}
` + "```" + `

2) capabilities 含 "ahead-behind-all" → 批量端点一次拿全：
` + "```bash" + `
curl -s {{BASE}}/api/ahead-behind -H "X-Lock-Token: $CC_LOCK_TOKEN"
` + "```" + `

3) 不含（或探测 404 = 旧版本对端）→ 逐项目降级：
` + "```bash" + `
for id in <项目id...>; do
  curl -s "{{BASE}}/api/projects/$id/ahead-behind" -H "X-Lock-Token: $CC_LOCK_TOKEN"
done
` + "```",
		},
		Section{
			ID: "error-codes", Title: "错误码对照（按 code 分支自纠）", Order: 7,
			Summary: "4xx/5xx 错误响应带稳定 code 字段（<域>.<错误> 点分式）——按 code 程序化分支自纠，不要解析 error 文本",
			Body: `错误响应形态：{"error":"<人类可读>","code":"<域>.<错误>"}，携额外载荷的错误同体多带字段
（如 files.conflict 带 currentContent / ops.approval_required 带 approvalId）。
code 与 HTTP status 的绑定是稳定契约（单测门禁防漂移）；部分端点尚未迁移、响应暂无
code 字段——此时按 HTTP status + error 文本降级判断即可。

## 对照表（code → HTTP → 含义与建议动作）

- projects.not_found            404  项目 id 不存在：GET /api/projects 核对 id
- project.locked                403  项目硬锁（归档不可变档）：不要重试/绕过，报告用户先在
                                     首页项目卡右键解锁，再继续原任务（见 projects 节）
- files.path_required           400  缺 path（或 oldPath/newPath）字段：补上重发
- files.payload_invalid         400  请求体非法（JSON 解析失败/字段非法）：修正载荷重发
- files.payload_too_large       413  请求体超写入上限：缩小单次写入（大数据经终端命令分块落盘）
- files.path_outside_root       403  路径越出项目根（绝对路径/.. 段/符号链接外逃）：改用项目内相对路径（正斜杠）
- files.name_invalid            400  文件名跨平台不兼容（Windows 保留设备名/结尾点空格等）：换合规名字
- files.conflict                409  目标已存在/文件打开后被外部修改：先读现状再决策（带 baseHash 保存时响应附 currentContent）
- files.not_found               404  文件不存在：核对路径或先创建再写
- files.file_too_large          413  文件过大无法整读：GET /file?path=&maxBytes= 部分预览或分段读取
- files.binary_not_previewable  415  二进制不进文本预览（响应附 policy 元信息）：改走下载或专用工具
- files.sensitive_confirm_required 409  批量替换命中敏感文件名（.env/密钥/凭据类）且未确认：
                                     响应附 sensitiveHits 清单——核对后带 confirmSensitive=true 重发
- ops.payload_invalid           400  请求体非法：修正 JSON 重发
- ops.event_type_invalid        400  ops-notify type 空/超 64 字符/带 system: 保留前缀：换合法 type
- ops.event_payload_invalid     400  内置事件（preview.port/task.progress/open-file-at/watch.invite）载荷非法：按 ops-channel 节载荷约定修正
- ops.payload_too_large         413  ops-notify 请求体超 64KB 封顶：精简载荷重发（通知是短文本语义，
                                     步骤名/label 文本字段各 ≤4096 字节，超限 400）
- ops.approval_required         428  智能体令牌命中高危端点待审批：轮询 GET /api/ops-confirm/<approvalId> 至 allowed，
                                     携 X-Approval-ID 头重试原请求（一次性放行，5 分钟内完成）
- ops.approval_denied           403  审批规则 deny：不可放行也不可重试，向用户报告并给替代方案
- ops.confirm_op_invalid        400  ops-confirm 的 op 为空或超 128 字符
- ops.confirm_field_too_long    400  target/detail/sessionId 超长：精简后重发
- ops.confirm_impact_invalid    400  ops-confirm 的 impact 影响面载荷非法（kind 枚举外/
                                     summary 空/命令超 5 条等）：修正或去掉 impact 重发（可选字段）
- ops.confirm_not_found         404  审批不存在（未产生/已过期/已被一次性消费）：重新发起确认
- ops.confirm_already_resolved  409  审批已被裁决：读轮询响应的终态继续，勿重复提交裁决
- ops.confirm_horizon_invalid   400  放行时限档位非法（非 session|24h|always，或 session 档缺
                                     会话归属）：修正 horizon 字段重发
- ops.confirm_status_invalid    400  审批列表 GET /api/ops-confirm 的 status 过滤参数非法
                                     （非 pending|allowed|denied）：修正或去掉 status 重发
- ops.message_payload_invalid   400  定向消息 to/body 缺失或超上限（body ≤2KB），或缺
                                     X-Session-ID 发送方头：补齐重发
- ops.message_target_not_found  404  定向消息目标会话不在册（打错地址/目标已关闭）：
                                     GET /api/terminals 核对 id 后重发
- ui.payload_invalid            400  POST /api/ui/snapshot 载荷非法（JSON 解析失败/字段超上界）：修正重发
- ui.snapshot_unavailable       404  无在报用户现场（用户设置关闭 / 10 分钟无心跳过期 / 浏览器
                                     未开项目页——三类同语义）：直接走无现场降级路径提问，
                                     不要重试等待，也不要向用户追问「现场在哪」
- runbook.payload_invalid       400  POST /api/runbooks/:id/run 请求体非法（JSON 解析失败/
                                     onFailure 非 continue|stop）：修正重发
- runbook.params_missing        400  运行书步骤占位符参数缺失/空白：响应附 missing 清单
                                     （按步骤出现序）——补 params 字段重发
- runbook.busy                  409  同一本书已有一次执行在途（同书串行互斥）：等在途
                                     run 返回再发起，或改跑其他书
- runbook.target_not_found      404  显式 targetSessionId 不在册：GET /api/terminals 核对 id，
                                     或缺省让服务端新建独立执行现场
- fleet.targets_required        400  舰队执行缺 targetIds：补目标会话清单重发
- fleet.targets_too_many        400  目标数超本地+远程会话上限之和：分批编排
- fleet.targets_not_found       400  部分 targetIds 不在册：响应附 missing 清单——
                                     GET /api/terminals（远程另 GET
                                     /api/remotehosts/terminals）核对后重发
- fleet.run_not_found           404  runId 不在册（终态保留窗 1h 已过/服务重启）：
                                     重新发起舰队执行，勿对过期 run 中止/重试
- fleet.run_busy                409  run 仍在跑（retry 拒绝运行中 run/已有单格重试
                                     在途）：等终态（task.progress fleet final）再操作
- fleet.cell_not_retryable      400  该格不可单台重试（仅 failed|aborted 可重；
                                     done 重试防双跑，skipped 是未发送）
- git.index_lock_stale          500  git 写命令失败且检出遗留 index.lock：POST
                                     /api/projects/:id/index-lock/cleanup 一键清理
                                     后重试原命令（自纠闭环，勿反复硬重试）
- git.write_busy                500  写串行队列等待 30s 超时（命令未执行）：稍候重发；
                                     持续命中说明有长写任务占队，先查在途任务
- git.index_lock_fresh          409  清理端点拒绝删「锁龄未达阈值」的活锁：等几秒
                                     重试清理，或向用户报告排查持锁进程
- git.hunk_conflict             409  回滚 hunk 时变更块已被再改：重拉 diff 按新内容
                                     重新决策，勿盲目重试
- git.conflict_stale            409  冲突解决写回时文件已被外部改动（响应附
                                     currentContent）：重读现状再决策
- clone.dest_exists             400  克隆目标目录存在且非空：换目录或清空后重发
                                     （空目录放行不报）
- clone.url_invalid             400  克隆 URL 形态非法（空白/全角/无法识别）：修正重发
- deploy.host_busy              400  同主机已有在途部署任务且本次不等候（句中含持锁
                                     任务 id）：等它结束或先取消，勿重复触发
- remote.auth_failed            502  SSH 认证被拒：核对凭据与账号后修正，勿原样重试
                                     （连续失败可能触发对端限频）
- remote.host_key_changed       502  主机指纹与钉扎不符（重装/轮换或中间人）：与用户
                                     核对后重置指纹再连，勿静默重试
- remoteaccess.profile_not_found 404 中继档案 id 不存在：GET /settings 的
                                     remoteAccess.profiles 核对后重发
- remoteaccess.config_invalid    400 远程接入配置校验失败：按 message 修正档案
                                     字段（authType/password/sshKeyId/端口）
- remoteaccess.payload_invalid   400 控制端点请求体非法：action 仅 start|stop
- remoteaccess.lock_required     409 锁定功能未启用/未配置密码：先在设置·安全
                                     启用锁定并设置密码，否则公网暴露不限权限
- remoteaccess.tls_insecure_confirm_required
                                 409  TLS 未启用：确认风险后携
                                     confirmInsecureTls=true 重发（确认入审计）
- remoteaccess.start_failed      502 反向隧道建立失败（拨号/远端绑定被拒）：
                                     先 POST /api/remoteaccess/tunnel/test 预检，
                                     按 hint 修 VPS sshd/防火墙后重试
- terminal.payload_invalid      400  terminal 域全部 JSON 端点请求体非法（JSON
                                     解析失败/必填字段缺失，创建/改名/调尺寸/广播/
                                     编队/排队/外部接管/命令预览/会话元数据等，经
                                     shared.BindJSON 统一收口）：修正载荷重发
- terminal.ids_empty            400  广播缺 ids：补会话 id 清单重发
- terminal.ids_too_many         400  广播 ids 超单进程会话上限：分批发
- terminal.data_required        400  广播缺 data：补输入内容重发
- terminal.data_too_large       400  单次广播输入超 64KB：拆分或改走粘贴链路
- terminal.body_too_large       413  广播请求体超 128KB 封顶：拆分
- terminal.project_ids_empty    400  编队缺 projectIds：补项目 id 清单重发
- terminal.project_ids_too_many 400  编队超单次 20 个项目上限：分批发起
- terminal.prompt_required      400  编队缺 prompt：补任务指令重发
- terminal.queue_full           409  排队指令满队（5 条）：等会话消费/取走队列后再入队
- terminal.queue_invalid        400  排队指令空/超 2000 字符：精简后重发
- search.rate_limited           429  搜索超限，响应附 retry_after 秒数：按 retry_after
                                     等待后重试或降低检索频次（窗口滑动自动恢复；
                                     同时留意 system:rate-limited 回告）。内容搜索
                                     30 次/分钟/项目（P-20261004-124）；终端输出检索
                                     30 次/分钟/会话或令牌/IP（P-20261005-158）
- notes.not_found               404  笔记篇不存在：GET /api/notes 清单核对 noteId
- notes.conflict                409  笔记 baseUpdatedAt 过期（响应附 currentContent/
                                     currentUpdatedAt）：先读现状再决策（覆盖/载入
                                     服务端版本/另存新篇），勿盲目重试覆盖
- notes.too_large               413  笔记内容超 256KB：精简后重发
- notes.global_limit            400  笔记库篇数达上限（100 含回收站）：删减或彻底
                                     删除回收站篇后重试（P-20261108-3 单库化后唯一
                                     额度码，项目档 notes.limit_reached 已随项目笔记
                                     端点退役）
- notes.title_too_long          400  笔记标题超 200 字节：换短标题

## git 失败恢复 hint（kind → 建议动作）

git 操作失败的错误响应（gitops 统一出口 + pull 409 通道）额外携带结构化恢复提示
{"hint":{"kind":"...","detail":"..."},"error":...}（P-20261005-194）——与 code 正交：
code 管注册文案的程序化分支，kind 管恢复语义，可同体（如遗留锁既有
git.index_lock_stale 码又有 kind=lock）也可各自单独出现。agent 按 kind 编程自愈
（fleet 巡检 push 拒 = pull-再-push 重试策略）；未命中特征（保守匹配，宁可漏分类
不误分类）响应无 hint 字段，按既有 code/status 降级判断。

- non-fast-forward   push 被拒（远端有本地没有的提交）：先 pull 再重推原命令
- diverged           本地与远端历史分叉：按仓库策略 pull（合并或变基）后重推；
                     无 pull 配置的仓库 git 会拒绝拉取，先与用户确认合并/变基二选
- conflict           合并/变基/cherry-pick 停在冲突：改冲突文件 → git add →
                     走既有冲突解决/继续端点（见 git 节），勿盲目重试原命令
- authentication     凭据/权限失败：核对凭据与账号（设置→安全凭据面）后重试；
                     勿原样反复重试（可能触发对端限频）
- lock               index.lock 残留（detail=锁文件路径）：无在写 git 进程时
                     POST /api/projects/:id/index-lock/cleanup 一键清理后重试；
                     清理端点对活锁（fresh）会拒绝，等几秒再清
- dubious-ownership  仓库目录属主与当前用户不符（safe.directory 拦截）：
                     报告用户以受信用户运行，或 git config --global --add
                     safe.directory <仓库路径> 后重试
- hook-rejected      钩子拒绝（pre-receive 推拒 / pre-rebase 拦截）：读错误里
                     的钩子输出修正违规（如分支命名/提交规范），勿绕过
- network            网络不可达（DNS/连接/超时）：核对网络与代理后重试，
                     属环境问题不在服务端自纠范围

## 约定与边界

- code 覆盖 agent 可分支的错误；内部故障（5xx 存储失败等）不带 code——不要对 5xx 重试风暴。
  显式例外：git.index_lock_stale / git.write_busy 是「可自纠的 5xx 携 code」（历史 status
  兼容优先），按对照表动作自纠，不属重试风暴范畴。
- ops-notify 频率限制不走错误通道：超限请求仍回 200（静默丢弃，防诱发重试放大风暴），
  经 ops-channel 每窗口回告一条 "system:rate-limited" 事件（携带 dimension/key/dropped/limit）
  ——收到即降频或修复上报循环，勿以 HTTP 状态判断限流。
- 搜索族限流走错误通道（429 + code search.rate_limited + retry_after）：内容搜索
  （P-20261004-124，回告 dimension "project"）与终端输出检索（P-20261005-158，键带
  sid:/tok:/ip: 前缀、回告 dimension 按前缀推导 session/token/ip）。与 ops-notify 相反
  ——搜索是同步取结果的原语，429 即明确回执；system:rate-limited 回告是给操作面的
  旁路感知，不替代 429 自纠。
- 远程主机部分端点（诊断 /exec/连通性测试/git 对比）把连接错误装进 200 响应的 error 字段
  （UI 先行设计），不经错误通道——那些面按 error 文本稳定标记（auth rejected / host key
  has changed / connection refused 等）降级判断；code 面只覆盖 JSON 错误通道端点。
- git/remote 域错误响应同时携带稳定文本标记（errmarkers 注册表）与 code：前端按标记映射
  本地化文案、agent 按 code 程序化分支，双轨并存互不替代；迁移不回退任何 message 关键字。
- 建议动作是指导而非硬约束；稳定承诺 = code 字符串本身与 code↔HTTP 绑定（随重构不变）。
`,
		},
		Section{
			ID: "projects", Title: "项目管理", Order: 10,
			Summary: "列出/添加/删除项目与查状态；项目硬锁（locked）写族一律 403",
			Body: ` - GET    /api/projects                      列出项目（含分支/远程地址）
- POST   /api/projects                      添加项目 {"name","path"(必须是 git 仓库)}
- GET    /api/projects/:id                  项目详情（id/name/path/locked 等注册面字段）
- PUT    /api/projects/:id                  修改项目 {"path"}——项目目录在磁盘上移动后
                                            重定位注册根（新路径须存在且为目录；与其他
                                            项目重复登记 409，指回当前路径为幂等放行）；
                                            项目内容迁移请用文件/git 端点，本端点只改注册
- DELETE /api/projects/:id                  移除项目（级联关闭其终端）
- GET    /api/projects/:id/status           git 状态（暂存/未暂存/未跟踪）

## 项目硬锁（locked = 归档不可变档）

项目列表项带 "locked": true 时，该项目的**全部写族端点一律 403**：文件写
（write/create/mkdir/rename/delete/upload/history-restore）、git 写（stage/
commit/push/pull/reset/rollback/merge/rebase/stash/tag/worktree 等）与该项目
终端创建（POST /api/terminals 携其 projectId 或 agent 会话 dir 落在项目内）。
读面（status/log/diff/file 读等）不受影响。

## 强制约定：403 含 "project.locked" 时的自纠路径

- 不要重试、不要换端点绕过（写族全在同一守卫后面）、更不要改动项目外路径。
- 正确动作：向用户报告「项目 X 已锁定（归档不可变档），需要写操作请先解锁」
  （首页项目卡右键 → 解锁），等用户解锁后再继续原任务。`,
		},
		Section{
			ID: "files", Title: "文件读写", Order: 12,
			Summary: "跨项目读/写/建/删/改名/建目录/上传/搜索/批量替换/回收站/在系统中显示",
			Body: ` - GET    /api/projects/:id/file?path=       读文件内容（跨项目场景必须走 API，不依赖 Agent 自身工具）
- PUT    /api/projects/:id/file             写文件 {"path","content"}
- POST   /api/projects/:id/file/create      新建文件 {"path","content"?}
- POST   /api/projects/:id/file/mkdir       新建目录 {"path"}
- POST   /api/projects/:id/file/rename      重命名/移动 {"oldPath","newPath"}
- POST   /api/projects/:id/file/delete      删除文件 {"path"}（进回收站，7 天内可恢复）
- POST   /api/projects/:id/files/duplicate  创建副本 {"path"} → 201 {"path","isDir"}：
                                            同目录 <stem>-copy<N>.<ext>（N 自 1 取首个不冲突，
                                            响应 path 是新路径唯一权威）；文件字节级复制、
                                            目录递归整树（条目上限 20000 超限 400）。做配置/
                                            脚本变体时优先用它，替代「读内容→新建→写回」
                                            三步编排（也覆盖二进制/超大文件——不走预览策略）
- POST   /api/projects/:id/files/batch      批量操作原语（单请求 + 逐条结果清单，单批 ≤200，
                                            批量整理/清理生成物优先用它替代逐条循环）：
                                            {"action":"move|delete|rename|copy",
                                            "entries":["path",...],              move/delete/copy 形态
                                            "destDir":"docs",                    move/copy 目标目录，缺省项目根
                                            "renames":[{"oldPath","newPath"},...]}  rename 形态
                                            → {"ok","skipped","failed","results":[{"path",
                                            "status":"ok|skipped|error","error"?}]}，失败不中断批次
                                            （按 results 逐条对账，error「file already exists」=
                                            目标已存在）。delete 逐条进回收站可恢复；move 保持叶子名
                                            挪入 destDir（条目在另一条目子树内随父 skipped）；rename
                                            按提交序执行，父目录先于子项时子项旧路径自动改写（选中集
                                            含目录及其子项先列目录）；copy 复制入 destDir，同名自动
                                            改名「-副本N」步进（复制要的是新副本，绝不覆盖既有条目），
                                            目录递归整树（条目上限 20000 超限逐条 error），目标目录在
                                            源条目子树内随条目 skipped（防子树自吞）。高危：agent 令牌
                                            一次审批覆盖整批（delete 形态 op「删除文件（批量 N 个）」，
                                            存量「删除文件」规则前缀照常命中；copy 形态 op「批量复制
                                            文件（N 个）」）
- GET    /api/projects/:id/file/stat?path=  删除前规模统计 {"isDir","files","dirs","bytes","sizeHuman","truncated"}（目录递归计数含隐藏文件；超 2000 条目 truncated=true 结果为下界；删除前先查此端点向用户复现规模）
- GET    /api/projects/:id/trash            回收站列表 [{"id","path","name","isDir","size","deletedAtMs","degraded"}]（删除的文件/目录 7 天内可恢复；degraded 条目 path 不可知仅可彻底删除）
- POST   /api/projects/:id/trash/:entryId/restore  恢复条目到原路径（响应 {"restoredPath","relocated"}；目标已存在 409；原父目录已消失时落到项目根并置 relocated=true）。
                                            可选 ?as=<newname> 重命名恢复：只换叶子名保留原父目录（目录条目同语义），仅接受 basename
                                            形态（路径分隔符/点段/Windows 保留名 400 code files.name_invalid）；as 命中已存在目标
                                            照旧 409——恢复冲突时自定新名（如 <name>-restaged.<ext>）换名重试，绝不覆盖现有文件
- DELETE /api/projects/:id/trash/:entryId   彻底删除该条目（危险，不可恢复）
- POST   /api/projects/:id/file/upload?dest=[&overwrite=1]  上传文件（multipart 字段 files）。
                                            缺省跳过目标目录同名文件（skipped 携原因 file already exists，同名目录同样跳过）；
                                            overwrite=1 放行替换同名目标，替换前先把磁盘旧内容留档本地历史。
                                            multipart filename 支持含 / 的子路径（相对 dest 自动建目录；
                                            .. 段与盘符段拒绝——目录拖入展平上传的通道，P-20261023-2）
- GET    /api/projects/:id/file-tree?path=  目录树（分页按层）
- GET    /api/projects/:id/file-list        扁平文件清单（单请求，大仓库友好）
- GET    /api/projects/:id/search?q=        内容/文件名搜索（本机装有 ripgrep 时自动用作加速后端，没有则回退 git grep，结果一致仅速度不同；中文查询对 GBK 等非 UTF-8 文件同样有效）。
                                            限流 30 次/分钟/项目（P-20261004-124 子进程风暴防线）：超限 429 带 code
                                            search.rate_limited + retry_after 秒数——收到即降频，窗口滑动自动恢复；
                                            同时每 key 每窗口广播一条 system:rate-limited（dimension "project"）
- GET    /api/search/projects?q=            跨项目批量内容搜索（并发池聚合，结果按项目分组；
                                            「这个函数在哪个项目」的全局原语）。限流 30 次/分钟按客户端维度
                                            （单请求扇出至多 50 项目，超限同上 429 + search.rate_limited）
- GET    /api/projects/:id/file-policy?path= 读取策略分级 {"policy":"text|too-large|binary",...}
                                            ——整读/编辑/下载走哪条路先查这里（超大分块、
                                            二进制不进文本预览）
- GET    /api/projects/:id/file/download?path=  单文件下载出档（私有内容，no-store）
- GET    /api/projects/:id/dir-archive?path=    目录流式打包 zip 下载（probe=1 返回 JSON 元信息）
- GET    /api/projects/:id/files-archive?paths=&… 多选批量归档 zip（文件/目录混合集合；
                                            probe=1 返回 JSON；排除 .git 由 excludeGit 控制）
- GET    /api/projects/:id/file/history?path=   本地文件历史版本列表（写前留档可回溯）
- GET    /api/projects/:id/file/history/content 版本内容查看
- POST   /api/projects/:id/file/history/restore 恢复到历史版本
- GET    /api/projects/:id/fs-attribution?path=&limit=  文件改动来源归因（P-20261005-170
                                            对账原语）：「这个文件刚才被谁改的」——
                                            watcher 事件 × 会话命令窗（OSC133 C/D）
                                            时间关联，事件发生当时判定入账。
                                            [{at,path,op,source,attributions?,
                                            overlap?}]（新→旧，limit 缺省 50 上限 500；
                                            path 缺省=全部路径的最近事件）。
                                            source=command 时 attributions 列
                                            [{terminalId,sessionName,command,
                                            exitCode,running?,startedAt,endedAt?}]
                                            （多会话并行同项目重叠窗全列+overlap=true
                                            歧义如实呈现）；source=editor=本产品文件
                                            API 写（编辑器保存/替换/改名/删除链）；
                                            source=unattributed=无窗无标记（诚实账，
                                            shellint 缺失/窗间隙/git API 写照实入账）。
                                            环形每项目 500 条。范围注记：node_modules/
                                            target 等依赖与构建产物目录不入账。典型
                                            用法：改完文件后核验副作用归属（自证
                                            「只改了 a.ts」/排查他者覆写）、异常文件
                                            变化的第一排查口
- POST   /api/projects/:id/replace/preview  批量替换命中预览（纯读不写）：
                                            {"pattern","replacement","glob"?,"maxFiles"?,
                                            "caseSensitive"?,"wholeWord"?,"useRegex"?} →
                                            {files:[{path,hits,rows:[{line,before,after}]}],
                                            totalFiles,totalHits,truncated?,sensitiveHits?}。
                                            rows 每文件最多 20 行；truncated=true = 命中超出
                                            扫描/maxFiles 上限（缩小 glob 分批）；sensitiveHits
                                            命中敏感文件名清单——执行前先向用户确认
- POST   /api/projects/:id/replace          执行批量替换（高危：agent 令牌走审批 428，
                                            与 git push 同级；一次改写 N 个文件）：
                                            同上请求 + "confirmSensitive"（sensitiveHits
                                            非空时必须 true 否则 409 files.sensitive_confirm_required）。
                                            执行前强制落备份 patch（响应 data.backup.{name,empty}，
                                            empty=true=执行前工作区干净）；逐文件写回携
                                            changed[{path,hits}]/skipped[{path,reason}]/
                                            conflicts[path]（写前外部改动检出，该文件跳过）。
                                            正则为服务端 Go RE2（无前瞻/后顾/反向引用），
                                            编译失败 400 提示降级字面量
- GET    /api/projects/:id/replace/backups[?name=]  替换备份清单（新→旧）/指定 patch 内容。
                                            回滚组合：GET ?name= 取 patch → 丢弃替换后改动
                                            （POST /rollback 或 git checkout --）→
                                            POST /patch/import {"content","apply":true}。
                                            备份保留 30 天/每项目 50 份自动清账；
                                            untracked 命中文件以 new-file 段入备份
                                            （回滚时先删除该文件再 apply 即还原替换前内容）
                                            执行请求可携 "paths":[...]（P-20261004-66）：
                                            命中集收窄到显式清单（≤500 条）——用户/
                                            agent 只想改勾选的文件时传，totalHits 随
                                            圈定口径
                                            批量重构推荐工作流：replace/preview 预览
                                            （文件×行 before→after + 敏感警示）→ 向用户
                                            确认 → replace 执行（审批放行）→
                                            replace/backups 备份可查可回滚
- GET    /api/projects/:id/replace/history  替换历史清单（新→旧，P-20261004-66）：
                                            [{id,time,pattern,replacement,useRegex?,
                                            files,hits,changed[{path,hits}],backupName?,
                                            backupEmpty?,patchBytes?,patchTruncated?,
                                            restorable}]——每次执行替换自动留档
                                            （每项目 20 份/30 天自动清账），补丁内嵌
                                            文档（超 2MB 只留 artifacts 引用）
- POST   /api/projects/:id/replace/history/:hid/restore  一键还原该次替换
                                            （高危：agent 令牌走审批 428，op「批量替换
                                            还原」）：把该次改写的文件回滚到替换前现场
                                            （checkout+正向 apply 备份补丁；untracked
                                            命中文件不在还原范围，响应 data.untracked>0
                                            即有此类文件，走本地历史快照）。apply 段
                                            失败（暂存区被推进）→ 409 "replace backup
                                            no longer applies"（稳定标记，此时工作区
                                            已归暂存区态，补丁仍在可重试）；
                                            备份已清账且未内嵌 → 410
- POST   /api/projects/:id/reveal           在实例宿主的系统文件管理器中显示目标 {"path"(项目相对，空=项目根)}。
                                            Windows explorer /select 与 macOS open -R 选中定位，Linux xdg-open 无选中支持
                                            退化为打开所在目录；打开的是**实例宿主**的窗口（本机实例为主场景）；
                                            headless 无显示环境返回 501（非暂时性故障，不要重试），xdg-open 缺失 500 带提示
- 敏感写入路径窄表闸（可预判：哪些写入会触发审批——透明协议）。写入请求的
                                            路径参数命中 **/.git/hooks/**、**/.git/config、**/.ssh/**
                                            （大小写/分隔符/./ 前缀归一后判定，** 吞零段故目录自身与子模块
                                            .git 一并覆盖；窄表刻意不收 CI 配置等日常编辑对象）时，下列写入
                                            端点对 agent 令牌返回 428 ops.approval_required + approvalId
                                            （审批卡 op「写入敏感路径 <path>」，不写盘零副作用）：
                                            PUT file / POST file/create / file/mkdir / file/rename（按 newPath）/
                                            file/upload（按 dest+文件名预检整批）。放行协议与其他高危面一致：
                                            轮询 GET /api/ops-confirm/<approvalId> → 用户允许 → 携 X-Approval-ID
                                            重试（一次性；审批钉死在卡面路径，跨路径重放视为无效头）。
                                            未命中照常（日常开发零打扰）；设置·审批规则以「写入敏感路径」为
                                            op 前缀、可叠 pathPattern 按路径细化 allow/deny。分工注记：本闸是
                                            agent 经 API 写入的**事前**关口；工作台外部改动由事后审计账
                                            （敏感读取审计/外部修改检出）覆盖，两者互补不替代`,
		},
		Section{
			ID: "settings", Title: "应用设置", Order: 20,
			Summary: "主题/终端/语言等读写（变更自动广播）",
			Body: ` - GET    /api/settings                      读取设置（主题/字体/终端后端/语言等）
- PUT    /api/settings                      部分更新设置（如 {"terminalTheme":"dracula"}；
                                            变更后系统自动广播 settings.changed，前端实时跟随）。
                                            终端默认 shell：{"terminalDefaultShell":"bash"}（裸名或
                                            完整路径，服务端做存在性校验；空串=清除回落平台缺省）
                                            ——仅影响新会话，agent 拉起纯终端可用候选见
                                            GET /api/terminals/shell-candidates
- userPrefs 用户偏好漫游单键（Settings Sync）：键位覆盖/通知三件/终端习性
                                            开关随账号漫游，GET null=未配置，PUT 对象
                                            整体替换（省略=不动；显式 null=清空并恢复
                                            「未配置」形态，各端下次启动走播种分支；
                                            服务端仅校验合法 JSON+
                                            ≤64KB，键域 schema 前端自治——keymap 覆盖
                                            表/notify{dnd,sound,simple}/terminal
                                            {copyOnSelect,followAppTheme}，稀疏偏差集
                                            仅存≠默认项）。预置键位方案：GET 读现值→
                                            合并 keymap 段→PUT 整体写回，settings.changed
                                            自动广播、各端打开即跟随；键位值用规范形
                                            （ctrl+alt+p 小写+号序，与前端改键录入同口径）
- externalAccessUrl 手机扫码外部入口（P-20261019-10）：
                                            PUT /api/settings {"externalAccessUrl":"https://nas.example.net"}
                                            仅 http/https origin（scheme+host+可选 port，无凭据/
                                            路径/query/fragment，尾斜杠与默认端口归一）；
                                            空串=清除，二维码回落当前地址/局域网候选；
                                            GET /api/settings 同键回读
- sharePublicBaseUrl 分享外发基址（P-20261020-2）：
                                            PUT /api/settings {"sharePublicBaseUrl":"https://share.example.net"}
                                            仅 http/https origin（同 externalAccessUrl 规则）；
                                            非空=分享短链固定为 <该 origin>/s/<token>（优先于
                                            externalAccessUrl/当前地址/局域网候选），空串=清除回落
                                            自动选址；改值即时生效（每次拼链现读），GET 同键回读。
                                            反代/隧道只转发主端口或分享域名独立时用它——agent 可
                                            据此自诊断「外发链接能不能被对端打开」
- updateProxyAutoDetect 系统代理自动探测开关（P-20261110-1 S6）：
                                            PUT /api/settings {"updateProxyAutoDetect":true}
                                            显式代理与 env 都未给出时更新链改用探测到的
                                            桌面系统代理（默认关，省略=不动）。诊断配套：
                                            GET /api/updates/proxy-status 更新链当前生效
                                            出站档位（tier: explicit/env/sysdetect/direct，
                                            按更新目标 github.com 裁决）+ 生效代理地址
                                            （userinfo 已脱敏）+ 最近一次探测结果——agent
                                            可代诊断「更新走哪条路、为什么走不通」`,
		},
		Section{
			ID: "system", Title: "系统网络与外部入口", Order: 21,
			Summary: "GET /api/system/network 本机非回环地址清单；settings.externalAccessUrl / sharePublicBaseUrl 配置手机与访客可达入口",
			Body: `二维码接力在桌面端以本机回环（localhost）打开时，手机扫码无法访问——
先看本机暴露了哪些地址，再决定用局域网还是外部入口。

- GET    /api/system/network                 本机非回环地址清单（只读，管理面鉴权）：
                                            {data:[{ip,family:"v4"|"v6",iface,private}]}
                                            过滤回环/未指定/链路本地/组播/未启用接口；
                                            private=true 含 RFC1918/ULA/CGNAT（Tailscale
                                            100.64/10）；不返回 MAC/主机名。
                                            用于自诊断「本实例对局域网暴露哪些地址」，
                                            也是二维码接力回环入口下的候选源。
- GET    /api/settings                       读设置（externalAccessUrl / sharePublicBaseUrl
                                            与其余设置同体）
- PUT    /api/settings                       写外部访问地址（手机扫码入口）：
                                            {"externalAccessUrl":"https://nas.tailnet.ts.net"}
                                            仅 http/https origin（无凭据/路径/query/fragment，
                                            尾斜杠与默认端口归一）；空串=清除。该地址只作
                                            二维码/复制内容，不参与任何重定向。
- PUT    /api/settings                       写分享外发基址（P-20261020-2，访客短链入口）：
                                            {"sharePublicBaseUrl":"https://share.tailnet.ts.net"}
                                            仅 http/https origin（同上规则）；空串=清除回落自动
                                            选址。分享短链 = <该 origin>/s/<token>，该 origin 需
                                            转发 /s/* 与访客页 vendored 资产；只作拼链内容，
                                            不参与重定向。
  注意：局域网候选可用还要求服务端监听非回环 host（默认 127.0.0.1 仅本机可达）；
        外网入口（Tailscale/Cloudflare Tunnel/公网反代）由用户自行配置并保证可达；
        只反代主端口时分享默认走主 origin 同源 /s/（P-20261020-2），无需暴露
        sharePort。`,
		},
		Section{
			ID: "instances", Title: "实例管理", Order: 25,
			Summary: "多实例拓扑查看/增删改/连通性检查",
			Body: ` - GET    /api/instances                     实例列表（含角色/状态）
- POST   /api/instances                     添加实例（远程节点）
- PUT    /api/instances/:id                 修改实例
- DELETE /api/instances/:id                 删除实例（危险）
- POST   /api/instances/:id/check           检查单个实例连通性
- POST   /api/instances/check-batch         检查全部实例
- POST   /api/instances/:id/dispatch        联邦派发（P-20261004-101）：在本中心
                                            登记的从实例上创建 agent 会话——
                                            {"name"?,"runtime"?,"dir"?,"launchArgs"?
                                            （≤500 字符）}，kind 恒 agent；中心经
                                            对端令牌转发 POST 对端 /api/terminals，
                                            返回 {remoteSessionId,instanceUrl,...}。
                                            对端 4xx 预检原文透传（runtime not
                                            installed 等稳定标记原样回传，按
                                            error-codes 分节同款原文自纠）；
                                            网络失败 502 前缀 remote unreachable。
                                            多机编排三件套：GET /instances 选机 →
                                            本端点派发 → 通知中心/对端 GET
                                            /terminals 监控。派发落寻址账（下两
                                            端点），中心进度回流轮询据此感知对端
                                            会话进度（P-20261004-131）；dir 是对
                                            端机器的路径（同机多实例可直用本机
                                            路径，跨机须对端已存在），不存在按
                                            对端 400 报错
- GET    /api/instances/dispatched          派发寻址账清单（P-20261004-131）：
                                            新在前 [{id,instanceId,instanceName,
                                            remoteSessionId,remoteSessionName,
                                            runtime,at}]；TTL 7 天/环形 200 服务
                                            端收账——成功派发才落账，回流监控段
                                            的寻址依据
- DELETE /api/instances/dispatched/:recordId 移除单条派发记录（幂等，未知 id
                                            同样 200）：不再跟踪该派发会话，中心
                                            回流轮询与进度映射随记录消失收账
- GET    /api/instances/activity-matrix     联邦活动热力（P-20261004-98）——
                                            多实例负载对比/派单原语：?days=14
                                            （≤365 钳制）并发拉取各注册实例的
                                            /api/reports/activity（本机行直读本
                                            地序列，带 self 标记），返回
                                            {days, rows:[{instanceId,name,self,
                                            status,series?,totals}]}。series 为
                                            date 升序 [{date,commits,sessions,
                                            commands}]，totals 为窗口三项合计；
                                            status: ok=序列在手 / unreachable=
                                            网络层失败或对端异常 / unsupported=
                                            旧对端无 activity 端点（404，服务在
                                            跑）。失败隔离——单行失败不影响他行；
                                            服务端聚合缓存约 5 分钟。agent 调度
                                            决策原语：把任务派到闲机器前先查矩阵
                                            （totals 最小且 status=ok 的实例），
                                            与 dispatch（上端点）组合成「选机→
                                            派活」。诚实边界：各实例日期串是
                                            对端本地时区口径，跨时区部署的行与
                                            中心日界可能差一天`,
		},
		Section{
			ID: "audit", Title: "审计日志（安全事件时间线与 CSV 切片导出）", Order: 26,
			Summary: "安全敏感事件只读时间线 + 参数化 CSV 导出（合规外送/按动作聚合的留痕原语）",
			Body: ` - GET    /api/audit                         审计时间线（时间倒序分页，只读）：
                                            ?limit&offset 常规分页（单页上限 500）、
                                            ?cursor= 键集游标续翻（取上一页响应的
                                            nextCursor，翻页间隙新增事件不重不漏）。
                                            条目只含动作与元数据（time/action/
                                            result/ip/detail），绝不含密码/令牌值/
                                            密钥材料；result ∈ success|failure|denied
- GET    /api/audit/export                  当前保留窗口审计全量 CSV（time/action/
                                            result/ip/detail 五列，RFC 4180 转义 +
                                            公式注入防护；?days= 收窄窗口，缺省=
                                            保留期全量）。过滤联动（P-20261007-2）：
                                            ?action= 与 ?result= 各接受逗号分隔
                                            多值（如 action=git.commit,file.write&
                                            result=failure）——服务端全窗口精确
                                            匹配后出 CSV，是拉「失败高危操作切片
                                            做合规外送」「按动作聚合留档」的结构化
                                            原语；零参数 = 全窗口口径。值须为系统
                                            真实动作点分值与 result 三值（原值精确
                                            匹配，大小写敏感；未知值=空结果不报错）。
                                            每次导出自身入账 audit.export，Detail
                                            记 days/rows 与 filters 段（切片口径可
                                            追溯）。与 List 面同域鉴权（LockToken）
- AgentGuard 高危操作留痕（行为可追责 = 放心授权的信任地基）：agent 令牌
                                            的高危请求经三条裁决通道各有台账
                                            一条——agentguard.allow（allow 规则
                                            命中或全局档位直放行，Detail 归属
                                            rule=/tier=）、agentguard.deny（审批
                                            规则拒绝，result=denied）、
                                            agentguard.approval_pass（人工允许后
                                            携 X-Approval-ID 重试放行，Detail 归属
                                            approval=<id>）。Detail 恒含
                                            actor=agent 与 route/op/target/
                                            session/agent 元数据（会话 id 与运行时），
                                            自查高危操作史 = 拉台账后按 Detail 的
                                            session= 段过滤（GET /api/audit 时间线
                                            不支持参数过滤）；切片拉取用
                                            GET /api/audit/export 的 action= 参数：
                                            action=agentguard.allow,
                                            agentguard.deny,
                                            agentguard.approval_pass 导出 CSV 后
                                            筛 detail 列。428 待批路径不入账——
                                            审批卡即记录；操作结果细节见各
                                            handler 自审计，两层面互补）
- CSP Report-Only 违规聚合（P-20261007-6）：主应用响应带
                                            Content-Security-Policy-Report-Only 观察期
                                            策略，浏览器自动上报到 POST /api/csp-report
                                            （公开无凭据、按客户端 IP 限流）——服务端
                                            按 directive|blocked-origin 聚合计数落
                                            security.csp_violation 审计（Detail
                                            reports=/distinct=/dropped=/top=，不含
                                            document-uri/策略原文/样本）。安全巡检：
                                            GET /api/audit/export?action=security.csp_violation
                                            拉切片，按 Detail 的 top= 观察违规源面`,
		},
		Section{
			ID: "terminal", Title: "终端会话", Order: 30,
			Summary: "会话列表/创建（项目+智能体）/重命名/关闭/调整尺寸/产出",
			Body: ` - GET    /api/terminals                     会话列表（data:[{id,name,kind,path,projectId,createdAt}]；
                                            kind: shell=项目会话 / agent=智能体会话；name 即会话显示名；
                                            currentDir 可选携带 = OSC 7 实时追踪的当前工作目录
                                            （P-20261004-59；缺 key = shell 未上报，path 为创建目录）——
                                            判断「会话在哪个目录干活」读它而非 path）。
                                            derived/resumed 可选携带（P-20261023-3，缺 key = false）：
                                            名字系统派生 / 由恢复旗标创建——程序化区分
                                            「同类名会话谁新谁旧」按 createdAt + 这两个标记
- GET    /api/terminals/external-sessions   外部 tmux 会话列举（P-20261005-189）：
                                            服务器上用户自建的 tmux 会话（SSH
                                            attach 的那种、nohup 挂着的构建/训练
                                            任务，住用户默认 socket）——本系统
                                            自建会话住专属 socket 不在列。返回
                                            {data:[{name,attached,createdAt,
                                            windows,activity,takenOver}],available}
                                            （available=false=服务端 tmux 不可用）。
                                            巡检价值：发现服务器遗留 tmux 任务；
                                            takenOver=true=已被本系统接管
- POST   /api/terminals {"attachTmux":"<name>"}  接管外部 tmux 会话（attach 模式
                                            创建变体，P-20261005-189）：跳过
                                            new-session/环境注入直接 attach，
                                            产物 id=tmux 会话名、origin=external。
                                            接管后进既有 /terminals 全域（WS 围观/
                                            scrollback/广播/导出照用）。**默认
                                            只读**（P-20261008-17）：接管会话的
                                            服务端只读闸默认开——WS 单会话写链
                                            （连接 /ws/terminal/:id 发输入帧）被
                                            拒，每秒至多回一帧 TextMessage
                                            {"type":"input_rejected",
                                            "code":"readonly_external"}，连接保持
                                            （输出流照常）；广播/排队指令不经本闸
                                            （走各自审批，见下）。需要写入先经
                                            input-lock 解锁（下条）。close
                                            语义分流：DELETE 缺省=解除接管（tmux
                                            会话与其中进程原样存活，可再接管），
                                            ?kill=1=显式终结（kill-session 不可逆，
                                            先经 ops-confirm 向用户确认再调）。
                                            接管与显式终结均入审计
                                            （terminal.external.takeover /
                                            terminal.external.kill，P-20261008-16，
                                            Detail 只记会话名元数据）——强操作事后
                                            可答「谁在何时对哪个 tmux 动手」，
                                            GET /api/audit?action= 可查；解除接管
                                            属非破坏性语义不入账
- PUT    /api/terminals/:id/input-lock      接管会话服务端只读闸翻转 {"locked":bool}
                                            （P-20261008-17，仅 origin=external
                                            会话可用，自建会话 400）：locked=false
                                            解锁=放开对用户 tmux 会话（可能正跑
                                            deploy/生产脚本）的写入——高危方向，
                                            agent 令牌须 AgentGuard 审批（同
                                            broadcast-write 链：428+approvalId
                                            重试）；locked=true 上锁为加固方向直
                                            放行。翻转落审计底账（terminal.input_lock）
- POST   /api/terminals                     创建会话，返回 {data:{id,name,kind,shell,...}}：
                                            项目会话 {"projectId","name","dir"?}（name 空则取
                                            "Terminal"；P-20261005-192 起 dir=会话工作目录，
                                            项目根内子目录相对/绝对路径，缺省项目根——
                                            「只进这个服务目录构建/清理」先开对落点再写
                                            命令，免 cd 长路径；须已存在且在项目根内，
                                            越界 400 "path traversal not allowed"、缺失
                                            400 "path does not exist or is not a directory"）；
                                            智能体会话 {"kind":"agent","name","runtime","dir","launchArgs"}——
                                            免项目绑定，runtime 空按设置/可用性选型（claude/codex/dsh/shell，
                                            "shell"=纯终端；launchArgs 上限 500 字符，如 --resume <id>；
                                            dir 语义不同：任意已存在目录，不限于项目内）；
                                            可选 "shell"=会话级 shell 覆盖（裸名或完整路径，须存在于
                                            服务端 PATH 否则 400）——仅纯终端形态生效（runtime=shell /
                                            项目会话 / 选型失败降级），claude 等运行时会话忽略；
                                            缺省跟随设置 terminal.defaultShell（再回落平台缺省）。
                                            响应 data.shell = 实际启动的 shell、data.path = 会话
                                            起始工作目录（观测面）
- GET    /api/terminals/shell-candidates    平台 shell 候选探测：{platform,settingShell,
                                            defaultShell,candidates:[{name,path,available}]}——
                                            「这台机器有什么 shell 可用」先问这里；也可经
                                            PUT /api/settings {"terminalDefaultShell"} 固定默认
                                            （空串=清除回落平台缺省，写入即做存在性校验）
- GET    /api/agent-runtimes                智能体运行时清单（name/displayName/available/version/
                                            defaultCommand/customCommand；含用户在设置里自配的
                                            自定义运行时，displayName 为其展示名）
- PUT    /api/terminals/:id/rename          重命名 {"name"}（显示名允许重名，仅改标签不影响寻址；
                                            接手任务后尽早把本会话重命名为任务简称，:id 取 $CC_TERMINAL_ID）。
                                            重命名前先 GET /api/terminals 对照会话列表查重
                                            （kind=agent 行的 name，勿与存量会话同名——同名错认
                                            = 对错会话发错指令）；重名时响应附 duplicate:
                                            [{id,name,createdAt,lastActivity}] 同名会话摘要警示
                                            （不阻断，见警示应换一个更精确的名字再改）。
                                            带 prompt 的新会话尾部由系统附一行「[系统注记]」
                                            （会话 id + 任务演化后重命名指令，设置
                                            agentNamingNoteEnabled 可关）；名字与任务不符时
                                            按注记执行，与本条查重约定一致。
                                            自动命名（P-20261111-6）：claude 运行时未手动
                                            改名的会话（名字仍是系统派生形态）在首条用户
                                            消息落盘后数秒内由服务端按其首行自动总结改名
                                            （约 40 字符截断，同名自动消歧）——「会话名≈
                                            首条任务语义」，按名字引用/汇报会话即可对准
                                            任务；手动 rename 永远优先（改过名的会话不再
                                            自动覆盖）；敏感首句静默跳过；设置
                                            agentAutoNameEnabled 可关（默认开）
- PUT    /api/terminals/:id/resize          调整尺寸 {"rows","cols"}
- DELETE /api/terminals/:id                 关闭会话（tmux kill / PTY 终止）
- POST   /api/terminals/broadcast-write     多终端广播输入（舰队式批量）{"ids":[...],"data":"..."}：
                                            同一段输入逐个写入多个会话（ids 从会话
                                            列表取，本地 + 远程主机终端混合一次发，
                                            P-20261005-11）。data 为原始 PTY 输入，
                                            要执行命令须自带尾部换行（"git status\r"）；
                                            不存在的 id 跳过并在响应 missing 计数
                                            回告，响应 {written,missing,failed,
                                            failedHosts}——failed 为存在但写失败的
                                            id（远程断连入此不阻塞其余目标），
                                            failedHosts 为其中远程目标的主机标注
                                            [{id,hostId,host}]（哪台失败一目了然）。
                                            高危面（=任意命令执行，本地与远程同防）：
                                            agent 令牌调用走审批（428+approvalId，
                                            与 git push 同级）。
                                            舰队巡检组合（本地）：GET /terminals 列
                                            会话 → broadcast-write 发同一条命令 →
                                            逐个 GET /terminals/:id/scrollback 收
                                            结果，不需要逐个开 WS 会话；
                                            舰队巡检组合（远程，P-20261005-11）：
                                            GET /api/remotehosts/terminals 聚合列
                                            全部远程终端会话（跨主机一次取，host
                                            为别名）→ broadcast-write 混合 ids 发
                                            N 台诊断命令 → 逐个 GET
                                            /api/remotehosts/:id/terminals/:sid/
                                            scrollback 收结果（断连主机按
                                            failedHosts 定向补开重试）
- POST   /api/terminals/command-preview    高危命令影响面预览（P-20261005-191）：
                                            {"command","cwd"?} → {level(空/danger/
                                            warning),kind,detail,matches:[{id,
                                            segment,targets,dynamic}]}——执行前
                                            自检原语：运行书/队列/broadcast-write
                                            把破坏性命令（rm -rf/git reset --hard/
                                            clean/覆盖重定向…）写进会话前先调它，
                                            把 dynamic 计数（rm 目标 glob 展开的
                                            文件数与字节、git 脏文件/untracked 数）
                                            附进给用户的说明或审批证据。cwd 传会话
                                            工作目录（$PWD / OSC 7）计数才准，缺省
                                            静态判定。level=空即未命中；dynamic
                                            计数为 0（干净树上 reset --hard）通常
                                            无害可放行。只读面（读元数据不执行）
- GET    /api/terminals/:id/activity        会话产出（智能体 startHead..工作区 diff 摘要；
                                            可带 ?since=<标记ts RFC3339Nano> 把 diff
                                            范围切到某个审阅基线标记之后）
- POST   /api/terminals/:id/review-mark     标记审阅基线（P-20261003-217）：阶段性
                                            工作完成时把当前时点记为该会话的审阅
                                            基线（时间戳+HEAD 快照，上限 10 FIFO），
                                            之后 activity?since= 只看标记后的产出，
                                            人/agent 分轮审阅不用每次从头重看
- GET    /api/terminal-history/search?q=&limit=   跨项目命令历史检索（P-20261004-2）：
                                            「这条命令上次在哪个项目跑过」的全局原语。
                                            q 为命令子串（不区分大小写，≥2 字符），
                                            返回 [{projectId,projectName,command,exitCode,ts,
                                            source,host}] 全局时间倒序（limit 默认 50，
                                            上限 200）；失败命令带 exitCode，可顺带溯源
                                            排障。source=input 为输入域条目（P-20261005-188
                                            远程控制台采集的「提交的输入行」，host=主机 id、
                                            无 exitCode——舰队巡检「这台机器刚跑过什么」
                                            一手证据链）；缺省 = osc 精确域本地条目。
                                            敏感命令（含 token/password 等）本就不落历史
- GET    /api/terminals/search?q=&limit=    跨会话输出检索（P-20261003-290）：
                                            「那个报错/端口号是哪个会话打印的」——
                                            广播诊断命令后回读命中即可定位现场会话。
                                            q≥2 字符子串不区分大小写，扫每会话最近
                                            2000 行，返回 [{sessionId,sessionName,
                                            projectId,lineText,hitIndex}]
                                            （单会话≤10 条、总量≤50，lineText 已剥 ANSI，
                                            超长行按命中点截窗）。限流 30 次/分钟
                                            （P-20261005-158，键=X-Session-ID→tokenID→
                                            ClientIP）：超限 429 带 code search.rate_limited
                                            + retry_after 秒数——收到即降频退避，窗口滑动
                                            自动恢复
- POST   /api/terminals/bulk-agent          舰队批量发起（P-20261003-291，多项目编队）：
                                            {"projectIds"(≤20,"runtime"?),"prompt"} 逐项目
                                            创建 agent 会话——dir=项目根、同一 prompt（超
                                            500 字节服务端保尾截断，裁头部铺垫保尾部指令）、
                                            会话名统一 "fleet: <prompt 头部>"。顺序创建，
                                            单项目失败（项目缺失/runtime 预检失败）逐条回告
                                            跳过不中断编队；返回
                                            {created:[{projectId,terminalId}],skipped:[{projectId,reason}],
                                            fleetBatch:{batchId,launchedAt,members}}——batchId 是
                                            本批编队身份，members 为已创建会话 id 花名册。
                                            旧对端先探 /api/meta 能力项 "bulk-agent"（无则
                                            逐项目 POST /api/terminals 降级）
- GET    /api/terminals?fleet=<batchId>     编队追踪（P-20261005-145）：按 batchId 过滤会话
                                            （元数据 fleetBatch 精确匹配），返回该批仍存活的
                                            成员快照（各条目带 fleetBatch 元数据）。标准追踪
                                            配方：bulk-agent 拿 fleetBatch.batchId → 周期
                                            GET /terminals?fleet=<batchId> → 数 running 键
                                            （缺省/true）为未收口成员 → 全员终态（无 running）
                                            即编队收敛，failed 成员可按其 projectId 重新
                                            bulk-agent 重派。诚实边界：成员全部关闭后过滤
                                            结果为空列表（非错误）——存活成员任一在即可反查
                                            全批花名册（fleetBatch.members）
- GET    /api/terminals/ports               端口注册表查询（P-20261003-293）：
                                            起 dev server 前「选自由端口」原语——
                                            返回当前已知占用 [{port,sessionId,
                                            sessionName,projectId,label,source,
                                            firstSeen}]（source: detected=输出探测 /
                                            reported=agent 上报），选口避开这些端口；
                                            同端口异会话再登记会触发冲突通知（点名
                                            先占会话）。登记面=探测/上报面：未被探测
                                            且未上报的监听不在列（选口后仍以实际
                                            bind 成功为准）；重启后登记清空
- GET    /api/terminals/running-count?kind= OSC 133 运行态计数（P-20261004-63）：
                                            「多少会话命令在跑」的服务端权威计数，
                                            跨设备可查（浏览器本地运行态只覆盖持有
                                            连接的端）。kind 缺省=全体 / shell / agent，
                                            返回 {count,total,running:[会话id]}；
                                            自查「我的会话在跑吗」= $CC_TERMINAL_ID
                                            是否在 running 清单内。诚实边界：shell
                                            集成未注入的会话、服务重启前已开始的
                                            长命令不在计数（宁漏报不误报）
- GET    /api/terminals/:id/scrollback      会话输出回读（最近输出原文，含 ANSI；fleet 巡检
                                            组合里逐会话收结果的读取口）
- GET    /api/terminals/:id/export          会话输出整体留档导出（txt 附件，已剥 ANSI）。
                                            出域敏感闸（P-20261004-113）：内容命中凭据
                                            形态/敏感文件名或会话被标记敏感时回 200
                                            {warnings,sensitiveHits}（类型+计数，不含原
                                            文）——核对后内容闸带 ?confirm=1、标记闸带
                                            ?override=1 重发才出附件（两闸并存同时带）
- GET    /api/terminals/:id/postmortem      失败会话验尸报告（P-20261004-60）：聚合
                                            退出码/末命令/输出尾部/会话元数据的只读
                                            快照——「上会话为什么挂」可编程获取（本会话
                                            或他人会话异常退出后自析）。缺省 JSON
                                            {data:{sessionId,alive,exitCode,exitedAt,
                                            lastCommands,outputTail,outputSource,...}}；
                                            Accept: text/markdown 得人读 Markdown。
                                            outputTail 已剥 ANSI 并做敏感值遮蔽；
                                            会话标记敏感时回 warnings 需 ?override=1
                                            二次确认（与导出同一出域闸门）
- POST   /api/terminals/:id/queue           排队指令入尾 {"text"}（会话 busy 时延迟投递：
                                            idle 即发 / running 等命令回执 / missing 降级
                                            只存不投）——排队=延迟的终端输入，完成回执驱动
- PUT    /api/terminals/:id/queue           整表替换编辑该会话排队指令
- GET    /api/terminals/queues              全会话排队指令批量读（只回存有排队指令的
                                            在册会话——侧栏徽标/队列面板单一取数口）
- Claude 本地会话历史（只读扫描 ~/.claude/projects，跨实例回放/检索/出档；
  星标/备注/隐藏等策展见 POST /api/claude/sessions/curation）：
- GET    /api/claude/sessions               会话列表（?projectId= 项目级过滤 / ?q= / ?limit=
                                            / ?offset= / hidden=1 管理视图）。行携 ledger
                                            结构化台账（P-20261005-208）{filesWritten,
                                            commandsRun,durationMs} = 该会话写类工具去重
                                            文件数 / shell 命令数 / 首尾工具活动跨时——
                                            agent 会话考古可编程筛「改文件最多 / 跑命令
                                            异常多」的会话；字段缺省 = 无工具动作数据
                                            （纯聊天/纯只读会话），按段零值自行隐藏
- GET    /api/claude/sessions/search?q=     会话历史全文搜索（跨 transcripts 命中带上下文，
                                            敏感值遮蔽；备注是额外命中源）
- GET    /api/claude/sessions/:id/timeline  单会话回放时间线（transcript 直读解析，尾部窗口
                                            分页；响应携该会话轮级书签 bookmarks 与
                                            轮级语义标签 tags (at,tag) 对集合）
- GET    /api/claude/sessions/:id/export    会话导出（?format=md 缺省知识文档 | jsonl 原始
                                            直传；出域路径已相对化）。md 另有
                                            ?mode=qa 仅问答档（P-20261004-132）：
                                            渲染层过滤只留 user/assistant 正文——
                                            跳过工具摘要/结果引用/思考块过程噪声，
                                            文件名带 -qa 尾缀；给下游文档/报告喂
                                            结论形态选 qa，看完整过程用缺省 full。
                                            出域敏感闸
                                            （P-20261004-113）：md/jsonl 均在出域前扫描
                                            凭据形态/敏感文件名，命中回 200
                                            {warnings:["sensitive-content"],sensitiveHits}
                                            （类型+计数，不含原文）——核对后带
                                            ?confirm=1 重发才出附件（默认原样保真）
- POST   /api/claude/sessions/curation      策展部分更新 {"sessionId","starred"?,"note"?,
                                            "hidden"?,"bookmarkAdd"?,"bookmarkRemove"?,
                                            "tagAdd"?,"tagRemove"?}
                                            （指针字段只动携带项；bookmark* 值=轮时刻
                                            RFC3339，轮级书签增删；tag* 值={at,tag} 对，
                                            at 同 RFC3339 验形、tag trim+剥前导 # 后
                                            1..32 rune，轮级标签增删）
- POST   /api/claude/sessions/export-archive 批量导出 zip {"ids"(1..50),"format":"md"缺省|
                                            "jsonl"}（可选口令信封；隐藏会话被排除）
- GET    /api/projects/:id/sessions-at?ts=  会话时间窗溯源（P-20261007-11）：
                                            「这个时间点哪些 AI 会话在该项目动」——
                                            ts 为 RFC3339 时刻（blame 行提交时刻/
                                            审批时刻/报错时间点），交叉项目内
                                            transcript 时间窗（首末活动时间覆盖
                                            ts），返回 {sessions:[{id,title,
                                            firstAt,lastAt,active,starred,...}],
                                            total,truncated}，按时间接近度升序
                                            上限 10。排障组合：git blame 拿行提交
                                            时刻 → sessions-at 找同窗会话 →
                                            GET /api/claude/sessions/:id/timeline
                                            回放对话现场。诚实边界：时段关联非
                                            因果确证——同窗并行会话全部列出，
                                            因果判断需人工；transcript 已删的
                                            会话不命中（宁漏报不误报）
- WS     /ws/terminal/:id                   终端双向流（二进制输入输出）

会话自定义分组（P-20261111-1-S3）：侧栏「自定义分组」是纯组织结构（uiState
  agentTerminal.groups，不动会话本体），以下端点让 agent 可编程归置会话——
  值班巡检自建分组归置同任务会话、交付前按主题归拢等。分组结构变更实时广播
  agent.groups.changed，用户侧栏就地跟随；id 形态 at_<ts>_<rand> 服务端铸造
  （POST 响应回权威 id），名称 trim 非空 ≤64 rune，组数 ≤100。归属判定 =
  「会话 id 出现在某个组的 sessionIds 里」，不在任何组 = 未分组；
- GET    /api/terminals/session-groups             分组清单 [{id,name,sessionIds}]（含空组）
- POST   /api/terminals/session-groups             新建空组 {"name"}，201 回 {id,name,sessionIds:[]}；
                                                  组数触顶 400 "session groups limit reached (100)"
- PUT    /api/terminals/session-groups/:id         改名 {"name"}；组不存在 404
- DELETE /api/terminals/session-groups/:id         删组；组内会话自动回未分组（不丢会话）
- PUT    /api/terminals/session-groups/:id/sessions 移入 {"sessionIds":[...]}：会话从原组
                                                  摘除入目标组尾部（前端拖拽同语义）；任一
                                                  会话 id 不在册 404 整体不动（先 GET /api/terminals
                                                  核对 id），空清单 400
- DELETE /api/terminals/session-groups/:id/sessions/:sid  移出（回未分组）；组不存在或
                                                  会话不在该组 404
- 配方（归置 N 个同任务会话）：GET /api/terminals → POST 建组得 id →
  PUT :id/sessions 一次移入全部 → 侧栏经 agent.groups.changed 就地跟随，
  无需逐个通知
- 环境变量：会话内已注入 CC_BASE_URL（API 基址，TLS 部署时为明文回环辅助端口，
  经代理转发）/ CC_LOCK_TOKEN（调用凭据）/ CC_TERMINAL_ID（本会话 id）。
  项目绑定会话另有 CC_PROJECT_ID（项目 id，全部 /api/projects/$CC_PROJECT_ID/*
  端点开箱可调，免按路径反查）与 CC_PROJECT_PATH（注册根路径，对照 pwd 判断
  cwd 相对关系）；免项目会话（如你在临时目录被拉起）不注入，此时先
  GET /api/projects 按路径反查`,
		},
		Section{
			ID: "remote", Title: "远程主机（SSH）", Order: 40,
			Summary: "主机增删改查/远程执行/诊断/端口隧道/远程接入",
			Body: ` - GET/POST        /api/remotehosts          主机列表 / 新增（name/host/port/user/authType）
- PUT/DELETE      /api/remotehosts/:id      修改 / 删除
- POST            /api/remotehosts/:id/test 测试连接
- POST            /api/remotehosts/:id/terminals          开远程终端（返回 sessionId+tmuxName）
- GET             /api/remotehosts/terminals  跨主机聚合列全部远程终端会话
      [{id,hostId,host,createdAt}]（P-20261005-11，host 为别名未命名回落 hostId）——
      广播（/api/terminals/broadcast-write 收远程 id）与舰队巡检的取数原语，
      一次请求替代逐主机查询
- WS              /ws/remote-terminal/:sid  远程终端流
- POST            /api/remotehosts/:id/exec {"cmd"}  远程执行单条命令（返回 stdout/stderr/exitCode）
- POST            /api/remotehosts/:id/diagnose           一键只读诊断（系统/磁盘/内存/端口等聚合）
- POST            /api/remotehosts/diagnose-batch {"ids":[".."]}  多主机批量巡检（并行扇出
      单主机只读命令集，逐台结构化摘要 {hostId,name,ok,durationMs,error?,snapshot}；
      ids 去重后 1..50 台，单台失败是该台 error 结构化降级不拖垮整体，HTTP 恒 200；
      snapshot.diskAvailMB/diskTotalMB/memUsedMB/load1/cpuPercent/failedServices，
      缺省=未采集不当 0；跨主机横向对比/离群定位用这个，单台深排障用 :id/diagnose）
- GET             /api/remotehosts/:id/git-compare        本地-远端同项目 Git 对照
      ?projectId=<项目ID>&remotePath=<远端仓库绝对路径（缺省回填上次记忆）>
      单次 SSH 往返取远端 HEAD/分支/脏文件数，与本地项目并排返回：
      {local,remote:{head,branch,dirtyCount,available,unavailableReason},behind,remotePath}
      behind.relation = same | remoteBehind（远端落后本地 N，remoteBehindCount）|
      remoteAhead（远端领先本地 N，localBehindCount）| diverged | unknown
      （远端 HEAD 对象本地不可见——需先在项目里 fetch 才能判定，诚实降级不猜）。
      远端排障第一步：先对照再动手。不可达/非 git 目录/超时按
      unavailableReason 结构化降级（HTTP 恒 200）；FTP 主机顶层 error。
- PUT             /api/remotehosts/:id/git-compare-path   记忆/清除远端路径
      {"projectId","remotePath"}（remotePath 空 = 清除）；GET 对照纯读不落盘，
      对照成功后回写一次即可让下次免手填

## 远程接入（SSH 反向隧道：经自有 VPS 从任意网络访问本实例）

与「SSH 端口隧道」方向相反：实例主动连用户自带的 VPS 中继并请求远端监听
（tcpip-forward），把本机主服务呈现在任意手机网络，不需要公网 IP/端口映射。
同一时刻仅一条隧道（多档案 + 单活 + 一键切换）。档案 CRUD 走设置 API
（GET/PUT /api/settings 的 remoteAccess 字段，密码不回参）；运行期控制：

- GET  /api/remoteaccess/tunnel           状态（state/publicUrl/lastError/hostKey/
      lockReady/tlsEnabled）+ 安全门槛；agent 自诊断先读这里
- POST /api/remoteaccess/tunnel {"action":"start","profileId?":"sc_ra_...",
      "confirmInsecureTls":false}   启用/切换中继（不同档案 = 停旧起新）。
      门槛：锁定功能必须启用并配置密码（否则 409 remoteaccess.lock_required）；
      TLS 未启用必须显式 confirmInsecureTls=true（409
      remoteaccess.tls_insecure_confirm_required，确认动作入审计）
- POST /api/remoteaccess/tunnel {"action":"stop"}   停止（幂等）
- POST /api/remoteaccess/tunnel/test {"profileId":"..."} 或 {"profile":{...}}
      预检：本机主端口/SSH 可达/主机密钥 TOFU/认证/端口占用/
      AllowTcpForwarding/GatewayPorts 可达性，逐步返回 {step,ok,message,hint}
- POST /api/remoteaccess/tunnel/hostkey/reset {"profileId":"..."}  合法迁移后
      重置中继主机指纹（TOFU 变更默认拒绝，错误含 host key has changed）

VPS 侧要求：sshd AllowTcpForwarding yes；公网绑定（0.0.0.0）还需
GatewayPorts clientspecified + 防火墙放行远端端口；否则改绑 127.0.0.1，
在 VPS 上用 nginx/caddy 反代（可终结受信 TLS、复用 443）。
事件：remoteaccess.status 每次状态迁移广播（公网入口存活感知，免轮询）；
审计 remoteaccess.tunnel.start/stop/fail 与 remoteaccess.tls_insecure。

## SSH 端口隧道（远端 dev server 预览穿透）

你在远程主机终端里起了 dev server（监听远端 127.0.0.1:port），预览面板够不着
远端端口——先开本地转发隧道把它映射到实例本机临时端口，再上报预览端口：

- POST /api/remotehosts/:id/tunnels {"remotePort":3000}   开隧道（返回 localPort；
  同 host+remotePort 幂等复用；上限 5 条，15 分钟空闲自动回收）
- GET  /api/remotehosts/:id/tunnels            该主机隧道列表（localPort/lastActive）
- DELETE /api/remotehosts/:id/tunnels/:localPort   关闭隧道

组合玩法：远程起服务 → 开隧道拿 localPort → 经 ops-notify 上报
preview.port {"port":<远端端口>,"label":"...","hostId":"<主机ID>"}——前端自动
经隧道打通并展示「remote:N → local:M」徽标，用户一键直达预览面板。

## 远程文件读写（SFTP/FTP，VS Code Remote 式；仅 SSH 主机可编辑）

- GET  /api/remotehosts/:id/files/list?path=     目录浏览
- GET  /api/remotehosts/:id/files/content?path=  读文件（二进制 415 / 超大 413 /
                                                 baseHash 冲突 409，语义对齐本地编辑器）
- PUT  /api/remotehosts/:id/files/content        写文件（携 baseHash 防覆盖外部改动）
- GET  /api/remotehosts/:id/files/download?path= 单文件下载
- GET  /api/remotehosts/:id/files/archive        多选打包 zip 下载
- POST /api/remotehosts/:id/files/upload         上传文件
- POST /api/remotehosts/:id/files/mkdir          建目录
- POST /api/remotehosts/:id/files/rename         重命名/移动
- POST /api/remotehosts/:id/files/delete         删除
- POST /api/remotehosts/:id/files/transfer       本地↔远端互传`,
		},
		Section{
			ID: "git", Title: "Git 操作", Order: 50,
			Summary: "暂存/提交/历史过滤/分支标签/远程同步/LFS/stash/reflog/变更列表与搁置 全流程",
			Body: ` - POST /api/projects/:id/stage              暂存 {"files":[...]}
- POST /api/projects/:id/unstage           取消暂存 {"files":[...]}
- POST /api/projects/:id/commit             提交 {"message"}
- POST /api/projects/:id/commit-split-execute 拆分建议逐组执行 {"groups":[{name,files,subject}]}
      确认弹层预览后的人工触发自动化（agent 勿直接调用）：每组 add + pathspec
      commit（commit -m <主题> -- <组内文件>，组外已暂存内容不卷入保持暂存态）；
      任一组失败即中断，200 返回逐组报告 {"total","executed","failed","remaining"}
      （failed={index,subject,step:stage|commit,error}），已落库组不回滚；上限 20 组
- POST /api/projects/:id/commit/amend-message 修改最后一条提交信息 {"message"}
- GET  /api/projects/:id/commit/:commit/pushed    提交是否已推送（含包含它的远程分支列表）
- POST /api/projects/:id/commit/:commit/reword    修改任意提交信息 {"message","confirmPushed"?}
      HEAD 走 amend --only（不卷入已暂存变更）；更早提交走非交互 rebase reword；
      已推送提交改写=重写公开历史，需 confirmPushed=true 且事后 force-with-lease 推送；
      合并提交及改写区间内含合并提交会被拒绝
- GET  /api/projects/:id/rebase/todo              整理区间列表 ?commit=<自此提交起>（或 ?onto=<基准>，空=全历史）
      返回 {"data":[{action,hash,msg}],"onto":<换算后基准>}，data 按应用序（最老在前）
- POST /api/projects/:id/rebase/interactive       执行整理计划（高危，审批同 push/reset）
      {"onto","actions":[{action:pick|squash|reword|drop,hash,msg,newMessage?}],"confirmPushed"?}
      actions 必须按应用序（与 todo 返回序同向）且恰好覆盖区间全部提交；步数上限 20；
      reword 必须带 newMessage（squash 合并消息=各条按序空行连接）；区间含合并提交拒绝；
      含已推送提交须 confirmPushed=true（409 携 remoteBranches 影响面）；失败（冲突）服务端
      自动 rebase --abort 恢复原状；成败均入审计。建议流程：todo 取列表 → 编辑 → 执行 →
      GET /log 刷新确认；改写后推送需 forceWithLease
- POST /api/projects/:id/rollback           回滚工作区文件（危险）
- GET  /api/projects/:id/status             变更状态（staged/unstaged/untracked）
- GET  /api/projects/:id/diff               工作区 diff（?staged=true 暂存区；?path= 单文件）
- GET  /api/projects/:id/file/diff          工作区单文件 diff
- GET  /api/projects/:id/blame?file=        文件 blame
- GET  /api/projects/:id/log                提交历史；支持过滤与分页参数
      ?author=（作者）&since=&until=（YYYY-MM-DD 时间范围）&limit=&skip=&branch=
- GET  /api/projects/:id/log/search?query=  按提交消息全分支搜索
- GET  /api/projects/:id/log/file?file=     单文件提交历史
- GET  /api/projects/:id/log/directory?path= 目录提交历史
- GET  /api/projects/:id/commit/:commit/files  某提交的变更文件列表（path/status）
- GET  /api/projects/:id/branches           分支列表 / POST 创建 / DELETE 删除
- POST /api/projects/:id/branches/rename    重命名分支 {"oldName","newName"}
- POST /api/projects/:id/branches/set-upstream {"branch","remote","remoteBranch"}
- GET/POST/DELETE /api/projects/:id/tags    标签列表 / 创建 {"name","commit"?,"annotated"?,"message"?}
                                            / 删除 {"name"}
- GET  /api/projects/:id/remotes            远程仓库列表
- POST /api/projects/:id/remotes            添加远程 {"name","url"}
- DELETE /api/projects/:id/remotes/:name    删除远程
- GET  /api/projects/:id/remote-branch-exists?remote=&branch=  远端分支存在性检查（推送/跟踪前）
- GET  /api/projects/:id/branch-diff?from=&to=  分支差异文件列表
- GET  /api/projects/:id/branch-file-diff   分支间单文件差异

## 分支切换与高级操作（硬锁写族；agent 令牌高危审批与 push/reset 同级）

- POST /api/projects/:id/checkout           切换分支 {"branch","autoStash"?}（autoStash=
                                            脏工作区先 stash 再切回后 pop，响应附结构化结果）。
                                            成功响应可附 recoverableStash {index,branch,message,
                                            files}：切回原分支时点名留在 stash 的 auto 暂存条目
                                            （On <branch>: + auto: checkout to 双注记匹配、多条取
                                            最新）——P-203 pop 冲突后「切回原分支恢复」的闭环原语，
                                            agent 例程（切分支干活→切回→读此字段→POST /stash/pop
                                            自动恢复）据此编程；无命中字段缺席
- POST /api/projects/:id/checkout-update    切换并更新（submodule 跟随）
- POST /api/projects/:id/merge              合并 {"source","strategy"?,"message"?}（冲突 409 携输出，
                                            走 conflict 节流程）。strategy=squash 压平合并：源分支多提交
                                            压为单条汇总提交（--squash），message 缺省自动生成
                                            「(<source>) N commits: 首末提交标题」；源分支无领先提交报
                                            nothing to squash merge；冲突时索引冲突态保留（无 MERGE_HEAD），
                                            解决后走常规 POST /commit 收尾；源分支不自动删除
- GET  /api/projects/:id/merge-preview?branch=<源分支>  合并预演（merge-tree --write-tree 只读原语，
      不动工作区/引用/提交、零审计）：返回 {"data":{clean,treeOid,conflicts:[{path,status,
      both-modified|both-added|deleted-by-us|deleted-by-them,hunkCount,ours,theirs}],cleanCount,
      stat:{files,insertions,deletions}}}。agent 合并前自检闸：clean=true 可放心合（POST /merge），
      false 先解决冲突再合、勿硬闯（ours/theirs 是首段导航摘要非全文）；git <2.38 端点 501
      （可先 GET /branches 看 mergePreviewSupported 探测）
- POST /api/projects/:id/rebase             变基 {"branch"}（同上冲突语义）
- POST /api/projects/:id/rebase/abort       放弃变基回原状（冲突收尾）
- POST /api/projects/:id/rebase/continue    继续下一段变基（可能再停冲突）
- POST /api/projects/:id/cherry-pick        拣选 {"commit"}
- POST /api/projects/:id/revert             回退提交 {"commit"}
- POST /api/projects/:id/reset              重置 {"mode","commit"?}（危险，先向用户确认）
- POST /api/projects/:id/squash             压缩提交 {"commits"(≥2),"message"?}
- POST /api/projects/:id/drop-commit        丢弃提交 {"commit"}（危险）
- POST /api/projects/:id/extract            抽取变更到提交 {"commit","files","message"?}
- POST /api/projects/:id/index-lock/cleanup 清理遗留 index.lock（写命令失败检出的恢复入口）

## Worktree（定点历史检视与并行工作区）

- GET  /api/projects/:id/worktrees          列表 [{"path","branch","hash","isMain","isLocked",...}]
- POST /api/projects/:id/worktrees          创建 {"path","branch"?,"ref"?}：branch=检出并建新
                                            分支；ref=任意既有 ref——分支/tag/裸 hash 均可
                                            （hash 落成 HEAD 分离、不建分支的定点检出）。
                                            agent bisect 基元：疑点提交经 hash 定点开出
                                            独立工作区起会话复现回归，主检出与既有分支
                                            零扰动、与接续链组合可自动化二分；惯例路径
                                            <仓库兄弟目录>/wt-hist-<短hash>，前端目录名
                                            wt-hist- 前缀即「历史检视」身份标记；同名
                                            worktree 已登记即复用勿重复创建，用完即删
                                            （排查现场不留垃圾工作区）
- DELETE /api/projects/:id/worktrees        删除 {"path","force"?}（force 双保险删 locked）
- POST /api/projects/:id/worktrees/prune    清理失效 worktree 引用（目录已散的注册残留）
- POST /api/projects/:id/worktrees/move     移动 {"oldPath","newPath"}
- POST /api/projects/:id/worktrees/lock     锁定 {"path","reason"?}（防误删长驻工作区）
- POST /api/projects/:id/worktrees/unlock   解锁 {"path"}

## 克隆与 PR、补丁与快照

- POST /api/clone                           克隆仓库（异步任务 {"url","dir","branch"?,
                                            "depth"?,...}，返回 taskId；进度 WS /ws/clone/:taskId）
- POST /api/clone/branches                  克隆前预取远端分支 {"url","sshKeyId"?} →
                                            {data:[...]}（ls-remote --heads，凭据注入同克隆；
                                            失败 502 稳定标记 remote branch prefetch failed:*，
                                            分支仍可手填不阻断克隆）
- POST /api/clone/:taskId/cancel            取消进行中的克隆
- POST /api/projects/:id/create-pr          创建 PR（当前分支为 source，平台集成）
- GET  /api/projects/:id/patch?scope=       未提交变更导出 .patch 下载（scope=worktree|staged|head）；
                                            worktree/head 含 untracked 新文件段（new-file 补丁，
                                            纯 untracked 现场也可导出；单文件 >2MB/总数 >500
                                            跳过并在补丁内注记），收件侧 git apply 直接还原；
                                            命中敏感文件名（.env/密钥类）时回 200 JSON
                                            {warnings:[…]} 不出补丁，confirm=1 确认后出
- POST /api/projects/:id/patch/export       导出 patch {"commits"?,"from"?,"to"?,"staged"?,
                                            "confirm"?}——敏感文件名命中回 {warnings}，
                                            "confirm":true 确认后真出（响应附 sensitiveHits）
- POST /api/projects/:id/patch/import       导入 patch {"content","apply"?}（apply=true 直接应用）
- POST /api/projects/:id/patch/check        检查 patch 可应用性（只检不改）
- GET  /api/projects/:id/log/recent-messages 最近提交信息（提交框联想/风格匹配）
- GET  /api/projects/:id/tree?ref=          版本快照目录树（任意 ref 的历史时点浏览）
- GET  /api/projects/:id/blob?ref=&path=    版本快照文件内容
- GET  /api/projects/:id/diff/:commit       单提交完整 diff
- GET  /api/projects/:id/git-config         读项目 git config（提交身份排障第一步）
- PUT  /api/projects/:id/git-config         写项目 git config（白名单键：user.name/user.email）
- WS   /ws/clone/:taskId                    克隆进度推送（百分比/阶段）
- WS   /ws/projects/:id                     项目事件流（file/branch/log.changed 与
                                            git.activity 定向广播，见下方协作感知）

## 远程同步（与远端仓库交互）

- POST /api/projects/:id/fetch             拉取远端更新 {"remote"?}
- POST /api/projects/:id/pull              拉取并合并 {"remote"?,"branch"?}
- POST /api/projects/:id/push              推送 {"remote"?,"branch"?,"remoteBranch"?,
      "setUpstream"?,"force"?,"forceWithLease"?}——force/forceWithLease 属危险操作，先确认

## Stash 与 Reflog

- GET    /api/projects/:id/stashes          stash 列表（每条含 index 与 hash 稳定引用）
- GET    /api/projects/:id/stashes/:index/diff  查看 stash 内容 diff（含 untracked；路径段可为列表 index 或完整 commit hash）
- POST   /api/projects/:id/stash            创建 stash {"message","includeUntracked"?}
- POST   /api/projects/:id/stash/pop        弹出 stash {"index","hash"?}（hash 优先：栈位漂移不致错位）
- POST   /api/projects/:id/stash/apply      应用 stash（不删除）{"index","hash"?}
- POST   /api/projects/:id/stash/branch     应用到新分支 {"index","hash"?,"name"}（git stash branch
                                            原子链，实验性应用场景）
- DELETE /api/projects/:id/stash/:index     删除 stash（危险；路径段可为 index 或完整 commit hash）
- 注：hash 指向的条目已不在当前栈（已 drop/pop）时稳定报错 stash entry no longer exists，
      需重拉列表按新栈位操作；不带 hash 的 index 入口保持兼容
- GET    /api/projects/:id/reflog           引用日志
- GET    /api/projects/:id/reflog/:hash/diff  某条 reflog 的差异
- POST   /api/projects/:id/reflog/reset     回退到 reflog 记录 {"hash","mode"}（危险）

## 变更列表（Changelist）与搁置（shelve）

把未提交改动按逻辑分组（类似 JetBrains changelist）：一组 = 一个正在进行的任务；
「切去修紧急 bug 前搁置当前组，回来恢复接着提交」的多任务工作流原语。

- GET  /api/changelists?projectId=<pid>     列表清单（归属该项目 + 存量全局条目；
                                            返回 {"data":[{name,files,active,projectId?}]}，
                                            files 为项目相对路径，active=活跃组标记）
- POST /api/changelists                     新建 {"name","projectId"?}（同项目重名 409
                                            "changelist already exists"）
- DELETE /api/changelists/:name?projectId=  删除列表（组内文件与工作区不受影响，
                                            只是分组视图消失）
- PUT  /api/changelists/active              设活跃组 {"name","projectId"?}（同项目内
                                            互斥；活跃组是分组维度，提交时仍按 files 精确圈定）
- PUT  /api/changelists/move-file           文件移入列表 {"changelist","file","projectId"?}
                                            （同项目内一文件至多属一组，移动即换组）
- POST /api/projects/:id/shelve             搁置 {"files":[...],"message"?}：组内文件的
                                            未提交变更（含未暂存与 untracked）整体存入
                                            一条 stash 条目，工作区随即干净；响应
                                            {"created":bool}——false=组内文件当前无变更、
                                            未产生条目。恢复走 stash pop（stash 面板或
                                            POST /stash/pop），条目消息带 shelve: 前缀标识；
                                            与全量 stash 的区别：pathspec 限定只动组内
                                            文件，无关变更（含已暂存的）不受影响
- 典型例程（切任务前搁置当前组）：GET /changelists?projectId= 取活跃组 files →
  POST /shelve {"files": <组内文件>, "message": "<任务名>"} → 切分支修 bug →
  回来 POST /stash/pop 恢复。搁置/恢复均不动分支，HEAD 不变

## LFS（大文件）

- GET  /api/projects/:id/lfs                LFS 状态（是否安装/跟踪规则）
- POST /api/projects/:id/lfs/install        安装 LFS
- POST /api/projects/:id/lfs/track          追踪模式 {"pattern"}
- POST /api/projects/:id/lfs/untrack        取消追踪
- POST /api/projects/:id/lfs/pull           LFS 拉取
- POST /api/projects/:id/lfs/push           LFS 推送

## 协作感知（git.activity 定向广播）

你在会话内（TUI/脚本）用子进程跑 git commit/push/switch 完成时，服务端嗅探会话输出并
经项目归属向项目 WS 定向广播 git.activity——同项目 WS 上的其他会话/前端面板即时感知
「仓库被动了」，无需轮询：

- 订阅：WebSocket 连 /ws/projects/:id，子协议携 CC_LOCK_TOKEN；收到
  {"type":"git.activity","data":{"kind":"commit|push|switch","ref"?,"sessionId","projectId","at"}}
- 纪律：收到即表示有会话动了该仓库（sessionId=来源）——多 agent 协同前先 GET /status
  重建现场，勿基于陈旧 HEAD 行事；嗅探是保守的元数据信号（本地化 git 文案可能漏报、
  相似文本形态可能多报），权威状态始终以 GET /status 为准`,
		},
		Section{
			ID: "conflict", Title: "冲突解决（merge/rebase 冲突处置）", Order: 55,
			Summary: "冲突文件列表→逐块解析→写回解决；解决动作对 agent 令牌走高危审批（428）——遇冲突先问用户偏好，勿擅自 ours/theirs",
			Body: `merge/rebase 撞冲突（GET /conflicts 非空、或 pull/merge/rebase 失败后 status
出现 UU 条目）时有结构化处置面，但**解决动作受审批约束**：两侧改动都可能承载
工作成果，整文件采用其中一侧会静默丢弃另一侧全部改动（数据丢失级）。

## 端点

- GET  /api/projects/:id/conflicts                  冲突文件列表 [{"path","status"}]
                                                    （status: both-modified/added-by-us/
                                                    added-by-them/deleted-by-us/
                                                    deleted-by-them）；响应附 inProgress
                                                    （"merge"|"rebase"|"cherry-pick"|""
                                                    之一）= 进行中的有序操作
- GET  /api/projects/:id/conflicts/content?file=   冲突文件原文（含 <<<<<<< 标记），
                                                    响应附 encoding（原编码标签，
                                                    写回时原样带回，避免转码）
- GET  /api/projects/:id/conflicts/parsed?file=    结构化解析（程序化逐块决策的数据面）：
                                                    {"data":{"ours","theirs"},        整文件两侧聚合
                                                     "hunks":[{"ours","theirs",       每块两侧正文（不含标记行）
                                                               "base"?,               diff3/zdiff3 基准段（||||||| 至 =======，
                                                                                       仅参考；双子段形态缺省）
                                                               "startLine","endLine"}],行号基于工作区内容（1 起步，含两端标记行）
                                                     "complex":false}                 true=嵌套/未闭合/标记计数异常等不可信形态：
                                                                                      无逐块语义，降级整文件模式
                                                                                      （diff3/zdiff3 自 P-20261004-28 起可逐块）
- POST /api/projects/:id/conflicts/resolve          整文件采用 {"file","strategy":"ours"|"theirs"|"manual"}
                                                    （ours/theirs=checkout --ours/--theirs 后 add，高危审批面）
- POST /api/projects/:id/conflicts/resolve-content  合成写回 {"file","content","encoding"?}
                                                    （原子写入自定义内容并 add 标记已解决；高危审批面）

## 强制约定（行为规范）

- 遇冲突第一步**先向用户上报偏好**（ops-ask 节），选项给全：整文件策略
  （「全部采用我方/他方」）/ 逐块人工（用户在冲突面板逐块裁决，你等待）/
  授权你自动解决。未获授权不得擅自调 resolve 族端点。
- 不得为「让流程跑通」默认选 ours 或 theirs——那会丢掉另一侧全部改动；
  deleted-by-* 形态（一侧删除了文件）尤其要先问清「删还是留」。
- agent 令牌调 resolve/resolve-content 会被服务端拦截返回 428 + approvalId
  （与 git push 同级的高危审批，见 ops-channel 节「危险操作确认」）：轮询
  GET /api/ops-confirm/<approvalId> 至 allowed，携 X-Approval-ID 头重试原请求。
  这道关口=用户在审批卡上看到了你的解决动作；它**不豁免** ops-ask 偏好询问
  ——审批是裁决关口，不是授权本身，勿把它当自动放行通道刷。
- 全部文件解决后的收尾按 inProgress：merge → POST /commit 落合并提交；
  rebase → POST /rebase/continue（可能停在下一段冲突，重走本节流程），
  整体放弃用 POST /rebase/abort 回原状。

## 示例：结构化逐块解决（用户已授权自动时）

1) 列出冲突并取解析（读面免审批）：
` + "```bash" + `
curl -s "{{BASE}}/api/projects/$CC_PROJECT_ID/conflicts" -H "X-Lock-Token: $CC_LOCK_TOKEN"
curl -s "{{BASE}}/api/projects/$CC_PROJECT_ID/conflicts/parsed?file=src/a.go" -H "X-Lock-Token: $CC_LOCK_TOKEN"
# {"data":{"ours":"...","theirs":"..."},"hunks":[{"ours":"...","theirs":"...","startLine":12,"endLine":16}],"complex":false}
` + "```" + `

2) 逐块合成写回：对每块按用户授权的策略选侧，把选中正文替换回工作区文件对应
   行段（startLine..endLine 含两端标记行，替换后全文件不得残留任何 <<<<<<<），
   整文件经 resolve-content 写回（encoding 带回读取时的标签）；复杂形态
   （complex=true）没有逐块语义，向用户说明后改走整文件策略。调用会先收到
   428 + approvalId——按上述审批链走完再重试。

3) 收尾提交：
` + "```bash" + `
curl -s -X POST "{{BASE}}/api/projects/$CC_PROJECT_ID/commit" -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"message":"merge: resolve conflicts"}'
` + "```" + `

## 委派会话（用户一键「交给智能体解决」）

用户也会从冲突面板直接把选中文件或整个冲突集委派给你（新建 agent 会话）：
prompt 首行是任务模板（缺省要求「说明两侧取舍理由，完成后保持文件可 stage
状态」，用户可改），其后附文件行、场景行（merge/rebase/cherry-pick 处理中）
与冲突体节选（冲突块带标记 + 两侧正文各截，超长有省略注记——launchArgs
500 字节同限，全量内容用上方端点自读）。收到此类会话 = 用户已显式授权解决
该批冲突，偏好询问可免；但仍受下列约束：优先经 parsed hunks 逐块/合成写回，
不得整文件 ours/theirs 静默丢弃另一侧；解决动作照走 428 审批链；改动落盘
后**不要**擅自 stage/commit 收尾（除非任务模板明确要求）——把取舍理由写在
回复里，等用户在变更面板终审后再继续。`,
		},
		Section{
			ID: "deploy", Title: "部署", Order: 60,
			Summary: "部署器列表/执行部署/任务进度",
			Body: ` - GET  /api/deploy/deployers                部署器列表
- POST /api/deploy                          执行部署任务
- GET  /api/deploy/tasks                    任务列表
- GET  /api/deploy/:taskId                  任务状态（WS /ws/deploy/:taskId 进度）
- GET  /api/deploy/:taskId/log              任务日志留档 txt（失败排障先取日志；
                                           终态 1h 内存窗外 410 携 "deploy log expired"）
- POST /api/deploy/:taskId/cancel           取消进行中的任务`,
		},
		Section{
			ID: "share", Title: "文件分享", Order: 65,
			Summary: "把项目内文件/目录生成匿名访客短链（独立端口子服务），支持冻结快照定格内容",
			Body: ` - GET    /api/share                         列出全部分享（每条带 viewOnce/consumed 投影——一次性
                                           分享已被查看且宽限窗走完后 consumed:true，见下方「一次性」；
                                           响应附 frozenUsage{totalBytes,capBytes} 快照库占用——
                                           冻结快照总量护栏 1GB 的透明化，容量治理先看这里再动撤销；
                                           有快照在盘的行另带 frozenBytes=该份快照字节量，找大头逐条撤销）
- POST   /api/share                         创建（幂等）{"projectId","path"(项目内相对路径，空=整个项目根),"mode"?:"live"(默认)|"frozen","ttl"?:有效期预设（P-20261020-5：1h|1d|7d|30d|permanent，相对创建时刻）,"expiresAt"?:自定义绝对时点（RFC3339，与 ttl 互斥）,"passphrase"?:访问口令（设门后访客需口令，响应 hasPassphrase）,"watermark"?:访客页溯源水印（P-20261005-193，缺省开；false 关；截图外传可按水印尾号对账）,"viewOnce"?:一次性查看（P-20261006-27；true=访客在确认页显式点击「查看内容」（POST /s/{token}/view）后进入 10 分钟宽限窗、窗后失效，GET/HEAD 预览抓取不武装；frozen 模式不支持 400）}
                                           未显式选择有效期时 live 文件分享应用 settings.shareDefaultTTL（GET/PUT /api/settings 可读写，
                                           缺省 permanent=存量行为；frozen 仍默认 30 天）；访客页出「此链接将于 … 过期」弱提示，
                                           访客 meta 对全部形态带 expiresAt（永久省略）
- POST   /api/share                         批量冻结评审包 {"projectId","paths":["a.ts","docs/b.md"],"mode":"frozen",
                                           "passphrase"?,"watermark"?,"override"?}（P-20261008-1：多选 N 个跨目录
                                           文件/目录定格进同一条链，path 与 paths 互斥、仅 frozen（live 批量 400）、
                                           ≤50 项；集合顺序无关幂等，重复提交恒同链；N 路径合计 200MB/库总量 1GB
                                           触顶 413（拆分选择集）；敏感扫描对整份副本，命中未确认回 warnings，
                                           override:true 二次提交放行；访客页根列表按选择集逐项列全路径，
                                           可逐项预览/下载或整包 zip；rotate/refresh/expiry/撤销/口令门同单路径语义）

- GET    /api/share/status                  分享子服务状态（running/port/scheme；短链拼装的
                                           「服务可用」判据。P-20261020-2 起短链基址优先取
                                           settings.sharePublicBaseUrl > externalAccessUrl >
                                           当前非回环地址 > /api/system/network 局域网候选，
                                           /s/* 同源挂在主应用 origin；仅无候选时回退旧格式
                                           host:sharePort）
- POST   /api/share/terminal                开终端只读直播 {"sessionId"(取 $CC_TERMINAL_ID),"ttlMinutes"?,"passphrase"?,"watermark"?}(默认 30 分钟；
                                           幂等同链；访客看遮蔽化只读输出流，无输入端点)
- POST   /api/share/terminal-frozen         冻结终端输出快照 {"sessionId"(取 $CC_TERMINAL_ID),"watermark"?,"passphrase"?}（P-20261005-205：
                                           创建时刻的输出定格链接，默认 30 天；会话关闭后仍可访问；同一段
                                           输出重复冻结恒同链；空输出 400；passphrase 可选访问口令门，
                                           幂等命中带新口令=改门、不带=保持既有（P-20261107-4））
                                           两端点可选 "unfiltered":true 关闭敏感值遮蔽（P-20261106-9：原样
                                           出域——直播原样转发/快照含原文落盘 24h 强制失效，访客页标「未过滤」，
                                           与遮蔽链恒不同链、创建时定死）。缺省遮蔽开；agent 令牌带 true 走
                                           AgentGuard 审批（428）——仅在用户明确要求原样输出时使用，绝不自作主张
- POST   /api/share/cast                    会话回放分享 {"recordingId"(录制 id，取实况记录列表),"ttlMinutes"?,
                                           "override"?,"passphrase"?,"watermark"?}（P-20261004-103：把一次
                                           过程录制的 cast 快照成只读回放页链接，默认 1 小时、上限 24h；
                                           同一录制重复分享恒同链（倒计时不续期，重分享重写快照跟进录制
                                           内容）；敏感模式扫描命中未确认返回 warnings（行号清单），带
                                           override:true 二次请求放行——快照落盘前仍会兜底遮蔽；空录制 400、
                                           录制不存在/cast 缺失 404、超 200MB 413）
- POST   /api/share/session                 会话回放只读分享 {"sessionId"(Claude transcript 会话 id),
                                           "ttlMinutes"?,"passphrase"?,"watermark"?}（P-20261003-77：把一条
                                           会话的完整时间线快照成只读访客页链接——含思考块与工具详情，
                                           标题/正文/工具输入按 P-108 模式集遮蔽为 *** 后落快照；默认 24h、
                                           上限同值；同一会话重复分享恒同链（不续期，重分享跟进新增回合）；
                                           会话不存在 404、无可回放条目 400）
- POST   /api/share/snippet                 文本片段分享 {"content","name"?,"passphrase"?,"watermark"?,"viewOnce"?}（不绑项目的
                                           排障贴短链，24h 自动过期；snippet 有效期固定不可调）
- POST   /api/share/:token/rotate           轮换短链（旧链立即失效、新链即刻可用，泄露应对）。
                                           旧链退役后仍被踩会入外泄观测（P-20261008-2）：
                                           GET /api/share 行带 retiredHits/lastRetiredAt（退役命中
                                           合计与最近时点），审计台账记 share.retiredHit、通知中心
                                           发 warning（首次命中即发、此后每 10 次汇总一条）——死链
                                           被踩是零误报的外泄信号，巡检见此可自主响应（检查内容
                                           敏感度/再次轮换或撤销；响应仍 404 静默，对访客无感）
- POST   /api/share/:token/refresh          冻结分享原地刷新 {"override"?}（P-20261005-177）：同 token 重拷
                                           当前内容顶替旧副本——已分发出去的链接全部继续有效（与 rotate
                                           换链语义正交并存：rotate 是主动换链防泄露，refresh 是链稳定、
                                           内容跟进）。敏感扫描对新副本跑一遍，命中未确认拦下返回 warnings
                                           （旧副本原样），带 override:true 二次请求放行；体积护栏重跑
                                           （单份 200MB/总量 1GB），触顶拒绝且旧副本保留；刷新即 TTL 重置
                                           （重新起算 30 天）。仅 frozen 记录可用（其他形态 400）；目标已删
                                           /项目已删 404。定时刷新基线快照的调度原语（agentcron 例程可编程
                                           周期刷新——评审基线链接恒定、内容随刷新跟进）
- POST   /api/share/:token/expiry           有效期调整 {"expiresAt"(绝对时点|null=恢复永久)}；
                                           仅 snippet 拒绝调整（400，24h 固定窗口）；文件/目录/冻结/terminal/
                                           cast/session 均可程序化改期（创建后二次调整走这里）
- POST   /api/share/:token/passphrase       设置/更换/移除访问口令门 {"passphrase"(空=移除),"rotate"?:
                                           true=联动轮换短链}（改/移除即全体访客门会话失效；口令分享的访客子资源
                                           未验证一律 401 passphrase_required，POST <shareBase>/s/<token>/gate 验证）
- GET    /api/share/:token/messages         访客留言列表（新到旧，P-20261006-13）：巡检同事回流——
                                           「对我分享的配置/输出有疑问」时先读这里再决定是否跟进；
                                           管理列表 GET /api/share 每条带 messages 计数（角标）
- DELETE /api/share/:token/messages/:mid    单删一条留言（垃圾内容出清，入审计）
- DELETE /api/share/:token/messages         清空该分享全部留言（入审计）
- DELETE /api/share/:token                  撤销分享（立即失效；终端直播撤销即断流；冻结分享撤销即删副本；
                                           访客留言附表随记录级联删除）
访客短链形如 <分享基址>/s/<token>。分享基址（P-20261020-2 统一地址计划，前端
result card / 管理器复制 / 二维码同源）优先 settings.sharePublicBaseUrl
（设置·通用「分享外发基址」，仅 http/https origin；agent 可 GET/PUT
/api/settings 同键自诊断/修正），其次 settings.externalAccessUrl、当前非回环
地址、局域网候选，最后才回退旧格式 {{BASE 的主机名}}:<sharePort>。阶段 B 起
主应用同源直通 /s/* 与访客页 vendored 资产（/assets/xterm.js、addon-fit.js、
xterm.css），反代/SSH 隧道只转发主端口即可；旧格式链接继续可用（子服务独立
端口未移除）。目录分享可递归浏览，
- GET  <shareBase>/s/<token>/meta?path=      条目元信息（isDir/kind/size）
- GET  <shareBase>/s/<token>/list?path=      目录列表
- GET  <shareBase>/s/<token>/raw?path=       文件内容（图片/PDF/音视频/文本内联预览）
- GET  <shareBase>/s/<token>/download?path=  下载（目录自动打包 zip）
终端直播访客页 <shareBase>/s/<token> 即只读终端视图（SSE 推流 + 单 token 并发
访客 ≤5）：需要远程结对/汇报「让人看我的终端」时，把直播短链发出去即可——
输出经敏感值遮蔽（sc 令牌/password 赋值/云密钥 → ***，启发式非绝对），
撤好直播（DELETE）是好习惯。
agent 侧「请人来看」的完整闭环是直播三步配方（P-20261005-165）：
①开直播 POST /api/share/terminal 取 data.token；
②发邀请 ops-notify type=watch.invite {"url":"/s/<token>","title":"..."}——
用户通知中心出现邀请条目，点击即在新窗口打开访客直播页（开了直播没人知道
的问题就此收口，详见 ops-channel 节内置事件）；
③演示/讲解完 DELETE /api/share/:token 断流收摊（临时暴露面不留尾巴）。
终端输出快照（terminal-frozen）：求援/报障时不要开直播（直播是活流，创建后
你的后续输入持续暴露给访客）——用 terminal-frozen 把「当前输出」定格成一条
链接再发出去：会话继续跑、访客看到的定格内容不变，会话关了链接仍在（30 天
TTL）。巡检 agent 发现异常输出时的求援自动化：POST /api/share/terminal-frozen
冻一条快照，把返回的短链带进通知/提问（ops-ask）里，「人来看」的入口即链接化。
访客页 <shareBase>/s/<token> 是只读定格视图；快照落盘前已完成敏感值遮蔽
（启发式非绝对）；撤销（DELETE）即删快照。
会话回放分享（kind=cast，P-20261004-103，异步 walkthrough）：教学/复盘/展示——
把一次过程录制（录制索引 /api/recordings 的 id）生成只读回放短链（创建端点
/api/share/cast），访客页 <shareBase>/s/<token> 按录制时序播放、OSC133 命令
章节可跳转；<shareBase>/s/<token>/cast 是净化后的 cast 净本（?dl=1 导出交
外部播放器）。录制继续写不影响已分享的快照；默认 1 小时 TTL（回放含全量
输出回显，暴露面应短），撤销即删快照，会话/录制删除后链接仍可访问到 TTL。
访客留言板（P-20261006-13）：访客页底部可附言（昵称可选、≤500 字、按
token+IP 频控），留言随分享生命周期级联删除——新留言入通知中心（标题
「分享收到新留言」，点击进分享管理器）。agent 侧闭环：开分享 → 收到
回流通知或巡检 GET messages → 看同事疑问 → 直接更新分享内容（frozen 重
建）或经 ops-ask/IM 跟进（留言是单向回流，无回复端点，回复是 IM 的活）。
协作通道（P-20261024-1，分享级开关缺省关，动作化行内端点——分享无编辑面）：
- POST /api/share/:token/collab             开关协作通道 {"collab":true|false}
                                            （开启后访客直播页出现「协作素材」上传位：
                                            粘贴/拖入/点击三入口 + 文字素材框（访客文字
                                            成 .txt 素材走同一收件链，P-20261107-4），
                                            图片 ≤10MB/文件 ≤20MB/
                                            单批 ≤5 个，per-share 收件区配额 200MB；关闭即
                                            回收上传位，存量素材保留可读；访客留言上限
                                            500→2000 字）
- GET    /api/share/:token/drops            收件清单（新到旧，含 absPath 绝对路径——
                                            「把绝对路径贴进所选会话」动作链的取数点）
- POST   /api/share/:token/drops/:id/consume 标已消费（交给会话即标——已消费 24h 清/
                                            未消费 72h 清，防主人未看即被清）
- DELETE /api/share/:token/drops/:id        单删素材（垃圾出清；未知 id 幂等）
- POST   /api/share/:token/direct-input     直通输入档开关（第二档独立开关，与协作
                                            通道互不联动）{"on":true,"confirm":true}——
                                            开启需显式 confirm（管理面摩擦硬闸）；
                                            仅 terminal 形态可开（400）
- GET    /api/share/:token/direct           直通档状态投影 {enabled,session{alive,kind},
                                            pending?,hold?}（管理面轮询数据源）
- POST   /api/share/:token/direct/approve   批准访客申请（单持有者握手；仅锚定 kind=agent
                                            会话可授——普通终端直通=匿名远程 shell 明确不做；
                                            授予即 owner 侧 WS 键盘挂只读闸）
- POST   /api/share/:token/direct/revoke    一键收回（幂等；解除只读闸）
- POST   /api/share/:token/writable         可写分享开关（P-20261106-8「对方可
                                            直接输入」远程协助档，显式推翻 P-20261024-1
                                            「普通终端不做直通」红线：owner 逐案开关+
                                            出域警示+全量审计+实时可见+一键收回五重
                                            补偿）{"on":true,"confirm":true,"passphrase"?}——
                                            开启需显式 confirm；强制口令门（记录无
                                            口令时必携 passphrase 补设，400 stable
                                            "writable requires a passphrase"）；仅
                                            terminal live 形态可开（frozen/cast/session
                                            天然只读 400）；关闭零摩擦（断全部上行）
- POST   /api/share/writable/batch          可写批量开关 {"tokens":[..],"on":true,
                                            "confirm":true}（管理列表多选；逐条独立
                                            结算 per-token {ok,reason}——无口令条目
                                            passphrase_required 跳过，批量不摊薄口令
                                            补偿）
- POST   /api/share/:token/paste/:pid/decision  可写粘贴审批决策 {"approve":bool}
                                            （访客整块输入命中 commandrisk danger 档
                                            挂待批面——未批不注入 PTY，60s 不决自动
                                            拒绝；sc-ops:share.paste-review 审批卡两
                                            动作的调用端点，未知/已决 404 幂等）
访客侧握手与输入在 /s/{token}/direct/*（申请 60s 时效、10min 无输入自动回收、
每批 ≤4KB 全量审计）。素材到达经 ops-channel 广播 sc-ops:share.drop（detail 仅
元数据：token/文件名/大小/昵称）+ 通知中心入账（行内动作「交给当前会话/新会话
处理」两键：回查 drops 取绝对路径 → broadcast-write 把路径贴进所选会话（不自动
执行，agent 读路径即析图析文件）或 createAgent 以路径为种子新开会话；成功后
consume 标已消费；素材随分享撤销/过期级联清）。agent 自动感知协作素材：监听
ops-channel 的 share.drop 事件（或巡检通知中心 drop 类别）→ 读 drops 清单 →
按主人确认把绝对路径读入分析（图片即析图、文档即析文）。
冻结快照分享（mode:"frozen"，评审/教学/归档留证）：「给同事看这个版本」——
创建时把分享根复制进隔离副本，访客读副本而非项目目录：之后继续开发不影响
该链接内容（内容定格不可变）；敏感扫描即对副本本身（所见即所扫，命中仍走
警示 + override 二次确认流）。默认保留 30 天、单份上限 200MB（超限拒绝并
提示走 live）。重复分享同一目标幂等返回既有冻结链（副本不刷新）；要冻结新
版本用 POST /api/share/:token/refresh 原地刷新（保 token 换内容，P-20261005-177）
——不必撤销重建（那会让已分发的外链全部失效）。轮换（rotate）只换短链、
副本不动。响应 data 带 "frozen": true 供程序化辨识。
一次性查看（viewOnce:true，P-20261006-27，分享时限的次数维）：「发凭证
截图给同事看一眼」的防转发单发——P-20261020-3 起武装收口到显式确认：
GET 链接只出泛化确认页（不计数、不武装、不渲染内容、不泄露文件名，IM/
邮件预览抓取 GET/HEAD 不会烧链），访客点「查看内容」（POST
/s/{token}/view；口令分享先过既有 gate）才进入 10 分钟宽限窗并计一次访问
（同浏览器凭查看 cookie 打开内容页；窗内刷新不失效也不重复计数），窗后
链接失效：访客见 410 share_consumed 专页（「已被查看并失效」，区别于 TTL
的「已过期」与 404）；管理列表该条 viewOnce:true，失效后 consumed:true
（记录保留不清，供分享者对账「已经被看过了」）。与口令门正交可叠（一次性
+口令=最严）；frozen/terminal/terminal-frozen 形态不支持（400）。失效不
可逆（rotate/SetExpiry 救不回），要再发请撤销后重建（重建即全新倒计时）。
安全边界：访客只能访问分享根内的内容（符号链接不可见），路径穿越被拒绝；
终端直播缺省严格只读（访客面无分享内容写入端点：/gate 口令验证、/view 一次性
确认、/messages 留言均不写分享内容；唯一例外=可写分享档 POST
/api/share/:token/writable 显式开启后的 /s/{token}/termws 上行桥——五重补偿
控制见上文端点行，缺省关即回到只读）；冻结副本住服务端数据目录隔离区，
不随项目删除联动（撤销/过期才清）。

## 快投递 quickdrop（P-20261006-51「手机触发 agent」配方）

手机上的一段报错/代码/想法 → 家里工作台的 agent 开工，最轻通道。凭据即门禁：
scd_ 投递 token 由用户在设置·分享区生成/撤销，无效凭据一律 404（端点存在性
不可探测）；内容 ≤4KB、24h 自动过期（过期即查无，不留痕）。

- POST /api/quickdrop                      投递原语（公开端点，token 即凭据）：
                                           {"token","content"(≤4KB)} →
                                           {"data":{"id","expiresAt"}}。到达即
                                           工作台通知中心入账（类别 drop、带遮蔽
                                           摘要行 + 行内动作双出口）。agent/脚本/
                                           iOS 快捷指令 curl 直投同样走这里
                                           （每 IP 每分钟 30 次限流）。错误按
                                           status 分支：404=凭据无效、400=内容
                                           为空、413=超 4KB
- GET    /api/quickdrop                    收件箱清单（新→旧，[{id,content,size,
                                           from,createdAt,expiresAt}]）——
                                           「刚才投了什么」的自查口
- DELETE /api/quickdrop/:id                摘除单条（转发消费后清理；未知 id 幂等）
- GET    /drop/<token>                     访客投递页（零依赖单页，手机浏览器直开
                                           直投；表单 POST /drop/<token>，成功
                                           303 回 ?sent=1 成功态）。链接 =
                                           工作台地址 /drop/<token>

「手机触发 agent」配方（向用户转述的口径）：设置·分享区快投递卡生成凭据 →
把 <工作台地址>/drop/<token> 存成手机书签或快捷指令 → 手机粘贴内容点投递 →
工作台通知中心到达 → 用户点行内动作「交给当前会话」（broadcast-write 写入
激活会话）或「新会话处理」（createAgent 以投递内容为 launchArgs 种子，超
500 字节自动走任务文件降级）。`,
		},
		Section{
			ID: "inbound-hooks", Title: "入站事件 Hook（外部事件 → 通知/面板直达）", Order: 66,
			Summary: "CI 失败/监控告警/脚本 → 通知中心；独立 sch_ 凭据、可选 panel: 动作直达面板，60 条/分钟",
			Body: `CI 失败/监控告警/自托管脚本 → 工作台通知中心的最短通道（与出站 webhook 对称）。
凭据是独立 hook token（sch_ 前缀），与 agent token（sca_）权限域分离：只能写通知
（可选 panel: 动作），拿不到任何管理面能力。用户在 设置·安全·入站 Hook 页签
签发/轮换/销毁；无有效凭据时入站全部 401（销毁即关闭）。

- POST /api/hooks                           入站原语（公开端点，凭据即门禁）：
                                           header X-Hook-Token: <sch_ token> 优先；
                                           URL 形态 POST /api/hooks/<token> 兼容
                                           （访问日志已打码）。body 白名单
                                           {title(必填),body?,category?,action?}；
                                           category ∈ git/task/clone/system/error
                                           （缺省 system；error → type=error，随出站
                                           webhook important 范围外发）；action 仅
                                           panel:<面板>，面板 ∈ files/changes/todos/
                                           notes/stream/env/git/terminal/deploy/
                                           share-manager。每凭据 60 条/分钟，超限
                                           429；无效凭据 401，载荷非法 400
- GET    /api/hook-token                    凭据元信息（exists/prefix/时间，不含明文）
- POST   /api/hook-token/rotate             签发/轮换（明文仅本次响应一次；旧值立即失效）
- DELETE /api/hook-token                    销毁（入站随即全部 401）

示例（脚本/CI 集成）：
curl -X POST {{BASE}}/api/hooks \
  -H "X-Hook-Token: $CC_HOOK_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"CI failed","body":"job=build","category":"error","action":"panel:git"}'`,
		},
		Section{
			ID: "ops-ask", Title: "智能体提问（向用户追问）", Order: 72,
			Summary: "长任务需要用户输入时提问，卡片直达用户，轮询取答案——提问出终端、答案回 agent",
			Body: `卡在需要用户输入的时刻（「选方案 A 还是 B？」「缺个环境变量值」）不要在
终端里打印问题干等——用提问端点把问题送到用户面前（全局提问卡片 + 值班大屏），
用户作答后轮询取答案继续任务。与「危险操作确认」共同构成 agent↔用户 双向通道。

- POST /api/ops-ask                          发起提问 {"question"(必填,≤2048 字),
  "options"?["选项A","选项B"](≤10 项,有则用户点选作答),"terminalId"?}（terminalId
  取 $CC_TERMINAL_ID，提问卡片可一键跳回你的会话）；返回 {"data":{"id","status","expiresAt"}}
- GET  /api/ops-ask/:id                      轮询状态/取答案（建议 2s 间隔，最多等 30 分钟）
  status: pending（未答）| answered（answered 载荷含 answer 字段即用户答复）| expired
- GET  /api/ops-ask                          提问列表（诊断用）
- POST /api/ops-ask/:id/answer               用户作答侧端点（Agent 不调用）

## 强制约定

- **不引入回复标记**：没有 [[ASK_DONE]] 类标记，也无需把答案写进任务标记——
  轮询语义已足够：轮询到 answered 即取 answer 继续任务。
- 未答问题 30 分钟自动过期（expired）——长时间无人响应时停止轮询，先做其他
  独立步骤或按合理默认值继续并在任务汇报中注明假设。
- 问题要具体可答：需要选择时给 options 列表；需要取值时说明格式与用途。

## 推荐用法（示例）

1) 发起选择型提问并轮询答案：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-ask -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"question":"检测到未推送提交，推送到 origin/main 还是先变基？","options":["直接推送","先变基"],"terminalId":"'"$CC_TERMINAL_ID"'"}'
# {"data":{"id":"sc_aq_...","status":"pending","expiresAt":"..."}}
` + "```" + `

2) 轮询取答案（answered 后取 data.answer 继续；expired 则走降级路径）：
` + "```bash" + `
curl {{BASE}}/api/ops-ask/<id> -H "X-Lock-Token: $CC_LOCK_TOKEN"
# {"data":{"id":"...","status":"answered","answer":"先变基",...}}
` + "```" + `

3) 自由取值型提问（不带 options，用户在卡片输入框作答）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-ask -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"question":"缺 STAGING_DATABASE_URL 的值（postgres 连接串），请提供","terminalId":"'"$CC_TERMINAL_ID"'"}'
` + "```",
		},
		Section{
			ID: "snippets", Title: "命令片段库", Order: 75,
			Summary: "常用命令片段的增删改查",
			Body: ` - GET    /api/snippets                      片段列表
- POST   /api/snippets                      新建 {"title","command","description"?,"tags"?,"scope"?}
- PUT    /api/snippets/:id                  修改
- DELETE /api/snippets/:id                  删除（系统预置片段不可删）
  · 片段文本里的 $0 / ${CLIPBOARD} / ${DATE} / ${TIME} 由前端在插入时替换
    （未识别变量原样保留）；经 API 直取片段不走该层，agent 按需自拼变量值`,
		},
		Section{
			ID: "runbook", Title: "运行书（多步序列服务端执行）", Order: 76,
			Summary: "运行书 CRUD 与一键执行（params 供参、退出码等待、逐步进度上报）；排障知识沉淀闭环——成功固化→检索引用→定时复用",
			Body: ` - GET    /api/runbooks                      运行书列表（data:[{id,title,onFailure,steps}]）
- POST   /api/runbooks                      新建 {"title","steps":[{"command","description"?}],"onFailure"?}
- PUT    /api/runbooks/:id                  修改（patch 语义：空字段不改写）
- DELETE /api/runbooks/:id                  删除
- POST   /api/runbooks/:id/run              服务端执行（P-20261004-108，同步：返回即终态）：
                                            {"params"?,"targetSessionId"?,"onFailure"?,"stepTimeoutMs"?}
  · steps 里的 {参数} 占位符按 params 插值（与前端面板同语法）；缺失/空白参数
    400 runbook.params_missing，响应 missing 清单按步骤出现序列出——补齐重发
  · targetSessionId 缺省 = 新建纯 shell 会话作为独立执行现场（响应 sessionId
    可回查 scrollback）；显式指定须在册（404 runbook.target_not_found），该会话
    里若有人在跑别的命令，退出码归属按到达序可能错位（知情边界）
  · onFailure 缺省沿书定义（再缺省 continue=失败步记录不拦截）；"stop"= 非 0
    退出码停在失败项（余下步骤 skipped）；同书并发跑 409 runbook.busy
  · stepTimeoutMs 单步退出码等待上限（缺省 30000，钳 3000~600000）：超时视为
    完成继续（命令可能仍在跑，timedOut 如实标注）；首轮超时且无 shell 集成
    时降级连续发送（响应 degraded=true，无逐条退出码判据）
  · 响应 data：{runId,bookId,title,sessionId,onFailure,status:"completed|failed",
    degraded?,steps:[{index,command(插值后),description?,status,exitCode?,timedOut?}]}
  · 同步语义（返回即终态）有 60s 响应墙（服务端 WriteTimeout）：总时长超 60s
    的长运行连接会断、执行本身不受影响——勿盲目重试（同书互斥 409 挡二跑），
    终态以 task.progress 广播与 GET /api/agent-tasks?sessionId=<执行会话> 为准
  · 每步进度经 ops-channel 广播 task.progress（terminalId 归属执行会话，
    steps 结构化清单），悬浮球/值班大屏实时可见；GET /api/agent-tasks?
    sessionId=<id> 可查历史进度流
  · 每次执行入审计（runbook.run，只记书/会话/步数元数据）

## 推荐工作流（人与 agent 共享的操作知识库，P-20261007-13）

1) 引用执行（用户说「按上次排障流程跑」类请求）：GET /api/runbooks 按 title
   关键词匹配目标书 → POST /api/runbooks/:id/run 执行（缺的 {参数} 占位符按
   400 runbook.params_missing 的 missing 清单补齐重发；对多台同跑改走
   fleet-runbook 节）。等退出码/onFailure/进度上报均由服务端承担，优先走
   端点、勿把书内步骤拆出来自己逐条手发；对端确无该端点（404=旧版本，按
   meta 节降级约定）才降级逐条经终端输入执行——该路径与手打等效零豁免，
   每条命令照常过 AgentGuard 与高危审批（服务端执行端点的存稿免检语义
   不适用于它）。
2) 沉淀固化（排障成功的收尾动作）：本次排障流程有复用价值 → POST
   /api/runbooks 固化——title 含场景关键词（报错特征/组件名/服务名）供日后
   检索命中，steps 写可重放命令（环境差异用 {参数} 占位符），onFailure 按
   流程语义选 stop/continue；会话收尾总结时主动固化或向用户建议固化，把
   一次性排障变可复用资产。定时复用见 agent-cron 节（例程 prompt 引用
   运行书，改书即改例程）。`,
		},
		Section{
			ID: "fleet-runbook", Title: "舰队运行书（N 台会话有序编排）", Order: 78,
			Summary: "按序对多台会话执行同一本运行书：每步广播写全目标 + 并发等各目标退出码聚合（矩阵），onFailure 停/续",
			Body: ` - POST   /api/runbooks/:id/fleet-run        舰队执行（同步语义，60s 响应墙同 run）：
                                            {"targetIds":["会话id",...],"params"?,"onFailure"?,"stepTimeoutMs"?}
- POST   /api/runbooks/:id/fleet-abort      中止在途 run {"runId"}：未完成目标广播
                                            Ctrl+C（\x03），响应 = 终态矩阵快照
- POST   /api/runbooks/:id/fleet-retry      失败步单台重试 {"runId","stepIndex","targetId"}：
                                            只重发该格命令到该目标，响应 = 重算后全矩阵
  · 编排语义（P-20261005-147）：每步 = 逐目标写入插值命令 + 并发等各目标
    OSC 133 D 帧退出码 → 全成功走下一步；任一失败按 onFailure（stop =
    中止全书，矩阵 failed 格即「哪台哪步」；continue 记录继续）。同书互斥
    与 runbook run 共表（409 runbook.busy——同书舰队跑/单台跑并发无语义）
  · targetIds 本地+远程混合（本地 GET /api/terminals、远程 GET
    /api/remotehosts/terminals 取 id；去重保序），全须在册——缺席 400
    fleet.targets_not_found 带 missing 清单（编排目标集开跑前须完整可解析）
  · 无 OSC133 目标（裸 sh / 远程终端——确认信号不回传）：不等待，该格
    done + noSignal=true（「无确认信号」诚实标注，成败不可判定不虚报）；
    有信号但超时（缺省 120000ms，钳 3000~600000）视为完成 + timedOut=true
  · 响应 data：{runId,bookId,title,targetIds,onFailure,
    status:"completed|failed|aborted",steps:[{index,command(插值后),
    description?,status,targets:[{id,status,exitCode?,timedOut?,noSignal?,error?}]}]}
  · 进度订阅：ops-channel task.progress 批形态——payload.fleet 扩展
    {phase:"start|step|final",stepIndex,stepTotal,targetIds,stepNames?,results?}：
    start 建矩阵骨架（列序 targetIds/行序 stepNames），step 携本步逐目标格
    增量，final 终态。无 terminalId（舰队不归属单会话）；GET /api/agent-tasks
    落库流可回查（fleet 载荷原样落库）
  · retry 语义：仅终态 run 可重试（运行中 409 fleet.run_busy）；仅
    failed|aborted 格可重（done 重试防双跑，skipped 是未发送——补跑走重跑
    全书）。runId 终态保留窗 1h，过期/重启后 404 fleet.run_not_found
  · 安全面：写入 PTY 的命令来自用户策展的运行书存稿（agent 只供参数与目标），
    不入 AgentGuard 高危表（与 runbook run 同级）；执行/中止/重试均入审计
    （fleet.runbook.execute，Detail op= 区分，参数值与命令原文不入账）。
    写入前可 POST /api/terminals/command-preview 自查命令影响面（terminal 节）
  · 手动中止（fleet-abort）：幂等（已终态回快照不报错）；未收敛目标收 \x03，
    已收敛格保留真实结果`,
		},
		Section{
			ID: "notifications", Title: "通知中心", Order: 85,
			Summary: "应用内通知的读取与处理",
			Body: ` - GET    /api/notifications                 通知列表
- POST   /api/notifications                 手动投递一条通知（多为内部/webhook 面；
                                            agent 发用户可见提醒走 ops-notify
                                            type=notify（toast 即逝）或
                                            type=notify.persist（持久条目带动作，
                                            P-20261007-10），见 ops-channel 节）
- WS     /ws/notifications                  通知实时流（前端常驻订阅）
- POST   /api/notifications/read-all        全部标记已读
- POST   /api/notifications/read/:id        标记单条已读
- POST   /api/notifications/dismiss/:id     移除单条
  分级语义（P-20261004-117）：POST 载荷 type=error（任务失败/哨兵命中/部署
  失败等「值得叫醒人」的事件）在用户开启免打扰时段（夜间挂机）时仍穿透为
  桌面提醒——可靠上报 error 即可达；info/warning 属噪声级免打扰期间不弹
  桌面（通知中心照常在册）。task.progress status=failed 同口径（前端入账
  error 级穿透勿扰），用户可在设置·通知关闭「错误级仍提醒」回绝对静默`,
		},
		Section{
			ID: "ops-channel", Title: "前端联动（智能操作通道）", Order: 70,
			Body: ` - WS   /ws/ops-channel                      前端常驻订阅；事件 {"type","payload","source","ts"}
- POST /api/ops-notify                      发布前端联动指令 {"type","payload"}
- GET  /api/ops-tasks/active                查询各会话最近一次 task.progress（P-20261004-120）：
                 响应 data.tasks[] = {"sessionId","receivedAt"(unix 毫秒),
                 "payload":最近一条全量载荷}，receivedAt 升序；瞬态内存快照——
                 会话关闭即清、重启清空（落库历史另查 GET /api/agent-tasks）。
                 你巡检「全舰队在跑什么」（task/step/状态一屏可知）的监控原语，
                 也用于页面刷新/通道重连后各监控面的即时回填；无会话归属
                 （无 X-Session-ID 头且载荷无 terminalId/sessionId）的上报不入列

{{PRESENT_ATOMS}}

  另有 "task.progress"（进度上报：{"task":"任务简称","status":"running|done|failed","step":"当前步骤一句话","terminalId":"会话id"}）——
                 AI 助手悬浮窗进度数据源：多步任务在开始/关键节点/结束时上报。
                 terminalId = 环境变量 CC_TERMINAL_ID（当前终端会话自标识）——带上它，
                 悬浮窗的进度与点击跳转能精确归属到你所在的终端会话
                 可选 steps 数组（≤20 项，每项 {"name":"步骤名","done":布尔}）：
                 结构化步骤清单，悬浮球/值班大屏除当前步骤外还展示「共几步、完成
                 几步」。约定：任务开始先报全量计划（全部 done=false），每完成一项
                 整包重发清单并置该 done=true（最后一份为准）；step 与当前项 name
                 保持一致，前端高亮对应清单项。缺省 steps 的上报不影响既有清单
                 done/failed 终态广播由服务端顺带附加可选 summary 字段
                 （该会话 transcript 的结论尾部：done=你最后的 assistant 文本、
                 failed=最后一条报错结果，已遮蔽压平、可能缺省）——终态通知
                 （通知中心/桌面/webhook）据此一屏知结果，你监听同一广播亦可
                 消费该字段做后续自动化判定；载荷自带 summary 时服务端以你的
                 原值为准（可自报更精准的一句话摘要）。
                 进度是「等待/汇报」原语而非呈现原语，校验与终态摘要的伴生
                 副作用耦合在发布口，故不在上方原子注册表内
  - "projects.changed" / "settings.changed"           系统在项目/设置变更后自动广播，前端自动刷新

  频率限制：每会话 60 条/分钟（会话取 X-Session-ID 头，缺省按载荷 sessionId，
  再退调用令牌）。超限请求被静默丢弃（仍回 200），并每分钟经通道回告一条
  "system:rate-limited" 事件（携带 dimension/key/dropped/limit）——收到即说明
  你的上报循环失控，应降频或修复；正常的关键节点上报远低于此限额

  尺寸限制：请求体 ≤64KB（超限 413 ops.payload_too_large），通知文本字段
  （task.progress 步骤名 / preview.port label）各 ≤4096 字节（超限 400）——
  通知是短文本语义，正常上报远低于此，超限即精简载荷重发

## 推荐用法（示例）

1) 添加项目并让前端立即刷新（前端订阅了 projects.changed，后端会自动广播）：
` + "```bash" + `
curl -X POST {{BASE}}/api/projects -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"name":"demo","path":"/path/to/demo"}'
` + "```" + `

2) 切换终端主题（设置变更自动广播，前端实时跟随）：
` + "```bash" + `
curl -X PUT {{BASE}}/api/settings -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"terminalTheme":"dracula"}'
` + "```" + `

3) 注意力引导三连：改完文件 → 打开到目标行 → 变更面板聚焦（原子自由组合；type 用线协议名，原子 id 与事件的对应见上方目录）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"type":"open-file-at","payload":{"path":"src/app.ts","projectId":"<项目ID>","line":42}}'
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"type":"navigate","payload":{"view":"changes"}}'
` + "```" + `
   给用户发可点链接用人类深链表（勿编造 URL 形态）：
   /project?file=src/app.ts&project=<项目ID>&line=42

4) 多步任务上报进度（AI 助手收起后的悬浮进度窗实时跟随）。任务开始先报全量
   计划，之后逐项勾选（整包重发清单，置完成项 done=true）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"type":"task.progress","payload":{"task":"切换主题","status":"running","step":"写入设置","terminalId":"$CC_TERMINAL_ID","steps":[{"name":"读取当前主题","done":true},{"name":"写入设置","done":false},{"name":"刷新界面","done":false}]}}'
` + "```" + `

5) 打开指定面板（把界面带到任务相关区域；type 用线协议名 "panel"，present.panel 是注册表原子 id）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"type":"panel","payload":{"name":"git"}}'
` + "```" + `

6) dev server 就绪后上报端口（用户一键直达预览面板，免人工读端口号；每次服务起来只报一次；type 用线协议名 "preview.port"，present.port 是注册表原子 id）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"type":"preview.port","payload":{"port":3000,"label":"vite dev server"}}'
` + "```" + `

7) 改完文件后把用户的注意力带到目标位置（示例 3 的 present.file 单步形态；
   projectId 从 GET /api/projects 取）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"type":"open-file-at","payload":{"path":"src/app.ts","projectId":"<项目ID>","line":42}}'
` + "```" + `

8) 长任务收尾在通知中心留一条可跳转的持久结论（「查看会话」直达你的终端，
   跨设备可见、历史留痕；toast 级提醒用 "notify" 即可）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"type":"notify.persist","payload":{"title":"回归测试完成：42 通过 1 跳过","level":"success","action":"terminal","actionPayload":"'"$CC_TERMINAL_ID"'"}}'
` + "```" + `

9) 让用户在文件树里看到产出文件的位置（结构上下文，不开编辑器）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-notify -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d '{"type":"locate-in-tree","payload":{"path":"src/server/agentops","projectId":"<项目ID>"}}'
` + "```" + `

## 危险操作确认（强制约定）

执行高危操作前（git reset --hard / push --force / branch -D / clean /
删除文件 / 远程命令执行 / 部署等），必须先请求用户确认并等待裁决。
另外：使用智能体令牌直接调用高危端点（push/reset/删除/部署等）会被
服务端拦截返回 428 + approvalId——轮询到 allowed 后，携带
"X-Approval-ID: <id>" 头重试原请求即可（一次性放行）；建议所有请求
都带 "X-Session-ID: $CC_TERMINAL_ID" 头，审批卡片能精确归属到你的会话：

ops-confirm 端点全家福（上文示例用到其中两个）：

- POST /api/ops-confirm                     请求确认（示例 1）
- GET  /api/ops-confirm                     审批列表（?status=pending|allowed|denied 过滤，诊断用）
- GET  /api/ops-confirm/:id                 轮询裁决结果（示例 2）
- GET  /api/ops-confirm/export              裁决历史 CSV 导出（复盘/对账）
- POST /api/ops-confirm/:id/resolve         用户裁决侧端点（Agent 不调用）

**高危审批必附 impact（结构化影响面）**：请求确认时在请求体加 impact 字段，
用户在审批卡顶部秒读要点（不用读完 detail 长散文再抓重点）——几行代码的
成本换更快的裁决：

- "impact":{"kind":"delete|reset|push-force|remote-exec|deploy|other",
            "summary":"一句话影响摘要（≤200 字）",
            "filesCount":12,                       可选：受影响文件数
            "commands":["git reset --hard ..."]}   可选：关键命令 ≤5 条
- kind 归类拿不准就用 "other"，不要硬凑；坏载荷 400
  （code=ops.confirm_impact_invalid）——修正或去掉 impact 重发均可。
- 服务端强制拦截（428）建的审批也会自动填充影响面（有可靠数据的操作，
  初批删除项目 = 将级联终止的终端会话计数）；轮询响应 data.impact 同样
  携带——等裁决时你也能自知这次操作的影响面。

1) 请求确认（返回审批 id，前端弹出确认卡片）：
` + "```bash" + `
curl -X POST {{BASE}}/api/ops-confirm -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  -d '{"sessionId":"'"$CC_TERMINAL_ID"'","op":"reset --hard","target":"main","detail":"丢弃未推送改动，恢复到 origin/main","impact":{"kind":"reset","summary":"丢弃 main 上 3 个未推送提交","filesCount":7,"commands":["git reset --hard origin/main"]}}'
` + "```" + `

2) 轮询裁决结果（建议 2s 间隔，最多等 120s；用户未响应时先做其他独立步骤）：
` + "```bash" + `
curl {{BASE}}/api/ops-confirm/<id> -H "X-Lock-Token: $CC_LOCK_TOKEN"
# {"data":{"id":"...","status":"pending|allowed|denied","reason":"拒绝理由（denied 时可能携带）",...}}
` + "```" + `

3) 按结果继续：allowed → 执行该操作；denied → 中止该操作并告知用户替代方案，
   轮询响应的 reason 字段是拒绝理由（如「别动 .env，改用环境变量」）——读它
   并按其调整方案（换目标/换方式），不得原样重试；长时间 pending → 先继续
   其他无风险步骤，勿擅自绕过确认。

放行时限档位（用户侧选择，对你是透明的）：用户可把高危审批设为三档放行——
会话级（只放行某个会话）/ 24 小时（全局，到期自动恢复询问）/ 永久（直到手动
改回）。档位生效期间你的高危请求不再弹卡：POST /ops-confirm 会直接返回
allowed，或 428 后轮询立即 allowed——你的调用方式与轮询语义完全不变，无需
感知档位，也勿因「直接 allowed」而跳过确认约定（档位之外的会话/到期后仍会
正常弹卡等待裁决）。

审批规则支持按「操作×目标路径」双条件裁决（target 传**项目相对路径、正斜杠**，
如 docs/notes.md——命令型/URL 型 target 不参与路径判定）：轮询响应的
ruleHit 字段显示命中的规则（带路径条件时形如 "files.write (path: docs/**)"），
status=denied 且带 ruleHit 即用户配置的规则拦截，勿原样重试，向用户报告或
改用规则放行范围内的目标。`,
		},
		Section{
			ID: "clip", Title: "跨设备剪贴板中继", Order: 77,
			Summary: "跨设备贴内容/取内容：写入即广播到全部前端，读取即焚（TTL 5 分钟）",
			Body: `从手机/其他设备递命令、链接、token 到本机工作台（或反向）：写入后前端
通知中心即时可粘，不必隔着聊天工具转手。

- POST /api/clip {"content"}                写入中继（内存单槽，成功广播
                                            clipboard.arrived 到全部前端；32KB 上限 413；
                                            每 IP 30 次/分钟限流——写入是广播放大面）
- GET  /api/clip                            读取并清槽（返回 {"content","origin","size","at"}；
                                            空槽/过期 404）。读取即焚 + TTL 5 分钟：
                                            高频轮询无意义，读一次就到手`,
		},
		Section{
			ID: "sync", Title: "多实例项目同步（跨实例搬运项目与上下文）", Order: 78,
			Summary: "fleet 巡检可编程化：manifest 对账四态判定 → plan 预览 → pull/push 整项目搬运（含 .gitignore 感知排除/原子落位/覆盖备份）",
			Body: `把「项目 + 上下文（会话/定时任务/运行时注册/审批规则/接续链/uiState）」
整体在实例间搬运：新实例从零到与源实例体验一致，一次同步完成。对端能力探测：
GET /api/meta capabilities 含 "sync" 才可用（未声明 = 对端需升级）。
**笔记不随实例同步**（P-20261108-3 单库化：笔记是项目无关的全局库，notes/
notes-multi 单元已退役；跨实例需要时单篇 export 后人工搬运）。

## 端点

- GET  /api/sync/manifest                    本端单元清单（项目本体+上下文+全局单元，
                                             每单元聚合指纹/字节/文件数；磁盘水位）
- POST /api/sync/plan {"instanceId","projectKeys"?,"contexts"?}
                                             四态判定预览：synced/local-newer/
                                             peer-newer/conflict/new + 建议动作与
                                             默认勾选（冲突默认不勾需人工裁决）；
                                             旧对端仍带的笔记单元标 retired
                                             （action=skip 不可勾选——知情不执行）
- POST /api/sync/pull {"instanceIds":[一个],"units":[键...],"includeIgnored"?,"includeGit"?}
                                             拉取落地本端（自动注册项目）
- POST /api/sync/push {"instanceIds":[可多台],"units":[...],"resolutions"?{键:local|peer|skip}}
                                             推送到对端（高危审批面；多目标并行 2）
- GET  /api/sync/units?keys=a,b&includeIgnored=1&includeGit=1
                                             对端面：zip 流式打包（X-Sync-Meta 头携
                                             单元元数据）
- POST /api/sync/units?mode=land|deliver     对端面：接收 zip 落位（land=注册项目/
                                             .sync-backup 备份；deliver=纯落位不注册）
- POST /api/sync/deliver {"instanceId","projectId","relPath","dest"}
                                             项目子树轻投递（不注册项目）
- GET  /api/sync/progress                    当前任务快照（常态走 WS sync.progress 广播）
- GET/DELETE /api/sync/ledger?peerId=&unitKey=   同步账本（基线四态判定依据；删除=重置基线）
- GET  /api/sync/crons                       定时同步任务清单
- POST /api/sync/crons                       新建（方向/项目集/目标集/时刻/冲突策略
                                             safe|local-mirror|peer-mirror）
- PUT  /api/sync/crons/:id                   编辑（运行期事实保留）
- DELETE /api/sync/crons/:id                 删除
- POST /api/sync/crons/:id/run               立即试跑

## 单元键（跨实例稳定）

- project:<根目录基名>   项目本体（目录树；含 .git 与否是传输档）
- sessions:/crons:<基名>   项目上下文（notes:/notes-multi: 已退役——点名即逐个记
  失败不传输，旧对端推来的笔记单元落地侧拒收回告，结果卡标红）
- snippets/runtimes/approvals/chains/uistate   全局单元（键即 kind）

## agent 工作流示例（把项目集推到新实例）

1) GET /api/sync/manifest 记下各单元 key；
2) POST /api/sync/plan 预览：只取 action=push 且 selected=true 的键
   （冲突行 selected=false，把它们原样留人工——不要替用户裁决冲突）；
3) POST /api/sync/push {"instanceIds":["<id>"],"units":[键...]}；
4) GET /api/sync/progress 轮询或消费 WS sync.progress（500ms 节流）等终态。

边界：凭据库/锁密码/实例 Token/SSH 主机凭据/分享 token 永不同步（对端各自
配置）；git 仓库双端都有本地提交时 plan 标 conflict 且建议走 git remote/fetch
（文件级覆盖会丢提交）；审计 sync.pull/sync.push 只记单元数/字节/冲突计数。

## 手动携密同步（P-20261024-3）——**纯人工边界（重要）**

唯一例外通道：用户在同步中心手动勾选「包含密钥凭据」并发起，凭据档
（credential 库+SSH 主机含私钥+部署凭据+Agent Token）经配对密钥端到端加密
搬运。**定时/自动同步服务端硬编码永不携密**（cron 源携密请求直接拒绝）。
agent **不要**代用户触发携密链路——三道仪式关口已入高危审批表（配对钥轮换
sync.cred.control / 指纹核对 / 暂存终审），正确动作是引导用户到同步中心：
- 先在两端实例间完成配对（pairing 码与 Token 同屏人工抄录，不走网络）；
- 首次携密必须完成证书指纹短码双端核对（内网也不可跳过）；
- 对端首次接收弹确认（未确认不落盘，暂存 10 分钟过期即焚）；
- agent 令牌调用 pull/push 的 includeCredentials=true 需审批，且审计
  sync.cred.send/sync.cred.recv 双端入账（只记枚数/pairFp 短指纹元数据）。

携密端点（管理面，供人审参考）：
- GET    /api/sync/pairing                              配对状态（无明文钥，只出 pairFp 短指纹）
- POST   /api/sync/pairing/:instanceId/generate         生成/轮换（响应一次性携带配对码；高危审批面）
- PUT    /api/sync/pairing/:instanceId {"code"}         录入对端抄来的配对码
- DELETE /api/sync/pairing/:instanceId                  解除配对（双端对称，重置即需重新配对）
- POST   /api/sync/credentials/verify {"instanceId"}    首次指纹核对确认（高危审批面）
- GET    /api/sync/credentials/staged                   接收端暂存清单（元数据）
- POST   /api/sync/credentials/staged/:ticket/resolve {"accept"}   暂存终审（高危审批面）
- GET    /api/sync/credentials/certinfo                 本机证书指纹（核对仪式比对源）`,
		},
		Section{
			ID: "migration", Title: "换机迁移（实例配置包导出/导入）", Order: 79,
			Summary: "单包单口令整机迁移：配置四块（凭据/令牌/设置/实例注册表）+ 可选内容全量包；apply 高危审批面",
			Body: `换机/迁实例的一次性迁移工具（.scpkg 口令信封包）：日常态复制走 sync
（见上节），迁移补 sync 红线内不迁的凭据/令牌/系统设置/实例注册表四块。
双模：light=配置四块（KB~MB 亚秒）；full=四块+项目与上下文内容（流式分块
加密，旧机导完即可退役，新机单包自足）。

## **纯人工边界（重要）**

迁移向导是纯人工流程：口令永不过 agent 通道（请求体口令由用户在设置·迁移
分区亲手输入）。agent **不要**代用户导出/导入——正确动作是把用户引导到
「设置 → 迁移」分区，并提示：
- 包含凭据密文的 .scpkg 妥善保管，口令遗失无法恢复；
- 导入后新机首设锁密码（包不含锁密码哈希——Bitwarden 模式）；
- 旧机令牌建议轮换/退役（同 token 双活风险）；
- 机器 API token（sc_）/quickdrop（scd_）/hook（sch_）为仅哈希+本机盐落盘，
  不随包迁移，新机需重签。

## 端点（管理面鉴权；apply 高危审批）

- POST /api/migration/export {"mode":"light"|"full","passphrase","blocks":
  {credentials,tokens,settings,instances},"projects"?:[{projectId,includeGit,
  includeContexts}],"globalContexts"?}
                                             导出 .scpkg 附件（审计
                                             migration.export：模式/块清单/
                                             单元数元数据，口令与凭据绝不如账）
- POST /api/migration/import/preview         multipart: file+passphrase →
                                             预览（逐块计数/设置 diff/内容档
                                             清单+票据 ticket；不含秘密明文）
- POST /api/migration/import/apply {"ticket","blocks":{credentials|instances|
  tokens:"merge"|"overwrite"|"skip",settings:"package"|"local"},"projects"?}
                                             应用导入（高危审批面）。内容先
                                             落位（sync 引擎：原子落位/
                                             .sync-backup/自动注册），配置四块
                                             按策略应用，任一块失败整体回滚
                                             （报告 RolledBack=true）。审计
                                             migration.import 只记块策略/计数

## agent 可编程消费面

selfcheck 排障可读迁移审计（migration.export/import 的模式与计数元数据）；
其余环节（口令、文件选择、策略裁决）均为人工裁决点，无 agent 直调场景。`,
		},
		Section{
			ID: "reports", Title: "日报与活动流（回顾与值班）", Order: 80,
			Summary: "近 14 天日报回看/手动补跑与实例活动序列——接手任务先看「最近发生过什么」",
			Body: `- GET  /api/reports/daily                   日报列表（近 14 天存档）
- GET  /api/reports/daily/:date             单日详情（会话/提交/通知聚合的当日回顾）
- POST /api/reports/daily/run               手动补跑/重发指定日期（写面）
- GET  /api/reports/activity                实例活动序列（值班大屏热力图数据面）
接手任务或回顾进展先读昨日日报与活动流，不要凭记忆断言「最近做过什么」；
用户问「昨天干了啥」类问题时这里是一手事实源。`,
		},
		Section{
			ID: "proc-tty-safety", Title: "进程/终端排障安全（/proc fd 与 tty）", Order: 90,
			Summary: "排查 /proc/<pid>/fd 与终端设备时的强制守则——直接读 /dev/pts/* 会吃掉用户终端的键盘输入",
			Body: `排查「管道占用/句柄持有」类问题（如谁持有某 pipe/socket）时，经常要
看进程的 /proc/<pid>/fd/*。**强制守则：/proc/<pid>/fd/* 下的 symlink 目标
可能是终端设备节点（/dev/pts/N、/dev/tty*）——把这些设备当普通文件打开读，
会与该终端的前台进程竞争同一条 stdin 字节流，用户的键盘输入（含鼠标事件）
被你的 grep/cat 静默截走，表现为「进程活着、屏幕能重绘、键盘全无反应」。**

安全做法：
- 只看链接指向，**绝不打开/读取设备节点内容**：
    ls -l /proc/<pid>/fd            # symlink 目标可见，不读
    ls -l /proc/<pid>/fd | grep -c pts
- 查谁持有某个 fd/pipe：用专门的查询工具，它们只读内核结构不读设备：
    fuser -v /dev/pts/3             # 谁在用这个终端
    lsof -p <pid>                   # 进程句柄清单（含管道对端）
    ss -xp | grep <inode>           # socket/pipe inode 反查
- 对 /proc/<pid>/fd/* 做内容搜索（grep/ugrep -r）时，必须显式排除设备：
    grep <pattern> /proc/<pid>/fd/* --include='*pipe*'   # 不够——fd 名是数字
    正确姿势：先 ls -l 列出目标，把**非设备文件**（pipe:/socket: 之外的
    普通文件路径）逐个作为参数传给 grep，禁止把 /dev/pts/* /dev/tty*
    /dev/null 之外的设备路径混进参数列表。
- 若已发生输入被截走：找到读取该 pts 的进程（fuser -v /dev/pts/N 或
  lsof | grep pts/N）结束它，终端输入立即恢复；被吃掉的字节无法找回，
  重新输入即可。`,
		},
	)
}
