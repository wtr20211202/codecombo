package remoteterminal

import (
	"errors"
	"testing"
	"time"
)

// recPTY 记录写入的假 PTYConn：Write 记录内容供断言（不经 SSH 真拨号）
type recPTY struct {
	writes [][]byte
}

func (p *recPTY) Write(b []byte) (int, error) {
	cp := make([]byte, len(b))
	copy(cp, b)
	p.writes = append(p.writes, cp)
	return len(b), nil
}
func (p *recPTY) Read(_ []byte) (int, error)          { return 0, nil }
func (p *recPTY) Resize(uint16, uint16) error         { return nil }
func (p *recPTY) Close() error                        { return nil }
func (p *recPTY) SetReadDeadline(_ time.Time) error   { return nil }

// deadWritePTY 写入即失败的假连接（模拟 SSH channel 已断但会话尚未被回收）
type deadWritePTY struct{}

func (deadWritePTY) Write(_ []byte) (int, error)            { return 0, errors.New("conn dead") }
func (deadWritePTY) Read(_ []byte) (int, error)             { return 0, nil }
func (deadWritePTY) Resize(uint16, uint16) error            { return nil }
func (deadWritePTY) Close() error                           { return nil }
func (deadWritePTY) SetReadDeadline(_ time.Time) error      { return nil }

// newBroadcastFixture 内存态 Manager 直挂两个可写会话 + 一个写失败会话，
// 不经 CreateSession（免 readLoop goroutine 与拨号，测试确定性优先——
// terminal 包 broadcast_test.go 同款形态）
func newBroadcastFixture() (*Manager, *recPTY, *recPTY) {
	m := &Manager{sessions: make(map[string]*Session)}
	pa := &recPTY{}
	pb := &recPTY{}
	m.sessions["r-a"] = &Session{ID: "r-a", HostID: "sc_rh_a", conn: pa}
	m.sessions["r-b"] = &Session{ID: "r-b", HostID: "sc_rh_b", conn: pb}
	m.sessions["r-dead"] = &Session{ID: "r-dead", HostID: "sc_rh_c", conn: deadWritePTY{}}
	return m, pa, pb
}

// TestBroadcastWriteDeliversToAll 存活会话都收到同一段输入（服务端中继：写入
// 即进 SSH stdin）
func TestBroadcastWriteDeliversToAll(t *testing.T) {
	m, pa, pb := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"r-a", "r-b"}, []byte("uptime\r"))

	if res.Written != 2 || len(res.Missing) != 0 || len(res.Failed) != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(pa.writes) != 1 || string(pa.writes[0]) != "uptime\r" {
		t.Fatalf("session a not written: %v", pa.writes)
	}
	if len(pb.writes) != 1 || string(pb.writes[0]) != "uptime\r" {
		t.Fatalf("session b not written: %v", pb.writes)
	}
}

// TestBroadcastWriteMissingAndFailed 不存在 id 计 missing；断连（写失败）计
// failed；二者都不拖累存活目标（P-288 逐会话跳过语义在远程半边继承）
func TestBroadcastWriteMissingAndFailed(t *testing.T) {
	m, pa, _ := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"r-a", "r-ghost", "r-dead"}, []byte("df -h\r"))

	if res.Written != 1 || len(pa.writes) != 1 {
		t.Fatalf("alive session not written: %+v", res)
	}
	if len(res.Missing) != 1 || res.Missing[0] != "r-ghost" {
		t.Fatalf("missing not reported: %+v", res)
	}
	if len(res.Failed) != 1 || res.Failed[0] != "r-dead" {
		t.Fatalf("failed not reported: %+v", res)
	}
}

// TestBroadcastWriteDedupesIds 同一 id 重复出现只写一次（防调用方重复勾选
// 造成重复执行）
func TestBroadcastWriteDedupesIds(t *testing.T) {
	m, pa, _ := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"r-a", "r-a", "r-a"}, []byte("x"))

	if res.Written != 1 {
		t.Fatalf("duplicate id written more than once: %+v", res)
	}
	if len(pa.writes) != 1 {
		t.Fatalf("expected single write, got %d", len(pa.writes))
	}
}
