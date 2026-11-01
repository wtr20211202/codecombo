package sync

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"codecombo/server/config"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// 对端环境画像差集提示（方案⑥体验一致性保障）：推送落地后，把对端项目环境
// 画像摘要（dev 端口观测 / 输出哨兵规则 / 部署目标）带回结果卡——环境差异
// 不静默假装一致，差集如实点名（P-20261007-14 画像既有数据源，只读消费）。
// 拉取方向不带对端提示（对端项目 id 需额外反查，而落地后本端画像即用户新
// 环境的真值；诚实边界注记见 ops 手册 sync 节）。

// envSummary 环境画像摘要（对端 /api/projects/:id/env-profile 的计数投影；
// 明细端点始终可现查，同步面只带数量级提示）
type envSummary struct {
	DevPorts      int `json:"devPorts"`
	Sentinels     int `json:"sentinels"`
	DeployTargets int `json:"deployTargets"`
}

// String 一行人话摘要（结果卡 envHints 值）
func (s envSummary) String() string {
	return fmt.Sprintf("dev端口 %d · 哨兵 %d · 部署目标 %d", s.DevPorts, s.Sentinels, s.DeployTargets)
}

// diff 与本端摘要比对，差集非零返回提示行（全等 = 体验一致的环境面如实不说教）
func (s envSummary) diff(local envSummary) string {
	if s == local {
		return ""
	}
	return fmt.Sprintf("对端(%s) vs 本端(%s)", s, local)
}

// localEnvSummary 本端项目画像摘要（直接读既有数据源，与 envprofile 同口径：
// 端口=本项目会话登记条目；哨兵=scope 圈定（空视作 global，envprofile 同判定）；
// 部署目标=实例级主机表）
func localEnvSummary(projectID string) envSummary {
	s := envSummary{}
	for _, pe := range terminal.DefaultManager.ListDevPorts() {
		if sess := terminal.DefaultManager.GetSession(pe.SessionID); sess != nil && sess.ProjectID == projectID {
			s.DevPorts++
		}
	}
	if rules, err := store.Get().Sentinel.List(); err == nil {
		for _, r := range rules {
			if r.Scope == "" || r.Scope == store.SentinelScopeGlobal || r.Scope == projectID {
				s.Sentinels++
			}
		}
	}
	if hosts, err := store.Get().RemoteHost.List(); err == nil {
		s.DeployTargets = len(hosts)
	}
	return s
}

// peerEnvSummary 对端项目画像摘要（既有 env-profile 端点 HTTP 消费；失败返回
// false——提示是增强面，不为它放大失败面）
func peerEnvSummary(ctx context.Context, peer config.InstanceConfig, projectID string) (envSummary, bool) {
	ctx2, cancel := context.WithTimeout(ctx, peerJSONTimeout)
	defer cancel()
	resp, err := peerDo(ctx2, http.MethodGet, peer.URL, peer.Token, "/api/projects/"+projectID+"/env-profile", nil, nil)
	if err != nil {
		return envSummary{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return envSummary{}, false
	}
	var parsed struct {
		Data struct {
			DevPorts      []json.RawMessage `json:"devPorts"`
			Sentinels     []json.RawMessage `json:"sentinels"`
			DeployTargets []json.RawMessage `json:"deployTargets"`
		} `json:"data"`
	}
	if json.NewDecoder(resp.Body).Decode(&parsed) != nil {
		return envSummary{}, false
	}
	return envSummary{
		DevPorts:      len(parsed.Data.DevPorts),
		Sentinels:     len(parsed.Data.Sentinels),
		DeployTargets: len(parsed.Data.DeployTargets),
	}, true
}

// collectEnvHint 推送成功后采集差集提示（尽力而为：任一侧取不到即放弃）。
// srcProjectID = 本端源项目 id；peerProjectID = 对端落位注册的项目 id
func collectEnvHint(ctx context.Context, peer config.InstanceConfig, srcProjectID, peerProjectID string) string {
	if srcProjectID == "" || peerProjectID == "" {
		return ""
	}
	peerSum, ok := peerEnvSummary(ctx, peer, peerProjectID)
	if !ok {
		return ""
	}
	localSum := localEnvSummary(srcProjectID)
	return peerSum.diff(localSum)
}
