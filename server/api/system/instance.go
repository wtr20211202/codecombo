package system

import (
	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/peercert"
	"codecombo/server/proxy"
	"codecombo/server/store"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// instanceWithStatus 实例配置附带运行时状态（不含 Token 明文）
type instanceWithStatus struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	IsLocal   bool   `json:"isLocal"`
	ParentID  string `json:"parentId"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Status    string `json:"status"`
	Version   string `json:"version,omitempty"`
}

// toInstanceResponse 将 InstanceConfig 转换为 API 响应
func toInstanceResponse(inst config.InstanceConfig, role string) instanceWithStatus {
	return instanceWithStatus{
		ID:        inst.ID,
		Name:      inst.Name,
		URL:       inst.URL,
		IsLocal:   inst.IsLocal,
		ParentID:  inst.ParentID,
		Role:      role,
		CreatedAt: inst.CreatedAt,
		UpdatedAt: inst.UpdatedAt,
		Status:    store.Get().Instance.GetStatus(inst.ID),
	}
}

// ListInstances 获取所有实例列表（含运行时状态）
func ListInstances(c *gin.Context) {
	instances, err := store.Get().Instance.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	// 一次遍历推导所有角色，避免 N+1
	roleMap := store.Get().Instance.BuildRoleMap(instances)

	result := make([]instanceWithStatus, 0, len(instances))
	for _, inst := range instances {
		result = append(result, toInstanceResponse(inst, roleMap[inst.ID]))
	}

	c.JSON(http.StatusOK, gin.H{"data": result})
}

// AddInstance 创建远程实例
func AddInstance(c *gin.Context) {
	var req struct {
		Name     string `json:"name" binding:"required"`
		URL      string `json:"url" binding:"required"`
		Token    string `json:"token"`
		ParentID string `json:"parentId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Instance operation failed", err)
		return
	}

	// 自引用拦截：URL 指向本机自身会让代理把请求转发回自己，切换后必然异常
	req.URL = normalizeInstanceURL(req.URL)
	if rejectSelfReference(c, req.URL) {
		return
	}

	inst := store.Get().Instance.NewRemote(req.Name, req.URL, req.Token)
	inst.ParentID = req.ParentID

	if req.ParentID != "" {
		if err := store.Get().Instance.CheckCycleAdd(req.ParentID, inst.ID); err != nil {
			shared.Error(c, http.StatusBadRequest, "Instance operation failed", err)
			return
		}
	}

	if err := store.Get().Instance.Save(inst); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	invalidateCheckAllCache()
	// 实例清单变化同步失效联邦活动矩阵缓存：新注册实例应立即可见，而非等
	// 5 分钟 TTL 过期（与批量探测缓存同一失效纪律）
	invalidateActivityMatrixCache()
	instances, _ := store.Get().Instance.List()
	c.JSON(http.StatusOK, gin.H{"data": toInstanceResponse(inst, roleOfInstance(inst, instances))})
}

// roleOfInstance 计算单个实例的角色，取值与 BuildInstanceRoleMap 对齐
// （优先级 child > center > local > standalone），供 Add/Update 的即时响应使用
func roleOfInstance(inst config.InstanceConfig, all []config.InstanceConfig) string {
	if inst.ParentID != "" {
		return "child"
	}
	for _, other := range all {
		if other.ParentID == inst.ID {
			return "center"
		}
	}
	if inst.IsLocal {
		return "local"
	}
	return "standalone"
}

// RemoveInstance 删除实例
func RemoveInstance(c *gin.Context) {
	id := c.Param("id")
	if id == "local" {
		shared.Error(c, http.StatusBadRequest, "cannot remove local instance", nil)
		return
	}

	if err := store.Get().Instance.Delete(id); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	// 级联清理：被删实例若被他人引用为上级，清空引用方的 parentId——
	// 否则子实例悬空（getParentInstance 找不到、角色永远 child 但中心已不存在）
	if instances, err := store.Get().Instance.List(); err == nil {
		for _, inst := range instances {
			if inst.ParentID == id {
				inst.ParentID = ""
				if err := store.Get().Instance.Save(inst); err != nil {
					slog.Warn("instance remove: cascade clear parentId failed", "id", inst.ID, "err", err)
				}
			}
		}
	}

	// 清理代理相关资源
	proxy.CleanupInstance(id)
	// 同步账本级联清理（P-20261023-1）：陈旧基线会让「对端已重建的项目」
	// 被误判为 skip——对端删除即清其全部账目（风险节防陈旧基线误判注记）
	if err := store.Get().SyncLedger.DeleteByPeer(id); err != nil {
		slog.Warn("sync ledger cascade cleanup failed", "id", id, "err", err)
	}
	// 携密同步状态级联清理（P-20261024-3）：仪式态/序号水位/上次携密时刻随
	// 对端条目消亡——重建条目拿新 ID，残留会让旧核对态被无关新条目误继承
	if err := store.Get().CredSync.Delete(id); err != nil {
		slog.Warn("cred sync state cascade cleanup failed", "id", id, "err", err)
	}
	invalidateCheckAllCache()
	invalidateActivityMatrixCache()
	slog.Info("instance removed", "id", id)
	c.JSON(http.StatusOK, gin.H{"message": "instance removed"})
}

// UpdateInstance 更新实例配置
func UpdateInstance(c *gin.Context) {
	id := c.Param("id")

	var req struct {
		Name     *string `json:"name"`
		URL      *string `json:"url"`
		Token    *string `json:"token"`
		ParentID *string `json:"parentId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Instance operation failed", err)
		return
	}

	// 加载所有实例，找到目标实例
	instances, err := store.Get().Instance.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	var target *config.InstanceConfig
	for i := range instances {
		if instances[i].ID == id {
			target = &instances[i]
			break
		}
	}
	if target == nil {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}

	// 自引用拦截（同 AddInstance，编辑时把地址改成本机自身同样拒绝）。
	// 本机实例豁免：其地址天然指向本机服务——编辑本机的目的正是把它配置为
	// 对外可达地址（供子实例从本机拉取更新）
	if req.URL != nil {
		normalized := normalizeInstanceURL(*req.URL)
		req.URL = &normalized
		if !target.IsLocal && rejectSelfReference(c, normalized) {
			return
		}
	}

	// 本机的上级不能是本机自身（自指无意义）；本机可以声明从某个远程中心更新——
	// "我从谁更新"由每台机器自己登记，与"中心方登记孩子"（远程实例设 parent）视角对称
	if target.IsLocal && req.ParentID != nil && *req.ParentID == id {
		shared.Error(c, http.StatusBadRequest, "local instance cannot be its own parent", nil)
		return
	}

	// 应用更新
	if req.Name != nil {
		target.Name = *req.Name
	}
	if req.URL != nil {
		target.URL = *req.URL
	}
	if req.Token != nil {
		target.Token = *req.Token
	}
	if req.ParentID != nil {
		if *req.ParentID != "" {
			if err := store.Get().Instance.CheckCycleAdd(*req.ParentID, target.ID); err != nil {
				shared.Error(c, http.StatusBadRequest, "Instance operation failed", err)
				return
			}
		}
		target.ParentID = *req.ParentID
	}
	target.UpdatedAt = time.Now().Format(time.RFC3339)

	if err := store.Get().Instance.Save(*target); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	// 保存后实例列表已变，重算角色（引用关系可能变化）+ 失效批量探测缓存
	//（联邦活动矩阵缓存同纪律同步失效）
	invalidateCheckAllCache()
	invalidateActivityMatrixCache()
	instances, _ = store.Get().Instance.List()
	c.JSON(http.StatusOK, gin.H{"data": toInstanceResponse(*target, roleOfInstance(*target, instances))})
}

// CheckInstance 探测单个实例的连通性
func CheckInstance(c *gin.Context) {
	id := c.Param("id")

	instances, err := store.Get().Instance.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	var target *config.InstanceConfig
	for i := range instances {
		if instances[i].ID == id {
			target = &instances[i]
			break
		}
	}
	if target == nil {
		shared.Error(c, http.StatusNotFound, "instance not found", nil)
		return
	}

	result := checkInstanceURL(target.URL, target.Token)
	store.Get().Instance.SetStatus(id, result.status)
	// 单实例探测可能迁移 URL/状态：批量探测缓存一并失效（联邦活动矩阵缓存
	// 同纪律——URL 迁移后旧地址的失败行应立即可刷新）
	invalidateCheckAllCache()
	invalidateActivityMatrixCache()
	// scheme 自动发现：探测到的可用地址与存量不同（典型：存量 http://、
	// 对端升级默认 TLS 后变为 https）→ 迁移落盘，代理/WS 链路随之自愈
	if result.effectiveURL != "" && result.effectiveURL != target.URL && !target.IsLocal {
		oldURL := target.URL
		target.URL = result.effectiveURL
		target.UpdatedAt = time.Now().Format(time.RFC3339)
		if err := store.Get().Instance.Save(*target); err == nil {
			slog.Info("instance URL migrated by scheme discovery", "id", id, "from", oldURL, "to", result.effectiveURL)
		}
	}

	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"id":      id,
		"status":  result.status,
		"version": result.version,
		"tlsHint": result.tlsHint,
	}})
}

// checkAllCacheTTL 批量探测结果的复用窗口：离线实例一轮探测最长 10s
// （5s 超时 + scheme 翻转再 5s），前端实例面板打开时 30s 一轮，多标签页/多
// 调用方各自触发即形成探测风暴——窗口内的重复调用直接复用上次结果。
// 单实例 CheckInstance（手动「检查」按钮）不走此缓存，保证即时性
const checkAllCacheTTL = 30 * time.Second

var (
	checkAllCacheMu   sync.Mutex
	checkAllCacheAt   time.Time
	checkAllCacheData []map[string]string
)

// invalidateCheckAllCache 实例增删改/单实例探测后使批量探测缓存失效
func invalidateCheckAllCache() {
	checkAllCacheMu.Lock()
	checkAllCacheData = nil
	checkAllCacheMu.Unlock()
}

// CheckAllInstances 并行探测所有远程实例的连通性
func CheckAllInstances(c *gin.Context) {
	checkAllCacheMu.Lock()
	if checkAllCacheData != nil && time.Since(checkAllCacheAt) < checkAllCacheTTL {
		data := checkAllCacheData
		checkAllCacheMu.Unlock()
		c.JSON(http.StatusOK, gin.H{"data": data})
		return
	}
	checkAllCacheMu.Unlock()

	instances, err := store.Get().Instance.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Instance operation failed", err)
		return
	}

	type checkResult struct {
		ID      string `json:"id"`
		Status  string `json:"status"`
		Version string `json:"version,omitempty"`
	}

	results := make([]checkResult, len(instances))
	var wg sync.WaitGroup
	// 并发上限：历史实现每实例一个 goroutine 无准入，实例多时形成瞬时连接风暴
	//（每个探测 5s 超时 + SetStatus 磁盘写）；与 remotehost 探测器（并发 4）对齐
	sem := make(chan struct{}, 4)

	for i, inst := range instances {
		wg.Add(1)
		go func(idx int, instance config.InstanceConfig) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			cr := checkInstanceURL(instance.URL, instance.Token)
			store.Get().Instance.SetStatus(instance.ID, cr.status)
			// 同 CheckInstance：scheme 迁移落盘（批量健康检查驱动自愈）
			if cr.effectiveURL != "" && cr.effectiveURL != instance.URL && !instance.IsLocal {
				migrated := instance
				migrated.URL = cr.effectiveURL
				migrated.UpdatedAt = time.Now().Format(time.RFC3339)
				if err := store.Get().Instance.Save(migrated); err == nil {
					slog.Info("instance URL migrated by scheme discovery", "id", instance.ID, "to", cr.effectiveURL)
				}
			}
			results[idx] = checkResult{
				ID:      instance.ID,
				Status:  cr.status,
				Version: cr.version,
			}
		}(i, inst)
	}
	wg.Wait()

	// 批量探测可能迁移 URL（上方 scheme 自愈落盘）：联邦活动矩阵缓存同纪律
	// 同步失效，避免旧地址的失败行再存活一个 5 分钟窗口
	invalidateActivityMatrixCache()

	// 结果入缓存：实例列表结构可能已变（探测期间增删实例），缓存按结果快照
	// 原样返回，下一窗口自然刷新
	checkAllCacheMu.Lock()
	out := make([]map[string]string, len(results))
	for i, r := range results {
		m := map[string]string{"id": r.ID, "status": r.Status}
		if r.Version != "" {
			m["version"] = r.Version
		}
		out[i] = m
	}
	checkAllCacheData = out
	checkAllCacheAt = time.Now()
	checkAllCacheMu.Unlock()

	c.JSON(http.StatusOK, gin.H{"data": results})
}

// checkInstanceURL 探测目标 URL 的 /api/settings 端点并获取版本信息
// 实例间健康探测 HTTP 客户端：默认 TOFU 指纹校验（自签直达，内网部署无需
// 导入信任库，对端证书变更即拒）；管理员开启 TLSVerifyPeer 强校验后走系统
// 信任库。策略在 TLS 配置的握手回调内实时读取，设置切换即时生效
var checkHTTPClient = &http.Client{
	Timeout:   5 * time.Second,
	Transport: &http.Transport{TLSClientConfig: peercert.TLSConfig()},
}

type instanceCheckResult struct {
	status     string
	version    string
	httpStatus int
	// effectiveURL 探测发现的可用地址：与入参 scheme 不同时非空
	//（TLS 默认世界的 scheme 自动发现），调用方据此回填/迁移
	effectiveURL string
	// tlsHint 目标为 https 但证书未受本机信任（对端自签）——
	// 需要将对端证书装入本机系统信任库，而非普通网络不可达
	tlsHint bool
}

// errSelfReference 自引用实例错误（Add/Update 共用同一哨兵，避免文案漂移）
var errSelfReference = errors.New("cannot point an instance to this server itself (URL points to the local server)")

// normalizeInstanceURL 规范化用户输入的实例地址：
// 缺 scheme 自动补 https://（TLS 已是本产品默认形态，裸 host:port 的真实
// 目标绝大多数是 https；http-only 目标显式写 http://，或经探测自动发现）、
// 去尾部斜杠、trim 空白
func normalizeInstanceURL(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return raw
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	return strings.TrimRight(raw, "/")
}

// rejectSelfReference 校验实例 URL 是否指向本机服务自身；
// 命中时写 400 响应并返回 true，调用方直接 return
func rejectSelfReference(c *gin.Context, rawURL string) bool {
	if !isSelfReferenceURL(rawURL, c.Request.Host) {
		return false
	}
	shared.Error(c, http.StatusBadRequest, "Instance operation failed", errSelfReference)
	return true
}

// isSelfReferenceURL 判断实例 URL 是否指向本机服务自身——
// 自引用实例的代理请求会被转发回本机（锁态/鉴权不一致），切换后必然异常。
// requestHost 为当前请求的 Host 头（如 localhost:9999）：用户正通过它访问本机服务，
// 是"本机真实监听地址"的最可靠来源（legacy config 的 port 字段可能与实际监听不一致）
func isSelfReferenceURL(rawURL, requestHost string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || u.Hostname() == "" {
		return false
	}
	_, localPort, err := net.SplitHostPort(requestHost)
	if err != nil {
		// 请求 Host 无端口（标准 80/443）——本机服务不在该请求端口上，无自引用风险
		return false
	}
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	if port != localPort {
		return false
	}
	// 与当前访问地址完全同 host:port（含自定义域名指向本机的场景）
	if u.Host == requestHost {
		return true
	}
	host := u.Hostname()
	if host == "localhost" {
		return true
	}
	// IsLoopback 覆盖 127.x.x.x、::1 及其等价序列化写法（如 0:0:0:0:0:0:0:1）
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	// 本机网卡 IP（用户用局域网 IP 访问页面时填同 IP 的变体）
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if ipnet, ok := a.(*net.IPNet); ok && ipnet.IP.String() == host {
			return true
		}
	}
	return false
}

func checkInstanceURL(rawURL string, token string) instanceCheckResult {
	res := tryCheckInstance(rawURL, token)
	if res.status != "offline" {
		// online / invalid（可达但非本应用）都不换 scheme——换协议不会把
		// gitea/nginx 变成本应用
		return res
	}
	// 网络层失败或明文打 TLS 端口：探测对侧 scheme（TLS 默认世界里
	// http/https 混布的自动发现；存量 http:// 实例在对端升级后自愈）
	if flipped := flipScheme(rawURL); flipped != "" {
		alt := tryCheckInstance(flipped, token)
		if alt.status == "online" {
			alt.effectiveURL = flipped
			return alt
		}
		if alt.tlsHint {
			// 对侧确为 https 但证书未受信：该结果比"离线"更具行动价值
			return alt
		}
	}
	return res
}

// flipScheme 交换 http/https（其余 scheme 不翻转）
func flipScheme(rawURL string) string {
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || u.Host == "" {
		return ""
	}
	switch strings.ToLower(u.Scheme) {
	case "http":
		u.Scheme = "https"
	case "https":
		u.Scheme = "http"
	default:
		return ""
	}
	return u.String()
}

// plaintextToHTTPSBody Go http.Server 对"明文请求打到 TLS 端口"的固定响应体，
// 是目标实际为 https 的确定信号
const plaintextToHTTPSBody = "Client sent an HTTP request to an HTTPS server"

// tryCheckInstance 单次探测（不换 scheme）
func tryCheckInstance(rawURL string, token string) instanceCheckResult {
	// 规范化拼接：容忍 URL 带尾斜杠（字符串直拼会产生 //api/settings 假路径，
	// 不匹配 API 路由时可能命中 SPA fallback 返回 200 造成假阳性）
	base := strings.TrimRight(rawURL, "/")
	req, err := http.NewRequest("GET", base+"/api/settings", nil)
	if err != nil {
		slog.Warn("instance check failed", "url", rawURL, "err", err)
		return instanceCheckResult{status: "offline"}
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := checkHTTPClient.Do(req)
	if err != nil {
		msg := err.Error()
		// 证书未受信（对端 https 自签）：与普通不可达区分，给出可行动提示
		if strings.Contains(msg, "x509") || strings.Contains(msg, "certificate") {
			slog.Warn("instance check: tls certificate not trusted", "url", rawURL)
			return instanceCheckResult{status: "offline", tlsHint: true}
		}
		// 网络层失败（连接拒绝/超时/TLS 握手失败）才是真正离线
		slog.Warn("instance check failed", "url", rawURL, "err", err)
		return instanceCheckResult{status: "offline"}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	// 明文请求打到 TLS 端口：400 + Go 固定文案 → 视为离线（触发对侧 scheme 探测）
	if resp.StatusCode == http.StatusBadRequest && strings.Contains(string(body), plaintextToHTTPSBody) {
		return instanceCheckResult{status: "offline", httpStatus: resp.StatusCode}
	}
	result := classifyInstanceCheck(resp.StatusCode, body)
	result.httpStatus = resp.StatusCode
	return result
}

// classifyInstanceCheck 按目标实例 /api/settings 响应分类存活状态
func classifyInstanceCheck(httpStatus int, body []byte) instanceCheckResult {
	// 200 + 可解析出 data 结构：确认是本系统（Codecombo），附带版本
	if httpStatus == http.StatusOK {
		var data struct {
			Data struct {
				Version string `json:"version"`
			} `json:"data"`
		}
		if json.Unmarshal(body, &data) == nil && data.Data.Version != "" {
			return instanceCheckResult{status: "online", version: data.Data.Version}
		}
		if json.Unmarshal(body, &data) == nil {
			return instanceCheckResult{status: "online"}
		}
		// 200 但响应体不是本应用 JSON（如任意路径都 200 的 SPA fallback）——不能判活
		return instanceCheckResult{status: "invalid"}
	}

	// 423 锁定响应是本系统的强特征（{"err":"locked",...}）——服务在跑，判活
	if httpStatus == http.StatusLocked && strings.Contains(string(body), "locked") {
		return instanceCheckResult{status: "online"}
	}

	// 401 且响应为本应用 TokenAuth 错误格式（{"error":"authentication failed"}）——
	// 服务在跑只是 token 无效/过期，判活。识别串与发射点同源收口 errmarkers
	//（P-20261004-29），对端跑同版本代码故同串成立
	if httpStatus == http.StatusUnauthorized && strings.Contains(string(body), errmarkers.AuthenticationFailed) {
		return instanceCheckResult{status: "online"}
	}

	// 其他响应（404 HTML / 反代错误页等）无法确认是本应用——标记 invalid
	// 而非 online，避免把指向 gitea/nginx 等服务的地址误报为"在线"
	return instanceCheckResult{status: "invalid"}
}

// ProbeInstance POST /api/instances/probe {url, token}
// 添加/编辑实例表单的「测试连接」专用：从服务端发起探测。此前由浏览器直接
// fetch 目标实例，跨源（不同 IP/端口）访问必撞 CORS 把可达误判为失败；
// 保存后的健康检查走服务端到服务端没有这个问题——本端点让表单内测试与
// 保存后行为一致。分类逻辑与 checkInstanceURL 同源
func ProbeInstance(c *gin.Context) {
	var req struct {
		URL   string `json:"url" binding:"required"`
		Token string `json:"token"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Instance operation failed", err)
		return
	}
	base := normalizeInstanceURL(req.URL)
	if base == "" {
		shared.Error(c, http.StatusBadRequest, "Instance operation failed", errors.New("url is required"))
		return
	}
	result := checkInstanceURL(base, req.Token)
	respData := gin.H{
		"status":     result.status,
		"version":    result.version,
		"httpStatus": result.httpStatus,
	}
	// scheme 自动发现：探测到输入地址之外的可听地址（如裸域补 https 后
	// 目标实际在 http）→ 回传给表单回填
	if result.effectiveURL != "" && result.effectiveURL != base {
		respData["suggestedUrl"] = result.effectiveURL
	}
	if result.tlsHint {
		respData["tlsHint"] = true
	}
	c.JSON(http.StatusOK, gin.H{"data": respData})
}
