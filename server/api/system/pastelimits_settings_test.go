package system

// 粘贴上传限额设置 API（P-20261123-6）：GET 生效值+spec、PUT 叶子级增量语义
//（省略=不动、显式 0=恢复默认落盘 0、非零范围校验）、非法 400 可读文案。
// 复用既有 settings 测试基建（setupApprovalRulesRouter/doSettingReq——两者
// 均为 settings 路由 + 临时 doc store 装配，t.Cleanup 复位见 helper 内部）。
import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type pasteLimitsShape struct {
	Data struct {
		PasteLimits struct {
			Owner struct {
				FileMB  int `json:"fileMB"`
				ImageMB int `json:"imageMB"`
				BodyMB  int `json:"bodyMB"`
			} `json:"owner"`
			Share struct {
				FileMB int `json:"fileMB"`
			} `json:"share"`
			Remote struct {
				FileMB int `json:"fileMB"`
			} `json:"remote"`
		} `json:"pasteLimits"`
		PasteLimitsSpec struct {
			Defaults struct {
				Owner struct {
					FileMB int `json:"fileMB"`
				} `json:"owner"`
			} `json:"defaults"`
			Ranges struct {
				Owner struct {
					FileMin int `json:"fileMin"`
					FileMax int `json:"fileMax"`
				} `json:"owner"`
				Share struct {
					FileMax int `json:"fileMax"`
				} `json:"share"`
			} `json:"ranges"`
		} `json:"pasteLimitsSpec"`
	} `json:"data"`
}

func readPasteLimits(t *testing.T, r *gin.Engine) pasteLimitsShape {
	t.Helper()
	w := doSettingReq(t, r, http.MethodGet, "/api/settings", "")
	var got pasteLimitsShape
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestPasteLimitsSettings(t *testing.T) {
	r := setupApprovalRulesRouter(t)

	// 默认：GET 生效值=owner 100/20（body 104）、share/remote 20；spec 下发
	// 默认值与范围（设置页不抄范围）
	got := readPasteLimits(t, r)
	if got.Data.PasteLimits.Owner.FileMB != 100 || got.Data.PasteLimits.Owner.ImageMB != 20 {
		t.Fatalf("default owner = %+v, want 100/20", got.Data.PasteLimits.Owner)
	}
	if got.Data.PasteLimits.Owner.BodyMB != 104 {
		t.Fatalf("default owner bodyMB = %d, want 104", got.Data.PasteLimits.Owner.BodyMB)
	}
	if got.Data.PasteLimits.Share.FileMB != 20 || got.Data.PasteLimits.Remote.FileMB != 20 {
		t.Fatalf("default share/remote file = %d/%d, want 20/20", got.Data.PasteLimits.Share.FileMB, got.Data.PasteLimits.Remote.FileMB)
	}
	if got.Data.PasteLimitsSpec.Defaults.Owner.FileMB != 100 {
		t.Fatalf("spec defaults.owner.fileMB = %d, want 100", got.Data.PasteLimitsSpec.Defaults.Owner.FileMB)
	}
	if got.Data.PasteLimitsSpec.Ranges.Owner.FileMax != 512 || got.Data.PasteLimitsSpec.Ranges.Share.FileMax != 20 {
		t.Fatalf("spec ranges wrong: %+v", got.Data.PasteLimitsSpec.Ranges)
	}

	// PUT 叶子级增量：只改 owner.fileMB，share/remote 不动且落盘载荷不含它们
	w := doSettingReq(t, r, http.MethodPut, "/api/settings", `{"pasteLimits":{"owner":{"fileMB":200}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT owner.fileMB=200 status=%d body=%s", w.Code, w.Body.String())
	}
	got = readPasteLimits(t, r)
	if got.Data.PasteLimits.Owner.FileMB != 200 {
		t.Fatalf("owner.fileMB after PUT = %d, want 200", got.Data.PasteLimits.Owner.FileMB)
	}
	if got.Data.PasteLimits.Share.FileMB != 20 || got.Data.PasteLimits.Remote.FileMB != 20 {
		t.Fatalf("share/remote should be untouched, got %d/%d", got.Data.PasteLimits.Share.FileMB, got.Data.PasteLimits.Remote.FileMB)
	}
	// 生效 body 随 file 联动（+4MB）
	if got.Data.PasteLimits.Owner.BodyMB != 204 {
		t.Fatalf("owner bodyMB after raise = %d, want 204", got.Data.PasteLimits.Owner.BodyMB)
	}

	// 显式 0 = 恢复默认（落盘 0，GET 回默认 100——证明不是写死数字）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"pasteLimits":{"owner":{"fileMB":0}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT owner.fileMB=0 status=%d", w.Code)
	}
	got = readPasteLimits(t, r)
	if got.Data.PasteLimits.Owner.FileMB != 100 {
		t.Fatalf("owner.fileMB after reset = %d, want default 100", got.Data.PasteLimits.Owner.FileMB)
	}

	// 非法值 400 + 可读文案（含端名/叶子名/范围/重置提示）
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"pasteLimits":{"owner":{"fileMB":600}}}`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("PUT owner.fileMB=600 status=%d, want 400", w.Code)
	}
	if !strings.Contains(w.Body.String(), "pasteLimits.owner.fileMB out of range (1-512 or 0 to reset)") {
		t.Fatalf("readable error expected, body=%s", w.Body.String())
	}
	// share/remote 上调拒绝（上限=默认，只允许下调）
	for _, bad := range []string{`{"pasteLimits":{"share":{"fileMB":50}}}`, `{"pasteLimits":{"remote":{"fileMB":100}}}`} {
		w = doSettingReq(t, r, http.MethodPut, "/api/settings", bad)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("raise share/remote should 400, got %d for %s", w.Code, bad)
		}
	}
	// share 下调合法
	w = doSettingReq(t, r, http.MethodPut, "/api/settings", `{"pasteLimits":{"share":{"fileMB":5}}}`)
	if w.Code != http.StatusOK {
		t.Fatalf("PUT share.fileMB=5 status=%d", w.Code)
	}
	got = readPasteLimits(t, r)
	if got.Data.PasteLimits.Share.FileMB != 5 {
		t.Fatalf("share.fileMB after lower = %d, want 5", got.Data.PasteLimits.Share.FileMB)
	}

}
