package shareapi

// 分享健康投影（P-20261020-10）：管理列表逐行回答「这条短链的目标还在吗」。
// 访客面在目标丢失时只会得到 target_gone 的失效页，管理面此前仍显示正常行
// ——坏链静默存在。health 是纯响应投影（不落库、无 schema），取值：
//
//   - ok               目标可服务（live 目标存在 / 快照副本在盘 / 无文件锚点的形态）
//   - target_missing   live 文件分享的项目内目标已删除或移走
//   - project_gone     项目记录已删除，或项目根目录在盘上不可用
//   - snapshot_missing 冻结分享/终端快照/回放/会话回放的快照副本缺失
//
// live 行才做目标 stat（逐行一次 os.Root 探测，分享量级为用户手工创建的个位数
// 到十位数）；frozen 只看快照目录——项目删除后冻结链接仍按定格内容服务，
// 不应把可用的冻结链误报成 project_gone。

import (
	"os"

	"codecombo/server/share"
	"codecombo/server/store"
)

const (
	// ShareHealthOK 目标可服务
	ShareHealthOK = "ok"
	// ShareHealthTargetMissing live 分享的项目内目标不存在
	ShareHealthTargetMissing = "target_missing"
	// ShareHealthProjectGone 项目记录或项目根目录不可用
	ShareHealthProjectGone = "project_gone"
	// ShareHealthSnapshotMissing 冻结副本/快照文件不在盘
	ShareHealthSnapshotMissing = "snapshot_missing"
)

// shareHealthProbe 单次列表请求的健康探测上下文：同一项目的存活判定只查
// 一次（列表按项目聚集，逐行 GetByID 会重复读配置缓存/遍历项目表）
type shareHealthProbe struct {
	st       *store.Store
	projects map[string]projectRootState
}

type projectRootState struct {
	root string
	ok   bool
}

func newShareHealthProbe(st *store.Store) *shareHealthProbe {
	return &shareHealthProbe{st: st, projects: make(map[string]projectRootState)}
}

// rootOf 项目根目录（存在且为目录才算可用）；失败结果同样缓存，避免同一
// 坏项目在循环里反复 stat
func (p *shareHealthProbe) rootOf(projectID string) (string, bool) {
	if state, ok := p.projects[projectID]; ok {
		return state.root, state.ok
	}
	state := projectRootState{}
	if projectID != "" {
		if proj, err := p.st.Project.GetByID(projectID); err == nil && proj.Path != "" {
			if info, serr := os.Stat(proj.Path); serr == nil && info.IsDir() {
				state = projectRootState{root: proj.Path, ok: true}
			}
		}
	}
	p.projects[projectID] = state
	return state.root, state.ok
}

// health 单条分享的健康判定。s 按值传入（调用方持 range 变量无指针别名顾虑）
func (p *shareHealthProbe) health(s store.Share) string {
	switch s.Kind {
	case store.ShareKindSnippet, store.ShareKindTerminal:
		// 片段内容随记录落库；终端直播的内容源是会话语义（会话结束访客页
		// 显示「已结束」而非坏链），没有可 stat 的文件目标
		return ShareHealthOK
	case store.ShareKindTermFrozen:
		if name := snapshotDirName(&s); name != "" && share.HasTermFrozenSnapshot(name) {
			return ShareHealthOK
		}
		return ShareHealthSnapshotMissing
	case store.ShareKindCast:
		if name := snapshotDirName(&s); name != "" && share.HasCastSnapshot(name) {
			return ShareHealthOK
		}
		return ShareHealthSnapshotMissing
	case store.ShareKindSession:
		if name := snapshotDirName(&s); name != "" && share.HasSessionSnapshot(name) {
			return ShareHealthOK
		}
		return ShareHealthSnapshotMissing
	case store.ShareKindFile, "":
		return p.fileHealth(s)
	}
	// 未知未来形态：无健康判定口径，按 ok 消极放行（不误报坏链；新增形态
	// 时应在此显式登记判定）
	return ShareHealthOK
}

// fileHealth file 形态（Kind 零值按 file 解读，存量记录零迁移）：
// frozen 只看快照副本（自包含，项目删除不影响）；live 才探测项目根+目标。
func (p *shareHealthProbe) fileHealth(s store.Share) string {
	if s.Frozen {
		if name := snapshotDirName(&s); name != "" && share.HasFrozenSnapshot(name) {
			return ShareHealthOK
		}
		return ShareHealthSnapshotMissing
	}
	root, ok := p.rootOf(s.ProjectID)
	if !ok {
		return ShareHealthProjectGone
	}
	if _, err := share.StatTarget(root, s.Path); err != nil {
		return ShareHealthTargetMissing
	}
	return ShareHealthOK
}
