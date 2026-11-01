package sync

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 定时同步执行（方案⑤）：agentcron sync kind 语义——到点 plan→按冲突策略
// 档位执行：
//   - safe：只做安全项（push 方向 = local-newer 行；pull 方向 = peer-newer 行
//     + 新增档），冲突项留通知中心裁决（不带 action 的提示条目，点进同步中心）
//   - local-mirror：本端为准镜像——冲突按「本端为准」推平（备份场景 A→B 定时
//     推送需要镜像档，不能事事人工裁决）
//   - peer-mirror：对端为准镜像——冲突按「对端为准」拉平
//
// 对端非 online 跳过并入账原因（History/LastNote 如实记录）。

// runDueCrons 评估到点任务并执行（分钟巡检入口）。任务量小（用户手工维护），
// 串行逐任务评估；同任务执行互斥由「LastRunAt 槽点去重 + 到点即标」保证
// （与 agentcron 同范式：先记 LastRunAt 再执行，防巡检重入）
func runDueCrons(now time.Time) {
	crons, err := store.Get().SyncCron.List()
	if err != nil {
		return
	}
	for _, t := range crons {
		if !t.Enabled {
			continue
		}
		loc := t.Location()
		nowLocal := now.In(loc)
		if !t.IsDue(nowLocal) {
			continue
		}
		// 当日槽点去重（LastRunAt 已在当槽即跳过——重启追赶由 MissCatchUp 档处理）
		if !t.LastRunAt.IsZero() {
			prev := t.LastRunAt.In(loc)
			sameSlot := prev.Year() == nowLocal.Year() && prev.Month() == nowLocal.Month() &&
				prev.Day() == nowLocal.Day() && prev.Hour() == nowLocal.Hour() && prev.Minute() == nowLocal.Minute()
			if sameSlot {
				continue
			}
		}
		_ = store.Get().SyncCron.RecordRun(t.ID, now, "running", "")
		runSyncCron(t, now)
	}
}

// runSyncCron 执行单个定时同步任务（同步执行——分钟巡检 goroutine 串行，
// 与手动任务互斥由 execRunning 闸保证；撞上时本任务记 skipped）
func runSyncCron(t store.SyncCron, now time.Time) {
	if execRunningFlag() {
		_ = store.Get().SyncCron.RecordRun(t.ID, now, "skipped", "another sync is running")
		return
	}
	setExecRunning(true)
	defer setExecRunning(false)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	note, result := runSyncCronCtx(ctx, t)
	_ = store.Get().SyncCron.RecordRun(t.ID, now, result, note)
	notifyCronDone(t, result, note)
}

// runSyncCronCtx 执行主体：逐对端 plan → 按策略过滤 → executeSync。
// 返回 (note, result)
func runSyncCronCtx(ctx context.Context, t store.SyncCron) (string, string) {
	if len(t.PeerIDs) == 0 {
		return "no peer configured", "failed"
	}
	peers, err := resolveInstances(t.PeerIDs)
	if err != nil {
		return err.Error(), "failed"
	}
	direction := t.Direction
	if direction != store.SyncCronDirPull && direction != store.SyncCronDirPush {
		return "invalid direction", "failed"
	}

	var parts []string
	var failed int
	for _, peer := range peers {
		if store.Get().Instance.GetStatus(peer.ID) == "offline" {
			parts = append(parts, peer.Name+": offline")
			failed++
			continue // 对端非 online 跳过并入账原因
		}
		plan, err := BuildPlan(ctx, peer, t.ProjectKeys, t.Contexts)
		if err != nil {
			parts = append(parts, peer.Name+": plan failed")
			failed++
			continue
		}
		if plan.PeerUnsupported {
			parts = append(parts, peer.Name+": needs upgrade")
			failed++
			continue
		}
		units, conflicts := selectUnitsForPolicy(plan, direction, t.ConflictPolicy)
		if len(units) == 0 {
			if conflicts > 0 {
				parts = append(parts, fmt.Sprintf("%s: %d conflicts pending", peer.Name, conflicts))
			} else {
				parts = append(parts, peer.Name+": in-sync")
			}
			continue
		}
		req := ExecuteRequest{
			InstanceIDs:    []string{peer.ID},
			Units:          units,
			IncludeIgnored: t.IncludeIgnored,
			Parallel:       1,
		}
		// 镜像档的冲突单元显式裁决（safe 档冲突单元不在 units 内）
		if t.ConflictPolicy == store.SyncPolicyLocalMirror {
			req.Resolutions = mirrorResolutions(plan, direction, "local")
		} else if t.ConflictPolicy == store.SyncPolicyPeerMirror {
			req.Resolutions = mirrorResolutions(plan, direction, "peer")
		}
		res, err := executeSyncCtx(ctx, req, direction, "cron")
		if err != nil {
			parts = append(parts, peer.Name+": "+err.Error())
			failed++
			continue
		}
		okCount, failCount := 0, 0
		for _, u := range res.Units {
			if u.OK {
				okCount++
			} else if !u.Skipped {
				failCount++
			}
		}
		failed += failCount
		if conflicts > 0 && t.ConflictPolicy == store.SyncPolicySafe {
			notifyConflicts(t, peer, conflicts)
			parts = append(parts, fmt.Sprintf("%s: %d synced, %d conflicts left for review", peer.Name, okCount, conflicts))
		} else {
			parts = append(parts, fmt.Sprintf("%s: %d synced", peer.Name, okCount))
		}
	}
	if failed > 0 {
		return strings.Join(parts, "; "), "partial"
	}
	return strings.Join(parts, "; "), "synced"
}

// selectUnitsForPolicy 按方向与策略选单元：
//   - safe：push 只取（local-newer + new[push 建议行]）；pull 只取（peer-newer
//   - new[pull 建议行]）——即 plan 行 Action 与方向一致的默认勾选集
//   - mirror：safe 集 + 冲突行（冲突按镜像裁决执行）
func selectUnitsForPolicy(plan *PlanResponse, direction, policy string) (units []string, conflicts int) {
	for _, row := range plan.Rows {
		switch row.State {
		case PlanConflict:
			conflicts++
			if policy == store.SyncPolicyLocalMirror || policy == store.SyncPolicyPeerMirror {
				units = append(units, row.Key)
			}
			continue
		case PlanSynced:
			continue
		case PlanLocalNewer:
			if direction == store.SyncCronDirPush {
				units = append(units, row.Key)
			}
		case PlanPeerNewer:
			if direction == store.SyncCronDirPull {
				units = append(units, row.Key)
			}
		case PlanNew:
			if (direction == store.SyncCronDirPush && row.Action == PlanPush) ||
				(direction == store.SyncCronDirPull && row.Action == PlanPull) {
				units = append(units, row.Key)
			}
		}
	}
	sort.Strings(units)
	return units, conflicts
}

// mirrorResolutions 镜像档冲突裁决表（冲突单元按镜像方向裁决）
func mirrorResolutions(plan *PlanResponse, direction, side string) map[string]string {
	res := map[string]string{}
	for _, row := range plan.Rows {
		if row.State == PlanConflict {
			res[row.Key] = side
		}
	}
	_ = direction
	return res
}

// execRunningFlag / setExecRunning 复用 handler 层执行互斥（同刻一个任务）
func execRunningFlag() bool {
	execMu.Lock()
	defer execMu.Unlock()
	return execRunning
}

func setExecRunning(v bool) {
	execMu.Lock()
	execRunning = v
	execMu.Unlock()
}

// executeSyncCtx executeSync 的可传 ctx 形态（定时任务有明确的生命周期；
// 手动路径传 Background 由 finishJob 收口）
func executeSyncCtx(ctx context.Context, req ExecuteRequest, direction, source string) (*ExecuteResult, error) {
	return executeSyncWithCtx(ctx, req, direction, source)
}

// notifyConflicts 冲突留通知中心裁决（safe 档）：提示条目点进同步中心
func notifyConflicts(t store.SyncCron, peer config.InstanceConfig, conflicts int) {
	store.Get().Notification.Add(notification.Notification{
		Type:     "warning",
		Category: notification.CategoryTask,
		TitleKey: SyncCronConflictsTitleKey,
		Title:    fmt.Sprintf("定时同步有 %d 个冲突待裁决（%s → %s）", conflicts, t.Name, peer.Name),
		Body:     peer.URL,
		MsgParams: map[string]any{
			"task":      t.Name,
			"peer":      peer.Name,
			"conflicts": conflicts,
		},
		Action:        "open-sync-center",
		ActionPayload: "",
	})
}

// notifyCronDone 定时任务完成通知（携带结果摘要；峰值/平均速率随任务快照
// 可从进度中心查询——通知带摘要行）
func notifyCronDone(t store.SyncCron, result, note string) {
	nt := "success"
	if result == "partial" {
		nt = "warning"
	} else if result == "failed" || result == "skipped" {
		nt = "error"
	}
	if result == "synced" && note == "" {
		return // 全量在同步状态静默（不生产噪音通知）
	}
	store.Get().Notification.Add(notification.Notification{
		Type:     nt,
		Category: notification.CategoryTask,
		TitleKey: SyncCronDoneTitleKey,
		Title:    fmt.Sprintf("定时同步「%s」%s", t.Name, cronResultText(result)),
		Body:     note,
		MsgParams: map[string]any{
			"task":   t.Name,
			"result": result,
		},
		Action:        "open-sync-center",
		ActionPayload: "",
	})
}

func cronResultText(result string) string {
	switch result {
	case "synced":
		return "完成"
	case "partial":
		return "部分完成"
	case "skipped":
		return "已跳过"
	default:
		return "失败"
	}
}
