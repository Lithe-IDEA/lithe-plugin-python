package workbench

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginhost"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugininstall"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginservice"
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
	servers, _ := doc["languageServers"].([]any)
	for _, rawServer := range servers {
		srv, _ := rawServer.(map[string]any)
		if srv["languageID"] == "python" {
			if launch, ok := srv["launch"].(map[string]any); ok {
				launch["path"] = "bin/pyrefly.exe"
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

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	kernel := core.NewClient()
	appStore := store.At(t.TempDir())
	service, err := pluginservice.Open(kernel, appStore, filepath.Join(t.TempDir(), "Lithe Plugins"))
	if err != nil {
		t.Fatal(err)
	}

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

	// 4. Plan language server (Pyrefly) and run --version against installed binary.
	stateDir := t.TempDir()
	logDir := t.TempDir()
	lspPlan, err := kernel.PlanPluginLanguageServer(ctx, normalizedManifest, "python", core.PluginBackendDirectories{
		PluginDirectory: installedDir,
		StateDirectory:  stateDir,
		LogDirectory:    logDir,
		Architecture:    core.PluginArchitecture(),
	})
	if err != nil {
		t.Fatalf("PlanPluginLanguageServer: %v", err)
	}
	pyreflyExec, err := pluginhost.ResolveExecutable(installedDir, lspPlan.Launch.Path)
	if err != nil {
		t.Fatalf("ResolveExecutable(%s): %v", lspPlan.Launch.Path, err)
	}
	verOut, err := exec.CommandContext(ctx, pyreflyExec, lspPlan.ValidationArguments...).CombinedOutput()
	if err != nil {
		t.Fatalf("pyrefly --version failed: %v\n%s", err, verOut)
	}
	if !strings.Contains(strings.ToLower(string(verOut)), "pyrefly 1.4.1") {
		t.Fatalf("unexpected pyrefly version output: %q", string(verOut))
	}
	if strings.Contains(string(lspPlan.WorkspaceConfiguration), `"pythonPath"`) {
		t.Fatalf("workspaceConfiguration must not emit empty pythonPath: %s", lspPlan.WorkspaceConfiguration)
	}

	// 5. Plan debug adapter (debugpy), verify launch/attach startArguments, and run DAP initialize smoke.
	dapPlan, err := kernel.PlanPluginDebugAdapter(ctx, normalizedManifest, "debugpy", core.PluginBackendDirectories{
		PluginDirectory: installedDir,
		StateDirectory:  stateDir,
		LogDirectory:    logDir,
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
	if err := os.WriteFile(filepath.Join(workspace, "pyproject.toml"), []byte("[project]\nname = \"ws-app\"\nversion = \"0.1.0\"\n[project.scripts]\nws-cli = \"ws_pkg.cli:main\"\n"), 0o644); err != nil {
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

	// Smoke-run debugpy adapter over stdio with real systemPython and --log-dir.
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

	// 6. Detect all 4 build systems (python, uv, conda, ruff), run build_model.py, and decode litheBuildModel.
	detection, err := kernel.DetectBuildSystems(ctx, workspace, []json.RawMessage{normalizedManifest})
	if err != nil {
		t.Fatalf("DetectBuildSystems: %v", err)
	}
	var detectedIDs []string
	for _, inst := range detection.Instances {
		detectedIDs = append(detectedIDs, inst.BuildSystemID)
	}
	slices.Sort(detectedIDs)
	if !slices.Equal(detectedIDs, []string{"conda", "python", "ruff", "uv"}) {
		t.Fatalf("detected build systems = %v, want [conda python ruff uv]", detectedIDs)
	}

	outFile := filepath.Join(t.TempDir(), "model.json")
	modelPlan, err := kernel.PlanBuildModel(ctx, normalizedManifest, "python", core.BuildPlanRequest{
		Root:                    ".",
		PluginDirectory:         installedDir,
		WorkspaceStateDirectory: stateDir,
		OutputFile:              outFile,
		WorkspaceRoot:           workspace,
	})
	if err != nil {
		t.Fatalf("PlanBuildModel: %v", err)
	}
	modelCmd := exec.CommandContext(ctx, systemPython, modelPlan.Arguments...)
	modelCmd.Dir = workspace
	if modelOut, runErr := modelCmd.CombinedOutput(); runErr != nil {
		t.Fatalf("build_model.py failed: %v\n%s", runErr, modelOut)
	}
	decodedModel, err := kernel.DecodeBuildModel(ctx, normalizedManifest, "python", core.BuildDecodeModelRequest{
		WorkspaceRoot: workspace,
		Root:          ".",
		OutputFile:    outFile,
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

	// 8. Verify .venv toolchain resolution (including workspace trust gating when supported by host).
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

	// 9. Assert installed plugin package file list and SHA-256 hashes are 100% unchanged!
	afterDigest := pythonPackageDigest(t, installedDir)
	if !maps.Equal(beforeDigest, afterDigest) {
		t.Fatalf("installed plugin package was mutated at runtime!\nbefore=%d files\nafter=%d files", len(beforeDigest), len(afterDigest))
	}
}
