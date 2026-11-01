package terminal

import (
	"strings"
	"testing"
)

// TestProjectEnv 项目标识环境变量注入（P-20261003-307）：
//   - 项目绑定会话注入 CC_PROJECT_ID（/api/projects/:id 的 :id）+ CC_PROJECT_PATH
//     （注册根路径）——agent 免「GET /api/projects 按路径反查」
//   - 免项目会话（agent 等 projectID 为空）不注入，反查语义保留
//   - 路径缺失时只注入 ID（防御：注册路径空的项目不注入半枚）
func TestProjectEnv(t *testing.T) {
	const id = "0b6c1a2e-5c1d-4f8a-9a2b-3c4d5e6f7a8b"

	env := projectEnv(id, `/repo/root`)
	// P-20261025-1 双写：CC_ 正名 + SC_ 旧名各一枚（消费方是终端里的外部进程）
	if len(env) != 4 {
		t.Fatalf("projectEnv(project, path) len = %d, want 4: %v", len(env), env)
	}
	if env[0] != "CC_PROJECT_ID="+id || env[1] != "SC_PROJECT_ID="+id {
		t.Errorf("id pair = %v, want [CC_, SC_] PROJECT_ID", env[:2])
	}
	if env[2] != "CC_PROJECT_PATH=/repo/root" || env[3] != "SC_PROJECT_PATH=/repo/root" {
		t.Errorf("path pair = %v, want [CC_, SC_] PROJECT_PATH", env[2:])
	}

	if got := projectEnv("", `/repo/root`); got != nil {
		t.Errorf("projectEnv(empty id, path) = %v, want nil（免项目会话不注入）", got)
	}
	got := projectEnv(id, "")
	if len(got) != 2 || !strings.HasPrefix(got[0], "CC_PROJECT_ID=") || !strings.HasPrefix(got[1], "SC_PROJECT_ID=") {
		t.Errorf("projectEnv(id, empty path) = %v, want only CC_/SC_ PROJECT_ID pair", got)
	}
}
