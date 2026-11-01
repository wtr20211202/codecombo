//go:build !windows

package terminal

import (
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/store"
)

// projectHashPrefix 计算 projectId 的 SHA-256 前 8 位 hex
// 与 computeTmuxSessionName 中的算法一致，用于反查 session 归属项目
func projectHashPrefix(projectID string) string {
	return sha256Prefix(projectID, 8)
}

// listSessionsBothSockets 新旧两枚专属 socket 的 list-sessions 并集
// （`session_name\tcreated` 行；同名列新 socket 优先）。两枚都不可用返回空串。
// 切换期专用：旧 socket server 随末个会话退出后自然退化为单 socket 列举
func listSessionsBothSockets() string {
	seen := map[string]bool{}
	var lines []string
	for _, sock := range []string{tmuxSocketName, legacyTmuxSocketName} {
		out, err := runTmuxBinary([]string{"-L", sock, "list-sessions", "-F", "#{session_name}\t#{session_created}"})
		if err != nil {
			continue // no server running / tmux 缺失：该 socket 无会话
		}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line == "" {
				continue
			}
			name := strings.TrimSpace(strings.SplitN(line, "\t", 2)[0])
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			lines = append(lines, line)
		}
	}
	return strings.Join(lines, "\n")
}

// RecoverSessions 启动时扫描所有 sc- 前缀的 tmux session，按项目归类重新挂回 Manager
// 流程：
//  1. tmux list-sessions 列举所有 session 名（含 simple-coding 专属 socket 上的）
//  2. 正则解析 sc-<projHash>-<rand>
//  3. 按 projHash 反查项目（store.Project.List 中匹配 SHA-256 前 8 位）
//  4. 找到项目 → RegisterRecoveredSession 加回 Manager；找不到 → kill-session 清理孤儿
//
// 仅 tmux 可用时调用（windows 平台不会执行；main.go 应在调用前判断）
func RecoverSessions() int {
	if !isTmuxAvailable() {
		slog.Debug("terminal: tmux unavailable, skip session recovery")
		return 0
	}

	// 列出本系统专属 socket 上的所有 tmux session（新旧两枚 socket 并集，
	// P-20261025-1 socket 更名的切换期兼容：挂旧 socket 的在途会话同样恢复
	// 接管；同名列新 socket 优先——恢复/IO 的 socket 定向由 runTmux 回落链保证）
	out := listSessionsBothSockets()
	if out == "" {
		// 两枚 socket 都 no server running 是正常情况（首次启动）
		slog.Debug("terminal: tmux list-sessions returned no sessions")
		return 0
	}

	// 构造项目哈希反查表：hash → project
	projects, err := store.Get().Project.List()
	if err != nil {
		slog.Warn("terminal: failed to list projects for recovery", "err", err)
		return 0
	}
	projectByHash := make(map[string]config.ProjectConfig, len(projects))
	for _, p := range projects {
		hash := projectHashPrefix(p.ID)
		projectByHash[hash] = p
	}

	recovered := 0
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for _, line := range lines {
		if line == "" {
			continue
		}
		parts := strings.Split(line, "\t")
		if len(parts) < 1 {
			continue
		}
		name := strings.TrimSpace(parts[0])
		projHash, _, ok := parseTmuxSessionName(name)
		if !ok {
			// 不是 simple-coding 管理的 session（可能是用户的，跳过）
			continue
		}

		// 智能体终端：哨兵项目哈希归类为 agent 会话（免项目绑定），不参与
		// 项目孤儿清理——tmux 底层会话（含其中的智能体进程）随重启存活
		if projHash == projectHashPrefix(store.AgentProjectID) {
			home, _ := os.UserHomeDir()
			createdAt := time.Now()
			if len(parts) >= 2 {
				if ts, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err == nil {
					createdAt = time.Unix(ts, 0)
				}
			}
			// 恢复会话工作目录（产出视图/cwd 标签依赖）：优先查创建时落库的
			// 会话元数据（保留原始目录与产出基线），无元数据（功能上线前的
			// 老会话）取 tmux pane 当前路径兜底，再退回主目录
			dir := home
			meta, metaErr := store.Get().AgentSession.Get(name)
			if metaErr == nil && meta != nil && meta.Dir != "" {
				dir = meta.Dir
			} else {
				if out, err := runTmux("display-message", "-p", "-t", name, "#{pane_current_path}"); err == nil {
					if p := strings.TrimSpace(string(out)); p != "" {
						dir = p
					}
				}
			}
			// 显示名还原：优先用建会话/重命名时落库的名字（否则全部变回
			// 默认名，用户视角就是"会话被复原了"）；无名字记录退回 "Agent"
			displayName := "Agent"
			if metaErr == nil && meta != nil && meta.Name != "" {
				displayName = meta.Name
			}
			session := &Session{
				ID:        name,
				Name:      displayName,
				Kind:      KindAgent,
				Origin:    OriginSelf,
				Path:      dir,
				CreatedAt: createdAt,
				Backend:   string(BackendTmux),

				spec: SessionSpec{
					ID:       name,
					Name:     displayName,
					Shell:    getShell(),
					Dir:      dir,
					TmuxName: name,
				},
				backend: newTmuxBackend(),

				onOutput: make(map[int64]func(data []byte)),
				onExit:   make(map[int64]func(exitCode int)),

				devPort:     newDevPortDetector(name),
				sentinel:    newSentinelDetector(name, ""),
				osc:         newOscStateDetector(),
				cwd:         newCWDDetector(),
				gitActivity: newGitActivityDetector(name, ""),
			}
			if err := DefaultManager.RegisterRecoveredSession(session); err != nil {
				slog.Warn("terminal: failed to recover agent session", "session", name, "err", err)
				continue
			}
			// 产出视图元数据补记：有元数据的（保留原基线）不动；
			// 老会话补一条（基线=恢复时刻的 HEAD，重启前的改动无法归属，如实取舍）
			if metaErr != nil || meta == nil {
				meta := store.AgentSessionMeta{
					ID:        name,
					Dir:       dir,
					Runtime:   "",
					CreatedAt: createdAt,
				}
				if head, err := git.RevParseHead(dir); err == nil {
					meta.StartHead = head
				}
				if err := store.Get().AgentSession.Save(meta); err != nil {
					slog.Warn("terminal: agent session meta backfill failed", "session", name, "err", err)
				}
			}
			recovered++
			slog.Info("terminal: recovered agent tmux session", "session", name, "dir", dir)
			continue
		}

		// 反查项目
		project, found := projectByHash[projHash]
		if !found {
			// 孤儿 session：项目已删除，清理掉避免泄漏
			slog.Warn("terminal: orphan tmux session (project not found), killing",
				"session", name, "projHash", projHash)
			if _, err := runTmux("kill-session", "-t", name); err != nil {
				slog.Warn("terminal: failed to kill orphan session",
					"session", name, "err", err)
			}
			continue
		}

		// 解析创建时间（仅用于 Session.CreatedAt 还原，失败也不影响恢复）
		createdAt := time.Now()
		if len(parts) >= 2 {
			if ts, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64); err == nil {
				createdAt = time.Unix(ts, 0)
			}
		}

		// 显示名还原：建会话/重命名时落过名的（含项目终端）按记录还原，
		// 未落名的退回项目名
		displayName := project.Name
		if meta, err := store.Get().AgentSession.Get(name); err == nil && meta != nil && meta.Name != "" {
			displayName = meta.Name
		}

		// 构造恢复的 Session 对象
		// backend 用 tmuxBackend，spec.TmuxName 设为已有的 tmux session 名（不再重新生成）
		// session.ID 与 create 时一致（= tmux session name），保证通知中心等引用旧 ID 的功能不会失效
		session := &Session{
			ID:        name,
			Name:      displayName,
			ProjectID: project.ID,
			Origin:    OriginSelf,
			Path:      project.Path,
			CreatedAt: createdAt,
			Backend:   string(BackendTmux),

			spec: SessionSpec{
				ID:        name,
				Name:      displayName,
				ProjectID: project.ID,
				Shell:     getShell(),
				Dir:       project.Path,
				TmuxName:  name,
			},
			backend: newTmuxBackend(),

			onOutput: make(map[int64]func(data []byte)),
			onExit:   make(map[int64]func(exitCode int)),

			devPort:     newDevPortDetector(name),
			sentinel:    newSentinelDetector(name, project.ID),
			osc:         newOscStateDetector(),
			cwd:         newCWDDetector(),
			gitActivity: newGitActivityDetector(name, project.ID),
		}

		if err := DefaultManager.RegisterRecoveredSession(session); err != nil {
			slog.Warn("terminal: failed to recover session",
				"session", name, "err", err)
			continue
		}
		recovered++
		slog.Info("terminal: recovered tmux session",
			"session", name, "project", project.Name, "projectId", project.ID)
	}

	if recovered > 0 {
		slog.Info("terminal: session recovery completed", "recovered", recovered)
	}
	return recovered
}

// HealthCheck 扫描 Manager 中所有 tmux session，清理底层已不存活的引用
// 由 main.go 启动周期性 goroutine 调用（1 分钟一次）
// native session 不需要此检查（shell 死时 readLoop 已经清理）
func HealthCheck() {
	// 直接引用原锁：此前 `mu := DefaultManager.mu` 复制了锁值，RLock 锁的是
	// 副本——对并发 CreateSession/CloseSession 的互斥完全失效（vet 检出）
	DefaultManager.mu.RLock()
	sessionIDs := make([]string, 0, len(DefaultManager.sessions))
	for id, s := range DefaultManager.sessions {
		// 仅检查 tmux 持久化 session
		if s.IsPersistent() {
			sessionIDs = append(sessionIDs, id)
		}
	}
	DefaultManager.mu.RUnlock()

	for _, id := range sessionIDs {
		// 重新获取 session（可能在锁外被 CloseSession 删除）
		s := DefaultManager.GetSession(id)
		if s == nil {
			continue
		}
		if !s.backend.Alive(s.spec) {
			slog.Info("terminal: removing dead session from manager",
				"id", s.ID, "tmuxName", s.spec.TmuxName)
			DefaultManager.mu.Lock()
			delete(DefaultManager.sessions, id)
			DefaultManager.mu.Unlock()
		}
	}
}
