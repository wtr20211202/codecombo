package sync

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"codecombo/server/claudesessions"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/store"
)

// 本端 manifest 构建：项目本体 + 上下文单元 + 全局单元的聚合清单。
// 指纹口径统一为「工作区档」（不含 .git）：传输可选携带 .git（含 .git 档），
// 但账本基线恒用工作区档指纹——.git 有无不影响两端对账，避免「推了 .git 的
// 一端」与「没推的一端」因指纹口径不同而永久冲突。

// buildLocalManifest 组装本端全部单元（deliver 单元是临时构造不在此列）。
// 单项目场景可传 projectID 过滤（进度/单项目重试路径）。
func buildLocalManifest(projectIDs ...string) ManifestResponse {
	resp := ManifestResponse{}
	projects, err := store.Get().Project.List()
	if err != nil {
		return resp
	}
	filter := map[string]bool{}
	for _, id := range projectIDs {
		filter[id] = true
	}
	for _, p := range projects {
		if len(filter) > 0 && !filter[p.ID] {
			continue
		}
		resp.Units = append(resp.Units, projectUnits(p)...)
	}
	resp.Units = append(resp.Units, globalUnits()...)
	resp.DiskFree = diskFree(dataRootForDiskCheck())
	resp.DestRoot = syncDestRoot()
	resp.Version = buildVersion()
	return resp
}

// projectUnits 单项目的本体+上下文单元
func projectUnits(p config.ProjectConfig) []UnitEntry {
	units := make([]UnitEntry, 0, 4)
	base := rootBasename(p.Path)
	if base == "" {
		return units // 病态路径（空/纯盘符）：跳过不产出单元
	}
	pk := UnitKey(UnitProject, base)

	// 项目本体（工作区档指纹；GitRepo 标记供双向协作提示）
	scan, err := enumerateUnitDir(p.Path, false, false)
	ent := UnitEntry{
		Key: pk, Kind: UnitProject, ProjectKey: "", Name: p.Name,
		Path: p.Path, GitRepo: gitIsRepo(p.Path), Exists: err == nil,
		Excluded: scan.excluded, Truncated: scan.truncated,
	}
	if err == nil {
		ent.Fingerprint = fingerprintFiles(scan.files)
		ent.Size = sumSizes(scan.files)
		ent.Files = len(scan.files)
	}
	units = append(units, ent)

	// 上下文单元（存在即列出——空内容单元指纹为空串，plan 按新增档处置）
	if n, ok := notesUnit(p, pk); ok {
		units = append(units, n)
	}
	if s, ok := sessionsUnit(p, pk); ok {
		units = append(units, s)
	}
	if c, ok := cronsUnit(p, pk); ok {
		units = append(units, c)
	}
	return units
}

// notesUnit 项目笔记单元
func notesUnit(p config.ProjectConfig, projectKey string) (UnitEntry, bool) {
	note, err := store.Get().ProjectNotes.Get(p.ID)
	if err != nil || strings.TrimSpace(note.Content) == "" {
		return UnitEntry{}, false
	}
	return UnitEntry{
		Key: UnitKey(UnitNotes, rootBasename(p.Path)), Kind: UnitNotes,
		ProjectKey: projectKey, Name: p.Name + " · 笔记",
		Fingerprint: hashBytes([]byte(note.Content)),
		Size:        int64(len(note.Content)), Files: 1, Exists: true,
	}, true
}

// sessionsUnit agent 会话单元：transcripts（claude projects 下该工作目录对应
// 编码目录的 *.jsonl）+ 人工策展（claudecur 按 root 前缀圈定，session 在目录
// 内才算——vanished 策展不产生幽灵内容）。会话文件可达数百 MB：只列元数据，
// 枚举上限同 maxUnitEntries
func sessionsUnit(p config.ProjectConfig, projectKey string) (UnitEntry, bool) {
	root := claudesessions.Root()
	if root == "" {
		return UnitEntry{}, false
	}
	dir := filepath.Join(root, claudesessions.EncodePath(strings.TrimRight(p.Path, `\/`)))
	entries, err := os.ReadDir(dir)
	if err != nil {
		return UnitEntry{}, false // 无会话目录 = 无内容（对端有会话本端没有时按新增档拉入）
	}
	var files []fileEntry
	var size int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		if len(files) >= maxUnitEntries {
			break
		}
		files = append(files, fileEntry{rel: "transcripts/" + e.Name(), size: info.Size()})
		size += info.Size()
	}
	// 策展（同目录内会话的星标/备注/书签/标签）
	curJSON := curationPayloadJSON(root, dir, entries)
	if len(files) == 0 && len(curJSON) == 0 {
		return UnitEntry{}, false
	}
	if len(curJSON) > 0 {
		files = append(files, fileEntry{rel: "curation.json", size: int64(len(curJSON))})
		size += int64(len(curJSON))
	}
	sortFiles(files)
	return UnitEntry{
		Key: UnitKey(UnitSessions, rootBasename(p.Path)), Kind: UnitSessions,
		ProjectKey: projectKey, Name: p.Name + " · 会话",
		Fingerprint: fingerprintFiles(files), Size: size, Files: len(files), Exists: true,
	}, true
}

// cronsUnit 项目域定时任务单元：agentcron 中 Dir 落在项目路径内的任务
// （agentcron.Dir = 会话工作目录，项目域 = 前缀归属）
func cronsUnit(p config.ProjectConfig, projectKey string) (UnitEntry, bool) {
	crons, err := store.Get().AgentCron.List()
	if err != nil {
		return UnitEntry{}, false
	}
	root := strings.TrimRight(p.Path, `\/`)
	var mine []store.AgentCron
	for _, c := range crons {
		if c.Dir != "" && dirWithin(c.Dir, root) {
			mine = append(mine, c)
		}
	}
	if len(mine) == 0 {
		return UnitEntry{}, false
	}
	sort.Slice(mine, func(i, j int) bool { return mine[i].ID < mine[j].ID })
	b, _ := json.Marshal(mine)
	return UnitEntry{
		Key: UnitKey(UnitCrons, rootBasename(p.Path)), Kind: UnitCrons,
		ProjectKey: projectKey, Name: p.Name + " · 定时任务",
		Fingerprint: hashBytes(b), Size: int64(len(b)), Files: 1, Exists: true,
	}, true
}

// globalUnits 全局单元（不挂项目）：片段/运行时注册/审批规则/接续链/uiState
func globalUnits() []UnitEntry {
	units := make([]UnitEntry, 0, 5)
	nameOf := map[string]string{
		UnitSnippets: "命令与代码片段（全局）", UnitRuntimes: "自定义智能体运行时",
		UnitApprovals: "审批规则表", UnitChains: "会话接续链定义", UnitUIState: "界面偏好（uiState）",
	}
	for _, kind := range []string{UnitSnippets, UnitRuntimes, UnitApprovals, UnitChains, UnitUIState} {
		b := globalUnitPayload(kind)
		if len(b) == 0 {
			continue
		}
		units = append(units, UnitEntry{
			Key: kind, Kind: kind, Name: nameOf[kind],
			Fingerprint: hashBytes(b), Size: int64(len(b)), Files: 1, Exists: true,
		})
	}
	return units
}

// globalUnitPayload 全局单元 JSON 载荷单一出口（manifest 与打包共用——指纹与
// 载荷同源，避免两处构造漂移）
func globalUnitPayload(kind string) []byte {
	switch kind {
	case UnitSnippets:
		return globalSnippetsJSON()
	case UnitRuntimes:
		return runtimesJSON()
	case UnitApprovals:
		return approvalsJSON()
	case UnitChains:
		return chainsJSON()
	case UnitUIState:
		return uiStateJSON()
	}
	return nil
}

// globalSnippetsJSON 全局片段（host 域片段是「本机命令」语义——对端机器未必
// 有同款命令，刻意不入载荷）
func globalSnippetsJSON() []byte {
	snippets, err := store.Get().Snippet.List()
	if err != nil {
		return nil
	}
	var glob []store.Snippet
	for _, s := range snippets {
		if s.Scope == "global" {
			glob = append(glob, s)
		}
	}
	if len(glob) == 0 {
		return nil
	}
	sort.Slice(glob, func(i, j int) bool { return glob[i].ID < glob[j].ID })
	b, _ := json.Marshal(glob)
	return b
}

func runtimesJSON() []byte {
	cfg := store.Get().Settings.Get()
	if cfg == nil || len(cfg.Server.CustomAgents) == 0 {
		return nil
	}
	b, _ := json.Marshal(cfg.Server.CustomAgents)
	return b
}

func approvalsJSON() []byte {
	cfg := store.Get().Settings.Get()
	if cfg == nil || len(cfg.Server.AgentApprovalRules) == 0 {
		return nil
	}
	b, _ := json.Marshal(cfg.Server.AgentApprovalRules)
	return b
}

func chainsJSON() []byte {
	chains, err := store.Get().AgentChain.List()
	if err != nil {
		return nil
	}
	if len(chains) == 0 {
		return nil
	}
	// 只传定义（源会话 ID 保留原样——对端源会话不存在即链失效态，定义不丢；
	// 运行期事实不入载荷）
	type chainDef struct {
		PromptTemplate string `json:"promptTemplate"`
		Runtime        string `json:"runtime,omitempty"`
		Dir            string `json:"dir,omitempty"`
		OnFailure      bool   `json:"onFailure,omitempty"`
	}
	defs := make([]chainDef, 0, len(chains))
	for _, c := range chains {
		defs = append(defs, chainDef{
			PromptTemplate: c.PromptTemplate, Runtime: c.Runtime,
			Dir: c.Dir, OnFailure: c.OnFailure,
		})
	}
	b, _ := json.Marshal(defs)
	return b
}

func uiStateJSON() []byte {
	state, err := store.Get().UIState.Get()
	if err != nil || len(state) == 0 {
		return nil
	}
	b, _ := json.Marshal(state)
	return b
}

// curationPayloadJSON 指定 transcripts 目录内会话的策展载荷（landed 侧按
// 会话 UUID 以对端 root 重算键写回——键规则 <rootHash8>__<uuid> 两端各自成立）
func curationPayloadJSON(root, transcriptsDir string, entries []os.DirEntry) []byte {
	prefix := store.ClaudeCurPrefix(root)
	curs, err := store.Get().ClaudeCur.GetBatch(prefix)
	if err != nil || len(curs) == 0 {
		return nil
	}
	ids := map[string]bool{}
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".jsonl") {
			ids[strings.TrimSuffix(e.Name(), ".jsonl")] = true
		}
	}
	type curItem struct {
		ID        string                `json:"id"`
		Starred   bool                  `json:"starred,omitempty"`
		Note      string                `json:"note,omitempty"`
		Hidden    bool                  `json:"hidden,omitempty"`
		Bookmarks []string              `json:"bookmarks,omitempty"`
		Tags      []store.ClaudeTurnTag `json:"tags,omitempty"`
	}
	items := make([]curItem, 0, len(curs))
	for _, c := range curs {
		if !ids[c.ID] {
			continue
		}
		items = append(items, curItem{
			ID: c.ID, Starred: c.Starred, Note: c.Note, Hidden: c.Hidden,
			Bookmarks: c.Bookmarks, Tags: c.Tags,
		})
	}
	if len(items) == 0 {
		return nil
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	b, _ := json.Marshal(items)
	return b
}

// dirWithin 判断 p 是否在 root 内（同项目域判定：Clean 后大小写敏感比较——
// 路径归属按字面，不假设文件系统大小写不敏感）
func dirWithin(p, root string) bool {
	p = filepath.Clean(p)
	root = filepath.Clean(root)
	if p == root {
		return true
	}
	return strings.HasPrefix(p, root+string(filepath.Separator))
}

func gitIsRepo(path string) bool {
	return git.IsRepoProbe(path)
}

func sumSizes(files []fileEntry) (n int64) {
	for _, f := range files {
		n += f.size
	}
	return n
}

// hashBytes 任意字节载荷的稳定哈希（上下文/全局单元的指纹口径）
func hashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// dataRootForDiskCheck 磁盘预检取样目录（数据目录所在卷——落位根大概率同卷；
// 卷不同时对端落位层还有实际写失败兜底，预检是尽力而为的提前量）
func dataRootForDiskCheck() string { return config.DataDir() }
