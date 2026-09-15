package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/zerodenet/connect/internal/devsigning"
)

func main() {
	if len(os.Args) != 3 {
		fatal(errors.New("usage: keyderive PRIVATE_KEY PUBLIC_KEY_OUT"))
	}
	key, err := devsigning.ReadPrivateKey(os.Args[1])
	if err != nil {
		fatal(err)
	}
	wanted := devsigning.PublicKeyText(key) + "\n"
	if current, err := os.ReadFile(os.Args[2]); err == nil {
		if strings.TrimSpace(string(current)) != strings.TrimSpace(wanted) {
			fatal(errors.New("existing public key belongs to another publisher identity"))
		}
		return
	} else if !os.IsNotExist(err) {
		fatal(err)
	}
	if err := os.WriteFile(os.Args[2], []byte(wanted), 0o600); err != nil {
		fatal(err)
	}
	fmt.Println("derived publisher public key")
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
