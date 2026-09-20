package main

import (
	"context"
	"encoding/json"
	"sync"

	pluginv1 "github.com/zerodenet/zboard/backend/pkg/pluginapi/v1"
)

const (
	pluginID = "org.zerodenet.connect.zboard"
)

// Release builds replace this value with -X main.pluginVersion=<manifest version>.
// Keeping a valid source default makes local tests and `go run` deterministic.
var pluginVersion = "0.0.1"

var runtimeCapabilities = []string{
	"zboard.ui.page.v1",
	"zboard.config.v1",
	"zboard.storage.v1",
	"zboard.http.route.v1",
	pluginv1.AccountAssertionCapability,
	pluginv1.SubscriptionProjectionCapability,
	pluginv1.MessageProjectionCapability,
}

type connectRuntime struct {
	pluginv1.UnimplementedPluginControlServer

	configMu sync.RWMutex
	config   runtimeConfig
	opMu     sync.Mutex

	openStorage func() (storageClient, error)
	openHost    func() (hostClient, error)
}

func newRuntime() *connectRuntime {
	return &connectRuntime{
		config: runtimeConfig{DisplayName: "ZBoard"},
		openStorage: func() (storageClient, error) {
			return pluginv1.HostStorageFromEnvironment()
		},
		openHost: func() (hostClient, error) {
			return pluginv1.HostClientFromEnvironment()
		},
	}
}

func (runtime *connectRuntime) GetInfo(context.Context, *pluginv1.Empty) (*pluginv1.Info, error) {
	return &pluginv1.Info{Id: pluginID, Version: pluginVersion, Protocol: 1, Capabilities: runtimeCapabilities}, nil
}

func (runtime *connectRuntime) Health(context.Context, *pluginv1.Empty) (*pluginv1.HealthResult, error) {
	config := runtime.currentConfig()
	if !config.Enabled {
		return &pluginv1.HealthResult{Healthy: true, Message: "Connect is installed but communication is disabled"}, nil
	}
	return &pluginv1.HealthResult{Healthy: true, Message: "Connect provider runtime is ready"}, nil
}

func (runtime *connectRuntime) DescribeConfig(_ context.Context, request *pluginv1.ConfigRequest) (*pluginv1.ConfigResult, error) {
	return runtime.validateConfig(request)
}

func (runtime *connectRuntime) ValidateConfig(_ context.Context, request *pluginv1.ConfigRequest) (*pluginv1.ConfigResult, error) {
	return runtime.validateConfig(request)
}

func (runtime *connectRuntime) validateConfig(request *pluginv1.ConfigRequest) (*pluginv1.ConfigResult, error) {
	_, normalized, err := normalizeConfig(request.GetConfigJson())
	if err != nil {
		return nil, err
	}
	return &pluginv1.ConfigResult{NormalizedJson: normalized}, nil
}

func (runtime *connectRuntime) ApplyConfig(_ context.Context, request *pluginv1.ConfigRequest) (*pluginv1.HealthResult, error) {
	config, _, err := normalizeConfig(request.GetConfigJson())
	if err != nil {
		return nil, err
	}
	runtime.configMu.Lock()
	runtime.config = config
	runtime.configMu.Unlock()
	return &pluginv1.HealthResult{Healthy: true, Message: "Connect configuration applied"}, nil
}

func (runtime *connectRuntime) TestConfig(_ context.Context, request *pluginv1.ConfigRequest) (*pluginv1.HealthResult, error) {
	config, _, err := normalizeConfig(request.GetConfigJson())
	if err != nil {
		return nil, err
	}
	message := "Connect communication is disabled"
	if config.Enabled {
		message = "Connect configuration is valid; provider state is checked when communication starts"
	}
	return &pluginv1.HealthResult{Healthy: true, Message: message}, nil
}

func (runtime *connectRuntime) currentConfig() runtimeConfig {
	runtime.configMu.RLock()
	defer runtime.configMu.RUnlock()
	return runtime.config
}

func jsonResponse(status uint32, value any) *pluginv1.HTTPResponse {
	body, _ := json.Marshal(value)
	return &pluginv1.HTTPResponse{Status: status, ContentType: "application/json", Body: body}
}

func main() {
	pluginv1.Serve(newRuntime())
}
