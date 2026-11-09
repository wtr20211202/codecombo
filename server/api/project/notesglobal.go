package project

import (
	"github.com/gin-gonic/gin"

	"codecombo/server/agentops"
	"codecombo/server/store"
)

// ── 笔记库 /api/notes 族（P-20261107-5 全局库独立化 → P-20261108-3 单库化）──
//
// 笔记是项目无关的独立 notepad 库（真实使用定调「笔记独立不合项目关联」）：
// 同一 notesmulti kind 与仓储，作用域段取保留哨兵 store.GlobalNotesScope
// （复合键 _global-<noteID>）。本文件只做端点族声明与手册分节，实现体全部在
// notesmulti.go 作用域参数化（notesList/notesCreate/…）；存量项目篇的并入
// 见 notesmigrate.go。
//
// 单库化（P-20261108-3）：原项目族 GET/PUT /api/projects/:id/notes（兼容
// shim）与 /api/projects/:id/notes-multi 七端点随「全局库|项目库」双源切换
// 一并退役（404），能力项 notes/notes-multi 同步下线，/api/meta 只剩
// notes-global。项目归属改为标题约定：「[项目名] 」前缀（迁移自动加、沉淀
// 交接篇「[项目名] 交接」），接手项目按前缀搜本库。
//
// 路由注册必须挂 api 组（router.go，复审#2 钉死）——自动继承
// LockCSRF + LockMiddlewareWithCookie + TokenAuthMiddleware + AgentGuard 四件
// 中间件，挂错组（公开组）即绕锁门。agent 令牌实例级，不新增鉴权面/出域
// 口径：软删+restore 对 agent 开放、?purge=1 硬拒；审计维持 P-144 口径只记
// delete/restore/purge（+ 迁移汇总 notes.migrated）；notes.updated 广播
// projectId=_global；30 天回收站硬清（notes-trash-cleanup ticker 全 kind 扫描）。
// sync：笔记不随实例同步（notes/notes-multi 单元退役，旧对端回流落地拒收，
// 跨实例全局库车道明示放弃——见 server/api/sync/model.go retired 注记）。

// notesManualOrder 手册分节顺序：紧跟文件读写（12）之后——读笔记常是 agent
// 接手项目的第一步（单库化前 projnotes 节的同一位次）
const notesManualOrder = 14

// globalNotesScope 全局库作用域：固定保留哨兵，零请求侧参数（:id 维度不存在
// ——笔记库与项目无挂靠）
func globalNotesScope(c *gin.Context) (notesScope, bool) {
	_ = c
	return notesScope{key: store.GlobalNotesScope, label: store.GlobalNotesScope}, true
}

// ListGlobalNotes    GET /api/notes[?trash=1]
func ListGlobalNotes(c *gin.Context) { notesList(c, globalNotesScope) }

// CreateGlobalNote   POST /api/notes
func CreateGlobalNote(c *gin.Context) { notesCreate(c, globalNotesScope) }

// GetGlobalNote      GET /api/notes/:noteId
func GetGlobalNote(c *gin.Context) { notesGet(c, globalNotesScope) }

// PutGlobalNote      PUT /api/notes/:noteId
func PutGlobalNote(c *gin.Context) { notesPut(c, globalNotesScope) }

// DeleteGlobalNote   DELETE /api/notes/:noteId[?purge=1]
func DeleteGlobalNote(c *gin.Context) { notesDelete(c, globalNotesScope) }

// RestoreGlobalNote  POST /api/notes/:noteId/restore
func RestoreGlobalNote(c *gin.Context) { notesRestore(c, globalNotesScope) }

// ExportGlobalNote   GET /api/notes/:noteId/export?format=md|txt
func ExportGlobalNote(c *gin.Context) { notesExport(c, globalNotesScope) }

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "notes-global", Title: "笔记库（人机共享 notepad，项目无关）", Order: notesManualOrder,
		Summary: "唯一笔记库全 CRUD（/api/notes 族）：接手项目先按「[项目名]」标题前缀搜交接篇；任务终态结论沉淀进「[项目名] 交接」单篇（找到即追加、没有才新建）",
		Body: ` - GET    /api/notes                    在册篇清单 [{id,title,updatedAt,size}]
                                                       （updatedAt 降序；绝不内联 content）
- GET    /api/notes?trash=1            回收站视图（软删篇，携 deletedAt/deletedBy）
- POST   /api/notes                    新建一篇 {"title"?,"content"?} → 201 {data:{id,...}}
                                                       （id 服务端生成；≤100 篇含回收站，
                                                        超限 notes.global_limit）
- GET    /api/notes/:noteId            读单篇 {data:{id,title,content,createdAt,updatedAt,...}}
- PUT    /api/notes/:noteId            保存 {"content","title"?,"baseUpdatedAt"?} → {data:note}
                                                       title 携带即重命名；noteId=default 不存在时
                                                       upsert 落真身；baseUpdatedAt 过期
                                                       409 {"code":"notes.conflict","currentContent",
                                                       "currentUpdatedAt"}——先读现状再决策
- DELETE /api/notes/:noteId            软删进回收站（30 天内可恢复；幂等）
- POST   /api/notes/:noteId/restore    回收站恢复（幂等——重试安全）
- GET    /api/notes/:noteId/export?format=md|txt  单篇导出（md 缺省）
- GET    /api/notes/migration          单库化迁移滞留计数 {data:{pending,full}}（只读）
- POST   /api/notes/migration          续迁：把仍滞留的旧项目笔记并入本库
                                                       → {data:{migrated,pending,full}}（满额即停）

## 单库约定（P-20261108-3）

笔记只有这一个库，不挂任何项目（旧端点 /api/projects/:id/notes 与
/api/projects/:id/notes-multi 已退役 404；/api/meta 能力项只剩 notes-global）。
项目归属靠标题前缀「[项目名] 」表达：
- **接手项目**：先 GET /api/notes，按标题前缀「[<项目名>]」筛出该项目的篇（交接篇、
  旧项目笔记迁移篇都带此前缀），逐篇 GET 读里面的交接说明/待办/决策记录。项目名
  取 GET /api/projects/$CC_PROJECT_ID 的 name（项目绑定会话注入 CC_PROJECT_ID）。
- **写回**：阶段性结论/交接说明一律写进「[<项目名>] 交接」这**一篇**——找到就追加，
  没有才新建；不要每个任务新建一篇（100 篇上限会被任务数吃满）。随手记/通用备忘
  不必带前缀。
- 并发为后写覆盖：写前先读、写整份内容，携 baseUpdatedAt 防覆盖（409 = 期间被
  人或别的会话改过，重读再追加，勿盲目重试覆盖）。
- 不随实例同步：多实例同步（sync）的 notes/notes-multi 单元已退役，笔记只留在
  本实例；跨实例需要时导出（export）后人工搬运。

## 结论沉淀约定（任务终态写回，P-20261003-292）

任务到达终态（task.progress 上报 done/failed）时，把结论沉淀进「[<项目名>] 交接」
篇——结论只留在终端 scrollback 里，下次会话/别的设备就得靠人重新总结。三步：

1. GET /api/notes 按标题找交接篇（没有则下一步直接 POST 新建，首节即正文）
2. 找到则 GET 单篇读现文，markdown 末尾追加一节：标题「## <日期> <任务简称>」，
   结论 3~5 行——结果（done/failed）、做了什么、关键决定、遗留项。保持极简防刷屏
3. PUT 整份写回（原文 + 新节一起写，携 baseUpdatedAt；不要只写新节）

示例（找到即追加、没有才新建）：
` + "```bash" + `
name=$(curl -s {{BASE}}/api/projects/$CC_PROJECT_ID -H "X-Lock-Token: $CC_LOCK_TOKEN" | jq -r .data.name)
title="[$name] 交接"
nid=$(curl -s {{BASE}}/api/notes -H "X-Lock-Token: $CC_LOCK_TOKEN" \
  | jq -r --arg t "$title" '[.data[] | select(.title==$t)][0].id // empty')
section="## $(date +%F) 重构登录模块

- 结果：done
- 做了什么：拆分 auth 中间件，错误码迁移 files.*
- 关键决定：旧 Error 形态增量兼容，既有 status 一律不变
- 遗留项：其余域渐进迁移"
if [ -z "$nid" ]; then
  curl -s -X POST {{BASE}}/api/notes -H "Content-Type: application/json" -H "X-Lock-Token: $CC_LOCK_TOKEN" \
    -d "$(jq -n --arg t "$title" --arg c "$section" '{title:$t,content:$c}')"
else
  cur=$(curl -s {{BASE}}/api/notes/$nid -H "X-Lock-Token: $CC_LOCK_TOKEN")
  next="$(echo "$cur" | jq -r .data.content)

$section"
  curl -s -X PUT {{BASE}}/api/notes/$nid -H "Content-Type: application/json" -H "X-Lock-Token: $CC_LOCK_TOKEN" \
    -d "$(jq -n --arg c "$next" --arg b "$(echo "$cur" | jq -r .data.updatedAt)" '{content:$c,baseUpdatedAt:$b}')"
fi
` + "```" + `

前端助力：任务终态后悬浮球/条与管理页头部出现「沉淀到笔记」按钮——agent 忘了
约定时，人一键把预填模板追加进同一篇「[项目名] 交接」，再在笔记视图编辑补充
（防抖自动保存）。会话启动上下文勾「笔记」时，注入的也是本库「[项目名]」前缀篇
（最近更新那篇）的首段。

## 存量迁移（P-20261108-3）

升级后启动期自动把旧项目笔记（含旧单篇便签与项目回收站篇）并入本库，标题加
「[项目名] 」前缀、内容逐字保留；本库满 100 篇时**中止**（不丢弃、不挤占回收站），
GET /api/notes/migration 的 pending 为滞留篇数——腾出空间（彻底删除回收站篇）后
POST /api/notes/migration 续迁，或等下次启动自动续迁。项目删除不再连带删除笔记。`,
	})
}
