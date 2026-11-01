package git

import (
	"testing"
)

// GetAheadLog（P-20261003-151 推送前 ahead 预览）：
//   - 领先 upstream 的提交清单（最新在前，主题行+短 hash）
//   - 与 upstream 同步时为空清单
//   - 未 tracking 分支（无 upstream）→ noUpstream 标志而非错误
//   - limit 截取最新 N 条
func TestGetAheadLog(t *testing.T) {
	work, _ := setupUpstreamRepo(t)

	// 与 upstream 同步：空清单、无 noUpstream 标志
	commits, noUpstream, err := GetAheadLog(work, 20)
	if err != nil || noUpstream {
		t.Fatalf("synced: err=%v noUpstream=%v", err, noUpstream)
	}
	if len(commits) != 0 {
		t.Fatalf("synced: want 0 commits, got %d", len(commits))
	}

	// 本地连打 3 个提交 → ahead 3，最新在前
	runGit(t, work, "commit", "--allow-empty", "-m", "ahead one")
	runGit(t, work, "commit", "--allow-empty", "-m", "ahead two")
	runGit(t, work, "commit", "--allow-empty", "-m", "ahead three")
	commits, noUpstream, err = GetAheadLog(work, 20)
	if err != nil || noUpstream {
		t.Fatalf("ahead: err=%v noUpstream=%v", err, noUpstream)
	}
	if len(commits) != 3 {
		t.Fatalf("ahead: want 3 commits, got %d", len(commits))
	}
	wantSubjects := []string{"ahead three", "ahead two", "ahead one"}
	for i, want := range wantSubjects {
		if commits[i].Message != want {
			t.Errorf("commits[%d].Message = %q, want %q (newest first)", i, commits[i].Message, want)
		}
		if commits[i].ShortHash == "" || commits[i].Hash == "" {
			t.Errorf("commits[%d] missing hash fields: %+v", i, commits[i])
		}
	}

	// limit=2 截取最新 2 条
	commits, _, err = GetAheadLog(work, 2)
	if err != nil {
		t.Fatalf("limit: err=%v", err)
	}
	if len(commits) != 2 || commits[0].Message != "ahead three" || commits[1].Message != "ahead two" {
		t.Fatalf("limit: want 2 newest, got %d: %v", len(commits), commits)
	}

	// 未 tracking 分支：noUpstream 标志 + 空清单，不算错误
	runGit(t, work, "switch", "-c", "feat-no-upstream")
	commits, noUpstream, err = GetAheadLog(work, 20)
	if err != nil {
		t.Fatalf("no-upstream: err=%v", err)
	}
	if !noUpstream {
		t.Fatalf("no-upstream: want noUpstream=true, commits=%d", len(commits))
	}
	if len(commits) != 0 {
		t.Fatalf("no-upstream: want 0 commits, got %d", len(commits))
	}
}
