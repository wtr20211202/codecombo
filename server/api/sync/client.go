package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/peercert"
)

// 对端实例 HTTP 客户端：探活/派发同源信任域（peercert.TLSConfig TOFU 指纹
// 校验 + TLSVerifyPeer 切换强校验即时生效），scheme 翻转自愈同 dispatch 先例。
// 传输类请求无全局超时（zip 流时长随体积走），以 context 控制生命周期。

// peerClient 实例间调用客户端。传输响应是流：不设 Client.Timeout（它会把
// 整个响应读取时长掐死），用每请求 context 传递取消信号
var peerClient = &http.Client{
	Transport: &http.Transport{TLSClientConfig: peercert.TLSConfig()},
}

// peerJSONTimeout 元数据类请求（manifest/meta/落位回执）超时：大项目的
// manifest 枚举在对端可达数十秒（走树+git ls-files），取宽值
const peerJSONTimeout = 120 * time.Second

// peerRemoteUnreachable 网络层失败稳定前缀（errmarkers.RemoteUnreachable，
// 前端 KNOWN_ERROR_I18N 既有映射）
func peerRemoteUnreachable(err error) error {
	return fmt.Errorf("%s: %w", errmarkers.RemoteUnreachable, err)
}

// peerBase 规范化对端地址（去尾斜杠；避免 //api 假路径——instance.go 同款）
func peerBase(rawURL string) string { return strings.TrimRight(rawURL, "/") }

// peerDo 单次请求执行（不换 scheme）。错误已包装稳定前缀
func peerDo(ctx context.Context, method, rawURL, token, path string, body io.Reader, header http.Header) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, peerBase(rawURL)+path, body)
	if err != nil {
		return nil, err
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := peerClient.Do(req)
	if err != nil {
		return nil, peerRemoteUnreachable(err)
	}
	return resp, nil
}

// isPlaintextToHTTPS 明文打 TLS 端口的固定签名（dispatch 同款判定）
func isPlaintextToHTTPS(status int, body []byte) bool {
	return status == http.StatusBadRequest && strings.Contains(string(body), plaintextToHTTPSBody)
}

const plaintextToHTTPSBody = "Client sent an HTTP request to an HTTPS server"

// flipScheme 交换 http/https（instance.go 同款自愈；探测窗口外的首次调用
// 不该因对端升级 TLS 而失败）
func flipScheme(rawURL string) string {
	u := rawURL
	if i := strings.Index(u, "://"); i > 0 {
		switch strings.ToLower(u[:i]) {
		case "http":
			return "https://" + u[i+3:]
		case "https":
			return "http://" + u[i+3:]
		}
	}
	return ""
}

// fetchPeerMeta GET 对端 /api/meta（公开只读）——sync 能力声明探测。
// 返回 (capabilities, version, err)；网络失败按 err 返回
func fetchPeerMeta(ctx context.Context, rawURL string) (caps []string, version string, err error) {
	resp, err := peerDo(ctx, http.MethodGet, rawURL, "", "/api/meta", nil, nil)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if err != nil {
		return nil, "", peerRemoteUnreachable(err)
	}
	var parsed struct {
		Version struct {
			Version string `json:"version"`
		} `json:"version"`
		Capabilities []string `json:"capabilities"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return nil, "", errf("peer meta not parseable (not a Codecombo instance?)")
	}
	return parsed.Capabilities, parsed.Version.Version, nil
}

// peerSupportsSync 对端能力面是否声明 sync 族（含 scheme 翻转重探一次）
func peerSupportsSync(ctx context.Context, rawURL string) (ok bool, version string) {
	caps, v, err := fetchPeerMeta(ctx, rawURL)
	if err == nil {
		return capabilityHas(caps, syncCapability), v
	}
	if flipped := flipScheme(rawURL); flipped != "" {
		if caps2, v2, err2 := fetchPeerMeta(ctx, flipped); err2 == nil {
			return capabilityHas(caps2, syncCapability), v2
		}
	}
	return false, v
}

func capabilityHas(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

// FetchPeerManifest 拉取对端 manifest（GET /api/sync/manifest，Bearer 实例令牌）。
// 能力探测（peerSupportsSync）不过关返回 errPeerUnsupported；网络层失败或
// 明文打 TLS 端口（400 固定签名）时按对端 scheme 翻转重试一次（dispatch 同款
// 自愈——探测窗口外对端升级 TLS 的存量 http:// 地址不因首次命中而失败；URL
// 迁移落盘仍由探活链负责，本处只保当次调用可达）
func FetchPeerManifest(ctx context.Context, inst config.InstanceConfig) (*ManifestResponse, error) {
	ok, version := peerSupportsSync(ctx, inst.URL)
	if !ok {
		return nil, &PeerUnsupportedError{Version: version}
	}
	ctx2, cancel := context.WithTimeout(ctx, peerJSONTimeout)
	defer cancel()
	status, body, err := fetchManifestOnce(ctx2, inst, inst.URL)
	if err != nil || isPlaintextToHTTPS(status, body) {
		if flipped := flipScheme(inst.URL); flipped != "" {
			if status2, body2, err2 := fetchManifestOnce(ctx2, inst, flipped); err2 == nil && !isPlaintextToHTTPS(status2, body2) {
				status, body, err = status2, body2, nil
			}
		}
	}
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, errf("peer manifest failed: status=%d %s", status, truncateErrBody(body))
	}
	var parsed struct {
		Data ManifestResponse `json:"data"`
	}
	if json.Unmarshal(body, &parsed) != nil {
		return nil, errf("peer manifest not parseable")
	}
	if parsed.Data.Version == "" {
		parsed.Data.Version = version
	}
	return &parsed.Data, nil
}

// fetchManifestOnce manifest 单次拉取（不换 scheme）：返回状态码与原始 body
// 供 scheme 自愈层判定明文打 TLS 端口签名
func fetchManifestOnce(ctx context.Context, inst config.InstanceConfig, base string) (int, []byte, error) {
	resp, err := peerDo(ctx, http.MethodGet, base, inst.Token, "/api/sync/manifest", nil, nil)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return resp.StatusCode, nil, peerRemoteUnreachable(err)
	}
	return resp.StatusCode, body, nil
}

// PeerUnsupportedError 对端未声明 sync 能力族（旧版本）——文案带对端版本
type PeerUnsupportedError struct{ Version string }

func (e *PeerUnsupportedError) Error() string {
	if e.Version != "" {
		return fmt.Sprintf("peer instance needs upgrade to support sync (peer version %s)", e.Version)
	}
	return "peer instance needs upgrade to support sync"
}

// fetchPeerUnitsZip 从对端拉取单元 zip 流（GET /api/sync/units?keys=...）。
// 返回的 ReadCloser 由调用方关闭；meta 从响应头解析
func fetchPeerUnitsZip(ctx context.Context, inst config.InstanceConfig, keys []string, includeIgnored bool) (io.ReadCloser, *TransferMeta, error) {
	q := "/api/sync/units?keys=" + url.QueryEscape(strings.Join(keys, ","))
	if includeIgnored {
		q += "&includeIgnored=1"
	}
	resp, err := peerDo(ctx, http.MethodGet, inst.URL, inst.Token, q, nil, nil)
	if err != nil {
		return nil, nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		// 426 = 对端要求升级（理论不可达：能力已预检）；其他按原文回
		return nil, nil, errf("peer units fetch failed: status=%d", resp.StatusCode)
	}
	meta := &TransferMeta{}
	if raw := resp.Header.Get(syncMetaHeader); raw != "" {
		if err := json.Unmarshal([]byte(raw), meta); err != nil {
			resp.Body.Close()
			return nil, nil, errf("peer transfer meta not parseable")
		}
	}
	return resp.Body, meta, nil
}

// postPeerUnitsZip 推送 zip 流到对端落位（POST /api/sync/units?mode=land）。
// 成功解析对端回执（落位结果 + 注册的项目 id/env 摘要）
func postPeerUnitsZip(ctx context.Context, inst config.InstanceConfig, meta *TransferMeta, body io.Reader) (*LandResult, error) {
	mb, err := json.Marshal(meta)
	if err != nil {
		return nil, err
	}
	hdr := http.Header{}
	hdr.Set(syncMetaHeader, string(mb))
	resp, err := peerDo(ctx, http.MethodPost, inst.URL, inst.Token, "/api/sync/units?mode=land", body, hdr)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, peerRemoteUnreachable(err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errf("peer landing failed: status=%d %s", resp.StatusCode, truncateErrBody(raw))
	}
	var parsed struct {
		Data LandResult `json:"data"`
	}
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, errf("peer landing result not parseable")
	}
	return &parsed.Data, nil
}

func truncateErrBody(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
