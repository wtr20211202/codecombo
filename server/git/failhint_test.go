package git

import (
	"errors"
	"strings"
	"testing"
)

// P-20261005-194 分类器特征矩阵：真实 git stderr/stdout 原文样例 → 期望 kind。
// 样例全部取 git 实际输出句式（ push 拒绝的 rejected+hint 行 / pull 分叉的
// fatal / 冲突的 CONFLICT 行在 stdout 等），服务端包装前缀（"git push: "）照带
// ——分类必须对「服务端组装后的完整错误文本」成立而非裸 git 行。
func TestClassifyFailHint(t *testing.T) {
	cases := []struct {
		name       string
		errText    string
		extra      string // PullRemote 场景并进分类输入的部分输出（stdout）
		wantKind   string
		wantDetail string // 期望锁路径（仅 lock 类非空断言，其余忽略）
		want       bool
	}{
		// ── non-fast-forward（push 拒基础形态）──
		{"push fetch first", "git push origin main: To ../bare.git\n ! [rejected]        main -> main (fetch first)\nhint: Updates were rejected because the tip of your current branch is behind\nerror: failed to push some refs to '../bare.git'", "", FailNonFastForward, "", true},
		{"push non-fast-forward variant", "git push: To github.com:x/y.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs", "", FailNonFastForward, "", true},
		{"push behind hint without rejected tag", "git push: hint: Updates were rejected because the tip of your current branch is behind its remote counterpart. Integrate the remote changes (e.g. 'git pull ...')", "", FailNonFastForward, "", true},

		// ── diverged：分叉特征须压过同现的 non-fast-forward（表序优先）──
		{"push diverged beats non-fast-forward", "git push origin main: To ../bare.git\n ! [rejected]        main -> main (non-fast-forward)\nhint: Updates were rejected because the tip of your current branch and its remote counterpart diverge from each other.", "", FailDiverged, "", true},
		{"pull divergent branches", "git pull origin main: From ../bare.git\nfatal: Need to specify how to reconcile divergent branches.\nYou could instead use --rebase, --no-rebase, or --ff-only", "", FailDiverged, "", true},
		{"pull ff-only abort", "git pull: fatal: Not possible to fast-forward, aborting.", "", FailDiverged, "", true},

		// ── conflict（冲突行在 stdout：经 extraOutput 并入才可判，pull 实测形态）──
		{"pull conflict via stdout", "git pull origin main: ", "Merge made by the 'ort' strategy.\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.", FailConflict, "", true},
		{"merge conflict in stderr", "git merge feat: Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nerror: Failed to merge in the changes.", "", FailConflict, "", true},
		{"rebase conflict hint", "git rebase --continue: error: could not apply abc123... work\nhint: Resolve all conflicts manually, mark them as resolved with \"git add\"", "", FailConflict, "", true},
		{"unmerged files commit", "git commit: error: Committing is not possible because you have unmerged files.", "", FailConflict, "", true},

		// ── lock（git 原文 / 服务端升级标记两形态；Detail 提取锁路径）──
		{"lock file exists raw", "git commit: fatal: Unable to create 'D:/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository", "", FailLock, "D:/repo/.git/index.lock", true},
		{"stale lock server marker", "git add: fatal: Unable to create '/repo/.git/index.lock': File exists. [stale git index lock detected: 61s old]", "", FailLock, "/repo/.git/index.lock", true},
		{"marker without quoted path", "git add: file changed [stale git index lock detected: 61s old]", "", FailLock, "", true},

		// ── authentication ──
		{"https auth failed", "git push origin main: fatal: Authentication failed for 'https://github.com/x/y.git/'", "", FailAuthentication, "", true},
		{"ssh publickey denied", "git fetch origin: git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "", FailAuthentication, "", true},
		{"no username prompt", "git push: fatal: could not read Username for 'https://github.com': terminal prompts disabled", "", FailAuthentication, "", true},
		{"http 403", "git fetch origin: fatal: unable to access 'https://gitlab.com/x/y.git/': The requested URL returned error: 403", "", FailAuthentication, "", true},
		{"invalid credentials", "git push: remote: Invalid username or password.\nfatal: Authentication failed", "", FailAuthentication, "", true},

		// ── dubious ownership ──
		{"dubious ownership", "git status: fatal: detected dubious ownership in repository at 'D:/repo'", "", FailDubiousOwnership, "", true},

		// ── hook-rejected ──
		{"pre-receive hook declined", "git push origin main: To ../bare.git\n ! [remote rejected] main -> main (hook declined)\nerror: failed to push some refs", "", FailHookRejected, "", true},
		{"pre-rebase hook refused", "git rebase: The pre-rebase hook refused to rebase removed refs.", "", FailHookRejected, "", true},

		// ── network ──
		{"dns fail", "git fetch origin: fatal: unable to access 'https://github.com/x/y.git/': Could not resolve host: github.com", "", FailNetwork, "", true},
		{"connection refused", "git fetch origin: fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 2000 ms: Connection refused", "", FailNetwork, "", true},
		{"ssh timeout", "git fetch: ssh: connect to host git.example.com port 22: Connection timed out", "", FailNetwork, "", true},

		// ── 保守不误报：错误码族既有标记与普通错误保持无 hint ──
		{"conflict stale marker not conflict", "conflict file was modified externally since it was loaded", "", "", "", false},
		{"hunk stale marker not conflict", "hunk no longer applies", "", "", "", false},
		{"write busy marker no match", "another git write operation is still in progress: 30s", "", "", "", false},
		{"plain failure no match", "fatal: not a git repository", "", "", "", false},
		{"empty stdout extra ignored", "git pull: ", "", "", "", false},
		{"nil error", "", "", "", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var err error
			if tc.errText != "" || tc.name == "empty stdout extra ignored" {
				err = errors.New(tc.errText)
			}
			hint, ok := ClassifyFailHint(err, tc.extra)
			if ok != tc.want {
				t.Fatalf("ok = %v, want %v (got kind=%q)", ok, tc.want, hint.Kind)
			}
			if ok && hint.Kind != tc.wantKind {
				t.Errorf("kind = %q, want %q", hint.Kind, tc.wantKind)
			}
			if ok && tc.wantDetail != "" && hint.Detail != tc.wantDetail {
				t.Errorf("detail = %q, want %q", hint.Detail, tc.wantDetail)
			}
		})
	}
}

// TestClassifyFailHint_NilError nil 错误显式断言（表格里用空串承载，单独点名防回退）
func TestClassifyFailHint_NilError(t *testing.T) {
	if _, ok := ClassifyFailHint(nil); ok {
		t.Fatal("nil error must not carry a hint")
	}
}

// TestFailHintKindStable kind 枚举值是对外契约（前端按 kind 渲染动作按钮、agent
// 按自愈映射分支、ops 手册登记），改动必须三侧同步——此处钉死防手滑改名
func TestFailHintKindStable(t *testing.T) {
	want := map[string]bool{
		"non-fast-forward":  true,
		"diverged":          true,
		"conflict":          true,
		"authentication":    true,
		"lock":              true,
		"dubious-ownership": true,
		"hook-rejected":     true,
		"network":           true,
	}
	got := []string{FailNonFastForward, FailDiverged, FailConflict, FailAuthentication, FailLock, FailDubiousOwnership, FailHookRejected, FailNetwork}
	if len(got) != len(want) {
		t.Fatalf("kind count = %d, want %d", len(got), len(want))
	}
	for _, k := range got {
		if !want[k] {
			t.Errorf("kind %q not in stable enum set", k)
		}
		if strings.ContainsAny(k, " \t") {
			t.Errorf("kind %q must be a machine-safe token", k)
		}
	}
}
