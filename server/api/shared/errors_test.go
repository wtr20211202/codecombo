package shared

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// P-20261003-305 门禁：code 与 HTTP status 的绑定是稳定契约——本文件逐字面
// 断言防随重构漂移。改动任何一行绑定，必须同步 ops 手册「错误码对照」分节
// （agentops 对账单测守门）与全部消费方（agent 侧按 code 分支自纠）。

// allConsts 常量表全集（与 const 块逐项对账：新增码漏登记 errCodeStatus 即暴露）。
// 每个常量恰出现一次——重复项只虚增 len 口径，不增任何对账价值（P-319 合并
// 残留曾把 Confirm 三码写重，22 码表对成 25 项，门禁恒红；P-112 修复轮再次
// 出现 Confirm 五码双份的合并残留，按同一不变量去重）
func allConsts() []ErrCode {
	return []ErrCode{
		CodeProjectsNotFound, CodeProjectLocked,
		CodeFilesPathRequired, CodeFilesPayloadInvalid, CodeFilesPayloadTooLarge,
		CodeFilesPathOutsideRoot, CodeFilesNameInvalid, CodeFilesConflict,
		CodeFilesNotFound, CodeFilesFileTooLarge, CodeFilesBinaryNotPreviewable,
		CodeFilesSensitiveConfirmRequired,
		CodeOpsPayloadInvalid, CodeOpsEventTypeInvalid, CodeOpsEventPayloadInvalid,
		CodeOpsPayloadTooLarge,
		CodeOpsApprovalRequired, CodeOpsApprovalDenied, CodeOpsConfirmOpInvalid,
		CodeOpsConfirmFieldTooLong, CodeOpsConfirmImpactInvalid,
		CodeOpsConfirmNotFound, CodeOpsConfirmAlreadyResolved,
		CodeOpsConfirmHorizonInvalid, CodeOpsConfirmStatusInvalid,
		CodeOpsMessagePayloadInvalid, CodeOpsMessageTargetNotFound,
		CodeUIPayloadInvalid, CodeUINoLiveSnapshot,
		CodeRunbookPayloadInvalid, CodeRunbookParamsMissing,
		CodeRunbookBusy, CodeRunbookTargetNotFound,
		CodeFleetTargetsRequired, CodeFleetTargetsTooMany, CodeFleetTargetsNotFound,
		CodeFleetRunNotFound, CodeFleetRunBusy, CodeFleetCellNotRetryable,
		CodeGitIndexLockStale, CodeGitWriteBusy, CodeGitIndexLockFresh,
		CodeGitHunkConflict, CodeGitConflictStale,
		CodeCloneDestExists, CodeCloneURLInvalid,
		CodeDeployHostBusy,
		CodeRemoteAuthFailed, CodeRemoteHostKeyChanged,
		CodeRemoteAccessProfileNotFound, CodeRemoteAccessConfigInvalid,
		CodeRemoteAccessPayloadInvalid, CodeRemoteAccessLockRequired,
		CodeRemoteAccessTLSConfirmRequired, CodeRemoteAccessStartFailed,
		CodeTerminalPayloadInvalid, CodeTerminalIDsEmpty, CodeTerminalIDsTooMany,
		CodeTerminalDataRequired, CodeTerminalDataTooLarge, CodeTerminalBodyTooLarge,
		CodeTerminalProjectIDsEmpty, CodeTerminalProjectIDsTooMany,
		CodeTerminalPromptRequired, CodeTerminalQueueFull, CodeTerminalQueueInvalid,
		CodeSearchRateLimited,
		CodeNotesNotFound, CodeNotesConflict, CodeNotesTooLarge,
		CodeNotesTitleTooLong, CodeNotesGlobalLimit,
	}
}

// TestAllCodesRegistered 每个常量都在 errCodeStatus 内（AllCodes 与常量表一一对应）
func TestAllCodesRegistered(t *testing.T) {
	registered := map[ErrCode]bool{}
	for _, c := range AllCodes() {
		registered[c] = true
	}
	for _, c := range allConsts() {
		if !registered[c] {
			t.Errorf("constant %s missing from errCodeStatus (StatusFor would fall back to 500)", c)
		}
	}
	if got, want := len(registered), len(allConsts()); got != want {
		t.Errorf("registry has %d codes, %d constants declared", got, want)
	}
}

// TestStatusForKeyBindings code↔HTTP status 绑定逐字面断言（稳定契约核心门禁）
func TestStatusForKeyBindings(t *testing.T) {
	cases := map[ErrCode]int{
		CodeProjectsNotFound:              http.StatusNotFound,
		CodeProjectLocked:                 http.StatusForbidden,
		CodeFilesPathRequired:             http.StatusBadRequest,
		CodeFilesPayloadInvalid:           http.StatusBadRequest,
		CodeFilesPayloadTooLarge:          http.StatusRequestEntityTooLarge,
		CodeFilesPathOutsideRoot:          http.StatusForbidden,
		CodeFilesNameInvalid:              http.StatusBadRequest,
		CodeFilesConflict:                 http.StatusConflict,
		CodeFilesNotFound:                 http.StatusNotFound,
		CodeFilesFileTooLarge:             http.StatusRequestEntityTooLarge,
		CodeFilesBinaryNotPreviewable:     http.StatusUnsupportedMediaType,
		CodeOpsPayloadInvalid:             http.StatusBadRequest,
		CodeOpsEventTypeInvalid:           http.StatusBadRequest,
		CodeOpsEventPayloadInvalid:        http.StatusBadRequest,
		CodeOpsPayloadTooLarge:            http.StatusRequestEntityTooLarge,
		CodeOpsApprovalRequired:           http.StatusPreconditionRequired,
		CodeOpsApprovalDenied:             http.StatusForbidden,
		CodeOpsConfirmOpInvalid:           http.StatusBadRequest,
		CodeOpsConfirmFieldTooLong:        http.StatusBadRequest,
		CodeOpsConfirmImpactInvalid:       http.StatusBadRequest,
		CodeOpsConfirmNotFound:            http.StatusNotFound,
		CodeOpsConfirmAlreadyResolved:     http.StatusConflict,
		CodeOpsConfirmHorizonInvalid:      http.StatusBadRequest,
		CodeOpsConfirmStatusInvalid:       http.StatusBadRequest,
		CodeOpsMessagePayloadInvalid:      http.StatusBadRequest,
		CodeOpsMessageTargetNotFound:      http.StatusNotFound,
		CodeUIPayloadInvalid:              http.StatusBadRequest,
		CodeUINoLiveSnapshot:              http.StatusNotFound,
		CodeRunbookPayloadInvalid:         http.StatusBadRequest,
		CodeRunbookParamsMissing:          http.StatusBadRequest,
		CodeRunbookBusy:                   http.StatusConflict,
		CodeRunbookTargetNotFound:         http.StatusNotFound,
		CodeFleetTargetsRequired:          http.StatusBadRequest,
		CodeFleetTargetsTooMany:           http.StatusBadRequest,
		CodeFleetTargetsNotFound:          http.StatusBadRequest,
		CodeFleetRunNotFound:              http.StatusNotFound,
		CodeFleetRunBusy:                  http.StatusConflict,
		CodeFleetCellNotRetryable:         http.StatusBadRequest,
		CodeFilesSensitiveConfirmRequired: http.StatusConflict,
		// 第二批（P-20261005-160）：git/clone/deploy/remote/terminal
		CodeGitIndexLockStale:    http.StatusInternalServerError,
		CodeGitWriteBusy:         http.StatusInternalServerError,
		CodeGitIndexLockFresh:    http.StatusConflict,
		CodeGitHunkConflict:      http.StatusConflict,
		CodeGitConflictStale:     http.StatusConflict,
		CodeCloneDestExists:      http.StatusBadRequest,
		CodeCloneURLInvalid:      http.StatusBadRequest,
		CodeDeployHostBusy:       http.StatusBadRequest,
		CodeRemoteAuthFailed:     http.StatusBadGateway,
		CodeRemoteHostKeyChanged: http.StatusBadGateway,
		// 远程接入（P-20261019-11）
		CodeRemoteAccessProfileNotFound:    http.StatusNotFound,
		CodeRemoteAccessConfigInvalid:      http.StatusBadRequest,
		CodeRemoteAccessPayloadInvalid:     http.StatusBadRequest,
		CodeRemoteAccessLockRequired:       http.StatusConflict,
		CodeRemoteAccessTLSConfirmRequired: http.StatusConflict,
		CodeRemoteAccessStartFailed:        http.StatusBadGateway,
		CodeTerminalPayloadInvalid:         http.StatusBadRequest,
		CodeTerminalIDsEmpty:               http.StatusBadRequest,
		CodeTerminalIDsTooMany:             http.StatusBadRequest,
		CodeTerminalDataRequired:           http.StatusBadRequest,
		CodeTerminalDataTooLarge:           http.StatusBadRequest,
		CodeTerminalBodyTooLarge:           http.StatusRequestEntityTooLarge,
		CodeTerminalProjectIDsEmpty:        http.StatusBadRequest,
		CodeTerminalProjectIDsTooMany:      http.StatusBadRequest,
		CodeTerminalPromptRequired:         http.StatusBadRequest,
		CodeTerminalQueueFull:              http.StatusConflict,
		CodeTerminalQueueInvalid:           http.StatusBadRequest,
		// 多篇笔记（P-20261107-2；P-20261108-3 单库化后即 /api/notes 族）
		CodeNotesNotFound:     http.StatusNotFound,
		CodeNotesConflict:     http.StatusConflict,
		CodeNotesTooLarge:     http.StatusRequestEntityTooLarge,
		CodeNotesTitleTooLong: http.StatusBadRequest,
		// 笔记库额度（P-20261107-5；单库化后唯一额度码）
		CodeNotesGlobalLimit: http.StatusBadRequest,
	}
	for code, want := range cases {
		if got := StatusFor(code); got != want {
			t.Errorf("StatusFor(%s) = %d, want %d", code, got, want)
		}
	}
}

// TestStatusForUnregisteredFallsBack500 未登记码防御性回退 500（漏登记不被静默吞掉）
func TestStatusForUnregisteredFallsBack500(t *testing.T) {
	if got := StatusFor("files.undefined_future_code"); got != http.StatusInternalServerError {
		t.Errorf("StatusFor(unregistered) = %d, want 500", got)
	}
}

// TestErrorWithCodeResponseShape 响应体 {"error","code"}：devMode 暴露 err 原文、
// 生产模式只给公共消息——code 恒在（生产环境 agent 仍可分支）
func TestErrorWithCodeResponseShape(t *testing.T) {
	gin.SetMode(gin.TestMode)
	old := devMode
	defer SetDevMode(old)

	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		ErrorWithCode(c, CodeFilesConflict, "save conflict", errors.New("boom: internal detail"))
	})

	SetDevMode(true)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != string(CodeFilesConflict) {
		t.Errorf("dev body code = %q, want %q", body["code"], CodeFilesConflict)
	}
	if body["error"] != "boom: internal detail" {
		t.Errorf("dev mode should expose err text, got %q", body["error"])
	}

	SetDevMode(false)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/x", nil))
	var body2 map[string]string
	if err := json.Unmarshal(w2.Body.Bytes(), &body2); err != nil {
		t.Fatal(err)
	}
	if body2["code"] != string(CodeFilesConflict) {
		t.Errorf("prod body code = %q, want %q (code must survive prod mode)", body2["code"], CodeFilesConflict)
	}
	if body2["error"] != "save conflict" {
		t.Errorf("prod mode should use public msg, got %q", body2["error"])
	}
}

// TestJSONWithCodeKeepsPayloadAndAddsCode 携额外载荷的错误体（policy/currentContent 形态）
// 附加 code 后原载荷保留，status 仍由注册表派生
func TestJSONWithCodeKeepsPayloadAndAddsCode(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/x", func(c *gin.Context) {
		JSONWithCode(c, CodeFilesFileTooLarge, gin.H{"error": "file too large to preview", "policy": "P"})
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != string(CodeFilesFileTooLarge) {
		t.Errorf("code = %v, want %v", body["code"], CodeFilesFileTooLarge)
	}
	if body["policy"] != "P" {
		t.Errorf("payload field lost: %v", body)
	}
}

// TestAbortWithCodeAborts 中间件拦截语义：写入派生 status + code，并中止后续 handler
func TestAbortWithCodeAborts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	reached := false
	r := gin.New()
	r.POST("/x", func(c *gin.Context) {
		AbortWithCode(c, CodeOpsApprovalRequired, gin.H{"error": "approval required", "approvalId": "a1"})
	}, func(c *gin.Context) { reached = true })

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/x", nil))
	if w.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428", w.Code)
	}
	if reached {
		t.Error("handler after AbortWithCode must not run")
	}
	var body map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["code"] != string(CodeOpsApprovalRequired) || body["approvalId"] != "a1" {
		t.Fatalf("body = %v", body)
	}
}

// TestLegacyErrorHasNoCode 未迁移端点的旧形态保持无 code 字段（增量兼容约定）
func TestLegacyErrorHasNoCode(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/x", func(c *gin.Context) { Error(c, http.StatusBadRequest, "legacy", nil) })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/x", nil))
	var body map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, has := body["code"]; has {
		t.Errorf("legacy Error must not emit code field: %v", body)
	}
	if body["error"] != "legacy" {
		t.Errorf("legacy body = %v", body)
	}
}
