package terminal

import (
	"context"
	"io"
	"log/slog"
	"strings"
	"testing"

	"codecombo/server/filestore"
	"codecombo/server/kernel"
	"codecombo/server/store"
)

// TestEffectiveMaxSessionsBounds 会话上限读取端边界矩阵（P-20261006-12）：
// 未配置回落缺省 50（存量行为零变化）/ 下限护栏 10 防误配 1 / 上限软限 200
// 截断 / 合法区间原样直通（含两端点）
func TestEffectiveMaxSessionsBounds(t *testing.T) {
	cases := []struct {
		name string
		cfg  int
		want int
	}{
		{"未配置回落缺省", 0, DefaultMaxSessions},
		{"负数脏值同缺省", -3, DefaultMaxSessions},
		{"缺省值本身直通", DefaultMaxSessions, DefaultMaxSessions},
		{"下限端点直通", MinMaxSessions, MinMaxSessions},
		{"下限护栏收敛", MinMaxSessions - 1, MinMaxSessions},
		{"误配1收敛护栏", 1, MinMaxSessions},
		{"软限端点直通", MaxSessionsSoftLimit, MaxSessionsSoftLimit},
		{"软限截断", MaxSessionsSoftLimit + 1, MaxSessionsSoftLimit},
		{"超大值截断", 500, MaxSessionsSoftLimit},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := EffectiveMaxSessions(tc.cfg); got != tc.want {
				t.Fatalf("EffectiveMaxSessions(%d) = %d, want %d", tc.cfg, got, tc.want)
			}
		})
	}
}

// TestModuleInitReadsMaxSessionsConfig 模块 Init 读配置定值（P-20261006-12）：
// settings doc store 配 terminalMaxSessions=80 → MaxSessions() 生效 80，
// 超限错误文案携带当前上限值（用户可感知配在哪）。生效值是包级 atomic，
// 测试结束恢复缺省防跨用例污染
func TestModuleInitReadsMaxSessionsConfig(t *testing.T) {
	t.Cleanup(func() {
		maxSessionsLimit.Store(DefaultMaxSessions)
		store.SetDefault(nil)
	})

	doc := filestore.New(t.TempDir())
	if err := doc.Upsert("config", "default", []byte(`{"server":{"terminalMaxSessions":80}}`)); err != nil {
		t.Fatalf("seed settings doc: %v", err)
	}
	store.SetDefault(store.New(doc))

	m := NewModule()
	if err := m.Init(context.Background(), kernel.New(slog.New(slog.NewTextHandler(io.Discard, nil)))); err != nil {
		t.Fatalf("module init: %v", err)
	}
	if got := MaxSessions(); got != 80 {
		t.Fatalf("MaxSessions() = %d after init, want 80", got)
	}
	// 文案带值：错误信息反映当前生效上限（非硬编码 50）
	msg := errTooManySessions().Error()
	if !strings.Contains(msg, "limit 80") {
		t.Fatalf("errTooManySessions() = %q, want contains \"limit 80\"", msg)
	}
}

// TestModuleInitDefaultWithoutStore store 未装配（部分单测裸构造模块）时
// Init 不取配置，上限保持缺省 50 = 存量行为零变化
func TestModuleInitDefaultWithoutStore(t *testing.T) {
	t.Cleanup(func() { maxSessionsLimit.Store(DefaultMaxSessions) })

	store.SetDefault(nil)
	m := NewModule()
	if err := m.Init(context.Background(), kernel.New(slog.New(slog.NewTextHandler(io.Discard, nil)))); err != nil {
		t.Fatalf("module init: %v", err)
	}
	if got := MaxSessions(); got != DefaultMaxSessions {
		t.Fatalf("MaxSessions() = %d without store, want default %d", got, DefaultMaxSessions)
	}
	if !strings.Contains(errTooManySessions().Error(), "limit 50") {
		t.Fatalf("default limit error message must carry 50, got %q", errTooManySessions().Error())
	}
}
