package system

// 联邦活动热力（P-20261004-98）：多实例负载对比与派单原语。P-37 活动热力
//（/api/reports/activity）是单实例自恋视图——多机用户的调度问题「哪台机器
// 最近闲着/哪台过载」要逐台开各自的值班大屏；本中心握有各注册实例的地址与
// 令牌，带令牌跨实例调用与探活/派发同面（instance.go checkInstanceURL、
// dispatch.go postToInstance 先例），联邦聚合是零新协议的组合件。
//
//   - GET /api/instances/activity-matrix?days=14：并发拉取各注册实例的
//     activity 端点（sem 并发限流沿 fleet/CheckAllInstances 惯例），单实例
//     失败隔离行标不可达；本机行直读本地 ActivityDay 仓储零 HTTP。
//   - 旧对端（P-37 前版本无 activity 端点）404 → 行标 unsupported（能力探测
//     为可选增强，404 兜底即够）；其余失败（网络不通/对端 5xx/响应形态异常）
//     统一标 unreachable——非 404 的失败对调度决策是同一句话「这台拿不到数据」。
//   - 服务端缓存 TTL 5 分钟：联邦拉取不高频（值班大屏刷新/agent 派单决策
//     前置查询），窗口内重复调用直接复用，跨实例扇出不放大。
//
// 权限语义（与 checkInstanceURL 同面核实）：activity 端点在 /api 保护组内，
// LockMiddleware 对有效 Bearer sc_ 机器间调用放行（middleware/lock.go），实例
// 令牌即 sc_ access token——对端锁定态不影响拉取，与派发同语义。
//
// 诚实边界：各实例 activity 键是「服务器本地时区」的日期字符串（P-37），聚合
// 按日期直比不换算时区——跨时区部署的实例行与中心日界可能差一天，属已声明的
// 诚实边界而非缺陷。

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 矩阵行三态（ok 之外两者都无 series，前端显标签不打断整卡渲染）
const (
	// matrixStatusOK 序列在手
	matrixStatusOK = "ok"
	// matrixStatusUnreachable 网络层失败/对端非 200/响应形态异常——拿不到数据
	matrixStatusUnreachable = "unreachable"
	// matrixStatusUnsupported 对端 404（P-37 前版本无 activity 端点）
	matrixStatusUnsupported = "unsupported"
)

// activityMatrixDaysDefault 缺省对比窗口；activityMatrixDaysMax 与两端
// ActivityDay.List 的保留钳制同源（365 行封顶，超传无害但明确边界）
const (
	activityMatrixDaysDefault = 14
	activityMatrixDaysMax     = 365
)

// activityMatrixTTL 聚合结果复用窗口：联邦拉取不高频（提案约定 5 分钟），
// 大屏 30s 轮询/多标签页各自触发时不放大为跨实例扇出风暴
const activityMatrixTTL = 5 * time.Minute

// activityTotals 窗口内三项合计（跨行可比的原始事实，加权展示归前端——
// 权重是可读性取舍非精确度量，agent 派单决策直接消费原始三项）
type activityTotals struct {
	Commits  int `json:"commits"`
	Sessions int `json:"sessions"`
	Commands int `json:"commands"`
}

// activityMatrixRow 矩阵一行 = 一个实例的最近 days 天活动序列
type activityMatrixRow struct {
	InstanceID string `json:"instanceId"`
	Name       string `json:"name"`
	Self       bool   `json:"self"`
	Status     string `json:"status"`
	// Series date 升序（旧→新，与单实例端点同序直铺）；仅 ok 行携带
	Series []store.ActivityDay `json:"series,omitempty"`
	Totals activityTotals      `json:"totals"`
}

// 聚合缓存（checkAllCache 同款单快照形）：days 是缓存口径的一部分——不同
// days 的调用各自重算并顶替快照（调用方实际只会用一两种 days，单快照足够）
var (
	activityMatrixMu   sync.Mutex
	activityMatrixAt   time.Time
	activityMatrixDays int
	activityMatrixData []activityMatrixRow
)

// invalidateActivityMatrixCache 实例库变更（增删改/URL 迁移）时失效缓存——
// 新注册实例应立即可见而非等 5 分钟 TTL；调用点与 invalidateCheckAllCache
// 成对（Add/Remove/Update/CheckInstance）。另供测试隔离复位
func invalidateActivityMatrixCache() {
	activityMatrixMu.Lock()
	activityMatrixData = nil
	activityMatrixMu.Unlock()
}

// InstanceActivityMatrix GET /api/instances/activity-matrix?days=14
func InstanceActivityMatrix(c *gin.Context) {
	days := activityMatrixDaysDefault
	if v, err := strconv.Atoi(c.Query("days")); err == nil && v > 0 {
		// 超保留窗口的请求钳到 365（与 ActivityDay.List 的钳制同口径）；
		// 非法/非正数回落缺省 14，不透传 0/负数给对端
		days = v
		if days > activityMatrixDaysMax {
			days = activityMatrixDaysMax
		}
	}

	activityMatrixMu.Lock()
	if activityMatrixData != nil && activityMatrixDays == days && time.Since(activityMatrixAt) < activityMatrixTTL {
		rows := activityMatrixData
		activityMatrixMu.Unlock()
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"days": days, "rows": rows}})
		return
	}
	activityMatrixMu.Unlock()

	instances, err := store.Get().Instance.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	// 本机行先行直读（本地仓储读失败是本机基础设施错误，按 500 整体失败——
	// 不混入对端失败隔离语义），再并发拉远端。本机行兜底合成：本地条目只在
	// 用户触碰过更新链后才落库（GetLocal 惰性建档），未落库时补一行保证
	// 「本机」基线恒在（命名与 GetLocal 缺省同源）
	rows := make([]activityMatrixRow, 0, len(instances)+1)
	var remotes []config.InstanceConfig
	localSeen := false
	for _, inst := range instances {
		if inst.IsLocal {
			localSeen = true
			series, err := store.Get().ActivityDay.List(days)
			if err != nil {
				shared.Error(c, http.StatusInternalServerError, "Failed to list activity series", err)
				return
			}
			rows = append(rows, activityMatrixRow{
				InstanceID: inst.ID,
				Name:       inst.Name,
				Self:       true,
				Status:     matrixStatusOK,
				Series:     series,
				Totals:     activityTotalsOf(series),
			})
			continue
		}
		remotes = append(remotes, inst)
	}
	if !localSeen {
		series, err := store.Get().ActivityDay.List(days)
		if err != nil {
			shared.Error(c, http.StatusInternalServerError, "Failed to list activity series", err)
			return
		}
		rows = append(rows, activityMatrixRow{
			InstanceID: "local",
			Name:       "本机",
			Self:       true,
			Status:     matrixStatusOK,
			Series:     series,
			Totals:     activityTotalsOf(series),
		})
	}

	// 逐远端并发拉取（并发上限与 CheckAllInstances/fleet 对齐；注册实例个位
	// 量级，5s 超时兜底最坏等待，连接拒绝类失败即时返回）
	remoteRows := make([]activityMatrixRow, len(remotes))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for i := range remotes {
		wg.Add(1)
		go func(idx int, inst config.InstanceConfig) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			status, series := fetchPeerActivity(inst, days)
			row := activityMatrixRow{
				InstanceID: inst.ID,
				Name:       inst.Name,
				Status:     status,
				Totals:     activityTotalsOf(series),
			}
			if status == matrixStatusOK {
				row.Series = series
			}
			remoteRows[idx] = row
		}(i, remotes[i])
	}
	wg.Wait()
	rows = append(rows, remoteRows...)

	// 结果入缓存：快照原样复用，5 分钟窗口自然刷新（checkAllCache 同款取舍得）
	activityMatrixMu.Lock()
	activityMatrixData = rows
	activityMatrixDays = days
	activityMatrixAt = time.Now()
	activityMatrixMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"data": gin.H{"days": days, "rows": rows}})
}

// fetchPeerActivity 拉取对端 /api/reports/activity，返回 (行状态, 序列)。
// 失败隔离：任何失败都只影响本行，绝不放大为整矩阵失败
func fetchPeerActivity(inst config.InstanceConfig, days int) (string, []store.ActivityDay) {
	status, body, err := getPeerActivity(inst.URL, inst.Token, days)
	// scheme 翻转重试一次（探活/派发同款自愈）：存量 http:// 地址在对端升级
	// TLS 后由探测链迁移落盘，迁移窗口外的首次矩阵拉取不该因此失败；矩阵是
	// 只读聚合视图，不做 URL 迁移写盘（迁移归探测链管）
	if err != nil || isPlaintextToHTTPS(status, body) {
		if flipped := flipScheme(inst.URL); flipped != "" {
			if s2, b2, e2 := getPeerActivity(flipped, inst.Token, days); e2 == nil && !isPlaintextToHTTPS(s2, b2) {
				status, body, err = s2, b2, nil
			}
		}
	}
	if err != nil {
		slog.Warn("activity matrix: peer fetch failed", "instance", inst.Name, "err", err)
		return matrixStatusUnreachable, nil
	}
	if status == http.StatusNotFound {
		// 旧对端（P-37 前版本）无此端点——服务在跑，能力不支持
		return matrixStatusUnsupported, nil
	}
	if status < 200 || status >= 300 {
		slog.Warn("activity matrix: peer returned error", "instance", inst.Name, "status", status)
		return matrixStatusUnreachable, nil
	}
	// data 键必须是数组（指针判 nil 区分「缺失/非数组」与合法空序列）：
	// 2xx 但不是本应用 envelope（反代/SPA fallback/JSON 错误体形态异常）按
	// 失败处置——不能把无 data 的 2xx 误读成「该实例零活动」
	var parsed struct {
		Data *[]store.ActivityDay `json:"data"`
	}
	if json.Unmarshal(body, &parsed) != nil || parsed.Data == nil {
		slog.Warn("activity matrix: peer response not activity envelope", "instance", inst.Name)
		return matrixStatusUnreachable, nil
	}
	series := *parsed.Data
	if series == nil {
		series = []store.ActivityDay{}
	}
	return matrixStatusOK, series
}

// getPeerActivity 对端 /api/reports/activity 单次拉取（不换 scheme）：Bearer
// 携实例令牌（与探活/派发同款鉴权语义），客户端复用探活的 TOFU 5s（活动序列
// 是本地仓储小 JSON 读，派发的 20s 预检超时在这里不必要），响应体 64KB 封顶
// （365 行 × ~100B 富余，防对端异常时无界读入）
func getPeerActivity(rawURL, token string, days int) (int, []byte, error) {
	base := strings.TrimRight(rawURL, "/")
	req, err := http.NewRequest("GET", base+"/api/reports/activity?days="+strconv.Itoa(days), nil)
	if err != nil {
		return 0, nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := checkHTTPClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, dispatchRespLimit))
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, body, nil
}

// activityTotalsOf 序列三项合计（ok 行的汇总值；缺行计零，与单实例卡口径一致）
func activityTotalsOf(series []store.ActivityDay) activityTotals {
	var t activityTotals
	for _, d := range series {
		t.Commits += d.Commits
		t.Sessions += d.Sessions
		t.Commands += d.Commands
	}
	return t
}
