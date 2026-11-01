package whatsnew

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"codecombo/server/agentops"

	"github.com/gin-gonic/gin"
)

// 切分：文档头不入段 / semver 标题剥 v / 非 semver 标题版本号空串 / 段体含
// 空行与 ### 子标题 / 段落顺序保持文档书写序（新版本在前）
func TestParseSections(t *testing.T) {
	md := `# What's New

前置说明不属于任何段落。

## v0.0.2 智能体协作增强

- 审批卡批量放行
- 会话接续链

### 实验特性

- 对比实验

## 0.0.1 首个版本

- 终端工作台
`
	got := ParseSections(md)
	want := []Section{
		{Version: "0.0.2", Title: "智能体协作增强", Body: "- 审批卡批量放行\n- 会话接续链\n\n### 实验特性\n\n- 对比实验"},
		{Version: "0.0.1", Title: "首个版本", Body: "- 终端工作台"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ParseSections mismatch:\n got %#v\nwant %#v", got, want)
	}
}

// 非 semver 标题（日期/纯文字）：版本号空串、整行为标题；无 ## 段返回空切片
func TestParseSectionsEdgeCases(t *testing.T) {
	got := ParseSections("## 2026-10 秋季批次\n- 要点\n")
	if len(got) != 1 || got[0].Version != "" || got[0].Title != "2026-10 秋季批次" {
		t.Fatalf("non-semver heading: %#v", got)
	}
	if got := ParseSections("# 只有文档头\n正文\n"); got == nil || len(got) != 0 {
		t.Fatalf("no-section doc: want empty non-nil, got %#v", got)
	}
}

// CRLF 行尾（Windows 检出 / 构建机 autocrlf）：\r 不残留进 Version/Title/Body
func TestParseSectionsCRLF(t *testing.T) {
	got := ParseSections("## v1.2.3 标题\r\n- 要点一\r\n- 要点二\r\n")
	if len(got) != 1 {
		t.Fatalf("sections = %d, want 1", len(got))
	}
	s := got[0]
	if s.Version != "1.2.3" || s.Title != "标题" || s.Body != "- 要点一\n- 要点二" {
		t.Fatalf("CRLF residue: %#v", s)
	}
}

// SetContent 后端点返回全文 + buildVersion + 段落；空内容时 sections 为 []
// （非 null——前端 []WhatsNewSection 直读不炸，同 metaCapabilities 惯例）
func TestHandleWhatsNew(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/whats-new", HandleWhatsNew)

	SetContent("## v0.0.2 新功能\n- 要点\n")
	defer SetContent("")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/whats-new", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("code = %d", w.Code)
	}
	var body struct {
		Data struct {
			Version  string    `json:"version"`
			Content  string    `json:"content"`
			Sections []Section `json:"sections"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if body.Data.Content == "" {
		t.Fatal("content empty")
	}
	if len(body.Data.Sections) != 1 || body.Data.Sections[0].Version != "0.0.2" {
		t.Fatalf("sections: %#v", body.Data.Sections)
	}
	if body.Data.Version == "" {
		t.Fatal("buildVersion empty（SetBuildInfo 未注入的测试环境也应有 dev 兜底）")
	}

	SetContent("")
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/whats-new", nil))
	body.Data.Sections = nil
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal empty: %v", err)
	}
	if body.Data.Sections == nil || len(body.Data.Sections) != 0 {
		t.Fatalf("empty content sections: want [] non-nil, got %#v", body.Data.Sections)
	}
}

// agentops 手册分节注册：智能体经 SKILL.md/手册可发现版本内容接口
func TestWhatsNewSectionRegistered(t *testing.T) {
	for _, s := range agentops.Sections() {
		if s.ID == "whatsnew" {
			return
		}
	}
	t.Fatal("whatsnew section not registered in agentops manual")
}
