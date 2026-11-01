package sync

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// 导入端三段式（P-20261003-147 方案②③）：preview/apply 分离 + per 块冲突
// 策略 + 原子落位回滚。
//
// preview（multipart：file+passphrase）→ 解密 + 票据暂存 → 预览载荷（逐块
// 计数/设置 diff/内容档清单，绝不含秘密明文）。apply（JSON：ticket+策略）→
// 内容先落位（sync 落位引擎全套：原子换名/.sync-backup 备份/自动注册）→
// 配置四块按策略应用（undo 日志，任一块失败整体回滚到导入前状态）。
// 票据一次性 30min TTL；解密产物只存系统临时目录（0600——与 master-key 同
// 信任域，非新增暴露面），用后即焚。

// migrationLightMaxBytes v1 单发信封的体量上限（轻装包 KB~MB 级；单 JSON
// 信封必须整体驻内存，触顶干净失败——GB 级请走 full 模式）
const migrationLightMaxBytes = 256 << 20

// ── 票据暂存 ──

// stashedPackage 预览到应用之间的解密产物
type stashedPackage struct {
	ticket   string
	mode     string
	payload  []byte   // 明文载荷 JSON（light/full 都有）
	zipFile  *os.File // full：解密 spool（zip.Reader 惰性读条目需句柄存活到 apply 终）
	expireAt time.Time
}

func (sp *stashedPackage) zipPath() string {
	if sp.zipFile == nil {
		return ""
	}
	return sp.zipFile.Name()
}

func (sp *stashedPackage) cleanup() {
	if sp.zipFile != nil {
		_ = sp.zipFile.Close()
		_ = os.Remove(sp.zipFile.Name())
		sp.zipFile = nil
	}
}

// migrationStash 模块级票据注册表（进程内——迁移向导始终直达本机，不经
// 多实例代理转发面）
var migrationStash = struct {
	mu      sync.Mutex
	entries map[string]*stashedPackage
}{entries: map[string]*stashedPackage{}}

func stashPackage(sp *stashedPackage) {
	migrationStash.mu.Lock()
	defer migrationStash.mu.Unlock()
	migrationSweepLocked()
	migrationStash.entries[sp.ticket] = sp
}

// popStash 一次性取票（用后即焚）；过期/不存在返回 nil
func popStash(ticket string) *stashedPackage {
	migrationStash.mu.Lock()
	defer migrationStash.mu.Unlock()
	sp := migrationStash.entries[ticket]
	if sp == nil {
		return nil
	}
	delete(migrationStash.entries, ticket)
	if time.Now().After(sp.expireAt) {
		sp.cleanup()
		return nil
	}
	return sp
}

// migrationSweepLocked 过期票据清扫（preview 时惰性触发；调用方持锁）
func migrationSweepLocked() {
	now := time.Now()
	for t, sp := range migrationStash.entries {
		if now.After(sp.expireAt) {
			sp.cleanup()
			delete(migrationStash.entries, t)
		}
	}
}

// ── preview ──

// PostMigrationImportPreview POST /api/migration/import/preview
// multipart: file（.scpkg）+ passphrase → 预览载荷 + 票据
func PostMigrationImportPreview(c *gin.Context) {
	file, err := c.FormFile("file")
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "file required", err)
		return
	}
	passphrase := c.PostForm("passphrase")
	if passphrase == "" {
		shared.Error(c, http.StatusBadRequest, "passphrase required", nil)
		return
	}
	fh, err := file.Open()
	if err != nil {
		shared.Error(c, http.StatusBadRequest, "file open failed", err)
		return
	}
	defer fh.Close()

	payload, zipFile, err := readMigrationPackage(fh, []byte(passphrase))
	if err != nil {
		// 错口令与文件损坏/非迁移包统一文案（防 oracle——errmarkers 既有
		// 注册表 WrongPassphraseExport + 前端 KNOWN_ERROR_I18N 复用）
		if zipFile != nil {
			zipFile.Close()
			_ = os.Remove(zipFile.Name())
		}
		shared.Error(c, http.StatusBadRequest, errmarkers.WrongPassphraseExport, nil)
		return
	}

	prev, err := buildMigrationPreview(payload)
	if err != nil {
		if zipFile != nil {
			zipFile.Close()
			_ = os.Remove(zipFile.Name())
		}
		shared.Error(c, http.StatusBadRequest, err.Error(), nil)
		return
	}
	sp := &stashedPackage{
		ticket:   uuid.New().String(),
		mode:     payload.Mode,
		payload:  mustJSONBytes(payload),
		zipFile:  zipFile,
		expireAt: time.Now().Add(migrationTicketTTL),
	}
	stashPackage(sp)
	prev.Ticket = sp.ticket
	c.JSON(http.StatusOK, gin.H{"data": prev})
}

// lineReadResult 首行读取结果
type lineReadResult struct {
	line       []byte // 首行内容（不含换行符）
	remainder  []byte // 换行符及之后被多读的字节（回填流用）
	terminated bool   // 是否在帽内读到换行
}

// readLineCapped 读首行（换行终止；触帽未终止返回 terminated=false——
// v1 单行大 JSON 的形态）
func readLineCapped(br *bufio.Reader, cap int) (*lineReadResult, error) {
	var buf bytes.Buffer
	tmp := make([]byte, 1)
	// 逐字节读首行：4KB 量级的 v2 头行逐字节代价可忽略；v1 触帽 64KB 即止
	for buf.Len() < cap {
		n, err := br.Read(tmp)
		if n > 0 {
			if tmp[0] == '\n' {
				return &lineReadResult{line: buf.Bytes(), remainder: nil, terminated: true}, nil
			}
			buf.WriteByte(tmp[0])
		}
		if err != nil {
			if err == io.EOF {
				return &lineReadResult{line: buf.Bytes(), terminated: false}, nil
			}
			return nil, err
		}
	}
	return &lineReadResult{line: buf.Bytes(), terminated: false}, nil
}

// readMigrationPackage 信封嗅探 → 解密 → 明文载荷。zipFile 仅 full 非空
// （spool 句柄与文件归调用方生命周期）；任何失败统一 err（handler 出同一文案，
// 防 oracle）。嗅探依据：v2 是 NDJSON（头行带换行且可解析为带 chunkSize 的
// 信封头），v1 是单行大 JSON（json.Marshal 不产裸换行）
func readMigrationPackage(r io.Reader, passphrase []byte) (*MigrationPayload, *os.File, error) {
	br := bufio.NewReaderSize(r, 64*1024)
	first, err := readLineCapped(br, 64*1024)
	if err != nil {
		return nil, nil, fmt.Errorf("empty package")
	}
	rest := io.MultiReader(bytes.NewReader(first.remainder), br)
	if first.terminated {
		if _, herr := config.ParseChunkedEnvelopeHeader(first.line); herr == nil {
			er, rerr := config.NewChunkedEnvelopeReaderFromStream(
				io.MultiReader(bytes.NewReader(first.line), rest), passphrase)
			if rerr != nil {
				return nil, nil, rerr
			}
			return spoolDecryptedZip(er)
		}
	}
	// v1 单发信封：整体读入（体量护栏防误拿大文件进内存）
	restAll, err := io.ReadAll(io.LimitReader(rest, migrationLightMaxBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(restAll) > migrationLightMaxBytes {
		return nil, nil, fmt.Errorf("package too large for light envelope")
	}
	body := make([]byte, 0, len(first.line)+len(restAll))
	body = append(body, first.line...)
	body = append(body, restAll...)
	plain, derr := config.DecryptWithPassphraseFormat(body, passphrase, config.MigrationFormat)
	if derr != nil {
		return nil, nil, derr
	}
	payload, perr := parseMigrationPayload(plain)
	if perr != nil {
		return nil, nil, perr
	}
	return payload, nil, nil
}

// spoolDecryptedZip v2 流式解密 → zip 临时文件（0600）→ 读 payload.json。
// 句柄保持打开（zip.Reader 惰性读条目需要），随 stash 票据生命周期关闭
func spoolDecryptedZip(er io.Reader) (*MigrationPayload, *os.File, error) {
	spool, err := os.CreateTemp("", "sc-migration-*.zip")
	if err != nil {
		return nil, nil, err
	}
	if err := spool.Chmod(0o600); err != nil {
		spool.Close()
		_ = os.Remove(spool.Name())
		return nil, nil, err
	}
	if _, err := io.Copy(spool, er); err != nil {
		spool.Close()
		_ = os.Remove(spool.Name())
		return nil, nil, err
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		spool.Close()
		_ = os.Remove(spool.Name())
		return nil, nil, err
	}
	fi, _ := spool.Stat()
	zr, zerr := zip.NewReader(spool, fi.Size())
	if zerr != nil {
		spool.Close()
		_ = os.Remove(spool.Name())
		return nil, nil, zerr
	}
	payload, perr := readMigrationPayloadFromZip(zr)
	if perr != nil {
		spool.Close()
		_ = os.Remove(spool.Name())
		return nil, nil, perr
	}
	return payload, spool, nil
}

// readMigrationPayloadFromZip 从全量包 zip 读明文头
func readMigrationPayloadFromZip(zr *zip.Reader) (*MigrationPayload, error) {
	for _, f := range zr.File {
		if f.Name != migrationPayloadFileName {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		b, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return nil, err
		}
		return parseMigrationPayload(b)
	}
	return nil, fmt.Errorf("payload.json missing in package")
}

// parseMigrationPayload 载荷 schema/版本门禁
func parseMigrationPayload(b []byte) (*MigrationPayload, error) {
	var p MigrationPayload
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, fmt.Errorf("migration payload not parseable")
	}
	if p.Schema != migrationPayloadSchema || p.Version != migrationPayloadVersion {
		return nil, fmt.Errorf("unsupported migration payload schema/version")
	}
	if p.Mode != MigrationModeLight && p.Mode != MigrationModeFull {
		return nil, fmt.Errorf("unsupported migration mode")
	}
	return &p, nil
}

// buildMigrationPreview 预览载荷装配（绝不含秘密明文：凭据行只出 host/
// 用户名级元数据）
func buildMigrationPreview(p *MigrationPayload) (*migrationPreview, error) {
	prev := &migrationPreview{
		Format:    config.MigrationFormat,
		Version:   p.Version,
		Mode:      p.Mode,
		Host:      p.Host,
		CreatedAt: p.CreatedAt,
		Blocks:    p.Blocks,
	}
	if p.Credentials != nil {
		localGit, _ := store.Get().Credential.List()
		gitKey := map[string]bool{}
		for _, cr := range localGit {
			gitKey[cr.Host+"\x00"+cr.Username] = true
		}
		for _, cr := range p.Credentials.Git {
			prev.Credentials = append(prev.Credentials, migrationCredRow{
				Kind: "git", Label: cr.Host, Detail: cr.Username, Exists: gitKey[cr.Host+"\x00"+cr.Username],
			})
		}
		localHosts, _ := store.Get().RemoteHost.List()
		hostKey := map[string]bool{}
		for _, h := range localHosts {
			hostKey[fmt.Sprintf("%s:%d@%s", h.Host, h.Port, h.User)] = true
		}
		for _, h := range p.Credentials.SSHHosts {
			prev.Credentials = append(prev.Credentials, migrationCredRow{
				Kind: "sshHost", Label: fmt.Sprintf("%s:%d", h.Host, h.Port), Detail: h.User + " / " + h.Name,
				Exists: hostKey[fmt.Sprintf("%s:%d@%s", h.Host, h.Port, h.User)],
			})
		}
		for _, k := range p.Credentials.SSHKeys {
			exists := false
			if e, err := store.Get().SshKey.FindByFingerprint(k.Fingerprint); err == nil && e != nil {
				exists = true
			}
			prev.Credentials = append(prev.Credentials, migrationCredRow{
				Kind: "sshKey", Label: k.Name, Detail: k.Fingerprint, Exists: exists,
			})
		}
		if p.Credentials.Deploy != nil && p.Credentials.Deploy.AnthropicToken != "" {
			localDeploy, _ := store.Get().DeployConfig.Get()
			prev.Credentials = append(prev.Credentials, migrationCredRow{
				Kind: "deploy", Label: "deploy", Detail: p.Credentials.Deploy.Model,
				Exists: localDeploy != nil && localDeploy.AnthropicToken != "",
			})
		}
		sortCredRows(prev.Credentials)
	}
	prev.HasAgentToken = p.Tokens != nil && p.Tokens.AgentToken != ""
	if p.Settings != nil {
		local := store.Get().Settings.Get()
		prev.Settings = settingsDiff(portableSettingsFromConfig(local.Server), p.Settings.Server)
	}
	if len(p.Instances) > 0 {
		localInst, _ := store.Get().Instance.List()
		byID := map[string]bool{}
		for _, in := range localInst {
			byID[in.ID] = true
		}
		for _, in := range p.Instances {
			prev.Instances = append(prev.Instances, migrationInstanceRow{
				ID: in.ID, Name: in.Name, URL: in.URL, Exists: byID[in.ID],
			})
		}
	}
	if p.Mode == MigrationModeFull && p.Content != nil {
		destRoot := syncDestRoot()
		cp := &migrationContentPreview{DestRoot: destRoot, DiskFree: diskFree(destRoot)}
		for _, tu := range p.Content.Units {
			row := migrationUnitRow{Key: tu.Key, Kind: tu.Kind, Name: tu.Name, Size: tu.Size, Files: tu.Entries, DirName: tu.DirName}
			if tu.Kind == UnitProject {
				row.DestPath = filepath.Join(destRoot, tu.DirName)
				for _, pc := range p.Projects {
					if pc.Key == tu.Key {
						row.IncludeGit = pc.IncludeGit
					}
				}
			}
			cp.TotalBytes += tu.Size
			cp.Units = append(cp.Units, row)
		}
		prev.Content = cp
	}
	return prev, nil
}

// ── apply ──

// migrationApplyReq POST /api/migration/import/apply 请求体。
// Blocks 策略表：credentials/instances/tokens ∈ merge|overwrite|skip；
// settings ∈ package|local（skip 同义 local）。缺省（未出现）= skip——
// 显式勾选语义由前端承担，服务端按字面策略执行
type migrationApplyReq struct {
	Ticket string            `json:"ticket" binding:"required"`
	Blocks map[string]string `json:"blocks"`
	// Projects full 模式勾选落位的项目单元键（project:<基名>）；空 = 按包内
	// 清单全落
	Projects []string `json:"projects,omitempty"`
}

// PostMigrationImportApply POST /api/migration/import/apply —— 应用导入
// （内容先落位，配置四块按策略；任一块失败整体回滚配置面）
func PostMigrationImportApply(c *gin.Context) {
	shared.LimitBody(c, 1<<20)
	var req migrationApplyReq
	if ok := shared.BindJSON(c, &req, ""); !ok {
		return
	}
	sp := popStash(req.Ticket)
	if sp == nil {
		shared.Error(c, http.StatusNotFound, "migration ticket expired or unknown, re-select the package", nil)
		return
	}
	defer sp.cleanup()
	var payload MigrationPayload
	if err := json.Unmarshal(sp.payload, &payload); err != nil {
		shared.Error(c, http.StatusBadRequest, "migration payload not parseable", err)
		return
	}

	report := &migrationApplyReport{Blocks: map[string]*migrationBlockReport{}}
	// 内容先落位：失败即干净终止（配置四块未动）；成功后配置块失败经 undo
	// 日志回滚配置面，已落位内容保留并如实报告（sync 落位自带 .sync-backup
	// 备份与逐文件语义，修正后二次导入幂等可重入）
	if payload.Mode == MigrationModeFull && payload.Content != nil {
		lr, err := landMigrationContent(c.Request.Context(), &payload, sp.zipPath(), req.Projects)
		report.Content = lr
		if err != nil {
			report.Error = err.Error()
			auditMigrationFailure(c, payload.Mode, report)
			shared.Error(c, http.StatusBadGateway, err.Error(), nil)
			return
		}
		for _, u := range lr.Units {
			if u.OK && u.ProjectID != "" {
				_, base := ParseUnitKey(u.Key)
				report.LandedProjects = append(report.LandedProjects, base)
			}
		}
		// 落位完成广播（与对端收 sync 推送同链：已打开编辑器自动重读）
		if lr != nil {
			notifyLanded(lr)
		}
	}

	// 配置四块按序应用（凭据→实例→设置→令牌；令牌最后——其 undo 最弱，
	// 排尾把「前面块失败波及令牌」的面收窄到令牌自身失败）
	order := []string{"credentials", "instances", "settings", "tokens"}
	var undos []func()
	rollback := func() {
		for i := len(undos) - 1; i >= 0; i-- {
			undos[i]()
		}
		undos = nil
		report.RolledBack = true
	}
	settingsApplied := false
	var applyErr error
	for _, block := range order {
		policy := req.Blocks[block]
		if policy == "" || policy == policySkip || policy == policyLocal {
			report.Blocks[block] = &migrationBlockReport{}
			continue
		}
		rep, undo, err := applyMigrationBlock(block, policy, &payload)
		report.Blocks[block] = rep
		if err != nil {
			rep.Error = err.Error()
			applyErr = fmt.Errorf("%s: %w", block, err)
			break
		}
		if block == "settings" {
			settingsApplied = true
		}
		if undo != nil {
			undos = append(undos, undo)
		}
	}
	if applyErr != nil {
		rollback()
		report.Error = applyErr.Error()
		auditMigrationFailure(c, payload.Mode, report)
		shared.Error(c, http.StatusInternalServerError, "migration import failed and rolled back: "+applyErr.Error(), nil)
		return
	}
	// 引导闭环数据：导入策略实际生效的对端实例数（前端据此给「一键首同步」）
	if pol := req.Blocks["instances"]; pol == policyMerge || pol == policyOverwrite {
		report.PeerCount = len(payload.Instances)
	}
	if settingsApplied {
		notifySettingsChanged()
	}
	auditMigration(c, store.AuditMigrationImport, migrationApplySummary(&payload, req.Blocks, report))
	c.JSON(http.StatusOK, gin.H{"data": report})
}

// landMigrationContent 全量包内容落位（复用 sync 落位引擎全套）。勾选过滤：
// 只落勾选项目单元及其同基上下文单元
func landMigrationContent(ctx context.Context, payload *MigrationPayload, zipPath string, selected []string) (*LandResult, error) {
	if zipPath == "" {
		return nil, fmt.Errorf("migration package spool unavailable")
	}
	destRoot := syncDestRoot()
	if err := os.MkdirAll(destRoot, 0o755); err != nil {
		return nil, fmt.Errorf("dest root create failed: %w", err)
	}
	f, err := os.Open(zipPath)
	if err != nil {
		return nil, fmt.Errorf("migration package spool unavailable")
	}
	defer f.Close()
	fi, _ := f.Stat()
	zr, err := zip.NewReader(f, fi.Size())
	if err != nil {
		return nil, fmt.Errorf("migration package zip unreadable")
	}
	sel := map[string]bool{}
	for _, s := range selected {
		sel[s] = true
	}
	meta := &TransferMeta{IncludeIgnored: payload.Content.IncludeIgnored}
	for _, tu := range payload.Content.Units {
		if len(sel) > 0 {
			pk := tu.Key
			if k := ProjectKeyOf(tu.Key); k != "" {
				pk = k
			}
			if !sel[pk] {
				continue
			}
		}
		meta.Units = append(meta.Units, tu)
	}
	if len(meta.Units) == 0 {
		return &LandResult{DestRoot: destRoot}, nil
	}
	return landZipReader(ctx, zr, meta, destRoot, nil)
}

// applyMigrationBlock 单块应用分派（policy 已过 skip/local 过滤）
func applyMigrationBlock(block, policy string, payload *MigrationPayload) (*migrationBlockReport, func(), error) {
	switch block {
	case "credentials":
		return applyCredentialsBlock(policy, payload.Credentials)
	case "instances":
		return applyInstancesBlock(policy, payload.Instances)
	case "settings":
		if policy != policyPackage {
			return &migrationBlockReport{}, func() {}, nil
		}
		return applySettingsBlock(payload)
	case "tokens":
		return applyTokensBlock(policy, payload.Tokens)
	}
	return &migrationBlockReport{}, func() {}, fmt.Errorf("unknown block %s", block)
}

// applyCredentialsBlock 凭据块（host 去重合并/覆盖 + 私钥指纹去重重映射）。
// 写链全部走 store encrypt-on-write 既有口（明文进、enc: 落盘）
func applyCredentialsBlock(policy string, cred *MigrationCredentials) (*migrationBlockReport, func(), error) {
	rep := &migrationBlockReport{}
	if cred == nil {
		return rep, func() {}, nil
	}
	var undoMu sync.Mutex
	var undos []func()
	rollback := func() {
		undoMu.Lock()
		defer undoMu.Unlock()
		for i := len(undos) - 1; i >= 0; i-- {
			undos[i]()
		}
		undos = nil
	}
	// ① SSH 私钥先行（host 引用重映射锚点）：指纹同钥内容寻址——merge 与
	// overwrite 同语义（指纹相同即同一把钥，无可覆盖差异）
	keyIDMap := map[string]string{}
	for _, k := range cred.SSHKeys {
		if k.ID == "" || k.PrivatePem == "" {
			continue
		}
		if exist, err := store.Get().SshKey.FindByFingerprint(k.Fingerprint); err == nil && exist != nil {
			keyIDMap[k.ID] = exist.ID
			rep.Skipped++
			continue
		}
		name := k.Name
		if name == "" {
			name = "imported"
		}
		pub, err := store.Get().SshKey.Import(name, []byte(k.PrivatePem))
		if err != nil {
			rep.Failed++
			continue
		}
		keyIDMap[k.ID] = pub.ID
		newID := pub.ID
		undoMu.Lock()
		undos = append(undos, func() { _ = store.Get().SshKey.Delete(newID) })
		undoMu.Unlock()
		rep.Imported++
	}
	// ② HTTPS/git 凭据：(Host, Username) 去重
	localGit, err := store.Get().Credential.List()
	if err != nil {
		rollback()
		return rep, func() {}, err
	}
	gitKey := map[string]*store.Credential{}
	for _, cr := range localGit {
		gitKey[cr.Host+"\x00"+cr.Username] = cr
	}
	for _, cr := range cred.Git {
		if cr.Host == "" {
			rep.Failed++
			continue
		}
		key := cr.Host + "\x00" + cr.Username
		if exist := gitKey[key]; exist != nil {
			if policy != policyOverwrite {
				rep.Skipped++
				continue
			}
			updated := *exist
			updated.Secret = cr.Secret
			updated.RefreshToken = cr.RefreshToken
			updated.AuthType = cr.AuthType
			updated.ExpiresAt = cr.ExpiresAt
			updated.Scope = cr.Scope
			updated.Status = cr.Status
			prev := *exist
			if err := store.Get().Credential.Save(&updated); err != nil {
				rep.Failed++
				continue
			}
			undoMu.Lock()
			undos = append(undos, func() { pc := prev; _ = store.Get().Credential.Save(&pc) })
			undoMu.Unlock()
			rep.Imported++
			continue
		}
		created := *cr
		created.ID = "" // 新条目本机重建 ID
		if err := store.Get().Credential.Save(&created); err != nil {
			rep.Failed++
			continue
		}
		newID := created.ID
		undoMu.Lock()
		undos = append(undos, func() { _ = store.Get().Credential.Delete(newID) })
		undoMu.Unlock()
		gitKey[key] = &created
		rep.Imported++
	}
	// ③ SSH 主机：(host:port@user) 去重；sshKeyId 重映射到本机私钥
	localHosts, err := store.Get().RemoteHost.List()
	if err != nil {
		rollback()
		return rep, func() {}, err
	}
	hostKey := map[string]string{} // key → id
	for _, h := range localHosts {
		hostKey[fmt.Sprintf("%s:%d@%s", h.Host, h.Port, h.User)] = h.ID
	}
	for _, h := range cred.SSHHosts {
		if h.Name == "" || h.Host == "" || h.User == "" {
			rep.Failed++
			continue
		}
		if newID, ok := keyIDMap[h.SshKeyID]; ok {
			h.SshKeyID = newID
		}
		// 引用钥不在包内且本机无同指纹钥：保旧引用，拨号前被既有链拦截提示
		// 重录（remotehost 导入同语义）
		key := fmt.Sprintf("%s:%d@%s", h.Host, h.Port, h.User)
		if existID := hostKey[key]; existID != "" {
			if policy != policyOverwrite {
				rep.Skipped++
				continue
			}
			prev, err := store.Get().RemoteHost.Get(existID)
			if err != nil {
				rep.Failed++
				continue
			}
			updated := *prev
			updated.Name = h.Name
			updated.AuthType = h.AuthType
			updated.Protocol = h.Protocol
			updated.Password = h.Password
			updated.SshKeyID = h.SshKeyID
			updated.PemContent = h.PemContent
			updated.HostKeyVerifyDisabled = h.HostKeyVerifyDisabled
			if err := store.Get().RemoteHost.Save(updated); err != nil {
				rep.Failed++
				continue
			}
			undoMu.Lock()
			undos = append(undos, func() { pp := *prev; _ = store.Get().RemoteHost.Save(pp) })
			undoMu.Unlock()
			rep.Imported++
			continue
		}
		created, err := store.Get().RemoteHost.Create(h)
		if err != nil {
			rep.Failed++
			continue
		}
		newID := created.ID
		undoMu.Lock()
		undos = append(undos, func() { _ = store.Get().RemoteHost.Delete(newID) })
		undoMu.Unlock()
		hostKey[key] = newID
		rep.Imported++
	}
	// ④ 部署凭据（单例）：merge=本机为空才补；overwrite=以包为准
	if cred.Deploy != nil && cred.Deploy.AnthropicToken != "" {
		local, _ := store.Get().DeployConfig.Get()
		if local != nil && local.AnthropicToken != "" && policy != policyOverwrite {
			rep.Skipped++
		} else {
			var prev config.DeployConfig
			if local != nil {
				prev = *local
			}
			incoming := *cred.Deploy
			if err := store.Get().DeployConfig.Save(incoming); err != nil {
				rep.Failed++
			} else {
				undoMu.Lock()
				undos = append(undos, func() { _ = store.Get().DeployConfig.Save(prev) })
				undoMu.Unlock()
				rep.Imported++
			}
		}
	}
	return rep, rollback, nil
}

// applyInstancesBlock 实例注册表（ID 去重；Save 链对明文 Token 加密落盘）
func applyInstancesBlock(policy string, instances []config.InstanceConfig) (*migrationBlockReport, func(), error) {
	rep := &migrationBlockReport{}
	var undoMu sync.Mutex
	var undos []func()
	rollback := func() {
		undoMu.Lock()
		defer undoMu.Unlock()
		for i := len(undos) - 1; i >= 0; i-- {
			undos[i]()
		}
		undos = nil
	}
	local, err := store.Get().Instance.List()
	if err != nil {
		return rep, func() {}, err
	}
	byID := map[string]config.InstanceConfig{}
	for _, in := range local {
		byID[in.ID] = in
	}
	for _, in := range instances {
		if in.IsLocal || in.URL == "" {
			rep.Failed++
			continue
		}
		if exist, ok := byID[in.ID]; ok {
			if policy != policyOverwrite {
				rep.Skipped++
				continue
			}
			merged := in
			merged.IsLocal = exist.IsLocal
			if err := store.Get().Instance.Save(merged); err != nil {
				rep.Failed++
				continue
			}
			undoMu.Lock()
			undos = append(undos, func() { _ = store.Get().Instance.Save(exist) })
			undoMu.Unlock()
			rep.Imported++
			continue
		}
		if err := store.Get().Instance.Save(in); err != nil {
			rep.Failed++
			continue
		}
		id := in.ID
		undoMu.Lock()
		undos = append(undos, func() { _ = store.Get().Instance.Delete(id) })
		undoMu.Unlock()
		rep.Imported++
	}
	return rep, rollback, nil
}

// applyTokensBlock 令牌族（仅 agent token 可迁，见模型注记）。
// merge=本机无令牌才导入；overwrite=以包为准
func applyTokensBlock(policy string, tokens *MigrationTokens) (*migrationBlockReport, func(), error) {
	rep := &migrationBlockReport{}
	if tokens == nil || tokens.AgentToken == "" {
		return rep, func() {}, nil
	}
	if exist := store.Get().AgentToken.Meta(); exist.Exists && policy != policyOverwrite {
		rep.Skipped++
		return rep, func() {}, nil
	}
	if err := store.Get().AgentToken.ImportPlain(tokens.AgentToken); err != nil {
		rep.Failed++
		return rep, func() {}, err
	}
	return rep, func() {}, nil
}

// migrationApplySummary 审计 Detail（块策略+计数元数据；不含凭据）
func migrationApplySummary(p *MigrationPayload, policies map[string]string, r *migrationApplyReport) string {
	var b strings.Builder
	fmt.Fprintf(&b, "mode=%s blocks=%s", p.Mode, migrationBlocksSummary(p))
	for _, k := range []string{"credentials", "instances", "settings", "tokens"} {
		pol := policies[k]
		if pol == "" || pol == policySkip || pol == policyLocal {
			continue
		}
		rep := r.Blocks[k]
		if rep == nil {
			continue
		}
		fmt.Fprintf(&b, " %s=%s/%d+%d-%d", k, pol, rep.Imported, rep.Skipped, rep.Failed)
	}
	if r.Content != nil {
		fmt.Fprintf(&b, " contentUnits=%d", len(r.Content.Units))
	}
	if r.RolledBack {
		b.WriteString(" rolledBack")
	}
	return b.String()
}

// auditMigrationFailure 导入失败审计（与成功同 action，failure 结果——
// 元数据同等脱敏；后台无请求面的失败走裸 Append 口——auditappend 双口纪律）
func auditMigrationFailure(c *gin.Context, mode string, r *migrationApplyReport) {
	detail := "mode=" + mode
	if r.Error != "" {
		detail += " err=" + r.Error
	}
	if r.RolledBack {
		detail += " rolledBack"
	}
	if s := store.Get(); s != nil {
		s.Audit.Append(store.AuditEvent{Action: store.AuditMigrationImport, Result: store.AuditResultFailure, IP: c.ClientIP(), Detail: detail})
	}
}

// mustJSONBytes 序列化小件（载荷为纯数据结构，失败不设防线）
func mustJSONBytes(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}
