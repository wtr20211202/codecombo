package system

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// 终端默认 shell（P-20261004-57）settings 面测试：PUT 有效值（完整路径/裸名）
// + 空串清除 + 不存在路径 400 + GET 出参回读（未配置默认空串）

func defaultShellFromSettings(t *testing.T, r *gin.Engine) string {
	t.Helper()
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			Shell string `json:"terminalDefaultShell"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.Data.Shell
}

func TestUpdateSettings_TerminalDefaultShell(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	exe, err := os.Executable()
	if err != nil {
		t.Skipf("os.Executable unavailable: %v", err)
	}

	// 完整路径形态保存 + GET 回读
	w := doSettingReq(t, r, http.MethodPut, "/api/settings",
		`{"terminalDefaultShell":`+jsonQuote(exe)+`}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save path status = %d, body=%s", w.Code, w.Body.String())
	}
	if got := defaultShellFromSettings(t, r); got != exe {
		t.Fatalf("terminalDefaultShell = %q, want %q", got, exe)
	}

	// 裸名形态（git 为本仓库硬依赖，PATH 必含）保存 + 回读
	if _, err := exec.LookPath("git"); err == nil {
		w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"terminalDefaultShell":"git"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("save bare name status = %d", w.Code)
		}
		if got := defaultShellFromSettings(t, r); got != "git" {
			t.Fatalf("bare name readback = %q, want git", got)
		}
	}

	// 空串 = 清除（回落平台缺省序），GET 出参空串
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"terminalDefaultShell":""}`)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w.Code)
	}
	if got := defaultShellFromSettings(t, r); got != "" {
		t.Fatalf("after clear = %q, want empty", got)
	}

	// 不存在的路径/裸名 → 400（校验原文进 publicMsg），且拒绝写入不落盘
	for _, bad := range []string{filepath.Join(t.TempDir(), "no-such-shell"), "no-such-shell-xyz"} {
		w = doSettingReq(t, r, http.MethodPut, "/api/settings",
			`{"terminalDefaultShell":`+jsonQuote(bad)+`}`)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("invalid %q status = %d, want 400", bad, w.Code)
		}
		if got := defaultShellFromSettings(t, r); got != "" {
			t.Fatalf("rejected write leaked = %q, want still empty", got)
		}
	}
}

// 未配置（零值）时 GET 出参空串——存量配置升级零变化
func TestGetSettings_TerminalDefaultShellDefault(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	if got := defaultShellFromSettings(t, r); got != "" {
		t.Fatalf("default terminalDefaultShell = %q, want empty", got)
	}
}

func jsonQuote(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
