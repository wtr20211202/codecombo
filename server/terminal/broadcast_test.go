package terminal

import (
	"os"
	"testing"
)

// broadcastFakeConn 内存假 PTY：只实现 ptyConn 接口，Write 记录写入内容供断言
type broadcastFakeConn struct {
	wrote []byte
}

func (f *broadcastFakeConn) Read(_ []byte) (int, error) { return 0, nil }
func (f *broadcastFakeConn) Write(p []byte) (int, error) {
	f.wrote = append(f.wrote, p...)
	return len(p), nil
}
func (f *broadcastFakeConn) Close() error                    { return nil }
func (f *broadcastFakeConn) Wait() (*os.ProcessState, error) { return nil, nil }

// newBroadcastFixture 造一个内存 Manager 挂两个可写会话 + 一个已关闭会话
// （ptmx=nil 模拟「存在但写不进」——WriteInput 对 nil ptmx 返回 not attached）
func newBroadcastFixture() (*Manager, *broadcastFakeConn, *broadcastFakeConn) {
	m := &Manager{sessions: make(map[string]*Session)}
	connA := &broadcastFakeConn{}
	connB := &broadcastFakeConn{}
	m.sessions["t-a"] = &Session{ID: "t-a", ptmx: connA}
	m.sessions["t-b"] = &Session{ID: "t-b", ptmx: connB}
	m.sessions["t-dead"] = &Session{ID: "t-dead"}
	return m, connA, connB
}

// TestBroadcastWriteDeliversToAll 两个存活会话都收到同一段输入
func TestBroadcastWriteDeliversToAll(t *testing.T) {
	m, connA, connB := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"t-a", "t-b"}, []byte("git status\r"))

	if res.Written != 2 || len(res.Missing) != 0 || len(res.Failed) != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if string(connA.wrote) != "git status\r" || string(connB.wrote) != "git status\r" {
		t.Fatalf("data not delivered: a=%q b=%q", connA.wrote, connB.wrote)
	}
}

// TestBroadcastWriteMissingSkippedAndCounted 不存在的 id 跳过并计数回告，
// 不影响其余会话写入（提案「不存在 id 404 跳过并计数回告」）
func TestBroadcastWriteMissingSkippedAndCounted(t *testing.T) {
	m, connA, _ := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"t-a", "ghost-1"}, []byte("x"))

	if res.Written != 1 || len(res.Missing) != 1 || res.Missing[0] != "ghost-1" {
		t.Fatalf("missing not reported: %+v", res)
	}
	if string(connA.wrote) != "x" {
		t.Fatalf("surviving session not written: %q", connA.wrote)
	}
}

// TestBroadcastWriteFailedCounted 存在但写不进的会话（已关闭/未附着）计入
// failed，不掉队拖累其余
func TestBroadcastWriteFailedCounted(t *testing.T) {
	m, _, _ := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"t-a", "t-dead"}, []byte("x"))

	if res.Written != 1 || len(res.Failed) != 1 || res.Failed[0] != "t-dead" {
		t.Fatalf("failed not reported: %+v", res)
	}
}

// TestBroadcastWriteDedupesIds 同一 id 重复出现只写一次（防调用方重复勾选
// 造成重复执行）
func TestBroadcastWriteDedupesIds(t *testing.T) {
	m, connA, _ := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"t-a", "t-a", "t-a"}, []byte("x"))

	if res.Written != 1 {
		t.Fatalf("duplicate id written more than once: %+v", res)
	}
	if len(connA.wrote) != 1 {
		t.Fatalf("expected single write, got %d bytes", len(connA.wrote))
	}
}

// TestBroadcastWriteAllMissing 空命中（全部 id 不存在）：written=0，
// missing 全量回告，不报错
func TestBroadcastWriteAllMissing(t *testing.T) {
	m, _, _ := newBroadcastFixture()

	res := m.BroadcastWrite([]string{"ghost-1", "ghost-2"}, []byte("x"))

	if res.Written != 0 || len(res.Missing) != 2 || len(res.Failed) != 0 {
		t.Fatalf("unexpected result: %+v", res)
	}
}
