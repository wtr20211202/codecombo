package sync

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/middleware"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 导出端（P-20261003-147 方案①/⑥）：配置四块聚合收集 + 信封加密 + 审计。
// 明文不落盘：light 单信封整体出响应；full 经 io.Pipe 流式打包加密直挂响应
//（zip 内 payload.json + sync 单元布局，packUnitsInto/landZipReader 引擎复用）。
// 审计只记块/计数元数据，口令与凭据绝不如账。

// migrationPayloadFileName 全量包 zip 内明文头条目名
const migrationPayloadFileName = "payload.json"

// migrationExportReq POST /api/migration/export 请求体
type migrationExportReq struct {
	// Mode light（配置四块）| full（四块 + 内容档）
	Mode string `json:"mode" binding:"required"`
	// Passphrase 包口令（≥8 位；逐字使用不 trim——口令语义空白字符合法）
	Passphrase string `json:"passphrase" binding:"required"`
	// Blocks 配置四块勾选（缺省全选语义由前端承担；服务端按字面勾选收集）
	Blocks MigrationBlockSelection `json:"blocks"`
	// Projects full 模式逐项目勾选（含档位）；空 = 不带内容
	Projects []MigrationProjectChoice `json:"projects,omitempty"`
	// GlobalContexts full 模式是否携带全局上下文单元（snippets/runtimes/
	// approvals/chains/uistate）
	GlobalContexts bool `json:"globalContexts,omitempty"`
}

// PostMigrationExport POST /api/migration/export —— 聚合导出 .scpkg（口令信封附件）
func PostMigrationExport(c *gin.Context) {
	shared.LimitBody(c, 1<<20) // 请求体只有勾选与口令，1MB 富余
	var req migrationExportReq
	if ok := shared.BindJSON(c, &req, ""); !ok {
		return
	}
	if len(req.Passphrase) < 8 {
		shared.Error(c, 400, "passphrase too short (min 8)", nil)
		return
	}
	if req.Mode != MigrationModeLight && req.Mode != MigrationModeFull {
		shared.Error(c, 400, "unsupported mode (light|full)", nil)
		return
	}
	if !req.Blocks.any() {
		shared.Error(c, 400, "no blocks selected", nil)
		return
	}

	payload, unitKeys, perUnitGit, err := buildMigrationPayload(req.Mode, req.Blocks, req.Projects, req.GlobalContexts)
	if err != nil {
		shared.Error(c, 400, err.Error(), nil)
		return
	}

	name := migrationFilePrefix + timeNowUTC().Format("20060102-150405") + migrationFileExt
	disp := shared.ContentDispositionFile(name)

	if req.Mode == MigrationModeLight {
		// 轻装包：v1 单发信封（payload KB~MB 级，整体驻内存与既有凭据导出同档）
		body, err := json.Marshal(payload)
		if err != nil {
			shared.Error(c, 500, "marshal migration payload", err)
			return
		}
		env, err := config.EncryptWithPassphraseFormat(body, []byte(req.Passphrase), config.MigrationFormat)
		if err != nil {
			shared.Error(c, 500, "encrypt migration package", err)
			return
		}
		auditMigration(c, store.AuditMigrationExport, fmt.Sprintf("mode=light blocks=%s", migrationBlocksSummary(payload)))
		c.Header("Content-Type", "application/json")
		c.Header("Content-Disposition", disp)
		c.Status(200)
		_, _ = c.Writer.Write(env)
		return
	}

	// 全量包：解析内容单元键（项目缺失在解析期拒绝——打包中途失败会拖垮已
	// 发出的流）。上下文单元无内容按「跳过」处理（迁移包不因某项目没写笔记
	// 而整体失败），项目单元缺失才是致命
	payloads, _ := resolveUnitPayloads(unitKeys, false)
	if len(payloads) == 0 {
		shared.Error(c, 400, "no content units to pack", nil)
		return
	}
	packed := map[string]bool{}
	for i := range payloads {
		packed[payloads[i].unit.Key] = true
	}
	for _, k := range unitKeys {
		if kind, _ := ParseUnitKey(k); kind == UnitProject && !packed[k] {
			shared.Error(c, 400, "project unit unresolved: "+k, nil)
			return
		}
	}
	// per-unit git 档：按勾选记录逐项目赋值（sync 链是请求全局档，迁移是
	// per-unit 档——packUnitsInto 消费 up.withGit）
	for i := range payloads {
		kind, base := ParseUnitKey(payloads[i].unit.Key)
		if kind == UnitProject {
			payloads[i].withGit = perUnitGit[base]
		}
	}
	sortPayloads(payloads)

	// 流式链：zip(payload.json + 单元) → 分块信封 → pipe → 响应。打包协程
	// 失败时 pipe 断开、响应截断——客户端拿到不完整附件按导入端「截断拒绝」
	// 兜底（AEAD 终结块缺失即失败），不会误判为合法包
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		cw, err := config.NewChunkedEnvelopeWriter(pw, []byte(req.Passphrase), config.MigrationFormat, MigrationModeFull)
		if err != nil {
			pw.CloseWithError(err)
			return
		}
		err = writeMigrationFullPackage(c.Request.Context(), cw, payload, payloads)
		if cerr := cw.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			pw.CloseWithError(err)
		}
	}()
	auditMigration(c, store.AuditMigrationExport, fmt.Sprintf("mode=full units=%d blocks=%s", len(payloads), migrationBlocksSummary(payload)))
	c.Header("Content-Type", "application/json")
	c.Header("Content-Disposition", disp)
	c.Status(200)
	_, _ = io.Copy(c.Writer, pr) // 写失败（客户端断开）即中断，打包协程随 pipe 退出
}

// writeMigrationFullPackage 全量包明文 zip：先单元（meta 由打包期补齐）后
// payload.json（zip 条目序对读端无意义，payload 里需要 meta 故后写）
func writeMigrationFullPackage(ctx context.Context, cw *config.ChunkedEnvelopeWriter, payload *MigrationPayload, payloads []unitPayload) error {
	zw := zip.NewWriter(cw)
	meta, err := packUnitsInto(ctx, zw, payloads, false, nil)
	if err != nil {
		return err
	}
	payload.Content = meta
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	fw, err := zw.CreateHeader(&zip.FileHeader{Name: migrationPayloadFileName, Method: zip.Deflate})
	if err != nil {
		return err
	}
	if _, err := fw.Write(body); err != nil {
		return err
	}
	return zw.Close()
}

// buildMigrationPayload 收集配置四块（导出口令信封前的明文载荷）。
// full 模式同时解析内容单元键（unitKeys）与 per-project git 档
func buildMigrationPayload(mode string, blocks MigrationBlockSelection, projects []MigrationProjectChoice, globalContexts bool) (*MigrationPayload, []string, map[string]bool, error) {
	payload := &MigrationPayload{
		Schema:  migrationPayloadSchema,
		Version: migrationPayloadVersion,
		Mode:    mode,
		Host:    hostnameSummary(),
		Blocks:  blocks,
	}
	var unitKeys []string
	perUnitGit := map[string]bool{}
	if mode == MigrationModeFull {
		projByID, err := projectByIDMap()
		if err != nil {
			return nil, nil, nil, err
		}
		for _, pc := range projects {
			p, ok := projByID[pc.ProjectID]
			if !ok {
				return nil, nil, nil, fmt.Errorf("project %s not found", pc.ProjectID)
			}
			base := rootBasename(p.Path)
			key := UnitKey(UnitProject, base)
			unitKeys = append(unitKeys, key)
			perUnitGit[base] = pc.IncludeGit
			if pc.IncludeContexts {
				// 笔记单元不在列（P-20261108-3 单库化：笔记是全局库、不随实例搬运）
				for _, k := range []string{UnitSessions, UnitCrons} {
					unitKeys = append(unitKeys, UnitKey(k, base))
				}
			}
			pc.Key = key
			pc.Name = p.Name
			pc.DirName = base
			payload.Projects = append(payload.Projects, pc)
		}
		if globalContexts {
			unitKeys = append(unitKeys, UnitSnippets, UnitRuntimes, UnitApprovals, UnitChains, UnitUIState)
		}
	}

	if blocks.Credentials {
		cred, err := collectCredentials()
		if err != nil {
			return nil, nil, nil, err
		}
		payload.Credentials = cred
	}
	if blocks.Tokens {
		payload.Tokens = collectTokens()
	}
	if blocks.Settings {
		payload.Settings = collectSettings()
	}
	if blocks.Instances {
		insts, err := collectInstances()
		if err != nil {
			return nil, nil, nil, err
		}
		payload.Instances = insts
	}
	return payload, unitKeys, perUnitGit, nil
}

// collectCredentials 凭据块聚合（三处 store + SSH 私钥）。各 store 解密链
// 取明文（包整体口令加密承载，密文不出此函数）；单条失败跳过不影响整体——
// 与 remotehost 导出「逐条 Get 失败跳过」同口径
func collectCredentials() (*MigrationCredentials, error) {
	out := &MigrationCredentials{}
	// HTTPS/git 凭据：List 是 enc: 态，逐条解出明文（Secret/RefreshToken）
	creds, err := store.Get().Credential.List()
	if err != nil {
		return nil, err
	}
	for _, cr := range creds {
		c := *cr
		c.Secret = config.DecryptIfNeeded(c.Secret)
		c.RefreshToken = config.DecryptIfNeeded(c.RefreshToken)
		out.Git = append(out.Git, &c)
	}
	// SSH 主机：List 不解密（性能），导出必须逐条 Get 拿明文凭据
	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		return nil, err
	}
	for i := range hosts {
		h, err := store.Get().RemoteHost.Get(hosts[i].ID)
		if err != nil {
			continue
		}
		out.SSHHosts = append(out.SSHHosts, *h)
	}
	// SSH 私钥：整机迁移全量带走（不含引用死角）
	keys, err := store.Get().SshKey.ListPublic()
	if err != nil {
		return nil, err
	}
	for _, k := range keys {
		pem, err := store.Get().SshKey.GetPrivatePem(k.ID)
		if err != nil {
			continue
		}
		out.SSHKeys = append(out.SSHKeys, MigrationSSHKey{
			ID: k.ID, Name: k.Name, Fingerprint: k.Fingerprint, Algo: k.Algo, PrivatePem: pem,
		})
	}
	// 部署凭据（Get 链已解密 AnthropicToken）
	if dc, err := store.Get().DeployConfig.Get(); err == nil && dc != nil {
		cfg := *dc
		out.Deploy = &cfg
	}
	return out, nil
}

// collectTokens 令牌族块。仅 agent token 可迁（明文可逆存储）；机器 API/
// quickdrop/hook 令牌为哈希+本机盐落盘，明文不可恢复——不可迁的家族不进包
// （导入预览侧给「新机需重签」提示），防「导出了但导入无效」的假迁移
func collectTokens() *MigrationTokens {
	return &MigrationTokens{AgentToken: store.Get().AgentToken.Plain()}
}

// collectSettings 系统设置块（白名单投影 + 锁配置除哈希 + 通知偏好）
func collectSettings() *MigrationSettingsBlock {
	cfg := store.Get().Settings.Get()
	block := &MigrationSettingsBlock{Server: portableSettingsFromConfig(cfg.Server)}
	lc := store.Get().Lock.GetConfig()
	block.Lock = &MigrationLockConfig{
		Enabled: lc.Enabled, AutoLockEnabled: lc.AutoLockEnabled,
		AutoLockMinutes: lc.AutoLockMinutes, TokenTTLMinutes: lc.TokenTTLMinutes,
	}
	prefs := store.Get().Notification.GetPrefs()
	block.NotifyPrefs = &prefs
	return block
}

// collectInstances 实例注册表（List 链已解密 Token 明文；本机条目不随包——
// 新机的本机身份由新机自己登记）
func collectInstances() ([]config.InstanceConfig, error) {
	all, err := store.Get().Instance.List()
	if err != nil {
		return nil, err
	}
	out := make([]config.InstanceConfig, 0, len(all))
	for _, inst := range all {
		if inst.IsLocal {
			continue
		}
		out = append(out, inst)
	}
	return out, nil
}

// hostnameSummary 源机摘要（os.Hostname 失败回落 "unknown"——摘要只为
// 「拿错文件」的人读，不参与逻辑）
func hostnameSummary() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown"
	}
	return h
}

// projectByIDMap 本端项目 id → 配置（全量包勾选解析用）
func projectByIDMap() (map[string]config.ProjectConfig, error) {
	projects, err := store.Get().Project.List()
	if err != nil {
		return nil, err
	}
	out := make(map[string]config.ProjectConfig, len(projects))
	for i := range projects {
		out[projects[i].ID] = projects[i]
	}
	return out, nil
}

// auditMigration 迁移导出/导入审计（只记块/计数元数据；口令/凭据绝不如账）
func auditMigration(c *gin.Context, action, detail string) {
	middleware.AuditAppend(c, store.AuditEvent{
		Action: action, Result: store.AuditResultSuccess, IP: c.ClientIP(), Detail: detail,
	})
}

// migrationBlocksSummary 块清单摘要（审计 Detail 语言中立固定序：c/t/s/i）
func migrationBlocksSummary(p *MigrationPayload) string {
	s := ""
	if p.Blocks.Credentials {
		s += "c"
	}
	if p.Blocks.Tokens {
		s += "t"
	}
	if p.Blocks.Settings {
		s += "s"
	}
	if p.Blocks.Instances {
		s += "i"
	}
	if s == "" {
		s = "-"
	}
	return s
}

// sortCredRows 预览行确定性展示（按 label 稳定排序）
func sortCredRows(rows []migrationCredRow) {
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Label < rows[j].Label })
}
