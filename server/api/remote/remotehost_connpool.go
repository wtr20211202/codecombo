package remote

import (
	"errors"
	"io"
	"os"
	"time"

	"codecombo/server/config"
	"codecombo/server/sshclient"
	"codecombo/server/store"
)

// ============== per-host SSH 短操作连接池（P-20261005-159） ==============
//
// remote 域文件浏览/编辑读写/诊断/exec/git 对照此前每请求付全套 SSH 握手
// （LAN 数百 ms、WAN 秒级 × 高频交互）。池（sshclient.ClientPool）按 hostID
// 复用单条连接：5min 空闲 TTL 关闭、per-host 并发上限短排队、借出探活 +
// 首错弃置重建一次、凭据/指纹/主机配置变更 FlushHost 即时失效。
//
// 分界（池只服务短操作）：远程终端四处 Dialer 与 SSH 隧道持独占长连接
// （remotehost_terminal.go / remotehost_tunnel.go 生命周期自管，不走池）；
// 部署域（api/deploy、deploy/manager）按提案范围维持独占拨号。

// conns 主机短操作连接池单例：上限与 TTL 取 sshclient 默认（每主机 4 并发 /
// 5min 空闲）；生命周期挂远程模块（module.go 30s reap 循环 + Stop 时 CloseAll）
var conns = sshclient.NewClientPool(sshclient.DefaultPoolPerHostLimit, sshclient.DefaultPoolTTL)

// errPoolRebuildFailed 重建失败后的后续操作错误（dialFileErr 按 502 映射）
var errPoolRebuildFailed = errors.New("remote host dial failed")

// dialOptions 主机记录 → 拨号参数（池借出与既有独占拨号同源，防两处漂移；
// Timeout 沿既有 15s 惯例）
func dialOptions(rh *config.RemoteHost) sshclient.ConnectOptions {
	return sshclient.ConnectOptions{
		Host: rh.Host, Port: rh.Port, User: rh.User,
		Auth:            sshclient.AuthMethodFor(rh.AuthType, rh.Password, rh.PemContent),
		SkipHostKeyTOFU: rh.HostKeyVerifyDisabled,
		Timeout:         15 * time.Second,
	}
}

// FlushPoolHost 丢弃指定主机的池内连接（凭据/指纹/主机配置变更语义：旧连接
// 即时失效，下次借出按最新配置重新拨号+TOFU 校验）。主机 CRUD / hostkey 重置
// / sshkey 删除级联调用
func FlushPoolHost(hostID string) { conns.FlushHost(hostID) }

// FlushPoolHostsReferencingKey 引用指定 SSH key 的主机全部出池（key 删除后
// 旧连接的公钥语义已失效；按主机记录 SshKeyID 匹配，sshkey 删除级联调用）
func FlushPoolHostsReferencingKey(keyID string) {
	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		return // 清单读失败时放弃收割：TTL（5min）兜底回收，旧连接不会永久存活
	}
	for _, h := range hosts {
		if h.SshKeyID == keyID {
			conns.FlushHost(h.ID)
		}
	}
}

// leaseHostFile 按主机记录借出池化文件通道（SFTP；池键 = 主机 ID）。
// 调用方 defer fc.Close() 语义不变——pooledFileClient.Close 归还租约
func leaseHostFile(rh *config.RemoteHost) (fileClient, error) {
	lease, err := conns.Get(rh.ID, dialOptions(rh))
	if err != nil {
		return nil, err
	}
	return &pooledFileClient{rh: rh, lease: lease, fc: &sftpFileClient{c: lease.Client()}}, nil
}

// pooledFileClient 池化 fileClient 装饰器：一次借出服务整个 handler 请求
// （下载/zip 的流式读全程持租约，reap 不回收在借连接），首个连接级错误弃置
// 重建一次重放该操作（半开自愈，池借出探活之外的第二道）。业务失败（文件
// 不存在/权限拒绝）不重建
type pooledFileClient struct {
	rh      *config.RemoteHost
	lease   *sshclient.PoolLease
	fc      fileClient
	rebuilt bool // 半开重建只做一次：持续坏网时不无限重建循环
}

// attempt 执行单个操作；连接级首错弃置当前连接、按最新主机记录重建一次重放。
// replay 非 nil 时在重放前调用（流式写操作借它回卷读端，返回 false 即放弃
// 重放——截断流重传会把不完整内容当完整文件落远端，宁可不重试）
func (w *pooledFileClient) attempt(fn func(fc fileClient) error, replay func() bool) error {
	if w.fc == nil {
		return errPoolRebuildFailed // 重建已失败：后续操作按拨号失败呈递
	}
	err := fn(w.fc)
	if err == nil || w.rebuilt || !sshclient.IsConnLevelError(err) {
		return err
	}
	if replay != nil && !replay() {
		return err
	}
	if !w.rebuild() {
		return err // 重建失败：首个连接级错误如实上抛
	}
	w.rebuilt = true
	return fn(w.fc)
}

// rebuild 弃置当前租约并重新借出（新连接按重建时刻的最新主机记录拨号——
// 请求中途主机配置被改也不会把旧凭据再拨出去）
func (w *pooledFileClient) rebuild() bool {
	w.lease.MarkDead()
	w.lease.End()
	lease, err := conns.Get(w.rh.ID, dialOptions(w.rh))
	if err != nil {
		w.lease, w.fc = nil, nil
		return false
	}
	w.lease = lease
	w.fc = &sftpFileClient{c: lease.Client()}
	return true
}

// Close 归还租约（幂等）。池化通道无独占连接可关，handler 侧 defer fc.Close()
// 语义不变
func (w *pooledFileClient) Close() error {
	if w.lease != nil {
		w.lease.End()
		w.lease = nil
	}
	return nil
}

func (w *pooledFileClient) ListDir(path string) ([]sshclient.DirEntry, error) {
	var out []sshclient.DirEntry
	err := w.attempt(func(fc fileClient) error { var e error; out, e = fc.ListDir(path); return e }, nil)
	return out, err
}

func (w *pooledFileClient) Stat(p string) (int64, bool, error) {
	var size int64
	var isDir bool
	err := w.attempt(func(fc fileClient) error { var e error; size, isDir, e = fc.Stat(p); return e }, nil)
	return size, isDir, err
}

func (w *pooledFileClient) Open(p string) (io.ReadCloser, error) {
	var f io.ReadCloser
	err := w.attempt(func(fc fileClient) error { var e error; f, e = fc.Open(p); return e }, nil)
	return f, err
}

func (w *pooledFileClient) Upload(r io.Reader, p string) error {
	return w.attempt(func(fc fileClient) error { return fc.Upload(r, p) }, func() bool {
		// 重放前回卷读端（bytes.Reader / os.File 皆实现 Seeker）：已消费的
		// 流重传会把截断内容当完整文件落远端；不可回卷的流放弃重放
		s, ok := r.(io.Seeker)
		if !ok {
			return false
		}
		_, err := s.Seek(0, io.SeekStart)
		return err == nil
	})
}

func (w *pooledFileClient) Mkdir(p string) error {
	return w.attempt(func(fc fileClient) error { return fc.Mkdir(p) }, nil)
}

func (w *pooledFileClient) MkdirAll(p string) error {
	return w.attempt(func(fc fileClient) error { return fc.MkdirAll(p) }, nil)
}

func (w *pooledFileClient) Rename(from, to string) error {
	return w.attempt(func(fc fileClient) error { return fc.Rename(from, to) }, nil)
}

func (w *pooledFileClient) RemoveAll(p string) error {
	return w.attempt(func(fc fileClient) error { return fc.RemoveAll(p) }, nil)
}

func (w *pooledFileClient) Chmod(p string, mode os.FileMode) error {
	return w.attempt(func(fc fileClient) error { return fc.Chmod(p, mode) }, nil)
}

func (w *pooledFileClient) Mode(p string) (os.FileMode, error) {
	var mode os.FileMode
	err := w.attempt(func(fc fileClient) error { var e error; mode, e = fc.Mode(p); return e }, nil)
	return mode, err
}
