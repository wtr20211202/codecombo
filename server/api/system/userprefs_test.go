package system

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	filestore "codecombo/server/filestore"
	"codecombo/server/store"
)

// 用户偏好漫游单键（P-20261007-1）settings 面测试：PUT 全量替换 + 超限 400 +
// 省略语义（其他字段保存不清掉 userPrefs）+ GET 回读（null/对象两态）+
// 显式 null 清空回「未配置」形态 + 落盘回路（新 store 实例重读同目录 = 跨重启形态）

func TestUpdateSettings_UserPrefs(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 未配置时 GET 出参 = null（前端播种分支的判定依据）
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UserPrefs *json.RawMessage `json:"userPrefs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UserPrefs != nil {
		t.Fatalf("fresh server userPrefs = %s, want null", *got.Data.UserPrefs)
	}

	// 保存稀疏偏差集 + GET 回读
	body := `{"userPrefs":{"keymap":{"quickOpen":"ctrl+alt+p"},"notify":{"sound":false}}}`
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", body)
	if w.Code != http.StatusOK {
		t.Fatalf("save userPrefs status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UserPrefs == nil {
		t.Fatal("userPrefs lost after PUT")
	}
	if !strings.Contains(string(*got.Data.UserPrefs), `"quickOpen":"ctrl+alt+p"`) {
		t.Fatalf("userPrefs = %s, want keymap override preserved", *got.Data.UserPrefs)
	}
}

// 省略语义：PUT 其他设置字段（不带 userPrefs）不清掉已存漫游偏好——设置页
// 整体提交不携带该字段，天然不被全量保存清掉
func TestUpdateSettings_UserPrefsOmitIsolation(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"userPrefs":{"notify":{"simple":true}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("seed status = %d", w.Code)
	}
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"autoFetch":true,"terminalTheme":"dracula"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("unrelated save status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UserPrefs *json.RawMessage `json:"userPrefs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UserPrefs == nil || !strings.Contains(string(*got.Data.UserPrefs), `"simple":true`) {
		t.Fatalf("userPrefs clobbered by unrelated save: %v", got.Data.UserPrefs)
	}
}

// 显式 {} = 清空全部漫游偏好（全量替换语义：省略=不动，空对象=清空）。
// 注意与下面的 null 区分：{} 是「服务端真值为空偏差集」（GET 回 {}），
// null 才是恢复「从未配置」形态（GET 回 null，前端走播种分支）
func TestUpdateSettings_UserPrefsClear(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"userPrefs":{"keymap":{"closeTab":"ctrl+alt+x"}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("seed status = %d", w.Code)
	}
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"userPrefs":{}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d", w.Code)
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UserPrefs *json.RawMessage `json:"userPrefs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UserPrefs == nil || string(*got.Data.UserPrefs) != "{}" {
		t.Fatalf("userPrefs after clear = %v, want {}", got.Data.UserPrefs)
	}
}

// 显式 null = 恢复「服务端从未配置」形态：GET 回 null（前端播种分支）/落盘
// 省略该键（存量配置形态）——agent 复位与 e2e 数据面隔离依赖此语义
func TestUpdateSettings_UserPrefsClearToNull(t *testing.T) {
	dir := t.TempDir()
	gin.SetMode(gin.TestMode)
	store.SetDefault(store.New(filestore.New(dir)))
	t.Cleanup(func() { store.SetDefault(nil) })
	r := gin.New()
	r.GET("/api/settings", GetSettings)
	r.PUT("/api/settings", UpdateSettings)

	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"userPrefs":{"notify":{"simple":true}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("seed status = %d", w.Code)
	}
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"userPrefs":null}`)
	if w.Code != http.StatusOK {
		t.Fatalf("clear status = %d, body=%s", w.Code, w.Body.String())
	}
	w = doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UserPrefs *json.RawMessage `json:"userPrefs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UserPrefs != nil {
		t.Fatalf("userPrefs after null clear = %s, want null", *got.Data.UserPrefs)
	}
	// 落盘省略键（存量配置形态）
	raw, err := os.ReadFile(filepath.Join(dir, "data", "config", "default.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"userPrefs"`) {
		t.Fatalf("config document should omit userPrefs after clear: %s", raw)
	}
}

// 超限 400（64KB 封顶，防误写超大对象撑爆 config.json）
func TestUpdateSettings_UserPrefsTooLarge(t *testing.T) {
	r := setupApprovalRulesRouter(t)
	big := `{"userPrefs":{"pad":"` + strings.Repeat("a", 64*1024) + `"}}`
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", big)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("oversize userPrefs status = %d, want 400", w.Code)
	}
}

// 落盘回路：PUT 后同目录重建 store 实例（= 重启后 config.json 重读的升级形态），
// userPrefs 原样往返；再叠加「旧数据面」形态——无 userPrefs 的存量 config 不受影响
func TestUpdateSettings_UserPrefsDiskRoundTrip(t *testing.T) {
	dir := t.TempDir()
	gin.SetMode(gin.TestMode)

	buildRouter := func() *gin.Engine {
		store.SetDefault(store.New(filestore.New(dir)))
		r := gin.New()
		r.GET("/api/settings", GetSettings)
		r.PUT("/api/settings", UpdateSettings)
		return r
	}

	r1 := buildRouter()
	t.Cleanup(func() { store.SetDefault(nil) })
	w := doSettingReq(t, r1, http.MethodPut, "/api/settings", `{"userPrefs":{"terminal":{"copyOnSelect":false}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("save status = %d, body=%s", w.Code, w.Body.String())
	}

	// 新实例重读同目录（重启形态）
	r2 := buildRouter()
	w = doSettingReq(t, r2, http.MethodGet, "/api/settings", "")
	var got struct {
		Data struct {
			UserPrefs *json.RawMessage `json:"userPrefs"`
		} `json:"data"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.UserPrefs == nil || !strings.Contains(string(*got.Data.UserPrefs), `"copyOnSelect":false`) {
		t.Fatalf("userPrefs lost across restart: %v", got.Data.UserPrefs)
	}
}
