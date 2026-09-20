package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
)

func main() {
	templatePath := flag.String("template", "", "ZNet Sink manifest template")
	sourcePath := flag.String("source", "", "JavaScript component source")
	outputPath := flag.String("out", "", "temporary manifest output")
	version := flag.String("version", "", "acceptance package version")
	flag.Parse()
	if err := run(*templatePath, *sourcePath, *outputPath, *version); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(templatePath, sourcePath, outputPath, version string) error {
	if templatePath == "" || sourcePath == "" || outputPath == "" || version == "" {
		return errors.New("template, source, out and version are required")
	}
	template, err := os.ReadFile(templatePath)
	if err != nil {
		return err
	}
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		return err
	}
	var manifest map[string]any
	if err := json.Unmarshal(template, &manifest); err != nil {
		return err
	}
	digest := sha256.Sum256(source)
	manifest["version"] = version
	manifest["source_sha256"] = hex.EncodeToString(digest[:])
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return os.WriteFile(outputPath, encoded, 0o600)
}
