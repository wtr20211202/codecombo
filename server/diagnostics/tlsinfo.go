package diagnostics

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strings"
	"time"

	"codecombo/server/tlsutil"
)

// TLS 取证面（P-20261124-1 S3②）：state/tls.json + tls-summary.txt。
//
// 2026-11-24 复盘里 3 天 3,953 条 "TLS handshake error ... unknown certificate"
// 没有聚合，且大概率不在按日日志里（net/http 默认把握手错误写 stderr →
// journal）。两层修复：
//  1. 运行时：app.go 给 http.Server 设 ErrorLog=slog.NewLogLogger（握手错误从此
//     与访问日志同文件，可被本包扫描）；
//  2. 采集时：tls.json 给证书公钥元数据（指纹/有效期/SAN/自签）+ 当前网卡 IP
//     与 SAN 的差集；tls-summary.txt 扫 logs（+journal 样本）里的握手错误，
//     无行时明确写 "no TLS handshake lines found in packed logs"——不承诺一定
//     能数出 3,953 条（历史日志在 journal 里，包只能扫到包内的）。
//
// 私钥永不读取：tlsutil.LeafSummary 只接受 certPath。

const (
	// tlsScanWindowDeep deep 模式的单文件扫描窗口（尾偏置）
	tlsScanWindowDeep = 14 << 20
	// tlsScanWindow 默认模式的单文件扫描窗口
	tlsScanWindow = 2 << 20
	// tlsScanTopSignatures 签名条数上限
	tlsScanTopSignatures = 20
)

// TLSDoc state/tls.json 的结构
type TLSDoc struct {
	GeneratedAt string            `json:"generatedAt"`
	Status      string            `json:"status"` // ok | skipped
	Reason      string            `json:"reason,omitempty"`
	Enabled     bool              `json:"enabled"`
	CertFile    string            `json:"certFile,omitempty"`
	Leaf        *tlsutil.LeafInfo `json:"leaf,omitempty"`
	CurrentIPs  []string          `json:"currentIps"`
	MissingIPs  []string          `json:"missingIpsInSan,omitempty"`
	HSTS        string            `json:"hsts"`
	HSTSNote    string            `json:"hstsNote"`
	Notes       []string          `json:"notes,omitempty"`
}

// collectTLS 采集证书/监听摘要
func collectTLS(opts Options, red *Redactor) TLSDoc {
	doc := TLSDoc{
		GeneratedAt: opts.Now.Format(time.RFC3339),
		Enabled:     opts.TLSEnabled,
		CertFile:    red.Path(opts.TLSCertFile),
		CurrentIPs:  []string{},
		HSTS:        tlsutil.HSTSHeaderValue,
		HSTSNote: "HSTS is emitted only when TLS is enabled; browsers ignore HSTS for IP-literal hosts (RFC 6797 §2.3). " +
			"If clients reject the certificate: remove cert.pem+key.pem and restart (self-signed re-issue), or install a CA-issued certificate — see README.txt",
	}
	doc.CurrentIPs = append(doc.CurrentIPs, currentLocalIPs()...)
	if !opts.TLSEnabled {
		doc.Status = "skipped"
		doc.Reason = "TLS listener is not enabled on this instance (plain HTTP)"
		return doc
	}
	if strings.TrimSpace(opts.TLSCertFile) == "" {
		doc.Status = "skipped"
		doc.Reason = "TLS enabled but cert path unknown to the collector"
		return doc
	}
	// 证书读取也可能撞上挂死的共享盘（自签 cert.pem 就在数据目录）：放进带
	// deadline 的 goroutine，超时写 skipped 而不是让整包卡住
	type leafProbe struct {
		leaf *tlsutil.LeafInfo
		err  error
	}
	lp, leafTimedOut := runDeadline(opts.Deadline, func() leafProbe {
		l, e := tlsutil.LeafSummary(opts.TLSCertFile)
		return leafProbe{leaf: l, err: e}
	})
	if leafTimedOut {
		doc.Status = "skipped"
		doc.Reason = "certificate read hit the collection deadline (hung mount?)"
		return doc
	}
	if lp.err != nil {
		doc.Status = "skipped"
		doc.Reason = "certificate metadata unreadable: " + red.Line(lp.err.Error())
		return doc
	}
	doc.Status = "ok"
	doc.Leaf = lp.leaf
	doc.MissingIPs = missingIPs(lp.leaf.IPAddresses, doc.CurrentIPs)
	if lp.leaf.IsSelfSigned {
		doc.Notes = append(doc.Notes,
			"self-signed certificate: browsers warn on first visit; clients pin the SHA-256 fingerprint (see TELEMETRY/peercert trust store)")
	}
	if lp.leaf.DaysRemaining < 0 {
		doc.Notes = append(doc.Notes, "certificate is EXPIRED — every TLS handshake will fail")
	} else if lp.leaf.DaysRemaining < 30 {
		doc.Notes = append(doc.Notes, fmt.Sprintf("certificate expires in %d days", lp.leaf.DaysRemaining))
	}
	return doc
}

// currentLocalIPs 当前本机非回环地址（去重排序）
func currentLocalIPs() []string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	var out []string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, aerr := iface.Addrs()
		if aerr != nil {
			continue
		}
		for _, a := range addrs {
			ip, _, perr := net.ParseCIDR(a.String())
			if perr != nil || seen[ip.String()] {
				continue
			}
			seen[ip.String()] = true
			out = append(out, ip.String())
		}
	}
	sort.Strings(out)
	return out
}

// missingIPs SAN 里有、但本机当前没有的 IP（客户端按 SAN 校验时最容易踩空）
func missingIPs(san, current []string) []string {
	if len(san) == 0 {
		return nil
	}
	have := map[string]bool{}
	for _, ip := range current {
		have[ip] = true
	}
	var out []string
	for _, ip := range san {
		if !have[ip] {
			out = append(out, ip)
		}
	}
	sort.Strings(out)
	return out
}

// renderTLSJSON state/tls.json
func renderTLSJSON(doc TLSDoc) string {
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// tlsSig 一条握手错误签名
type tlsSig struct {
	Count  int64
	First  time.Time
	Last   time.Time
	Sample string
}

// collectTLSSummary tls-summary.txt：扫包内日志（+journal 样本）的 TLS 握手
// 错误；窗口尾偏置（失败证据在尾），deep 模式放大窗口。
func collectTLSSummary(opts Options, raw []rawFilePlan, journalSample string, red *Redactor) (string, int64, int) {
	window := int64(tlsScanWindow)
	if opts.Deep {
		window = tlsScanWindowDeep
	}
	sigs := map[string]*tlsSig{}
	var scannedBytes int64
	var files int
	stopped := false
	for _, rf := range raw {
		if opts.DeadlineReached() {
			stopped = true
			break
		}
		if rf.meta.Status != StatusPresent && rf.meta.Status != StatusTruncated {
			continue
		}
		if !strings.HasPrefix(rf.meta.Name, "logs/") {
			continue
		}
		f, err := os.Open(rf.abs)
		if err != nil {
			continue
		}
		read := int64(0)
		if rf.size > window {
			read = window
			_, _ = f.Seek(rf.size-window, io.SeekStart)
		}
		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 64<<10), scanBufMax)
		for sc.Scan() {
			line := sc.Text()
			if !isTLSHandshakeLine(line) {
				continue
			}
			sig := errorSignatureOf(line)
			es := sigs[sig]
			if es == nil {
				es = &tlsSig{Sample: red.Line(truncate(line, signatureSampleMax))}
				sigs[sig] = es
			}
			es.Count++
			ts := parseLogTimestamp(timestampOf(line))
			if !ts.IsZero() {
				if es.First.IsZero() {
					es.First = ts
				}
				es.Last = ts
			}
		}
		_ = f.Close()
		scannedBytes += read
		files++
	}
	// journal 样本（既有 systemd-journal 探针的 8s 输出）：同一判据，来源标注 journal
	if journalSample != "" {
		for _, line := range strings.Split(journalSample, "\n") {
			if !isTLSHandshakeLine(line) {
				continue
			}
			sig := "journal:" + errorSignatureOf(line)
			es := sigs[sig]
			if es == nil {
				es = &tlsSig{Sample: red.Line(truncate(line, signatureSampleMax))}
				sigs[sig] = es
			}
			es.Count++
		}
	}

	type row struct {
		sig string
		es  *tlsSig
	}
	rows := make([]row, 0, len(sigs))
	var total int64
	for sig, es := range sigs {
		total += es.Count
		rows = append(rows, row{sig, es})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].es.Count != rows[j].es.Count {
			return rows[i].es.Count > rows[j].es.Count
		}
		return rows[i].sig < rows[j].sig
	})
	if len(rows) > tlsScanTopSignatures {
		rows = rows[:tlsScanTopSignatures]
	}

	var b strings.Builder
	b.WriteString("# TLS handshake errors found in the packed logs (+ journal sample)\n")
	fmt.Fprintf(&b, "# scannedFiles=%d scannedBytes=%d deep=%t windowBytes=%d\n", files, scannedBytes, opts.Deep, window)
	b.WriteString("# scope: only what is INSIDE this bundle can be counted — historical handshake errors written to journal before ErrorLog was wired are not in these files\n")
	b.WriteString("# (app.go sets http.Server.ErrorLog to the daily slog handler, so NEW handshake errors land in the same daily log)\n")
	if stopped {
		b.WriteString("# scan stopped at the collection deadline — handshake counts are a lower bound\n")
	}
	b.WriteString("\n")
	if total == 0 {
		b.WriteString("no TLS handshake lines found in packed logs\n")
		return b.String(), 0, files
	}
	fmt.Fprintf(&b, "# total=%d distinct=%d\n", total, len(rows))
	b.WriteString("# count | first | last | signature\n")
	for _, r := range rows {
		first, last := "-", "-"
		if !r.es.First.IsZero() {
			first = r.es.First.Format(time.RFC3339)
		}
		if !r.es.Last.IsZero() {
			last = r.es.Last.Format(time.RFC3339)
		}
		fmt.Fprintf(&b, "%d | %s | %s | %s\n", r.es.Count, first, last, strings.ReplaceAll(r.es.Sample, "\n", " "))
	}
	return b.String(), total, files
}

// isTLSHandshakeLine 握手错误判据（net/http 与 crypto/tls 的两种措辞）
func isTLSHandshakeLine(line string) bool {
	lower := strings.ToLower(line)
	return strings.Contains(lower, "tls handshake error") ||
		strings.Contains(lower, "tls: ") ||
		strings.Contains(lower, "unknown certificate") ||
		strings.Contains(lower, "x509:")
}
