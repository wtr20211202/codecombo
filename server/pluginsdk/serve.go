package pluginsdk

import (
	"bufio"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
)

// Handler 插件业务方法分发器：返回 (result, nil) 或 (nil, *RPCError)
type Handler func(method string, params json.RawMessage) (any, *RPCError)

// Serve 插件侧主循环：从 in 逐行读 JSON-RPC 请求，分发并写响应到 out。
// 内置两个标准方法（宿主握手与心跳），其余交给业务 Handler：
//   - initialize → 应答 manifest（SDK 统一处理，插件无需关心）
//   - ping       → 应答 "pong"
//
// 阻塞直到 in 读到 EOF（宿主 Close 关闭 stdin 即优雅终止）。
// 顺序分发：spike 阶段单请求串行足以验证协议；并发化（per-request goroutine）
// 留给 Phase D 定案后实现，协议帧格式不受影响。
func Serve(mf PluginManifest, h Handler, in io.Reader, out io.Writer) error {
	// 统一带锁写：业务 Handler 若在 goroutine 中发 Notification 不会交错
	var wmu sync.Mutex
	w := bufio.NewWriter(out)
	writeMsg := func(v any) error {
		wmu.Lock()
		defer wmu.Unlock()
		if err := json.NewEncoder(w).Encode(v); err != nil {
			return err
		}
		return w.Flush()
	}

	dec := json.NewDecoder(bufio.NewReader(in))
	for {
		var req Request
		if err := dec.Decode(&req); err != nil {
			return err // EOF / 管道断裂：宿主侧 Close 的正常终止路径
		}
		if req.Method == "" {
			continue
		}

		// Notification（无 ID）：不回包
		if len(req.ID) == 0 {
			if h != nil {
				_, _ = h(req.Method, req.Params)
			}
			continue
		}

		result, rpcErr := dispatch(mf, h, req.Method, req.Params)
		resp := Response{JSONRPC: jsonrpcVersion, ID: req.ID}
		if rpcErr != nil {
			resp.Error = rpcErr
		} else if b, err := json.Marshal(result); err == nil {
			resp.Result = b
		} else {
			resp.Error = &RPCError{Code: CodeServerError, Message: "result marshal: " + err.Error()}
		}
		if err := writeMsg(resp); err != nil {
			slog.Debug("pluginsdk: write response failed", "err", err)
			return err
		}
	}
}

func dispatch(mf PluginManifest, h Handler, method string, params json.RawMessage) (any, *RPCError) {
	switch method {
	case MethodInitialize:
		if mf.APIVersion == "" {
			mf.APIVersion = ProtocolVersion
		}
		return mf, nil
	case MethodPing:
		return "pong", nil
	default:
		if h == nil {
			return nil, &RPCError{Code: CodeMethodNotFound, Message: method}
		}
		return h(method, params)
	}
}
