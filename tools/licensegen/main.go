// licensegen 许可证签发工具（仅限授权人员使用）
//
// 用法：
//
//	licensegen keygen                              生成 Ed25519 密钥对
//	licensegen sign -priv <hex私钥> -licensee <名称> [-edition <版次>] [-features <逗号分隔>] [-expires <RFC3339>]
//
// 安全模型：
//   - 私钥仅在命令行传入，不落盘、不入库
//   - 本工具代码可开源（无硬编码密钥），私钥由使用者自行保管
//   - 签发的许可由服务端内嵌公钥验证
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"codecombo/server/license"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "keygen":
		cmdKeygen()
	case "sign":
		cmdSign(os.Args[2:])
	default:
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`simple-coding license generator

Usage:
  licensegen keygen                              Generate Ed25519 keypair
  licensegen sign -priv <hex> -licensee <name>   Sign a license
        [-edition <beta|standard|pro|enterprise>]
        [-features <comma-separated, default *>]
        [-expires <RFC3339, empty = never>]`)
}

func cmdKeygen() {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "keygen: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("public key  (embed via ldflags): %s\n", hex.EncodeToString(pub))
	fmt.Printf("private key (keep secret):       %s\n", hex.EncodeToString(priv))
}

func cmdSign(args []string) {
	fs := flag.NewFlagSet("sign", flag.ExitOnError)
	privHex := fs.String("priv", "", "private key (hex)")
	licensee := fs.String("licensee", "", "licensee name")
	edition := fs.String("edition", "standard", "edition")
	features := fs.String("features", "*", "comma-separated features")
	expires := fs.String("expires", "", "expiry (RFC3339, empty = never)")
	_ = fs.Parse(args)

	if *privHex == "" || *licensee == "" {
		fmt.Fprintf(os.Stderr, "sign: -priv and -licensee are required\n")
		os.Exit(1)
	}
	privBytes, err := hex.DecodeString(*privHex)
	if err != nil || len(privBytes) != ed25519.PrivateKeySize {
		fmt.Fprintf(os.Stderr, "sign: invalid private key\n")
		os.Exit(1)
	}
	priv := ed25519.PrivateKey(privBytes)

	featList := []string{}
	for _, f := range strings.Split(*features, ",") {
		if f != "" {
			featList = append(featList, f)
		}
	}
	if len(featList) == 0 {
		featList = []string{"*"}
	}

	now := time.Now().UTC().Format(time.RFC3339)
	lic := &license.License{
		Licensee:  *licensee,
		Product:   "simple-coding",
		Edition:   *edition,
		Features:  featList,
		IssuedAt:  now,
		ExpiresAt: *expires,
	}
	payload, err := json.Marshal(lic)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		os.Exit(1)
	}
	sig := ed25519.Sign(priv, payload)

	b64 := base64.RawURLEncoding
	fmt.Printf("license key:\n%s.%s\n",
		b64.EncodeToString(payload),
		b64.EncodeToString(sig))
}
