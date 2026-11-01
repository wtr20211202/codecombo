package pluginsdk

import (
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

// ── M6.2 协议 spike 测试 ──
// 用内存 OS 管道对驱动完整协议栈（Serve ↔ Host）：NDJSON 帧、握手协商、
// 方法分发、心跳、标准错误码、单向通知全链路。子进程 exec 接线
// （StdinPipe/StdoutPipe/Wait）为标准库组合，Phase D 插件运行时集成阶段
// 由带真实子进程的集成测试覆盖（避免在单测里派生测试二进制）。

// TestSpikeRoundtrip 完整协议往返
func TestSpikeRoundtrip(t *testing.T) {
	pluginIn, hostOut := io.Pipe()  // 宿主写 → 插件读
	pluginOut, hostIn := io.Pipe() // 插件写 → 宿主读
	done := make(chan struct{})

	go func() {
		spikePlugin(pluginIn, hostIn, nil)
		hostIn.Close()
		close(done)
	}()

	h := newHost(nopWriteCloser{hostOut}, pluginOut, func() error {
		hostOut.Close()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		return nil
	})
	defer h.Close()

	// 1. 握手 + apiVersion 协商
	mf, err := h.Initialize()
	if err != nil {
		t.Fatal(err)
	}
	if mf.Name != "spike-plugin" || mf.APIVersion != ProtocolVersion {
		t.Fatalf("manifest = %+v", mf)
	}

	// 2. 业务调用往返
	var out struct {
		Echo string `json:"echo"`
	}
	if err := h.Call("echo", map[string]string{"value": "hello-spike"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.Echo != "hello-spike" {
		t.Fatalf("echo = %q", out.Echo)
	}

	// 3. 心跳
	var pong string
	if err := h.Call(MethodPing, nil, &pong); err != nil || pong != "pong" {
		t.Fatalf("ping = %q err=%v", pong, err)
	}

	// 4. 未知方法 → 标准错误码
	err = h.Call("no-such-method", nil, nil)
	var rpcErr *RPCError
	if !errors.As(err, &rpcErr) || rpcErr.Code != CodeMethodNotFound {
		t.Fatalf("unknown method err = %v", err)
	}

	// 5. 宿主 → 插件单向通知（无 ID），插件记副作用后可读回
	if err := h.Notify("record", map[string]string{"k": "v"}); err != nil {
		t.Fatal(err)
	}
	var note struct {
		Got json.RawMessage `json:"got"`
	}
	if err := h.Call("note", nil, &note); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(note.Got), `"k":"v"`) {
		t.Fatalf("note = %s", note.Got)
	}
}

// TestPluginRejectsIncompatibleHost apiVersion 不兼容的宿主请求被插件按
// manifest 应答（协商拒绝发生在宿主侧 Initialize，见 APICompatible）
func TestPluginRejectsIncompatibleHost(t *testing.T) {
	pluginIn, hostOut := io.Pipe()
	pluginOut, hostIn := io.Pipe()
	done := make(chan struct{})
	go func() {
		_ = Serve(PluginManifest{Name: "p", APIVersion: "9.9.9"}, nil, pluginIn, hostIn)
		hostIn.Close()
		close(done)
	}()
	h := newHost(nopWriteCloser{hostOut}, pluginOut, func() error {
		hostOut.Close()
		<-done
		return nil
	})
	defer h.Close()

	if _, err := h.Initialize(); err == nil || !strings.Contains(err.Error(), "incompatible") {
		t.Fatalf("initialize err = %v, want incompatible apiVersion", err)
	}
}

// spikePlugin spike 插件：内置 SDK 标准方法 + echo / note 两个业务方法
func spikePlugin(in io.Reader, out io.Writer, _ func(json.RawMessage)) {
	var lastNote json.RawMessage
	_ = Serve(PluginManifest{
		Name:       "spike-plugin",
		Title:      "RPC Spike",
		APIVersion: ProtocolVersion,
		Topics:     []string{"demo.ping"},
	}, func(method string, params json.RawMessage) (any, *RPCError) {
		switch method {
		case "echo":
			var req struct {
				Value string `json:"value"`
			}
			if err := json.Unmarshal(params, &req); err != nil {
				return nil, &RPCError{Code: CodeInvalidParams, Message: err.Error()}
			}
			return map[string]string{"echo": req.Value}, nil
		case "record":
			// 宿主 Notify（无 ID 通知）落点：记副作用，不回包
			lastNote = append(json.RawMessage(nil), params...)
			return "ok", nil
		case "note":
			return map[string]json.RawMessage{"got": lastNote}, nil
		default:
			return nil, &RPCError{Code: CodeMethodNotFound, Message: method}
		}
	}, in, out)
}

// nopWriteCloser io.PipeWriter 补 Close
type nopWriteCloser struct{ io.Writer }

func (nopWriteCloser) Close() error { return nil }
