package tools

// 外部 dsh 目标管理（跨机场景）——原 dsh.go 同名节整体平移（P-20261003-314
// 纯搬运拆分，逻辑零改动）。目标寻址/回退语义（baseForTarget 等）在 dsh.go。

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// newTargetID 随机 hex 目标键
func newTargetID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// DshTargetsList GET /api/tools/dsh/targets
func DshTargetsList(c *gin.Context) {
	cfg := readConfig()
	c.JSON(http.StatusOK, gin.H{"data": cfg.Targets})
}

type dshTargetReq struct {
	Name  string `json:"name"`
	Base  string `json:"base"`
	Token string `json:"token"`
}

// saveTarget 校验并落一个目标（Create 全新追加 / Update 按 ID 覆盖）
func saveTarget(c *gin.Context, id string) {
	var req dshTargetReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Invalid dsh target", err)
		return
	}
	name := strings.TrimSpace(req.Name)
	base := normalizeDshBase(req.Base)
	if name == "" {
		shared.Error(c, http.StatusBadRequest, "Invalid dsh target", fmt.Errorf("name is required"))
		return
	}
	if u, err := url.Parse(base); err != nil || u.Host == "" ||
		(u.Scheme != "http" && u.Scheme != "https") {
		shared.Error(c, http.StatusBadRequest, "Invalid dsh target",
			fmt.Errorf("base must be a http(s) URL with host, got %q", req.Base))
		return
	}
	sc := store.Get().Settings.Get()
	if sc == nil {
		shared.Error(c, http.StatusInternalServerError, "Settings unavailable", fmt.Errorf("settings not loaded"))
		return
	}
	if id == "" {
		t := config.DshTarget{ID: newTargetID(), Name: name, Base: base, Token: strings.TrimSpace(req.Token)}
		sc.Server.DshTargets = append(sc.Server.DshTargets, t)
		if err := store.Get().Settings.Save(); err != nil {
			shared.Error(c, http.StatusInternalServerError, "Save dsh target failed", err)
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": t})
		return
	}
	found := false
	for i := range sc.Server.DshTargets {
		if sc.Server.DshTargets[i].ID == id {
			sc.Server.DshTargets[i].Name = name
			sc.Server.DshTargets[i].Base = base
			sc.Server.DshTargets[i].Token = strings.TrimSpace(req.Token)
			found = true
			break
		}
	}
	if !found {
		shared.Error(c, http.StatusNotFound, "dsh target not found", fmt.Errorf("id %q", id))
		return
	}
	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Save dsh target failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": id}})
}

// DshTargetCreate POST /api/tools/dsh/targets
func DshTargetCreate(c *gin.Context) {
	saveTarget(c, "")
}

// DshTargetUpdate PUT /api/tools/dsh/targets/:id
func DshTargetUpdate(c *gin.Context) {
	saveTarget(c, c.Param("id"))
}

// DshTargetDelete DELETE /api/tools/dsh/targets/:id
// 删除后残留的 cookie/URL 自动回落本机目标（baseForTarget 的未知 ID 回退语义）
func DshTargetDelete(c *gin.Context) {
	id := c.Param("id")
	sc := store.Get().Settings.Get()
	if sc == nil {
		shared.Error(c, http.StatusInternalServerError, "Settings unavailable", fmt.Errorf("settings not loaded"))
		return
	}
	kept := make([]config.DshTarget, 0, len(sc.Server.DshTargets))
	removed := false
	for _, t := range sc.Server.DshTargets {
		if t.ID == id {
			removed = true
			continue
		}
		kept = append(kept, t)
	}
	if !removed {
		shared.Error(c, http.StatusNotFound, "dsh target not found", fmt.Errorf("id %q", id))
		return
	}
	sc.Server.DshTargets = kept
	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Save dsh target failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"id": id}})
}
