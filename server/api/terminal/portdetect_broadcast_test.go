package terminal

import (
	"testing"

	"github.com/gin-gonic/gin"

	"codecombo/server/api/opschannel"
	"codecombo/server/terminal"
)

// TestOnDevPortDetectedBroadcastsPreviewPort dev 端口被动探测（P-20261002-83）
// 与 P-70 事件链的装配点：init 注册的命中回调应广播 preview.port（前端通知中心
// + 悬浮球直达预览面板），payload 带 source:"detected" 供前端弱化展示。
// opschannel 观察者在广播方 goroutine 内同步执行，直接断言即可
func TestOnDevPortDetectedBroadcastsPreviewPort(t *testing.T) {
	var seen opschannel.Event
	unsub := opschannel.AddObserver(func(ev opschannel.Event) {
		if ev.Type == "preview.port" {
			seen = ev
		}
	})
	defer unsub()

	if terminal.OnDevPortDetected == nil {
		t.Fatal("init 应装配探测命中回调（api 层注入 opschannel 广播）")
	}
	terminal.OnDevPortDetected("term-1", 5173, "vite")

	if seen.Type != "preview.port" {
		t.Fatalf("应广播 preview.port，得到 %q", seen.Type)
	}
	if seen.Source != "system" {
		t.Fatalf("事件信封 source 应为 system（探测身份在 payload 层标注），得到 %q", seen.Source)
	}
	p, ok := seen.Payload.(gin.H)
	if !ok {
		t.Fatalf("payload 应为 gin.H map，得到 %T", seen.Payload)
	}
	if p["port"] != 5173 || p["label"] != "vite" || p["source"] != "detected" {
		t.Fatalf("payload 应为 {port:5173, label:vite, source:detected}，得到 %v", p)
	}
}
