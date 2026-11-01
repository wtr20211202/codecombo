package help

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"codecombo/server/agentops"
	"codecombo/server/api/whatsnew"

	"github.com/gin-gonic/gin"
)

// Get：200 + 分类与问答非空 + 每条 entry 的 category 必须在分类表中
// （内容为手写数据，防分类 ID 手滑写错导致前端整组消失）
func TestGetHelp(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/help", Get)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/help", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var body struct {
		Data struct {
			Categories []Category `json:"categories"`
			Entries    []Entry    `json:"entries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(body.Data.Categories) == 0 || len(body.Data.Entries) == 0 {
		t.Fatalf("empty content: %d categories, %d entries", len(body.Data.Categories), len(body.Data.Entries))
	}
	ids := map[string]bool{}
	for _, c := range body.Data.Categories {
		ids[c.ID] = true
	}
	for _, e := range body.Data.Entries {
		if !ids[e.Category] {
			t.Errorf("entry %q has unknown category %q", e.ID, e.Category)
		}
		if e.Q == "" || e.A == "" {
			t.Errorf("entry %q has empty q/a", e.ID)
		}
	}
}

// agentops 手册分节注册：智能体经 SKILL.md/手册可发现帮助查询接口
func TestHelpSectionRegistered(t *testing.T) {
	for _, s := range agentops.Sections() {
		if s.ID == "help" {
			return
		}
	}
	t.Fatal("help section not registered in agentops manual")
}

// NewSessionDialog 安装指引链接（HELP_RUNTIME_ENTRY）锚定本条目——前端
// sc-open-help 深链契约，条目被删/改名会让指引链接滚动定位静默落空
func TestRuntimeInstallGuideEntryExists(t *testing.T) {
	for _, e := range entries {
		if e.ID == "agent-runtime-install" {
			return
		}
	}
	t.Fatal("help entry \"agent-runtime-install\" missing: NewSessionDialog install guide anchors to it")
}

// 「更新内容」动态节（P-20261007-17）：whatsnew 内容注入后 Get 响应并入
// whatsnew 分类与条目（历史版本可回看）；未注入（缺文档）不出现空壳节。
// WhatsNewPopup「查看历史」经 openHelpEntry("whats-new") 锚定本条目——深链契约
func TestGetHelpMergesWhatsNew(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/help", Get)

	whatsnew.SetContent("## v0.0.2 新功能\n- 要点\n")
	defer whatsnew.SetContent("")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/help", nil))
	var body struct {
		Data struct {
			Categories []Category `json:"categories"`
			Entries    []Entry    `json:"entries"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	hasCat, hasEntry := false, false
	for _, c := range body.Data.Categories {
		if c.ID == "whatsnew" {
			hasCat = true
		}
	}
	for _, e := range body.Data.Entries {
		if e.ID == "whats-new" && strings.Contains(e.A, "v0.0.2") {
			hasEntry = true
		}
	}
	if !hasCat || !hasEntry {
		t.Fatalf("whatsnew section missing after SetContent: cat=%v entry=%v", hasCat, hasEntry)
	}

	whatsnew.SetContent("")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/help", nil))
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	for _, c := range body.Data.Categories {
		if c.ID == "whatsnew" {
			t.Fatal("whatsnew category present without content（缺文档应缺节）")
		}
	}
}
