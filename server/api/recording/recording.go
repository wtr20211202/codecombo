package recordingapi

import (
	"net/http"
	"os"
	"strconv"

	"codecombo/server/api/shared"
	"codecombo/server/recording"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 审批窗口过程实况录制 API（P-20261001-15） ==============
// 元数据索引与 cast 回放源：GET /api/recordings（列表，供审批历史/录制记录）、
// GET /api/recordings/:id、GET /api/recordings/:id/cast（asciinema v2 文本，
// 写盘前已遮蔽，前端回放层兜底二次遮蔽）、DELETE /api/recordings/:id。
// 只读为主 + 显式删除（隐私：录制含屏幕实况，用户可随时清除单条）。

// ListRecordings GET /api/recordings?limit=100&sessionId=&approvalId=
func ListRecordings(c *gin.Context) {
	list, err := store.Get().Recording.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "recordings list failed", err)
		return
	}
	sessionID := c.Query("sessionId")
	approvalID := c.Query("approvalId")
	filtered := make([]store.Recording, 0, len(list))
	for _, rec := range list {
		if sessionID != "" && rec.SessionID != sessionID {
			continue
		}
		if approvalID != "" && !containsID(rec.ApprovalIDs, approvalID) {
			continue
		}
		filtered = append(filtered, rec)
	}
	limit := 100
	if v, err := strconv.Atoi(c.Query("limit")); err == nil && v > 0 && v <= 500 {
		limit = v
	}
	if len(filtered) > limit {
		filtered = filtered[:limit]
	}
	c.JSON(http.StatusOK, gin.H{"data": filtered})
}

// GetRecording GET /api/recordings/:id
func GetRecording(c *gin.Context) {
	rec, err := store.Get().Recording.Get(c.Param("id"))
	if err != nil || rec == nil {
		shared.Error(c, http.StatusNotFound, "recording not found", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": rec})
}

// GetRecordingCast GET /api/recordings/:id/cast —— cast 文件本体（asciinema v2）
func GetRecordingCast(c *gin.Context) {
	id := c.Param("id")
	if _, err := store.Get().Recording.Get(id); err != nil {
		shared.Error(c, http.StatusNotFound, "recording not found", err)
		return
	}
	b, err := os.ReadFile(recording.CastPath(id))
	if err != nil {
		shared.Error(c, http.StatusNotFound, "recording cast file missing", err)
		return
	}
	c.Data(http.StatusOK, "application/octet-stream", b)
}

// DeleteRecording DELETE /api/recordings/:id —— 元数据 + cast 文件；
// 活动窗口先收尾（删除正在录制的条目 = 立即停录并清除）
func DeleteRecording(c *gin.Context) {
	id := c.Param("id")
	rec, err := store.Get().Recording.Get(id)
	if err != nil || rec == nil {
		shared.Error(c, http.StatusNotFound, "recording not found", err)
		return
	}
	recording.DefaultManager.Finalize(id)
	if err := store.Get().Recording.Delete(id); err != nil {
		shared.Error(c, http.StatusInternalServerError, "recording delete failed", err)
		return
	}
	if err := os.Remove(recording.CastPath(id)); err != nil && !os.IsNotExist(err) {
		shared.Error(c, http.StatusInternalServerError, "recording cast remove failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "recording deleted"})
}

func containsID(ids []string, target string) bool {
	for _, id := range ids {
		if id == target {
			return true
		}
	}
	return false
}
