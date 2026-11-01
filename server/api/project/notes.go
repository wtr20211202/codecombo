package project

import (
	"errors"
	"log/slog"
	"net/http"

	"codecombo/server/agentops"
	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 项目笔记（P-20261002-110，人机共享便签层）──
//
// 项目一文档的 markdown 便签：人经侧栏「笔记」面板编辑（防抖自动保存），
// agent 经 ops 手册登记的本组端点读写同一份——人写的交接说明 agent 会话
// 启动时可读，agent 的阶段性结论可写回，形成项目级人机共享记忆。
// 并发策略：last-writer-wins（整文档替换写，无读改写交错面；存储层同 kind
// 串行 + 原子改名保证最终内容必为某一方的完整版本）。

// notesBodyMaxBytes 请求体粗上限：JSON 转义最坏 6×/字节（\u00XX），给足
// 合法载荷余量；精确 256KB 上限由仓储层按解码后内容判定（413 语义一致）
const notesBodyMaxBytes = 4 << 20

// notesManualOrder 手册分节顺序：紧跟文件读写（12）之后——读笔记常是
// agent 接手项目的第一步
const notesManualOrder = 14

// GetProjectNotes GET /api/projects/:id/notes：读取项目笔记。
// 从未写过时返回空内容（便签语义：空即无，不 404 打扰面板首开）
func GetProjectNotes(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	n, err := store.Get().ProjectNotes.Get(p.ID)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusInternalServerError, "failed to load notes", err)
			return
		}
		// 空笔记：不带 updatedAt（零值时间戳对消费方是噪声）
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"content": ""}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": n})
}

// PutProjectNotes PUT /api/projects/:id/notes：全量覆盖写入项目笔记。
// 内容超 256KB 上限返回 413（与文件写超限同语义）
func PutProjectNotes(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}
	shared.LimitBody(c, notesBodyMaxBytes)

	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		if shared.BodyTooLarge(err) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "Notes too large",
				errors.New("notes content exceeds 256KB limit"))
			return
		}
		shared.Error(c, http.StatusBadRequest, "invalid request body", err)
		return
	}

	if err := store.Get().ProjectNotes.Put(p.ID, req.Content); err != nil {
		if errors.Is(err, store.ErrNotesTooLarge) {
			shared.Error(c, http.StatusRequestEntityTooLarge, "Notes too large",
				errors.New("notes content exceeds 256KB limit"))
			return
		}
		shared.Error(c, http.StatusInternalServerError, "failed to save notes", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "notes saved"})
}

// DeleteProjectNotes 删除项目笔记（项目删除的级联清理，尽力而为不阻断）
func DeleteProjectNotes(projectID string) {
	if err := store.Get().ProjectNotes.Delete(projectID); err != nil {
		slog.Warn("project notes cascade cleanup failed", "projectId", projectID, "err", err)
	}
}

func init() {
	agentops.RegisterSection(agentops.Section{
		ID: "projnotes", Title: "项目笔记（人机共享便签）", Order: notesManualOrder,
		Summary: "项目级共享便签（markdown，≤256KB）：接手项目先读笔记里的交接说明；阶段性结论/交接说明写回给人和下一轮 agent",
		Body: ` - GET /api/projects/:id/notes          读项目笔记 {"content","updatedAt"}（没写过返回空内容）
- PUT  /api/projects/:id/notes          全量覆盖写 {"content"}（markdown 文本，UTF-8 ≤256KB，超限 413）

约定：开始一个项目任务前先 GET 一次——里面的「交接说明/待办/决策记录」是人和
上一轮 agent 留给你的上下文；做完阶段性工作（或用户明确要求记录）时 PUT 写回
结构化摘要（做了什么/改动点/遗留与风险）。并发为后写覆盖（last-writer-wins）：
写前先读、写整份内容，不要拼增量。

## 结论沉淀约定（任务终态写回，P-20261003-292）

任务到达终态（task.progress 上报 done/failed）时，把结论沉淀进项目笔记——
结论只留在终端 scrollback 里，下次会话/别的设备就得靠人重新总结。三步：

1. GET 读现笔记（写前先读；last-writer-wins，写整份内容）
2. markdown 追加一节：标题「## <日期> <任务简称>」，结论 3~5 行——
   结果（done/failed）、做了什么、关键决定、遗留项。保持极简防刷屏
3. PUT 整份写回（把原文 + 新节一起写，不要只写新节）

示例（追加一节并写回）：
` + "```bash" + `
cur=$(curl -s {{BASE}}/api/projects/$id/notes -H "X-Lock-Token: $CC_LOCK_TOKEN" | jq -r .data.content)
next="${cur}
## $(date +%F) 重构登录模块

- 结果：done
- 做了什么：拆分 auth 中间件，错误码迁移 files.*
- 关键决定：旧 Error 形态增量兼容，既有 status 一律不变
- 遗留项：其余域渐进迁移"
curl -X PUT {{BASE}}/api/projects/$id/notes -H "Content-Type: application/json" \
  -H "X-Lock-Token: $CC_LOCK_TOKEN" -d "$(jq -n --arg c "$next" '{content:$c}')"
` + "```" + `

前端助力：任务终态后悬浮球/条与管理页头部出现「沉淀到笔记」按钮——agent 忘了
约定时，人一键把预填模板写进笔记，再在笔记面板编辑补充（防抖自动保存）。`,
	})
}
