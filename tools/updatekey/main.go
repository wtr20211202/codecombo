// 自更新发布配套工具（A5 发布侧）。
//
// 用法：
//
//	go run ./tools/updatekey keygen                 # 生成 ed25519 密钥对（输出 base64）
//	go run ./tools/updatekey pubkey <priv_b64>      # 由私钥推导公钥（base64）
//	go run ./tools/updatekey sign <priv_b64> < file # 从 stdin 读文件内容并签名：
//	                                                # sha256 hex 摘要字符串 → ed25519 → base64
//
// 发布约定与 server/update/verify.go 一一对应：
//   - <binary>.sha256 = 小写 hex 摘要（构建脚本用 sha256sum 生成，verifyChecksum 消费）
//   - <binary>.sig    = 对 hex 摘要字符串的 ed25519 签名，base64 编码（verifySignature 消费）
//   - 公钥经 build.sh 注入 ldflags：simple-coding/server/update.updatePubKey=<base64>
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
)

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "keygen":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		fail(err)
		fmt.Printf("SC_UPDATE_PRIVATE_KEY=%s\n", base64.StdEncoding.EncodeToString(priv))
		fmt.Printf("SC_UPDATE_PUBKEY=%s\n", base64.StdEncoding.EncodeToString(pub))
	case "pubkey":
		need(3)
		priv := decodeSeed(os.Args[2])
		pub := priv.Public().(ed25519.PublicKey)
		fmt.Println(base64.StdEncoding.EncodeToString(pub))
	case "sign":
		need(3)
		// stdin 管道式签名：cat <binary> | updatekey sign <priv_b64>
		data, err := io.ReadAll(os.Stdin)
		fail(err)
		priv := decodeSeed(os.Args[2])
		sum := sha256.Sum256(data)
		sig := ed25519.Sign(priv, []byte(hex.EncodeToString(sum[:])))
		fmt.Println(base64.StdEncoding.EncodeToString(sig))
	default:
		usage()
	}
}

// decodeSeed 解析 base64 私钥（ed25519.PrivateKey / Seed 的 base64 原始编码）
func decodeSeed(s string) ed25519.PrivateKey {
	raw, err := base64.StdEncoding.DecodeString(s)
	fail(err)
	switch len(raw) {
	case ed25519.PrivateKeySize, ed25519.SeedSize:
		return ed25519.PrivateKey(raw)
	default:
		fmt.Fprintf(os.Stderr, "error: private key must be %d or %d bytes after base64 decode, got %d\n",
			ed25519.PrivateKeySize, ed25519.SeedSize, len(raw))
		os.Exit(1)
		return nil
	}
}

func need(n int) {
	if len(os.Args) < n {
		usage()
	}
}

func fail(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: updatekey keygen | updatekey pubkey <priv_b64> | updatekey sign <priv_b64> < file")
	os.Exit(1)
}
