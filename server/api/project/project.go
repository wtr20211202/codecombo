package project

import (
	"codecombo/server/api/files"
	"codecombo/server/api/gitops"
	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/api/system"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/model"
	"codecombo/server/store"
	"codecombo/server/terminal"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// 列出所有项目（并发获取仓库信息，避免串行调用N个git命令）
// 并发池上限 + 仓库信息走短 TTL 缓存（git.GetRepoInfoCached）——项目多时
// （真实用户 40+）每次页面挂载的全量扫描是首页卡顿主因，TTL 内合并为一次
func ListProjects(c *gin.Context) {
	projectConfigs, err := store.Get().Project.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Project operation failed", err)
		return
	}

	projects := make([]model.Project, len(projectConfigs))

	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, p := range projectConfigs {
		projects[i] = model.Project{
			ID:     p.ID,
			Name:   p.Name,
			Path:   p.Path,
			Frozen: p.Frozen,
			Locked: p.Locked,
		}
		wg.Add(1)
		go func(idx int, path string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			branch, remoteURL, gitRepo, pathOK := git.GetRepoInfoCached(path)
			projects[idx].Valid = pathOK
			projects[idx].GitRepo = gitRepo
			if gitRepo {
				projects[idx].CurrentBranch = branch
				projects[idx].RemoteURL = remoteURL
			}
		}(i, p.Path)
	}
	wg.Wait()

	c.JSON(http.StatusOK, gin.H{"data": projects})
}

// 添加项目
func AddProject(c *gin.Context) {
	var req model.AddProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Project operation failed", err)
		return
	}

	// 检查路径是否存在
	info, err := os.Stat(req.Path)
	if err != nil || !info.IsDir() {
		shared.Error(c, http.StatusBadRequest, "path does not exist or is not a directory", nil)
		return
	}

	// 重复添加检测：归一（Clean + 大小写折叠）后与现有项目比对——Windows/
	// macOS 大小写不敏感文件系统上 D:\work 与 D:\WORK 是同一目录，重复
	// 添加会生成两个项目互相踩踏（watch/终端/清理资源全双份）
	if norm, nerr := normalizeDirPath(req.Path); nerr == nil {
		if existing, lerr := store.Get().Project.List(); lerr == nil {
			for _, ep := range existing {
				if en, eerr := normalizeDirPath(ep.Path); eerr == nil && en == norm {
					shared.Error(c, http.StatusConflict, "project path already added", nil)
					return
				}
			}
		}
	}

	// 非 git 目录允许添加（GitRepo=false 标记）：编辑器/文件树/终端与 git 无关，
	// git 相关功能（分支/提交/历史）在该项目上降级。此前硬拒 400 把纯目录
	// 场景堵死（部署产物/笔记目录等也是合法工作对象）。
	// Valid 与 GitRepo 语义独立：Valid=路径存在可用（此刻刚校验过），GitRepo=是 git 仓库
	isGitRepo := git.IsRepo(req.Path)

	p := config.ProjectConfig{
		ID:   uuid.New().String(),
		Name: req.Name,
		Path: req.Path,
	}
	if err := store.Get().Project.Create(p); err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to save project: failed", err)
		return
	}

	// 获取仓库信息返回
	project := model.Project{
		ID:      p.ID,
		Name:    req.Name,
		Path:    p.Path,
		Valid:   true,
		GitRepo: isGitRepo,
	}
	if branch, err := git.GetCurrentBranch(p.Path); err == nil {
		project.CurrentBranch = branch
	}
	if remoteURL, err := git.GetRemoteURL(p.Path); err == nil {
		project.RemoteURL = remoteURL
	}

	// 运行期接入文件监听：经内核总线发布生命周期事件，watch 模块订阅后
	// 自管接入（历史上只有启动时建一次监听索引，此后添加的项目的文件变更
	// 永远不会被推送——事件因索引缺失被丢弃）
	publishLifecycle(TopicProjectAdded, project.ID, p.Path)

	// 智能操作通道：通知前端项目列表已变（订阅方自动刷新，外部 Agent 添加项目即时可见）
	opschannel.BroadcastEvent(opschannel.EventProjectsChanged, gin.H{"action": "added", "id": project.ID, "name": project.Name})

	slog.Info("project added", "name", req.Name, "path", req.Path)
	c.JSON(http.StatusCreated, gin.H{"data": project})
}

// 删除项目
func DeleteProject(c *gin.Context) {
	id := c.Param("id")

	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}

	if err := store.Get().Project.Delete(id); err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to remove project: failed", err)
		return
	}

	// 级联清理：摘除文件监听（经总线发布，watch 模块订阅后自管摘除；
	// 历史实现从不注销，watch 句柄随删除项目泄漏）
	publishLifecycle(TopicProjectRemoved, id, p.Path)

	// 级联清理：释放该项目的 git 缓存条目（status 条目持有完整文件状态列表
	// 与 ignored 集合，长期运行反复增删项目会缓慢驻留内存）
	git.InvalidateRepoCaches(p.Path)
	gitops.InvalidateGitStatusCache(p.Path)
	// 级联清理：释放该项目的 git 写队列条目（P-20261002-78，防泄漏）
	git.InvalidateRepoWriteQueue(p.Path)

	// 级联清理：杀掉该项目全部终端会话（Kill 语义释放底层 shell/tmux）。
	// 否则泄漏的会话会在前端恢复出指向已删项目的 tab，命令历史上报等请求持续 404
	for _, s := range terminal.DefaultManager.ListSessions() {
		if s.ProjectID == id {
			terminal.DefaultManager.CloseSession(s.ID)
		}
	}

	// 级联清理（P-20261006-36）：驻留智能体会话处置。kind=agent 会话免项目
	// 绑定（ProjectID 恒空），但常在项目目录里启动——删除后其 cwd 指向已删
	// 目录继续运行、恢复 tab 指向已删项目，是上面要防的「泄漏会话 404」的
	// agent 变体。默认保留（agent 可能正写盘到别处/长任务收尾，保守不杀，
	// 与既有行为一致）；前端确认框勾选「一并关闭」时携 closeAgentSessions=1
	// 随删除级联 CloseSession。识别口径见 terminal.ResidentAgentSessions
	//（Path 前缀匹配，前缀失配=不计入不级联，不恶化现状）。
	// P-20261006-35 挂接点（同批在途，本分支实施时其尚未合入）：其删除 impact
	// Summary 落地时应把 ResidentAgentSessions 的驻留计数一并计入，与前端
	// useProjectSessionImpact 的驻留计数（residentTotal）同口径。
	closeAgents := c.Query("closeAgentSessions") == "1"
	residents := terminal.DefaultManager.ResidentAgentSessions(p.Path)
	agentTerminated := 0
	if closeAgents {
		for _, s := range residents {
			terminal.DefaultManager.CloseSession(s.ID)
			agentTerminated++
		}
	}

	// 智能操作通道：通知前端项目列表已变。有过驻留智能体会话时增量携带处置
	// 结果（terminated=勾选级联关闭数 / preserved=按默认保留数）——智能体
	// 操作面删前自知影响、多端据广播对账；旧消费者忽略新键无影响
	projectsChanged := gin.H{"action": "removed", "id": id}
	if n := len(residents); n > 0 {
		projectsChanged["residentAgents"] = gin.H{
			"terminated": agentTerminated,
			"preserved":  n - agentTerminated,
		}
	}
	opschannel.BroadcastEvent(opschannel.EventProjectsChanged, projectsChanged)

	// 级联清理：摘除各实例 UI 状态中对已删项目的悬挂引用（projectId 指针 /
	// projectOrder / projectSessionOrder），防止后续页面布局恢复读到死 id
	system.CleanupProjectUIState(id)

	// 笔记不随项目删除（P-20261108-3 单库化：笔记独立不合项目关联，原级联删
	// 项目笔记退役）：若仍有迁移滞留的旧项目篇，趁项目名还在尽力带「[项目名] 」
	// 前缀并入全局库（满额则残留，下轮启动/手动续迁按原标题并入——零丢弃）
	migrateNotesOnProjectDelete(c, p)

	// 级联清理：删除项目本地文件历史（版本快照 + 容量台账，项目 ID 不复用的孤儿语义）
	if err := store.Get().FileHistory.DeleteProject(id); err != nil {
		slog.Warn("project file history cascade cleanup failed", "projectId", id, "err", err)
	}

	// 级联清理：删除项目回收站条目（P-20261003-304，孤儿语义——项目 ID 不复用，
	// 条目永无恢复入口；连同本地历史一并先行于响应）
	files.DeleteProjectTrash(id)

	// 级联清理：删除项目批量替换备份 patch（P-20261004-114，同上孤儿语义）
	files.DeleteProjectReplaceBackups(id)

	// 级联清理：删除项目替换历史文档（P-20261004-66，同上孤儿语义——历史与
	// 备份同生死：项目没了还原无意义，内嵌补丁的留档也随项目一锅端）
	store.Get().ReplaceHist.DeleteProject(id)

	// 级联清理：删除项目文件改动归因账（P-20261005-170，同上孤儿语义——
	// 项目 ID 不复用，账面无人可达；失败仅记日志，不阻断删除主链）
	if err := store.Get().FSAttribution.DeleteProject(id); err != nil {
		slog.Warn("project fs-attribution cascade cleanup failed", "projectId", id, "err", err)
	}

	// 审计入账（P-20261003-304 顺带补记）：项目删除是最高权重不可逆动作，此前
	// 此域空白（只记项目名，不记路径内容）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditProjectDelete,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: p.Name,
	})

	c.JSON(http.StatusOK, gin.H{"message": "project removed"})
}

// 获取项目详情
func GetProject(c *gin.Context) {
	id := c.Param("id")
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}

	project := model.Project{
		ID:     p.ID,
		Name:   p.Name,
		Path:   p.Path,
		Frozen: p.Frozen,
		Locked: p.Locked,
	}
	// 5s TTL 缓存（与 ListProjects 对齐）：详情被频繁拉取时不再每请求起
	// 2 个 git 子进程（GetCurrentBranch + GetRemoteURL）
	if branch, remoteURL, gitRepo, pathOK := git.GetRepoInfoCached(p.Path); true {
		project.Valid = pathOK
		project.GitRepo = gitRepo
		if gitRepo {
			project.CurrentBranch = branch
			project.RemoteURL = remoteURL
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": project})
}

// 重新定位项目路径（目录搬家/换盘/改名后恢复有效态）：项目 ID/名称不变，
// 仅更新 path——uiState（面板布局/展开态）、终端历史等以项目 ID 为键的
// 关联状态全部保留，替代「删项目重建丢状态」的唯一恢复路径
func RelocateProject(c *gin.Context) {
	id := c.Param("id")
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}

	var req model.RelocateProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Project operation failed", err)
		return
	}

	// 新路径必须存在且为目录（沿用 AddProject 的目录校验语义）
	info, err := os.Stat(req.Path)
	if err != nil || !info.IsDir() {
		shared.Error(c, http.StatusBadRequest, "path does not exist or is not a directory", nil)
		return
	}

	// 重复登记检测：归一后与其他项目比对（排除自身——指向当前路径的
	// 重定位是幂等 no-op，不应被误判冲突）
	if norm, nerr := normalizeDirPath(req.Path); nerr == nil {
		if existing, lerr := store.Get().Project.List(); lerr == nil {
			for _, ep := range existing {
				if ep.ID == id {
					continue
				}
				if en, eerr := normalizeDirPath(ep.Path); eerr == nil && en == norm {
					shared.Error(c, http.StatusConflict, "project path already added", nil)
					return
				}
			}
		}
	}

	oldPath := p.Path
	p.Path = req.Path
	if err := store.Get().Project.Update(*p); err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to save project: failed", err)
		return
	}

	// 缓存/监听迁移：旧路径的 git 缓存失效；文件监听经总线换绑
	//（watch 模块订阅 project.removed/project.added 自管摘除/接入，
	// 载荷 ID 不变，监听身份连续）
	git.InvalidateRepoCaches(oldPath)
	gitops.InvalidateGitStatusCache(oldPath)
	// 旧路径的 git 写队列条目同点释放（P-20261002-78，防泄漏）
	git.InvalidateRepoWriteQueue(oldPath)
	publishLifecycle(TopicProjectRemoved, id, oldPath)
	publishLifecycle(TopicProjectAdded, id, req.Path)

	// 智能操作通道：通知前端项目列表已变（首页订阅方自动刷新）
	opschannel.BroadcastEvent(opschannel.EventProjectsChanged, gin.H{"action": "relocated", "id": id, "name": p.Name})

	slog.Info("project relocated", "id", id, "name", p.Name, "oldPath", oldPath, "newPath", req.Path)

	// 响应与 AddProject 同构：Valid/GitRepo 按新路径现查（此刻刚校验过存在）
	project := model.Project{
		ID:      p.ID,
		Name:    p.Name,
		Path:    p.Path,
		Valid:   true,
		GitRepo: git.IsRepo(req.Path),
		Frozen:  p.Frozen,
	}
	if branch, err := git.GetCurrentBranch(p.Path); err == nil {
		project.CurrentBranch = branch
	}
	if remoteURL, err := git.GetRemoteURL(p.Path); err == nil {
		project.RemoteURL = remoteURL
	}

	c.JSON(http.StatusOK, gin.H{"data": project})
}

// 获取项目状态（文件变更列表）
// 复用 gitops 的 3s TTL 仓库缓存：文件树与状态接口此前各自起 git 全工作区扫描，
// 大仓库下是明显的重复开销；同一采集一次服务两端
func GetProjectStatus(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": gitops.CachedStatusList(p.Path)})
}

// 获取当前分支的 ahead/behind 信息（分支与 tracking 均走短 TTL 缓存；写操作已在 git 执行层自动失效）
func GetAheadBehind(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	branch, _, gitRepo, _ := git.GetRepoInfoCached(p.Path)
	if !gitRepo || branch == "" {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"ahead": 0, "behind": 0}})
		return
	}

	ahead, behind := git.GetBranchTrackingCached(p.Path, branch)
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ahead": ahead, "behind": behind}})
}

// ListAllAheadBehind 批量获取全部项目的 ahead/behind。
// 首页/项目页此前对每个项目各发一次 GET /projects/:id/ahead-behind（前端扇出 N 个
// 请求、服务端 2N 个 git 子进程），收敛为一次请求；项目间并发有上限（8），
// 结果走短 TTL 缓存（TTL 窗口内的页面切换合并为一次全量扫描），
// 单个项目失败按 0/0 处理（与 GetAheadBehind 缺省行为一致）
func ListAllAheadBehind(c *gin.Context) {
	projectConfigs, err := store.Get().Project.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Project operation failed", err)
		return
	}

	result := make(map[string]gin.H, len(projectConfigs))
	var mu sync.Mutex
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for _, p := range projectConfigs {
		// 冻结项目跳过探测（P-20261003-9）：死项目不参与首页徽章，省每项目
		// 1 次 git 子进程；响应缺其键，前端按 0/0 缺省（fetchAheadBehindMap 同语义）
		if p.Frozen {
			continue
		}
		wg.Add(1)
		go func(id, path string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			// 单进程批量：一次 for-each-ref 同时取 HEAD 分支与 tracking
			//（C5：冷启动每仓库子进程 ~3 → 1；TTL 窗口内零子进程）
			_, ahead, behind := git.GetHeadTrackingCached(path)
			mu.Lock()
			result[id] = gin.H{"ahead": ahead, "behind": behind}
			mu.Unlock()
		}(p.ID, p.Path)
	}
	wg.Wait()

	c.JSON(http.StatusOK, gin.H{"data": result})
}

// 辅助函数：从上下文中获取项目

// DirEntry 目录浏览条目（Link: 条目是符号链接/junction 且指向目录）
type DirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Link bool   `json:"link,omitempty"`
}

// parentEntry 父目录条目（前端浏览面板的常驻「上一级」按钮数据源）。
// path 为根时 filepath.Dir 返回自身——前端据此禁用按钮（已到顶）
func parentEntry(path string) DirEntry {
	return DirEntry{Name: "..", Path: filepath.Dir(path)}
}

// 浏览目录列表（用于添加项目时选择路径）
func BrowseDirectory(c *gin.Context) {
	path := c.Query("path")
	if path == "" {
		// 空路径默认起点：Windows 列盘符；Linux/Unix 列用户 home
		//（root 无域限制，直接从根目录 / 起步更实用）。此前 Linux 上走
		// 盘符枚举，26 个 Stat 全失败返回空列表——表现为「点了没反应」
		if runtime.GOOS != "windows" {
			start := "/"
			if os.Getuid() != 0 {
				if home, herr := os.UserHomeDir(); herr == nil && home != "" {
					start = home
				}
			}
			if dirs, err := listDirEntries(start); err == nil {
				c.JSON(http.StatusOK, gin.H{"data": append([]DirEntry{parentEntry(start)}, dirs...), "current": start})
				return
			}
			// home 不可读（异常环境）→ 回退根目录
			if dirs, err := listDirEntries("/"); err == nil {
				c.JSON(http.StatusOK, gin.H{"data": append([]DirEntry{parentEntry("/")}, dirs...), "current": "/"})
				return
			}
			c.JSON(http.StatusOK, gin.H{"data": []interface{}{}})
			return
		}
		if drives, err := listDrives(); err == nil && len(drives) > 0 {
			// 盘符列表已是最顶层（无父级），不追加 ..
			c.JSON(http.StatusOK, gin.H{"data": drives, "current": drives[0].Path})
			return
		}
		c.JSON(http.StatusOK, gin.H{"data": []interface{}{}})
		return
	}

	// Windows 盘符如 "D:" 指向当前目录而非根目录，补 "\" 修正为 "D:\"
	if len(path) == 2 && path[1] == ':' &&
		((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) {
		path = path + string(filepath.Separator)
	}
	// 确保路径分隔符一致
	path = filepath.Clean(path)

	dirs, err := listDirEntries(path)
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "Project operation failed", err)
		return
	}

	// 常驻父目录条目（含 Windows 盘根的 filepath.Dir 自身情形，前端据此禁用上级按钮）
	result := []DirEntry{parentEntry(path)}
	result = append(result, dirs...)

	c.JSON(http.StatusOK, gin.H{"data": result, "current": path})
}

// listDirEntries 列出目录下的子目录（不含文件），按名称不区分大小写排序。
// 符号链接/junction 指向目录的条目同样纳入（Link=true 供 UI 展示链接标记）：
// os.ReadDir 的 DirEntry.IsDir 对 symlink 返回 false（dirent 类型是链接本身），
// 需 Stat 跟随链接判断目标；悬空链接（目标不存在）跳过
func listDirEntries(path string) ([]DirEntry, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, err
	}
	dirs := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, DirEntry{
				Name: entry.Name(),
				Path: filepath.Join(path, entry.Name()),
			})
			continue
		}
		if entry.Type()&fs.ModeSymlink == 0 {
			continue
		}
		full := filepath.Join(path, entry.Name())
		if target, serr := os.Stat(full); serr == nil && target.IsDir() {
			dirs = append(dirs, DirEntry{Name: entry.Name(), Path: full, Link: true})
		}
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})
	return dirs, nil
}

// listDrives 列出 Windows 盘符，返回 {name, path} 格式
func listDrives() ([]DirEntry, error) {
	var drives []DirEntry
	for _, letter := range "ABCDEFGHIJKLMNOPQRSTUVWXYZ" {
		path := string(letter) + ":/"
		if _, err := os.Stat(path); err == nil {
			drives = append(drives, DirEntry{
				Name: string(letter) + ":",
				Path: path,
			})
		}
	}
	return drives, nil
}

// normalizeDirPath 目录路径归一（重复项目检测用）：Abs/Clean 展开 + 大小写
// 折叠——Windows/macOS 默认文件系统大小写不敏感，D:\work 与 D:\WORK 同目录
func normalizeDirPath(path string) (string, error) {
	abs, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	// 真实路径优先（符号链接/短路径名 8.3 形态归到实际目录）
	if real, e := filepath.EvalSymlinks(abs); e == nil {
		abs = real
	}
	return strings.ToLower(abs), nil
}
