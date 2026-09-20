package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
)

func main() {
	templatePath := flag.String("template", "", "ZBoard manifest template")
	outputPath := flag.String("out", "", "temporary manifest output")
	version := flag.String("version", "", "acceptance package version")
	platform := flag.String("platform", "", "current GOOS-GOARCH")
	runtimePath := flag.String("runtime", "", "runtime path inside the package")
	flag.Parse()
	if err := run(*templatePath, *outputPath, *version, *platform, *runtimePath); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(templatePath, outputPath, version, platform, runtimePath string) error {
	if templatePath == "" || outputPath == "" || version == "" || platform == "" || runtimePath == "" {
		return errors.New("template, out, version, platform and runtime are required")
	}
	raw, err := os.ReadFile(templatePath)
	if err != nil {
		return err
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return err
	}
	components, ok := manifest["components"].(map[string]any)
	if !ok {
		return errors.New("manifest template has no components object")
	}
	server, ok := components["server"].(map[string]any)
	if !ok {
		return errors.New("manifest template has no server component")
	}
	manifest["name"] = "Connect"
	manifest["version"] = version
	manifest["files"] = map[string]string{}
	server["executables"] = map[string]string{platform: runtimePath}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	return os.WriteFile(outputPath, encoded, 0o600)
}
