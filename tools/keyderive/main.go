package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/zerodenet/connect/internal/devsigning"
)

func main() {
	if err := derive(os.Args[1:]); err != nil {
		fatal(err)
	}
}

func derive(args []string) error {
	if len(args) != 2 && len(args) != 3 {
		return errors.New("usage: keyderive PRIVATE_KEY PUBLIC_KEY_OUT [SEED_OUT]")
	}
	key, err := devsigning.ReadPrivateKey(args[0])
	if err != nil {
		return err
	}
	wanted := devsigning.PublicKeyText(key) + "\n"
	if current, err := os.ReadFile(args[1]); err == nil {
		if strings.TrimSpace(string(current)) != strings.TrimSpace(wanted) {
			return errors.New("existing public key belongs to another publisher identity")
		}
	} else if !os.IsNotExist(err) {
		return err
	} else if err := os.WriteFile(args[1], []byte(wanted), 0o600); err != nil {
		return err
	}
	if len(args) == 3 {
		if current, err := os.ReadFile(args[2]); err == nil {
			if !bytes.Equal(current, key.Seed()) {
				return errors.New("existing seed belongs to another publisher identity")
			}
			if err := os.Chmod(args[2], 0o600); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		} else if err := os.WriteFile(args[2], key.Seed(), 0o600); err != nil {
			return err
		}
	}
	fmt.Println("derived publisher signing inputs")
	return nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
