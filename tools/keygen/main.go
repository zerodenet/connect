package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 2 {
		fatal(errors.New("usage: keygen OUTPUT_DIRECTORY"))
	}
	if err := run(os.Args[1]); err != nil {
		fatal(err)
	}
}

func run(directory string) error {
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	files := []struct {
		name string
		data []byte
	}{
		{"publisher.key", []byte(base64.StdEncoding.EncodeToString(privateKey) + "\n")},
		{"publisher.key.pub", []byte(base64.StdEncoding.EncodeToString(publicKey) + "\n")},
		{"publisher.seed", privateKey.Seed()},
	}
	for _, file := range files {
		path := filepath.Join(directory, file.name)
		handle, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return fmt.Errorf("create %s: %w", path, err)
		}
		if _, err := handle.Write(file.data); err != nil {
			handle.Close()
			return err
		}
		if err := handle.Close(); err != nil {
			return err
		}
	}
	fmt.Println("created one publisher identity for ZBoard and ZNet Sink package signing")
	return nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
