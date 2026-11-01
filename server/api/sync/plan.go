package sync

import (
	"context"
	"sort"
	"time"

	"codecombo/server/config"
	"codecombo/server/store"
)

// plan 四态判定（方案①二审修正·正确性前提）：每「单元×对端」以同步账本基线
// 为参照——两端=基线→跳过；本端变+对端未变→本端新（可安全推送）；对端变+
// 本端未变→对端新（可安全拉取）；两端都变→冲突；无基线→新增档。
//
// 方向语义：用户选「拉取」时新增/对端新走 pull，「本端新」在拉取方向仍是
// 安全项吗？不——拉取方向下「本端新」推送出去才保两端一致，但那违背用户显式
// 方向意图。裁决：plan 行始终给出客观四态与两端指纹差，Action 按「哪端更新」
// 给建议（本端新建议 push、对端新建议 pull），Selected 由请求方向决定：
// 拉取会话只勾选 pull 侧动作行，推送会话只勾选 push 侧动作行——方向指示器
// 与按钮文案双保险（方案③）在 UI 层表达，plan 层保持客观。

// BuildPlan 组装 plan：本端 manifest（可按 projectKeys/context 过滤）× 对端
// manifest × 账本基线 → PlanRow 集 + 对端磁盘预检
func BuildPlan(ctx context.Context, inst config.InstanceConfig, projectKeys []string, contexts []string) (*PlanResponse, error) {
	local := buildLocalManifest()
	peer, err := FetchPeerManifest(ctx, inst)
	if err != nil {
		if unsupported, isUnsupported := err.(*PeerUnsupportedError); isUnsupported {
			return &PlanResponse{
				PeerOnline:      true,
				PeerUnsupported: true,
				PeerVersion:     unsupported.Version,
				Message:         unsupported.Error(),
			}, nil
		}
		return &PlanResponse{PeerOnline: false, PeerStatus: "offline", Message: err.Error()}, nil
	}
	return planFromManifests(&local, peer, ledgerBaselineMap(), projectKeys, contexts), nil
}

// planFromManifests 纯函数形态（单测直测四态判定；ledger 账本基线由调用方供
// 给——键 = 单元键）
func planFromManifests(local, peer *ManifestResponse, ledger map[string]store.SyncLedgerEntry, projectKeys, contexts []string) *PlanResponse {
	resp := &PlanResponse{PeerOnline: true, PeerVersion: peer.Version, PeerDiskFree: peer.DiskFree}

	localByName := make(map[string]UnitEntry, len(local.Units))
	for _, u := range local.Units {
		localByName[u.Key] = u
	}
	peerByName := make(map[string]UnitEntry, len(peer.Units))
	for _, u := range peer.Units {
		peerByName[u.Key] = u
	}

	wantProject := map[string]bool{}
	for _, k := range projectKeys {
		wantProject[k] = true
	}
	wantContext := map[string]bool{}
	for _, k := range contexts {
		wantContext[k] = true
	}

	ledgerMap := ledger
	destRoot := peer.DestRoot
	if destRoot == "" {
		destRoot = peerDestRootFallback()
	}

	keys := make([]string, 0, len(localByName)+len(peerByName))
	seen := map[string]bool{}
	for k := range localByName {
		if unitInScope(k, wantProject, wantContext) {
			keys = append(keys, k)
		}
		seen[k] = true
	}
	for k := range peerByName {
		if !seen[k] && unitInScope(k, wantProject, wantContext) {
			keys = append(keys, k)
			seen[k] = true
		}
	}
	sort.Strings(keys)

	for _, k := range keys {
		lu, lok := localByName[k]
		pu, pok := peerByName[k]
		if lok && !lu.Exists {
			continue // 本端项目目录已消失：不产出行（Invalid 项目不参与同步）
		}
		row := PlanRow{UnitEntry: unitEntryFor(k, lu, lok, pu, pok)}
		base, hasBase := ledgerMap[k]
		row.BaselineMissing = !hasBase
		if hasBase {
			row.LastSyncedAt = base.SyncedAt.Format(time.RFC3339)
			row.LastDirection = base.Direction
		}

		// 四态判定（对端缺失该单元 = 对端侧视为「无内容」，与基线对账）
		peerFP, peerHas := "", pok && pu.Exists
		if peerHas {
			peerFP = pu.Fingerprint
		}
		localFP := ""
		if lok {
			localFP = lu.Fingerprint
		}
		switch {
		case !hasBase:
			row.State = PlanNew
		case localFP == base.LocalFP && peerFP == base.PeerFP:
			row.State = PlanSynced
		case localFP != base.LocalFP && peerFP == base.PeerFP:
			row.State = PlanLocalNewer
		case peerFP != base.PeerFP && localFP == base.LocalFP:
			row.State = PlanPeerNewer
		default:
			row.State = PlanConflict
		}

		// 建议动作 + 默认勾选（新增/单向更新默认勾，冲突默认不勾标黄）
		switch row.State {
		case PlanSynced:
			row.Action = PlanSkip
			row.Selected = false
		case PlanLocalNewer:
			row.Action = PlanPush
			row.Selected = true
		case PlanPeerNewer:
			row.Action = PlanPull
			row.Selected = true
		case PlanNew:
			// 新增档：单侧存在 = 存在侧为源（对端缺内容→push，本端缺→pull）；
			// 双侧都有 = 内容多的一侧为源（无基线时「哪边是权威」由内容量裁决）。
			// UI 允许改勾另一方向
			switch {
			case !pok:
				row.Action = PlanPush
			case !lok:
				row.Action = PlanPull
			case lu.Size >= pu.Size:
				row.Action = PlanPush
			default:
				row.Action = PlanPull
			}
			row.Selected = true
		case PlanConflict:
			row.Action = PlanSkip
			row.Selected = false
			// git 双向协作边界：双 git 仓库且两端都变——文件级覆盖会丢对端
			// 本地提交，建议走 git 自身 remote/fetch（风险节注记的 UI 呈现）
			row.GitBothChanged = lok && lu.GitRepo && pok && pu.GitRepo
		}

		// push 方向的落位路径预览（对端 DestRoot + 源目录基名，plan 预览明示）
		if row.Action == PlanPush && lok {
			row.DestPath = joinDestPath(destRoot, rootBasename(lu.Path), k)
		}
		if row.Truncated {
			// 枚举触顶：指纹不可信，强制冲突档保守处置（宁人工裁决不静默覆盖）
			row.State = PlanConflict
			row.Action = PlanSkip
			row.Selected = false
		}
		resp.Rows = append(resp.Rows, row)
		if row.Selected {
			resp.TotalBytes += row.Size
		}
	}

	// 磁盘预检（推送方向：对端可用空间 < 待传总量即红，不盲传）
	if resp.TotalBytes > 0 && resp.PeerDiskFree >= 0 && resp.TotalBytes > resp.PeerDiskFree {
		resp.PeerDiskInsufficient = true
	}
	return resp
}

// ledgerBaselineMap 账本 → 单元键基线映射
func ledgerBaselineMap() map[string]store.SyncLedgerEntry {
	out := map[string]store.SyncLedgerEntry{}
	entries, err := store.Get().SyncLedger.List()
	if err != nil {
		return out
	}
	for _, e := range entries {
		out[e.UnitKey] = e
	}
	return out
}

// peerDestRootFallback 对端未带 DestRoot（旧版载荷）时的展示回落：仅用于
// 预览，不落盘
func peerDestRootFallback() string { return "" }

// unitEntryFor 组装 plan 行的 UnitEntry（两端信息合并：本端字段优先，缺端补对端）
func unitEntryFor(key string, lu UnitEntry, lok bool, pu UnitEntry, pok bool) UnitEntry {
	if lok {
		e := lu
		if pok {
			e.Excluded += pu.Excluded
		}
		return e
	}
	return pu
}

// unitInScope plan 范围过滤：projectKeys 空=全部项目单元；contexts 空=全部
// 上下文（全局单元恒在——UI 单独勾选全局单元时传其键于 projectKeys? 不：
// 全局单元键就是 kind 名，wantProject 也收它）
func unitInScope(key string, wantProject, wantContext map[string]bool) bool {
	kind, base := ParseUnitKey(key)
	if kind == UnitCredentials {
		// 凭据档单元不进 plan 四态（P-20261024-3 红线）：plan 是定时/自动
		// 同步的选单元面，凭据档只在手动勾选开关的专用通道走——即使对端
		// manifest 异常携带该键也构造性排除（含键即 kind 的全局形态，
		// 须在全局单元分支之前拦截）
		return false
	}
	if base == "" {
		// 全局单元：键即 kind
		if len(wantProject) == 0 {
			return true
		}
		return wantProject[key]
	}
	switch kind {
	case UnitProject:
		if len(wantProject) == 0 {
			return true
		}
		return wantProject[key]
	case UnitDeliver:
		return false // 临时单元不进 plan
	default:
		if IsContextKind(kind) {
			if len(wantContext) > 0 && !wantContext[kind] {
				return false
			}
		}
		if len(wantProject) == 0 {
			return true
		}
		return wantProject[ProjectKeyOf(key)]
	}
}

// joinDestPath 落位路径预览（绝对根 + 目录名；rootBasename 空则仅前缀）
func joinDestPath(root, dirName, unitKey string) string {
	kind, _ := ParseUnitKey(unitKey)
	if kind != UnitProject {
		return ""
	}
	if dirName == "" {
		return root
	}
	return root + "/" + dirName
}
