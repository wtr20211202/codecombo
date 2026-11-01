package terminal

import "testing"

// 高危命令模式表单测（P-20261005-191）：命中形态 × 不命中形态双面——
// 误报（切分支/追加重定向/dev/null）与漏报（变体 flag 序）都要钉住

func matchIDs(cmd string) []string {
	var ids []string
	for _, m := range MatchCommandRisk(cmd) {
		ids = append(ids, m.ID)
	}
	return ids
}

func hasID(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

func TestMatchCommandRiskHits(t *testing.T) {
	cases := []struct {
		name string
		cmd  string
		id   string
	}{
		{"rm 递归 flag 变体序", "rm -fr build", "rm-recursive"},
		{"rm 长选项递归", "rm --recursive dist/", "rm-recursive"},
		{"rm 仅 -f 非递归", "rm -f secret.key", "rm-force"},
		{"rm 目标在 -- 之后", "rm -rf -- ./-dash-dir", "rm-recursive"},
		{"git reset --hard", "git reset --hard HEAD~1", "git-reset-hard"},
		{"git -C 载体参数下的 reset", "git -C sub reset --hard", "git-reset-hard"},
		{"git checkout -- 丢弃形态", "git checkout -- .", "git-checkout-discard"},
		{"git checkout 点目标", "git checkout .", "git-checkout-discard"},
		{"git restore 现代等价", "git restore src/main.go", "git-restore"},
		{"git clean 带 f", "git clean -fd", "git-clean"},
		{"git push force 长选项", "git push origin main --force", "git-push-force"},
		{"git push force 短选项", "git push -f", "git-push-force"},
		{"truncate 零值带单位", "truncate -s 0 app.log", "truncate"},
		{"truncate 长选项等号", "truncate --size=0 app.log", "truncate"},
		{"shred", "shred -u secret.txt", "shred"},
		{"docker system prune", "docker system prune -af", "docker-prune"},
		{"docker volume prune", "docker volume prune", "docker-prune"},
		{"覆盖重定向", "echo x > config.txt", "overwrite-redirect"},
		{"复合命令逐段命中", "cd build && rm -rf * ; git reset --hard", "rm-recursive"},
	}
	for _, tc := range cases {
		ids := matchIDs(tc.cmd)
		if !hasID(ids, tc.id) {
			t.Fatalf("%s: MatchCommandRisk(%q) 命中 = %v, 期望含 %q", tc.name, tc.cmd, ids, tc.id)
		}
	}
}

func TestMatchCommandRiskMisses(t *testing.T) {
	cases := []struct {
		name   string
		cmd    string
		absent string
	}{
		{"普通 rm 不带 r/f", "rm tmpfile.txt", "rm-recursive"},
		{"切分支形态不命中丢弃", "git checkout -b feature/x", "git-checkout-discard"},
		{"checkout 分支名", "git checkout main", "git-checkout-discard"},
		{"git restore 仅暂存区", "git restore --staged src/main.go", "git-restore"},
		{"git clean 无 f 是空操作", "git clean -nd", "git-clean"},
		{"普通 push", "git push origin main", "git-push-force"},
		{"追加重定向非覆盖", "echo x >> config.txt", "overwrite-redirect"},
		{"fd 重定向与 dev/null", "make 2> err.log", "overwrite-redirect"},
		{"dev/null 覆盖不拦", "echo spam > /dev/null", "overwrite-redirect"},
		{"引号内分隔符不分段", `echo "a && b"`, "rm-recursive"},
		{"docker 非 prune 子命令", "docker ps -a", "docker-prune"},
		{"truncate 非零大小", "truncate -s 1M app.log", "truncate"},
	}
	for _, tc := range cases {
		ids := matchIDs(tc.cmd)
		if hasID(ids, tc.absent) {
			t.Fatalf("%s: MatchCommandRisk(%q) 误命中 %q（全集 %v）", tc.name, tc.cmd, tc.absent, ids)
		}
	}
}

func TestMatchCommandRiskTargets(t *testing.T) {
	// rm 目标参数抽取：动态计数（glob 展开/fs walk）的输入面
	matches := MatchCommandRisk("rm -rf build dist/*.log")
	if len(matches) == 0 {
		t.Fatal("期望命中 rm-recursive")
	}
	m := matches[0]
	if m.Kind != "rm" || m.Level != RiskDanger {
		t.Fatalf("命中形态不符: %+v", m)
	}
	if len(m.Targets) != 2 || m.Targets[0] != "build" || m.Targets[1] != "dist/*.log" {
		t.Fatalf("目标抽取不符: %v", m.Targets)
	}

	// 复合命令多命中按段保留；上限护栏（maxMatches）防病态输入撑爆载荷
	compound := MatchCommandRisk("git clean -fd && git reset --hard && shred a.txt")
	if len(compound) != 3 {
		t.Fatalf("复合命令期望 3 条命中, got %d: %+v", len(compound), compound)
	}
	many := "rm -f a0;"
	for i := 1; i < 30; i++ {
		many += "rm -f a" + string(rune('a'+i%26)) + ";"
	}
	if got := len(MatchCommandRisk(many)); got > maxMatches {
		t.Fatalf("命中数应封顶 %d, got %d", maxMatches, got)
	}
}

func TestSplitCommandSegments(t *testing.T) {
	segs := splitCommandSegments("echo \"a|b\"; rm -rf x\necho 'it;s'")
	if len(segs) != 3 {
		t.Fatalf("引号内分隔符不切段, got %q", segs)
	}
	if segs[0] != `echo "a|b"` || segs[1] != "rm -rf x" || segs[2] != "echo 'it;s'" {
		t.Fatalf("切段结果不符: %q", segs)
	}
	// && / || 双字符只切一次
	if segs := splitCommandSegments("a && b || c"); len(segs) != 3 {
		t.Fatalf("双字符分隔符处理不符: %q", segs)
	}
}
