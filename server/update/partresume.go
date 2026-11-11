// 自更新下载断点续传（P-20261110-1-S1）：大包在慢网/不稳网下一次停滞即前功尽弃
// （历史 download 全量重写 + 失败整目录 RemoveAll），本文件把自更新路径的下载
// 目标改写为 <dest>.part 半截文件 + 旁元数据，重试/重启后带 Range 从已有字节
// 续传。仅自更新路径启用——中心分发缓存（api/system/update.go DownloadToFile →
// ServeBinary）保持自有 .downloading + 失败即弃 + rename 的全量模式零改动
// （它的缓存可再生且有 1h 滚动清理，续传收益为零、状态面徒增）。
//
// 一致性防护是本文件的核心而非附带：Range 只保证「从第 N 字节继续」，不保证
// 继续的是同一个资产。发布方重传资产（同 URL 新内容）后若无身份核对，半截 A +
// 半截 B 会拼出必被校验拒绝、但浪费整轮下载的假包——故 206 响应须过
// resumeIdentityOK（响应 ETag / Content-Range 总长与旁元数据比对，可比信号全
// 一致且至少一份在场），不过即丢弃半截文件全量重下；拿不准时宁全量不拼接。
package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	partSuffix     = ".part"      // 半截文件（跨失败/重启保留，下载完成原子 rename 为最终名）
	partMetaSuffix = ".part.meta" // 旁元数据：半截文件的身份凭证
)

// partMeta .part 旁元数据：记录半截文件属于哪个资产。URL 是请求身份（换镜像/
// 换资产指针即弃），ETag 与 Total 是内容身份（发布方重传资产后据此丢弃旧半截）
type partMeta struct {
	URL   string `json:"url"`
	ETag  string `json:"etag,omitempty"`
	Total int64  `json:"total,omitempty"` // 全量总长（全量响应 Content-Length 或 206 Content-Range 总长；未知=0）
}

func loadPartMeta(path string) *partMeta {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var pm partMeta
	if json.Unmarshal(data, &pm) != nil {
		return nil // 损坏元数据按不存在处置：调用方会连同 .part 一并丢弃
	}
	return &pm
}

func savePartMeta(path string, pm *partMeta) error {
	data, err := json.Marshal(pm)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func partPaths(dest string) (part, meta string) {
	return dest + partSuffix, dest + partMetaSuffix
}

// removePartFiles 丢弃半截文件与元数据（身份不可考/资产漂移时的唯一安全动作）
func removePartFiles(dest string) {
	part, meta := partPaths(dest)
	_ = os.Remove(part)
	_ = os.Remove(meta)
}

// contentRange 206 响应 Content-Range 头的解析结果（bytes <start>-<end>/<total>）
type contentRange struct {
	Start int64
	End   int64
	Total int64 // 服务端不知总长时为 "*"，归一为 0
}

// parseContentRange 解析单段 Content-Range。multipart/多段/非 bytes 单位一律
// 解析失败——调用方据此丢弃半截文件走全量（本下载只发过单段 Range 请求，
// 多段响应不是我们要的答案）
func parseContentRange(h string) (contentRange, bool) {
	unit, spec, ok := strings.Cut(strings.TrimSpace(h), " ")
	if !ok || !strings.EqualFold(strings.TrimSpace(unit), "bytes") {
		return contentRange{}, false
	}
	rangeSpec, totalSpec, ok := strings.Cut(spec, "/")
	if !ok {
		return contentRange{}, false
	}
	startStr, endStr, ok := strings.Cut(rangeSpec, "-")
	if !ok {
		return contentRange{}, false
	}
	start, err := strconv.ParseInt(strings.TrimSpace(startStr), 10, 64)
	if err != nil {
		return contentRange{}, false
	}
	end, err := strconv.ParseInt(strings.TrimSpace(endStr), 10, 64)
	if err != nil {
		return contentRange{}, false
	}
	var total int64
	if t := strings.TrimSpace(totalSpec); t != "*" {
		total, err = strconv.ParseInt(t, 10, 64)
		if err != nil {
			return contentRange{}, false
		}
	}
	return contentRange{Start: start, End: end, Total: total}, true
}

// resumeIdentityOK 续传身份核对：可比信号（ETag / 总长）全部一致，且至少一份
// 在场。双空 = 身份不可证 = 拒绝续传丢弃重下——ETag 与总长都拿不到时，「半截
// A + 半截 B」无法排除，宁全量不赌。单边在场的信号匹配即放行（自建源可能只
// 回 Content-Range 不回 ETag；GitHub 两者都在）
func resumeIdentityOK(pm *partMeta, respETag string, cr contentRange) bool {
	etagCmp := pm.ETag != "" && respETag != ""
	totalCmp := pm.Total > 0 && cr.Total > 0
	if !etagCmp && !totalCmp {
		return false
	}
	if etagCmp && pm.ETag != respETag {
		return false
	}
	if totalCmp && pm.Total != cr.Total {
		return false
	}
	return true
}

// resumeState 续传起点（loadResumeState 的产出）
type resumeState struct {
	enabled bool
	size    int64 // .part 现有字节数（Range 请求的起始偏移）
	meta    *partMeta
}

// loadResumeState 解析 .part 续传起点。半截文件与元数据必须成对且 URL 与本次
// 资产一致：任一缺失、或元数据指向别的资产（发布重传/镜像漂移），整套丢弃——
// 残留的拿不准字节续上去就是「半截 A + 半截 B」
func loadResumeState(dest, url string) resumeState {
	partPath, metaPath := partPaths(dest)
	st, statErr := os.Stat(partPath)
	pm := loadPartMeta(metaPath)
	switch {
	case statErr != nil && pm == nil:
		return resumeState{} // 全新下载
	case statErr != nil:
		_ = os.Remove(metaPath) // 孤儿元数据（.part 已不在）：清掉防误配对
		return resumeState{}
	case pm == nil || st.IsDir():
		_ = os.Remove(partPath) // .part 在、元数据不在：内容身份不可考
		return resumeState{}
	case pm.URL != url:
		removePartFiles(dest) // 资产指针已变（换源/换镜像/发布重传换 URL）
		return resumeState{}
	case pm.Total > 0 && st.Size() > pm.Total:
		removePartFiles(dest) // 半截比记录的全量还长：内容已不可信，不必再问源端
		return resumeState{}
	}
	return resumeState{enabled: st.Size() > 0, size: st.Size(), meta: pm}
}

// downloadResumable 断点续传下载（仅自更新路径，单次会话；applyUpdate 经续传重试
// 层 downloadResumableWithRetry 调用，P-20261110-1-S2）：
// 写 <dest>.part，已有半截时发 `Range: bytes=<size>-`（有强 ETag 加 If-Range——
// 服务端资产已换会按 RFC 回全量 200，续传拼接在协议层先被拒一道）；206 且
// resumeIdentityOK 通过才追加。源端不支持 Range（对 Range 请求回 200 全量 /
// 416 不可满足）即回退全量语义——自建更新源不因续传能力劣化。下载完成（总长
// 已知时须过完整性闸：累计字节恰为总长）原子 rename .part → dest 再进校验；任何
// 中途失败（停滞/取消/传输错误/区间被截短）保留 .part 与元数据，重试层的下一
// 尝试、下一次受理或进程重启后续传。非预期状态码以 downloadStatusError 返回
// （文案即历史「download returned N」）供重试层按状态码分流瞬时/确定性失败。
//
// 进度分母口径：追加态用旁元数据总长 / Content-Range 总长，全量态用响应
// Content-Length——禁采信 206 的 Content-Length（那是剩余尾段长度，作分母会把
// 「已传 60%」显示成 150%）
func (m *Manager) downloadResumable(ctx context.Context, url, dest string, progressCB ProgressCallback) error {
	// 下载地址来自更新源 API 响应：强制 https 公网（与 download 同一校验口）
	if err := validateDownloadURL(url); err != nil {
		return err
	}
	dctx, cancel := context.WithCancel(ctx)
	defer cancel()

	partPath, metaPath := partPaths(dest)
	resume := loadResumeState(dest, url)

	var resp *http.Response
	var base int64     // .part 已有字节数（追加基偏移；0=全量写）
	var denom int64    // 进度分母 = 全量总长
	var meta *partMeta // 随 .part 存续的元数据（追加态沿用，全量态按本响应重写）

	if resume.enabled {
		rresp, err := rangedRequest(dctx, url, resume)
		if err != nil {
			return err // 传输层失败：.part 原样保留，续传资本不动
		}
		switch rresp.StatusCode {
		case http.StatusPartialContent:
			cr, ok := parseContentRange(rresp.Header.Get("Content-Range"))
			if ok && cr.Start == resume.size && resumeIdentityOK(resume.meta, rresp.Header.Get("ETag"), cr) {
				resp, base, meta = rresp, resume.size, resume.meta
				denom = meta.Total
				if meta.Total == 0 && cr.Total > 0 {
					// 首个会话总长未知（无 Content-Length），206 补齐后回写元数据
					//（身份已由 ETag 证实，写失败只损失下次的总长可比性）
					meta.Total = cr.Total
					denom = cr.Total
					_ = savePartMeta(metaPath, meta)
				}
				break
			}
			// 起点错位 / 身份核对不过（发布方重传资产）：半截文件作废，全量重下
			_ = rresp.Body.Close()
			removePartFiles(dest)
		case http.StatusOK:
			// 源端不支持 Range（或 If-Range 失配拒绝续传）：响应即全量——
			// .part 截断重写，绝不追加（追加就是半截 A + 全量 B）
			resp, base = rresp, 0
		case http.StatusRequestedRangeNotSatisfiable:
			// Range 不可满足（.part 越界/源端资产变短）：丢弃回退全量
			_ = rresp.Body.Close()
			removePartFiles(dest)
		default:
			_ = rresp.Body.Close()
			return &downloadStatusError{status: rresp.StatusCode}
		}
	}

	if resp == nil {
		fresp, err := plainRequest(dctx, url)
		if err != nil {
			return err
		}
		if fresp.StatusCode != http.StatusOK {
			_ = fresp.Body.Close()
			return &downloadStatusError{status: fresp.StatusCode}
		}
		resp, base = fresp, 0
	}
	defer resp.Body.Close()

	var f *os.File
	if base == 0 {
		// 全量写（首次/回退）：截断重开，再以本响应头部重写元数据。顺序刻意
		// 先截断后写元数据——进程死在两步之间只会留下「空半截 + 旧元数据」，
		// 下次按全新下载处置；反过来会出现「新元数据 + 旧半截」的拼接隐患
		var err error
		f, err = os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			return err
		}
		denom = resp.ContentLength
		meta = &partMeta{URL: url, ETag: resp.Header.Get("ETag")}
		if denom > 0 {
			meta.Total = denom
		}
		if err := savePartMeta(metaPath, meta); err != nil {
			_ = f.Close()
			return err
		}
	} else {
		var err error
		f, err = os.OpenFile(partPath, os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			return err
		}
	}

	// 分母补齐与全量路径同口径：发布元数据（applyUpdate 已按 FileSize 预置）
	// 优先，本响应只填空缺。进度即刻落到续传起点——首个采样窗（200ms）之前
	// 面板不从 0 起跳再闪回已有进度
	m.mu.Lock()
	if denom > 0 && m.total <= 0 {
		m.total = denom
	}
	m.progress = base
	// 续传起点透出（P-20261110-1-S4）：追加态 = 实际续传偏移，全量态（首下/
	// 身份核对不过/200/416 回退）归 0——「已续传」提示只对真实续传会话成立。
	// 每次尝试（含 S2 重试分层的每次重试，均经本函数）以自己的起点覆写上一
	// 次的值，语义 = 当前这次尝试从哪继续
	m.resumedBytes = base
	m.mu.Unlock()

	written, perr := pumpResponseBody(ctx, dctx, cancel, resp.Body, f, func(n int64) {
		m.mu.Lock()
		m.progress = base + n
		m.mu.Unlock()
		if progressCB != nil {
			progressCB(base+n, denom)
		}
	})
	closeErr := f.Close()
	if perr != nil {
		return perr // .part 与元数据原样保留：停滞/取消/写失败都可续传
	}
	if closeErr != nil {
		return closeErr
	}

	got := base + written
	m.mu.Lock()
	m.progress = got
	m.mu.Unlock()
	if progressCB != nil {
		progressCB(got, denom)
	}

	// 完整性闸：总长已知时累计字节须恰为总长才算下载完成。全量响应的
	// Content-Length 由 net/http 强制（短读即 ErrUnexpectedEOF），206 的 body 却
	// 只受尾段长度约束——源端截短区间（Content-Range 止于总长之前）时读到 EOF
	// 不等于资产读完。短了保留 .part（下一次从此处续传），长了内容已不可信即弃
	if denom > 0 && got != denom {
		if got > denom {
			removePartFiles(dest)
		}
		return fmt.Errorf("download incomplete: got %d of %d bytes", got, denom)
	}

	// 完成：原子 rename .part → dest（校验/换包只认最终名，最终名处绝不出现
	// 半截文件），旁元数据使命结束。同卷 rename 三平台原子
	if err := os.Rename(partPath, dest); err != nil {
		return err
	}
	_ = os.Remove(metaPath)
	return nil
}

// rangedRequest 续传请求：Range 从 .part 现有大小起；有强 ETag 加 If-Range，
// 让支持的服务端在资产已换时直接回全量 200 而非错位尾段。弱 ETag（W/ 前缀）
// 不发 If-Range——RFC 9110 §13.1.5 规定弱校验符作 If-Range 条件恒不成立，服务端
// 必回全量 200，续传会静默退化成每次全量；弱 ETag 场景的资产身份仍由 206 的
// resumeIdentityOK 兜底核对
func rangedRequest(dctx context.Context, url string, resume resumeState) (*http.Response, error) {
	req, err := http.NewRequestWithContext(dctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-", resume.size))
	if etag := resume.meta.ETag; etag != "" && !strings.HasPrefix(etag, "W/") {
		req.Header.Set("If-Range", etag)
	}
	return downloadClient.Do(req)
}

// plainRequest 全量请求（首次下载与 Range 回退共用）
func plainRequest(dctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(dctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	return downloadClient.Do(req)
}

// updateTmpTTL 自更新临时目录（tmp/update-*）保留期：.part 跨失败/重启保留以
// 支撑续传，但放弃更新/换版本后的孤儿目录不能无限堆积。7 天足够覆盖最保守的
// 「想起来再更」间隔；发布换版后旧目录里的半截文件也随之自然过期
const updateTmpTTL = 7 * 24 * time.Hour

// CleanupOldUpdateTmp 清理超过保留期的自更新临时目录（S1 .part 断点续传的配套
// 回收，挂 update 模块启动清理点，与 CleanupServeCache 同位）。目录新鲜度取
// 目录与直接子项 mtime 的最大值——长下载会话只追加 .part 内容不动目录 mtime，
// 只看目录会把活跃续传中的目录误判为陈旧。update-* 同族的 update-from-center
// （中心下发换包链，api/system/update.go）一并按 7 天口径回收：启动期本进程尚无
// 在途换包，陈旧残留与续传孤儿同属可再生临时产物。版本推进不做受理期主动删除
// ——续传现场按版本目录隔离天然弃用，中心下发链不经本状态机闸门、受理期删
// update-* 兄弟目录会撞上它并发在写的产物
func CleanupOldUpdateTmp(dataDir string) {
	tmpDir := filepath.Join(dataDir, "tmp")
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "update-") {
			continue
		}
		dirPath := filepath.Join(tmpDir, entry.Name())
		info, err := entry.Info()
		if err != nil {
			continue
		}
		last := info.ModTime()
		if subs, err := os.ReadDir(dirPath); err == nil {
			for _, sub := range subs {
				if si, err := sub.Info(); err == nil && si.ModTime().After(last) {
					last = si.ModTime()
				}
			}
		}
		if time.Since(last) > updateTmpTTL {
			_ = os.RemoveAll(dirPath)
		}
	}
}
