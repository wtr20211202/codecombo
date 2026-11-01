package git

import (
	"strings"
	"testing"
)

// 本机工具链版本探测单测（P-20261003-317）：git 是本仓库一切测试的前置依赖
//（execGit 全家桶），存在性在此环境恒真——断言输出形态；lfs 可选，存在才断言
// 形态，缺失时确认「报错而非空串」（体检条目据此判未安装）

func TestGitVersionOutput(t *testing.T) {
	out, err := GitVersionOutput()
	if err != nil {
		t.Fatalf("git --version failed: %v", err)
	}
	if !strings.HasPrefix(strings.TrimSpace(out), "git version") {
		t.Fatalf("git --version output = %q, want prefix `git version`", out)
	}
}

func TestLfsVersionOutput(t *testing.T) {
	out, err := LfsVersionOutput()
	if err != nil {
		// git-lfs 未安装是合法环境：探测必须显式报错（而非静默空串），
		// 体检条目靠 err 判「未安装」降级 warn
		if strings.TrimSpace(out) != "" {
			t.Fatalf("lfs missing: output = %q alongside error", out)
		}
		t.Skipf("git-lfs not installed in this environment: %v", err)
	}
	if !strings.Contains(strings.ToLower(out), "git-lfs") {
		t.Fatalf("git lfs version output = %q, want git-lfs marker", out)
	}
}
