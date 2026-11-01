package deploy

import (
	"os"
	"testing"
)

// TestMain 隔离留档落盘副作用（P-20261007-8）：终态（成功/失败）触发型单测
// 未设 SC_DATA_DIR 时会把日志快照写进真实 ~/.simple-coding/artifacts/deploy-logs/
// （测试污染），全包默认指到临时数据目录兜底；需要隔离留档落点的用例仍以
// t.Setenv 就地覆盖（恢复语义不变，dsh_test.go TestMain 同先例）
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "sc-deploy-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("CC_DATA_DIR", dir)
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
