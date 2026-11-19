package workbench

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/buildprovider"
	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/i18n"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginbackend"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginhost"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugininstall"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginservice"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginsettings"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugintrust"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
	"github.com/1lck/Lithe-IDEA/desktop/internal/toolchain"
)

const pythonSupportPluginID = "io.github.lithe-idea.python-support"

type workspaceTrustSaver interface {
	SaveWorkspaceTrust(ctx context.Context, kernel toolchain.Kernel, trusted bool) (bool, error)
}

func pythonPackageDigest(t *testing.T, root string) map[string]string {
	t.Helper()
	digest := map[string]string{}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		sum := sha256.New()
		_, readErr := io.Copy(sum, f)
		closeErr := f.Close()
		if readErr != nil {
			return readErr
		}
		if closeErr != nil {
			return closeErr
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		digest[rel] = hex.EncodeToString(sum.Sum(nil))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return digest
}

func toWindowsVariantManifest(t *testing.T, unixManifest []byte) []byte {
	t.Helper()
	var doc map[string]any
	if err := json.Unmarshal(unixManifest, &doc); err != nil {
		t.Fatal(err)
	}
	if backend, ok := doc["backend"].(map[string]any); ok {
		if launch, ok := backend["launch"].(map[string]any); ok {
			if path, ok := launch["path"].(string); ok && !strings.HasSuffix(path, ".exe") {
				launch["path"] = path + ".exe"
			}
		}
	}
	generators, _ := doc["projectGenerators"].([]any)
	for _, rawGen := range generators {
		gen, _ := rawGen.(map[string]any)
		steps, _ := gen["steps"].([]any)
		for _, rawStep := range steps {
			step, _ := rawStep.(map[string]any)
			if step["kind"] == "command" && step["command"] == "python3" {
				step["command"] = "python"
			}
		}
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func pythonFileURI(path string) string {
	slashed := filepath.ToSlash(path)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String()
}

func resolvePytestToolForE2E(t *testing.T, ctx context.Context, systemPython string) core.BuildTool {
	t.Helper()
	executable := os.Getenv("PYTEST_PYTHON")
	if executable == "" {
		executable = systemPython
	}
	cmd := exec.CommandContext(ctx, executable, "-B", "-c", "import pytest")
	if err := cmd.Run(); err != nil {
		t.Fatalf("pytest is required for the host test; set PYTEST_PYTHON to an interpreter with pytest: %v", err)
	}
	return core.BuildTool{Executable: executable}
}

func TestPythonSupportPluginContractPlansInstallAndImmutability(t *testing.T) {
	archive := os.Getenv("LITHE_TEST_PYTHON_PLUGIN_ARCHIVE")
	if archive == "" {
		t.Skip("set LITHE_TEST_PYTHON_PLUGIN_ARCHIVE to a python-support-<version>-<platform>.zip")
	}

	pythonCmd := "python3"
	if runtime.GOOS == "windows" {
		pythonCmd = "python"
	}
	systemPython, err := exec.LookPath(pythonCmd)
	if err != nil {
		t.Fatalf("%s not on PATH: %v", pythonCmd, err)
	}
	if resolvedSysPy, evalErr := filepath.EvalSymlinks(systemPython); evalErr == nil {
		systemPython = resolvedSysPy
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	providerHome := t.TempDir()
	if canonical, err := filepath.EvalSymlinks(providerHome); err == nil {
		providerHome = canonical
	}
	t.Setenv("HOME", providerHome)
	t.Setenv("USERPROFILE", providerHome)
	// Keep the provider's fixture independent of installed manager configurations.
	for _, name := range []string{"APPDATA", "LOCALAPPDATA", "CONDA_ENVS_PATH", "CONDA_PREFIX", "UV_PYTHON_INSTALL_DIR", "PYENV_ROOT", "POETRY_VIRTUALENVS_PATH", "POETRY_CACHE_DIR", "WORKON_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"} {
		t.Setenv(name, "")
	}
	registeredHomes := []string{
		filepath.Join(providerHome, "registered-python-one"),
		filepath.Join(providerHome, "registered-python-replacement"),
	}
	for _, home := range registeredHomes {
		if out, err := exec.CommandContext(ctx, systemPython, "-m", "venv", "--copies", "--without-pip", home).CombinedOutput(); err != nil {
			t.Fatalf("create regular-file external environment: %v\n%s", err, out)
		}
	}
	registryDir := filepath.Join(providerHome, ".conda")
	if err := os.MkdirAll(registryDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(registryDir, "environments.txt"), []byte(strings.Join(registeredHomes, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	kernel := core.NewClient()
	appStore := store.At(t.TempDir())
	service, err := pluginservice.Open(kernel, appStore, filepath.Join(t.TempDir(), "Lithe Plugins"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		service.Host.Stop(pythonSupportPluginID)
	})

	// 1. Real installer Prepare + Commit + Enable.
	plan, err := service.Installer.Prepare(ctx, plugininstall.Request{
		ArchivePath: archive,
		Root:        service.Root,
		Source:      plugintrust.Disk,
	})
	if err != nil {
		t.Fatalf("Installer.Prepare(%s): %v", archive, err)
	}
	if plan.ID != pythonSupportPluginID {
		_ = service.Installer.Discard(plan)
		t.Fatalf("archive ID = %s, want %s", plan.ID, pythonSupportPluginID)
	}
	installed, err := service.Installer.Commit(plan)
	if err != nil {
		_ = service.Installer.Discard(plan)
		t.Fatalf("Installer.Commit: %v", err)
	}
	if err := service.Manager.SetEnabled(pythonSupportPluginID, true); err != nil {
		t.Fatalf("SetEnabled: %v", err)
	}

	installedDir := installed.Path
	beforeDigest := pythonPackageDigest(t, installedDir)

	// 2. Validate BOTH Unix and Windows manifests against real Core + pluginhost.Declared().
	rawManifest, err := os.ReadFile(filepath.Join(installedDir, "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	normalizedManifest, err := pluginhost.Validate(ctx, kernel, rawManifest, pluginhost.Declared())
	if err != nil {
		t.Fatalf("Unix manifest rejected by pluginhost.Validate: %v", err)
	}
	winManifest := toWindowsVariantManifest(t, rawManifest)
	if _, err := pluginhost.Validate(ctx, kernel, winManifest, pluginhost.Declared()); err != nil {
		t.Fatalf("Windows manifest rejected by pluginhost.Validate: %v", err)
	}

	// Wire runtime tool launch resolution and structured log capture on service.Backend.
	registryInput, err := toolchain.RegistryInput([]json.RawMessage{normalizedManifest})
	if err != nil {
		t.Fatalf("toolchain.RegistryInput: %v", err)
	}
	var logMu sync.Mutex
	var recordedEvents []string
	service.Backend.SetLogFacts(func(_ core.LogLevel, event string, fields map[string]any) {
		logMu.Lock()
		op, _ := fields["operation"].(string)
		recordedEvents = append(recordedEvents, fmt.Sprintf("%s:%s", event, op))
		logMu.Unlock()
	})
	service.Backend.SetToolResolver(func(_ context.Context, _, _, tool string) (pluginbackend.ToolExecutable, error) {
		if tool != "python" {
			return pluginbackend.ToolExecutable{}, fmt.Errorf("unexpected tool %s", tool)
		}
		return pluginbackend.ToolExecutable{Path: systemPython}, nil
	})
	service.Backend.SetToolEntryResolver(func(callCtx context.Context, _, _ string, input pluginbackend.ToolEntryLaunch) (pluginbackend.ToolExecutable, error) {
		launch, launchErr := kernel.InstantiateToolchainLaunch(callCtx, registryInput, input.Tool, systemPython, "", input.Entry, input.RuntimeArguments, input.Arguments)
		if launchErr != nil {
			return pluginbackend.ToolExecutable{}, launchErr
		}
		return pluginbackend.ToolExecutable{Path: launch.Executable, Arguments: launch.Arguments}, nil
	})
	sessionLogDir := t.TempDir()
	service.LogDirectory = func(_ context.Context, _ string) string {
		return sessionLogDir
	}

	// 3. Verify zh-Hans localization is accepted by Core settingsState without rejections.
	zhBytes, err := os.ReadFile(filepath.Join(installedDir, "l10n", "zh-Hans.json"))
	if err != nil {
		t.Fatal(err)
	}
	settingsState, err := kernel.ReadPluginSettingsState(ctx, normalizedManifest, nil, nil, &core.PluginSettingsLocalizationRequest{
		Language: "zh-Hans",
		Files:    map[string]string{"l10n/zh-Hans.json": string(zhBytes)},
	})
	if err != nil {
		t.Fatalf("ReadPluginSettingsState(zh-Hans): %v", err)
	}
	if settingsState.Localization == nil || settingsState.Localization.Applied == nil || *settingsState.Localization.Applied != "l10n/zh-Hans.json" {
		t.Fatalf("expected l10n/zh-Hans.json applied, got %+v", settingsState.Localization)
	}
	if len(settingsState.Localization.Rejected) > 0 {
		t.Fatalf("unexpected l10n rejections: %+v", settingsState.Localization.Rejected)
	}

	// 4. Plan backend-resolved language server (Pyrefly), call the packaged Pyrefly launch resolver
	// with and without tools.python.executable, decode via Core, and run pyrefly --version.
	stateDir := t.TempDir()
	wsStateDir := t.TempDir()
	tempDir := t.TempDir()
	lspDirs := core.PluginBackendDirectories{
		PluginDirectory:         installedDir,
		StateDirectory:          stateDir,
		WorkspaceStateDirectory: wsStateDir,
		LogDirectory:            sessionLogDir,
		TemporaryDirectory:      tempDir,
		Architecture:            core.PluginArchitecture(),
	}
	lspPlan, err := kernel.PlanPluginLanguageServer(ctx, normalizedManifest, "python", lspDirs)
	if err != nil {
		t.Fatalf("PlanPluginLanguageServer: %v", err)
	}
	if lspPlan.Launch.Kind != "backend" || lspPlan.Launch.Function != "pyrefly.resolveLaunch" {
		t.Fatalf("expected backend-resolved pyrefly launch, got %+v", lspPlan.Launch)
	}

	// 4a. Call pyrefly.resolveLaunch WITH tools.python.executable injected.
	var resolveParamsWithTool map[string]any
	if err := json.Unmarshal(lspPlan.ResolveParams, &resolveParamsWithTool); err != nil {
		t.Fatal(err)
	}
	resolveParamsWithTool["tools"] = map[string]any{
		"python": map[string]any{
			"executable": systemPython,
			"version":    "3.12.0",
		},
	}
	encodedWithTool, err := json.Marshal(resolveParamsWithTool)
	if err != nil {
		t.Fatal(err)
	}
	ctxRef := json.RawMessage(`{"contextID":"ctx-e2e-1","generation":1}`)
	answerWithTool, err := service.Host.Call(ctx, pythonSupportPluginID, lspPlan.Launch.Function, encodedWithTool, ctxRef, 30*time.Second)
	if err != nil {
		t.Fatalf("Host.Call(pyrefly.resolveLaunch with tool): %v", err)
	}
	decodedWithTool, err := kernel.DecodePluginLanguageServerLaunch(ctx, normalizedManifest, "python", lspDirs, answerWithTool)
	if err != nil {
		t.Fatalf("DecodePluginLanguageServerLaunch(with tool): %v", err)
	}
	expectedPyreflyRel := "bin/pyrefly"
	if runtime.GOOS == "windows" {
		expectedPyreflyRel = "bin/pyrefly.exe"
	}
	if decodedWithTool.Launch.Kind != "packaged" || decodedWithTool.Launch.Path != expectedPyreflyRel {
		t.Fatalf("decoded launch = %+v, want packaged %s", decodedWithTool.Launch, expectedPyreflyRel)
	}
	if !slices.Equal(decodedWithTool.Arguments, []string{"lsp"}) {
		t.Fatalf("decoded arguments = %v, want [lsp]", decodedWithTool.Arguments)
	}
	if !strings.Contains(string(decodedWithTool.WorkspaceConfiguration), `"pythonPath"`) {
		t.Fatalf("expected pythonPath injected when tools.python is present, got %s", decodedWithTool.WorkspaceConfiguration)
	}

	pyreflyExec, err := pluginhost.ResolveExecutable(installedDir, decodedWithTool.Launch.Path)
	if err != nil {
		t.Fatalf("ResolveExecutable(%s): %v", decodedWithTool.Launch.Path, err)
	}
	verOut, err := exec.CommandContext(ctx, pyreflyExec, "--version").CombinedOutput()
	if err != nil {
		t.Fatalf("pyrefly --version failed: %v\n%s", err, verOut)
	}
	if !strings.Contains(strings.ToLower(string(verOut)), "pyrefly 1.4.1") {
		t.Fatalf("unexpected pyrefly version output: %q", string(verOut))
	}

	// 4b. Call pyrefly.resolveLaunch WITHOUT tools.python (graceful fallback, no pythonPath) and with Windows platform.
	answerFallback, err := service.Host.Call(ctx, pythonSupportPluginID, lspPlan.Launch.Function, lspPlan.ResolveParams, ctxRef, 30*time.Second)
	if err != nil {
		t.Fatalf("Host.Call(pyrefly.resolveLaunch fallback): %v", err)
	}
	decodedFallback, err := kernel.DecodePluginLanguageServerLaunch(ctx, normalizedManifest, "python", lspDirs, answerFallback)
	if err != nil {
		t.Fatalf("DecodePluginLanguageServerLaunch(fallback): %v", err)
	}
	if strings.Contains(string(decodedFallback.WorkspaceConfiguration), `"pythonPath"`) {
		t.Fatalf("workspaceConfiguration must omit pythonPath when tools.python is absent: %s", decodedFallback.WorkspaceConfiguration)
	}

	var resolveParamsWin map[string]any
	if err := json.Unmarshal(lspPlan.ResolveParams, &resolveParamsWin); err != nil {
		t.Fatal(err)
	}
	resolveParamsWin["platform"] = map[string]any{"os": "windows", "arch": "x86_64"}
	encodedWin, _ := json.Marshal(resolveParamsWin)
	answerWin, err := service.Host.Call(ctx, pythonSupportPluginID, lspPlan.Launch.Function, encodedWin, ctxRef, 30*time.Second)
	if err != nil {
		t.Fatalf("Host.Call(pyrefly.resolveLaunch windows): %v", err)
	}
	decodedWin, err := kernel.DecodePluginLanguageServerLaunch(ctx, normalizedManifest, "python", lspDirs, answerWin)
	if err != nil {
		t.Fatalf("DecodePluginLanguageServerLaunch(windows): %v", err)
	}
	if decodedWin.Launch.Path != "bin/pyrefly.exe" {
		t.Fatalf("windows launch path = %q, want bin/pyrefly.exe", decodedWin.Launch.Path)
	}

	// 5. Plan debug adapter (debugpy), verify launch/attach startArguments, and run DAP initialize smoke.
	dapPlan, err := kernel.PlanPluginDebugAdapter(ctx, normalizedManifest, "debugpy", core.PluginBackendDirectories{
		PluginDirectory: installedDir,
		StateDirectory:  stateDir,
		LogDirectory:    sessionLogDir,
		Architecture:    core.PluginArchitecture(),
	})
	if err != nil {
		t.Fatalf("PlanPluginDebugAdapter: %v", err)
	}
	if !slices.Contains(dapPlan.RequiredDirectories, "log") {
		t.Fatalf("expected debugpy plan RequiredDirectories to include 'log', got %v", dapPlan.RequiredDirectories)
	}
	if _, err := pluginhost.ResolvePackagePaths(installedDir, dapPlan.RequiredPackagePaths); err != nil {
		t.Fatalf("ResolvePackagePaths(%v): %v", dapPlan.RequiredPackagePaths, err)
	}
	entryScript := dapPlan.Launch.Entry
	if !filepath.IsAbs(entryScript) {
		entryScript, err = pluginhost.ResolvePackagePath(installedDir, entryScript)
		if err != nil {
			t.Fatalf("ResolvePackagePath(%s): %v", dapPlan.Launch.Entry, err)
		}
	}

	workspace := t.TempDir()
	if resolvedWs, evalErr := filepath.EvalSymlinks(workspace); evalErr == nil {
		workspace = resolvedWs
	}
	mainPy := filepath.Join(workspace, "main.py")
	if err := os.WriteFile(mainPy, []byte("if __name__ == '__main__':\n    print('ok')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "pyproject.toml"), []byte("[project]\nname = \"ws-app\"\nversion = \"0.1.0\"\nrequires-python = \">=3.10\"\n[project.scripts]\nws-cli = \"ws_pkg.cli:main\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "uv.lock"), []byte("version = 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "environment.yml"), []byte("name: demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "ruff.toml"), []byte("line-length = 100\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	testsDir := filepath.Join(workspace, "tests")
	if err := os.MkdirAll(testsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	sampleTestPy := "import pytest\n\ndef test_alpha():\n    assert 1 + 1 == 2\n\n@pytest.mark.parametrize('n,want', [(2, 6), (4, 12)])\ndef test_scale(n, want):\n    assert n * 3 == want\n"
	if err := os.WriteFile(filepath.Join(testsDir, "test_sample.py"), []byte(sampleTestPy), 0o644); err != nil {
		t.Fatal(err)
	}

	launchStart, err := kernel.PlanDebugStart(ctx, normalizedManifest, "debugpy", "launch", core.DebugStartFacts{
		Registration: core.DebugGeneration{Generation: 1, CurrentGeneration: 1},
		Target: core.DebugTargetFacts{
			Kind:             "file",
			Path:             mainPy,
			WorkingDirectory: workspace,
			Arguments:        []string{"--flag"},
			Environment:      map[string]string{},
		},
	}, nil)
	if err != nil {
		t.Fatalf("PlanDebugStart(launch): %v", err)
	}
	envMap, _ := launchStart.Arguments["env"].(map[string]any)
	if envMap["PYTHONDONTWRITEBYTECODE"] != "1" {
		t.Fatalf("expected PYTHONDONTWRITEBYTECODE=1 in launch env, got %+v", launchStart.Arguments)
	}
	if launchStart.Arguments["program"] != mainPy {
		t.Fatalf("expected program=%s, got %+v", mainPy, launchStart.Arguments["program"])
	}

	attachStart, err := kernel.PlanDebugStart(ctx, normalizedManifest, "debugpy", "attach", core.DebugStartFacts{
		Registration: core.DebugGeneration{Generation: 1, CurrentGeneration: 1},
		Target: core.DebugTargetFacts{
			Kind: "connection",
			Host: "127.0.0.1",
			Port: 5678,
			PathMappings: []core.DebugPathMapping{
				{Local: workspace, Remote: "/app"},
			},
		},
	}, nil)
	if err != nil {
		t.Fatalf("PlanDebugStart(attach): %v", err)
	}
	if attachStart.Connection == nil || attachStart.Connection.Port != 5678 || attachStart.Connection.Remote {
		t.Fatalf("unexpected attach connection: %+v", attachStart.Connection)
	}

	dapArgs := append([]string{}, dapPlan.Launch.RuntimeArguments...)
	dapArgs = append(dapArgs, entryScript)
	dapArgs = append(dapArgs, dapPlan.Arguments...)
	dapCmd := exec.CommandContext(ctx, systemPython, dapArgs...)
	dapCmd.Dir = workspace
	dapIn, err := dapCmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	dapOut, err := dapCmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := dapCmd.Start(); err != nil {
		t.Fatalf("starting debugpy adapter failed: %v", err)
	}
	initFrame := `{"seq":1,"type":"request","command":"initialize","arguments":{"adapterID":"debugpy"}}`
	_, _ = io.WriteString(dapIn, "Content-Length: 85\r\n\r\n"+initFrame)
	headerBuf := make([]byte, 18)
	if _, err := io.ReadFull(dapOut, headerBuf); err != nil {
		_ = dapCmd.Process.Kill()
		_ = dapCmd.Wait()
		t.Fatalf("debugpy adapter failed to emit DAP response header: %v", err)
	}
	_ = dapIn.Close()
	_ = dapCmd.Process.Kill()
	_ = dapCmd.Wait()

	// 6. Detect all four build systems and exercise the Python model, discovery and test run.
	detection, err := kernel.DetectBuildSystems(ctx, workspace, []json.RawMessage{normalizedManifest})
	if err != nil {
		t.Fatalf("DetectBuildSystems: %v", err)
	}
	var detectedIDs []string
	var pythonInstance core.BuildInstance
	for _, inst := range detection.Instances {
		detectedIDs = append(detectedIDs, inst.BuildSystemID)
		if inst.BuildSystemID == "python" {
			pythonInstance = inst
		}
	}
	slices.Sort(detectedIDs)
	if !slices.Equal(detectedIDs, []string{"conda", "python", "ruff", "uv"}) {
		t.Fatalf("detected build systems = %v, want [conda python ruff uv]", detectedIDs)
	}

	buildWsState := t.TempDir()
	providerClient, err := buildprovider.Start(ctx, service.Backend, pluginbackend.StartRequest{
		Manifest:                normalizedManifest,
		PackageDirectory:        installedDir,
		PluginID:                pythonSupportPluginID,
		ProviderID:              pythonSupportPluginID + "/build/python",
		BuildSystemID:           "python",
		Role:                    "build",
		StateDirectory:          stateDir,
		WorkspaceStateDirectory: buildWsState,
		LogDirectory:            sessionLogDir,
		Architecture:            core.PluginArchitecture(),
		RootURI:                 pythonFileURI(workspace),
		WorkingDirectory:        workspace,
	})
	if err != nil {
		t.Fatalf("buildprovider.Start(python): %v", err)
	}
	defer func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer stopCancel()
		_ = providerClient.Close(stopCtx)
	}()

	pytestTool := resolvePytestToolForE2E(t, ctx, systemPython)

	// 6a. Provider lithe/build/model -> DecodeBuildModel.
	modelPlan, err := kernel.PlanBuildModel(ctx, normalizedManifest, "python", core.BuildPlanRequest{
		Root:                    ".",
		PluginDirectory:         installedDir,
		WorkspaceStateDirectory: buildWsState,
		WorkspaceRoot:           workspace,
		Tool:                    &pytestTool,
	})
	if err != nil {
		t.Fatalf("PlanBuildModel: %v", err)
	}
	if modelPlan.Provider == nil || modelPlan.Provider.Method != "lithe/build/model" {
		t.Fatalf("expected provider modelPlan, got %+v", modelPlan)
	}
	modelOp, err := providerClient.Execute(ctx, modelPlan.Provider.Method, modelPlan.Provider.Params, 30_000)
	if err != nil {
		t.Fatalf("providerClient.Execute(lithe/build/model): %v", err)
	}
	modelRawResult, err := modelOp.Wait(ctx)
	if err != nil {
		t.Fatalf("modelOp.Wait: %v", err)
	}
	decodedModel, err := kernel.DecodeBuildModel(ctx, normalizedManifest, "python", core.BuildDecodeModelRequest{
		WorkspaceRoot: workspace,
		Root:          ".",
		Result:        modelRawResult,
	})
	if err != nil {
		t.Fatalf("DecodeBuildModel: %v", err)
	}
	if len(decodedModel.Projects) != 1 || decodedModel.Projects[0].Name != "ws-app" {
		t.Fatalf("unexpected decoded projects: %+v", decodedModel.Projects)
	}
	if len(decodedModel.Run) < 2 {
		t.Fatalf("expected derived Run entries for ws-cli and main.py, got %+v", decodedModel.Run)
	}

	// 6b. Run the installed plugin's discovery through the workbench command path.
	entries, err := service.Manager.Installed()
	if err != nil {
		t.Fatal(err)
	}
	buildPlugins, err := service.BuildPlugins(ctx, entries)
	if err != nil || len(buildPlugins) != 1 || buildPlugins[0].PluginID != pythonSupportPluginID {
		t.Fatalf("expected the installed Python build plugin: %+v (%v)", buildPlugins, err)
	}
	buildPlugin := buildPlugins[0]
	instance := buildInstance{
		BuildInstance:    pythonInstance,
		PluginID:         buildPlugin.PluginID,
		Version:          buildPlugin.Version,
		Manifest:         buildPlugin.Manifest,
		PackageDirectory: buildPlugin.Directory,
		System:           buildPlugin.Systems["python"],
	}
	if instance.System.Test == nil || !instance.System.Test.DiscoveryCommand {
		t.Fatal("installed Python build system did not expose command discovery")
	}
	preferences := pluginsettings.New(kernel, appStore.Dir())
	settings, err := preferences.Load(ctx, instance.Manifest, workspace)
	if err != nil {
		t.Fatal(err)
	}
	pythonSetting, err := json.Marshal(pytestTool.Executable)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := preferences.Save(ctx, settings, "global", []core.PluginSettingEdit{{ID: "pythonExecutable", Value: pythonSetting}}, nil); err != nil {
		t.Fatalf("set the test interpreter: %v", err)
	}
	workbench := &App{kernel: kernel, plugins: service, store: appStore, text: i18n.For(i18n.English)}
	discoveryOperation := core.NewOperation()
	discoveryCtx := core.WithOrigin(ctx, core.Origin{Operation: discoveryOperation})
	decodedDiscovery, err := workbench.buildTestDiscovery(discoveryCtx, &project{root: workspace}, instance, kernel, false)
	if err != nil {
		t.Fatalf("workbench command discovery: %v", err)
	}
	discoveryFiles, err := os.ReadDir(buildStateDirectory(service.Root, workspace, instance))
	if err != nil || len(discoveryFiles) != 0 {
		t.Fatalf("discovery left workspace state entries %v (%v)", discoveryFiles, err)
	}
	if len(decodedDiscovery.Tests) != 3 {
		t.Fatalf("discovered tests = %+v, want 3 items (test_alpha, test_scale[2-6], test_scale[4-12])", decodedDiscovery.Tests)
	}
	var chosenTest *core.BuildDiscoveredTest
	for i := range decodedDiscovery.Tests {
		if decodedDiscovery.Tests[i].Suite == "tests/test_sample.py" && decodedDiscovery.Tests[i].Case == "test_scale[2-6]" {
			chosenTest = &decodedDiscovery.Tests[i]
			break
		}
	}
	if chosenTest == nil {
		t.Fatalf("expected discovered parameterized selector tests/test_sample.py :: test_scale[2-6], got %+v", decodedDiscovery.Tests)
	}

	// 6c. Run that exact single discovered test via PlanBuildTest -> lithe/build/test -> DecodeBuildTestResults!
	testPlan, err := kernel.PlanBuildTest(ctx, normalizedManifest, "python", core.BuildTestRequest{
		Root:          ".",
		WorkspaceRoot: workspace,
		Project:       chosenTest.Project,
		Target:        chosenTest.Target,
		Suite:         chosenTest.Suite,
		Case:          chosenTest.Case,
		Projects:      []string{"."},
	})
	if err != nil {
		t.Fatalf("PlanBuildTest: %v", err)
	}
	if testPlan.Provider == nil || testPlan.Provider.Method != "lithe/build/test" {
		t.Fatalf("expected provider testPlan, got %+v", testPlan)
	}
	// Attach resolved pytestTool hints to the provider params just as workbench tests.go does.
	var testProviderParams map[string]any
	if err := json.Unmarshal(testPlan.Provider.Params, &testProviderParams); err != nil {
		t.Fatal(err)
	}
	testProviderParams["tool"] = map[string]any{"executable": pytestTool.Executable}
	enrichedTestParams, err := json.Marshal(testProviderParams)
	if err != nil {
		t.Fatal(err)
	}
	testOp, err := providerClient.Execute(ctx, testPlan.Provider.Method, enrichedTestParams, 60_000)
	if err != nil {
		t.Fatalf("providerClient.Execute(lithe/build/test): %v", err)
	}
	testRawResult, err := testOp.Wait(ctx)
	if err != nil {
		t.Fatalf("testOp.Wait: %v", err)
	}
	var execReply struct {
		ExitCode int    `json:"exitCode"`
		Output   string `json:"output"`
	}
	if err := json.Unmarshal(testRawResult, &execReply); err != nil {
		t.Fatal(err)
	}
	if execReply.ExitCode != 0 {
		t.Fatalf("pytest single-case exitCode = %d, output:\n%s", execReply.ExitCode, execReply.Output)
	}
	decodedResults, err := kernel.DecodeBuildTestResults(ctx, normalizedManifest, "python", core.BuildTestResultsRequest{
		WorkspaceRoot: workspace,
		Root:          ".",
		Project:       ".",
		Projects:      []string{"."},
		Output:        execReply.Output,
	})
	if err != nil {
		t.Fatalf("DecodeBuildTestResults: %v", err)
	}
	if !decodedResults.Success || decodedResults.Summary.Total != 1 || decodedResults.Summary.Passed != 1 {
		t.Fatalf("unexpected decoded JUnit XML results: %+v", decodedResults)
	}

	// Verify plugin RPC diagnostics and the workbench's command terminal event.
	drained, err := kernel.DrainCoreEvents(ctx)
	if err != nil {
		t.Fatalf("DrainCoreEvents: %v", err)
	}
	logMu.Lock()
	captured := slices.Clone(recordedEvents)
	logMu.Unlock()
	var discoveryTerminals []string
	for _, ev := range drained.Events {
		op, _ := ev.Fields["operation"].(string)
		captured = append(captured, fmt.Sprintf("%s:%s", ev.Event, op))
		if op == "lithe/build/discoverTests" && ev.Op == discoveryOperation {
			discoveryTerminals = append(discoveryTerminals, ev.Event)
		}
		if ev.Event == "plugins.diagnostics.rejected" {
			t.Fatalf("unexpected rejected plugin diagnostic from Core: %+v", ev)
		}
	}
	for _, entry := range captured {
		if strings.HasPrefix(entry, "plugins.diagnostics.rejected:") {
			t.Fatalf("unexpected rejected plugin diagnostic in log facts: %v", captured)
		}
	}
	if !slices.Contains(captured, "plugins.operation.finished:pyrefly.resolveLaunch") {
		t.Fatalf("expected plugins.operation.finished:pyrefly.resolveLaunch in Core log facts, got %v", captured)
	}
	if !slices.Equal(discoveryTerminals, []string{"plugins.operation.finished"}) {
		t.Fatalf("expected one successful command discovery terminal, got %v (Core events %v)", discoveryTerminals, captured)
	}

	// 7. Verify Python Traceback outputLinkMatchers.
	var normalizedDoc struct {
		OutputLinkMatchers []core.OutputLinkMatcher `json:"outputLinkMatchers"`
	}
	if err := json.Unmarshal(normalizedManifest, &normalizedDoc); err != nil {
		t.Fatal(err)
	}
	links, err := kernel.MatchOutputLinks(ctx, core.OutputLinkRequest{
		Scope:          "run",
		Platform:       toolchain.PlatformName(runtime.GOOS),
		WorkspaceRoots: []string{workspace},
		Sources: []core.OutputLinkSource{
			{PluginID: pythonSupportPluginID, Matchers: normalizedDoc.OutputLinkMatchers},
		},
		Lines: []string{`  File "` + mainPy + `", line 2, in <module>`},
	})
	if err != nil {
		t.Fatalf("MatchOutputLinks: %v", err)
	}
	if len(links) != 1 || links[0].Location == nil || links[0].Location.Line != 2 {
		t.Fatalf("unexpected output links: %+v", links)
	}

	// 8. Drive the real host's declared provider before creating a project-local .venv.
	providerHost, ok := any(service).(interface {
		ToolchainOptions(string, toolchain.Options) toolchain.Options
	})
	if !ok {
		t.Fatal("the pinned host lacks on-demand toolchain providers; use a compatible desktop revision")
	}
	service.Contexts.Open(workspace)
	t.Cleanup(func() { service.Contexts.Close(workspace) })
	manifestSet := []json.RawMessage{normalizedManifest}
	const providerID = pythonSupportPluginID + ":python"
	pinFile := filepath.Join(workspace, ".python-version")
	for _, expected := range registeredHomes {
		if err := os.WriteFile(pinFile, []byte(filepath.Base(expected)+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		snapshot, err := toolchain.Load(ctx, kernel, workspace, ".", manifestSet,
			providerHost.ToolchainOptions(workspace, toolchain.Options{Home: providerHome, Environment: map[string]string{}}))
		if err != nil {
			t.Fatalf("load provider toolchain: %v", err)
		}
		if len(snapshot.Tools) != 1 || snapshot.Tools[0].Effective == nil {
			t.Fatalf("no effective project interpreter: %+v", snapshot.Tools)
		}
		selection := snapshot.Tools[0].Effective
		if selection.Home == nil {
			t.Fatalf("provider selection has no installation home: %+v", selection)
		}
		actual, actualErr := os.Stat(*selection.Home)
		wanted, wantedErr := os.Stat(expected)
		if actualErr != nil || wantedErr != nil || !os.SameFile(actual, wanted) || selection.Provider != providerID {
			t.Fatalf("provider selection = %+v, want %s from %s", selection, expected, providerID)
		}
	}
	global, err := toolchain.Load(ctx, kernel, "", ".", manifestSet,
		providerHost.ToolchainOptions("", toolchain.Options{Global: true, Home: providerHome, Environment: map[string]string{}}))
	if err != nil {
		t.Fatalf("load global provider toolchains: %v", err)
	}
	if len(global.Tools) != 1 {
		t.Fatalf("expected one global tool, got %+v", global.Tools)
	}
	for _, expected := range registeredHomes {
		wanted, err := os.Stat(expected)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.ContainsFunc(global.Tools[0].Installations, func(installation core.ToolchainInstallation) bool {
			actual, err := os.Stat(installation.Home)
			return err == nil && os.SameFile(actual, wanted) && installation.Provider == providerID
		}) {
			t.Fatalf("global provider did not register %s: %+v", expected, global.Tools[0])
		}
	}

	// Verify .venv resolution retains its project trust gate.
	venvCmd := exec.CommandContext(ctx, systemPython, "-m", "venv", ".venv")
	venvCmd.Dir = workspace
	if out, err := venvCmd.CombinedOutput(); err != nil {
		t.Fatalf("creating .venv failed: %v\n%s", err, out)
	}
	expectedVenvPython := filepath.Join(workspace, ".venv", "bin", "python3")
	if runtime.GOOS == "windows" {
		expectedVenvPython = filepath.Join(workspace, ".venv", "Scripts", "python.exe")
	}

	globalRoot := t.TempDir()
	untrustedSnap, err := toolchain.Load(ctx, kernel, workspace, ".", []json.RawMessage{normalizedManifest}, toolchain.Options{
		GlobalRoot: globalRoot,
	})
	if err != nil {
		t.Fatalf("toolchain.Load(untrusted): %v", err)
	}
	if saver, ok := any(untrustedSnap).(workspaceTrustSaver); ok {
		for _, tool := range untrustedSnap.Tools {
			if tool.ID == "python" && tool.Effective != nil && tool.Effective.Executable == expectedVenvPython {
				t.Fatalf("untrusted workspace must NOT auto-select .venv interpreter %s", expectedVenvPython)
			}
		}
		if _, err := saver.SaveWorkspaceTrust(ctx, kernel, true); err != nil {
			t.Fatalf("SaveWorkspaceTrust(true): %v", err)
		}
		if _, statErr := os.Stat(filepath.Join(workspace, ".lithe")); !os.IsNotExist(statErr) {
			t.Fatalf("workspace trust must NOT write .lithe inside workspace, statErr=%v", statErr)
		}
		trustedSnap, err := toolchain.Load(ctx, kernel, workspace, ".", []json.RawMessage{normalizedManifest}, toolchain.Options{
			GlobalRoot: globalRoot,
		})
		if err != nil {
			t.Fatalf("toolchain.Load(trusted): %v", err)
		}
		var resolvedExec string
		for _, tool := range trustedSnap.Tools {
			if tool.ID == "python" && tool.Effective != nil {
				resolvedExec = tool.Effective.Executable
			}
		}
		if resolvedExec != expectedVenvPython {
			t.Fatalf("trusted .venv resolution = %q, want literal path %q", resolvedExec, expectedVenvPython)
		}
	}

	// Shut down backend cleanly BEFORE checking package immutability so any shutdown write would be caught too!
	service.Host.Stop(pythonSupportPluginID)

	// 9. Assert installed plugin package file list and SHA-256 hashes are 100% unchanged!
	afterDigest := pythonPackageDigest(t, installedDir)
	if !maps.Equal(beforeDigest, afterDigest) {
		t.Fatalf("installed plugin package was mutated at runtime!\nbefore=%d files\nafter=%d files", len(beforeDigest), len(afterDigest))
	}
}
