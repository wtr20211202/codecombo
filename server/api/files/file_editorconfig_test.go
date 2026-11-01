package files

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// file-policy 端点的 .editorconfig 随行下发（P-20261003-95）：项目根存在
// .editorconfig 时响应增量带 editorconfig 字段（该文件生效缩进约定），无配置
// 时无该键（前端回落全局设置零变化）。解析/匹配细节的单测在 filepolicy 包，
// 此处只锚定 handler 响应契约（键有无与生效值形态）
func TestGetFilePolicyEditorConfig(t *testing.T) {
	setup := func(t *testing.T) (*gin.Engine, string) {
		t.Helper()
		r, projPath := setupFileOpsTest(t)
		g := r.Group("/api/projects/:id")
		g.GET("/file-policy", GetFilePolicy)
		return r, projPath
	}

	policyBody := func(t *testing.T, r *gin.Engine, path string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/projects/proj-test/file-policy?path="+path, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("bad json: %v", err)
		}
		return body
	}

	t.Run("无配置无该键", func(t *testing.T) {
		r, projPath := setup(t)
		if err := os.WriteFile(filepath.Join(projPath, "a.txt"), []byte("x"), 0644); err != nil {
			t.Fatal(err)
		}
		if _, has := policyBody(t, r, "a.txt")["editorconfig"]; has {
			t.Fatalf("无 .editorconfig 响应不应带 editorconfig 键")
		}
	})

	t.Run("有配置随行生效值", func(t *testing.T) {
		r, projPath := setup(t)
		if err := os.WriteFile(filepath.Join(projPath, ".editorconfig"),
			[]byte("root = true\n[*]\nindent_style = space\nindent_size = 2\n[*.go]\nindent_style = tab\ntab_width = 8\n"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(projPath, "pkg"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(projPath, filepath.Join("pkg", "main.go")), []byte("package main\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(projPath, "app.js"), []byte("const a = 1\n"), 0644); err != nil {
			t.Fatal(err)
		}
		// [*.go] 后置节覆盖 [*]：tab/8
		ec, _ := policyBody(t, r, "pkg%2Fmain.go")["editorconfig"].(map[string]any)
		if ec["indentStyle"] != "tab" || ec["tabWidth"] != float64(8) {
			t.Fatalf("main.go editorconfig = %v, want tab/8", ec)
		}
		// 仅命中 [*]：space/2
		ec, _ = policyBody(t, r, "app.js")["editorconfig"].(map[string]any)
		if ec["indentStyle"] != "space" || ec["indentSize"] != float64(2) {
			t.Fatalf("app.js editorconfig = %v, want space/2", ec)
		}
	})
}
