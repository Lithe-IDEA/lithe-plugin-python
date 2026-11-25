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
	"reflect"
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
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugintrust"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
	"github.com/1lck/Lithe-IDEA/desktop/internal/toolchain"
)

const pythonSupportPluginID = "io.github.lithe-idea.python-support"

// Require all parts of the message on one diagnostic from this plugin and file.
func pythonDiagnosticMessage(a *App, path string, parts ...string) string {
	set := a.pluginDiagnostics[pythonSupportPluginID]
	if set == nil {
		return ""
	}
	for _, record := range set.All() {
		if record.FileKey == path && !slices.ContainsFunc(parts, func(part string) bool {
			return !strings.Contains(record.Message, part)
		}) {
			return record.Message
		}
	}
	return ""
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

// pythonInstallationForE2E returns the home without links (sys.prefix) and
// the version of the Python installation python, for a test to pin. It fails
// when python is a virtual environment, so that the pinned installation case
// stays apart from the pinned environment case, which makes its own
// environment. Set PYTEST_PYTHON to an installation, such as one from
// actions/setup-python, uv python install or pyenv.
func pythonInstallationForE2E(t *testing.T, ctx context.Context, python string) (home, version string) {
	t.Helper()
	facts, err := exec.CommandContext(ctx, python, "-c", "import platform, sys; print(sys.prefix); print(platform.python_version()); print(sys.prefix != sys.base_prefix)").Output()
	if err != nil {
		t.Fatalf("read the installation of %s: %v", python, err)
	}
	lines := strings.Split(strings.TrimSpace(string(facts)), "\n")
	if len(lines) != 3 {
		t.Fatalf("unexpected interpreter facts %q", facts)
	}
	if strings.TrimSpace(lines[2]) == "True" {
		t.Fatalf("%s is a virtual environment; set PYTEST_PYTHON to a Python installation with pytest", python)
	}
	if home, err = filepath.EvalSymlinks(strings.TrimSpace(lines[0])); err != nil {
		t.Fatal(err)
	}
	return home, strings.TrimSpace(lines[1])
}

// externalPythonEnvironmentForE2E makes a virtual environment from python in a
// directory outside any workspace and returns its home and version. On macOS
// and Linux the environment's python is a link to python's own executable,
// outside the environment.
func externalPythonEnvironmentForE2E(t *testing.T, ctx context.Context, python string) (home, version string) {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home = filepath.Join(parent, "external environment")
	if output, err := exec.CommandContext(ctx, python, "-m", "venv", "--without-pip", home).CombinedOutput(); err != nil {
		t.Fatalf("create the external environment: %v\n%s", err, output)
	}
	executable := filepath.Join(home, "bin", "python")
	if runtime.GOOS == "windows" {
		executable = filepath.Join(home, "Scripts", "python.exe")
	}
	output, err := exec.CommandContext(ctx, executable, "-c", "import platform; print(platform.python_version())").Output()
	if err != nil {
		t.Fatalf("read the version of %s: %v", executable, err)
	}
	return home, strings.TrimSpace(string(output))
}

// pinPythonForE2E pins the installation at home as the workspace's Python
// interpreter, as choosing it on the Toolchains page does, and returns a
// function that removes the pin again. The page keys a pin by the tool
// definition's own ID. The pin is kept in the workspace's .lithe folder;
// removing it also removes that folder when the pin created it.
func pinPythonForE2E(t *testing.T, ctx context.Context, kernel toolchain.Kernel, workspace, home, version string) func() {
	t.Helper()
	created := filepath.Join(workspace, ".lithe")
	if _, err := os.Stat(created); err == nil {
		created = ""
	}
	pin := &core.ToolchainPin{Home: filepath.ToSlash(home), Version: version, Provider: "host:manual"}
	_, baseline, err := toolchain.SavePin(ctx, kernel, workspace, ".", "python", pin, nil)
	if err != nil {
		t.Fatalf("pin the test interpreter: %v", err)
	}
	return func() {
		t.Helper()
		if _, _, err := toolchain.SavePin(ctx, kernel, workspace, ".", "python", nil, baseline); err != nil {
			t.Fatalf("remove the test interpreter's pin: %v", err)
		}
		if created != "" {
			if err := os.RemoveAll(created); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// addPythonInstallationForE2E adds home to the machine's Python installations,
// as adding an installation on the Toolchains page does. Hosts such as 0.8.9
// probe a pinned home only when discovery or this list finds it, and discovery
// does not search where a test interpreter usually is (the actions/setup-python
// tool cache, or a folder passed to uv python install --install-dir).
func addPythonInstallationForE2E(t *testing.T, ctx context.Context, h *harness, home string) {
	t.Helper()
	pages := settingsToolchains{app: h.app}
	machine, err := pages.LoadScope(ctx, "global")
	if err != nil {
		t.Fatalf("read the machine's toolchains: %v", err)
	}
	for index := range machine.Tools {
		tool := &machine.Tools[index]
		if tool.ID != "python" && !strings.HasSuffix(tool.ID, ":python") {
			continue
		}
		tool.CustomHomes = append(slices.Clone(tool.CustomHomes), filepath.ToSlash(home))
		if _, err := pages.Save(ctx, machine, []toolchain.Edit{{Tool: tool.ID}}); err != nil {
			t.Fatalf("add the test interpreter as a Python installation: %v", err)
		}
		return
	}
	t.Fatal("the Toolchains page lists no Python tool")
}

// trustProjectCode marks the workspace of the launch request at request, a
// pointer to a struct, as trusted. Hosts from 0.8.13 on start no language
// server or build provider that runs project code without it (safe mode);
// older hosts have no such field and start them anyway.
func trustProjectCode(request any) {
	if field := reflect.ValueOf(request).Elem().FieldByName("ProjectCodeAllowed"); field.IsValid() {
		field.SetBool(true)
	}
}

// registeredPythonEnvironments creates isolated external interpreters listed in a
// temporary Conda registry. Both the provider and the workbench see that same home.
func registeredPythonEnvironments(t *testing.T, ctx context.Context) (systemPython, providerHome string, registeredHomes []string) {
	t.Helper()
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

	providerHome = t.TempDir()
	if canonical, err := filepath.EvalSymlinks(providerHome); err == nil {
		providerHome = canonical
	}
	t.Setenv("HOME", providerHome)
	t.Setenv("USERPROFILE", providerHome)
	// Keep the provider's fixture independent of installed manager configurations.
	for _, name := range []string{"APPDATA", "LOCALAPPDATA", "CONDA_ENVS_PATH", "CONDA_PREFIX", "UV_PYTHON_INSTALL_DIR", "PYENV_ROOT", "POETRY_VIRTUALENVS_PATH", "POETRY_CACHE_DIR", "WORKON_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"} {
		t.Setenv(name, "")
	}
	registeredHomes = []string{
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

	return systemPython, providerHome, registeredHomes
}

func pythonArchiveForE2E(t *testing.T) string {
	t.Helper()
	archive := os.Getenv("LITHE_TEST_PYTHON_PLUGIN_ARCHIVE")
	if archive == "" {
		t.Skip("set LITHE_TEST_PYTHON_PLUGIN_ARCHIVE to a python-support-<version>-<platform>.zip")
	}

	return archive
}

func installPythonArchive(t *testing.T, ctx context.Context, service *pluginservice.Service, archive string) string {
	t.Helper()
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

	return installed.Path
}

func TestPythonSupportPluginStandaloneBuildPlans(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	kernel := core.NewClient()
	service, err := pluginservice.Open(kernel, store.At(t.TempDir()), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	installed := installPythonArchive(t, ctx, service, pythonArchiveForE2E(t))
	rawManifest, err := os.ReadFile(filepath.Join(installed, "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := pluginhost.Validate(ctx, kernel, rawManifest, pluginhost.Declared())
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	write := func(name, contents string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(workspace, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	detect := func(want ...string) {
		t.Helper()
		detection, err := kernel.DetectBuildSystems(ctx, workspace, []json.RawMessage{manifest})
		if err != nil || len(detection.Rejected) != 0 {
			t.Fatalf("detect build systems: %+v, %v", detection.Rejected, err)
		}
		ids := make([]string, 0, len(detection.Instances))
		for _, instance := range detection.Instances {
			ids = append(ids, instance.BuildSystemID)
		}
		slices.Sort(ids)
		if !slices.Equal(ids, want) {
			t.Fatalf("detected systems = %v, want %v", ids, want)
		}
	}
	write("pyproject.toml", "[project]\nname = 'plain'\nversion = '0.1.0'\n")
	write("uv.lock", "version = 1\n")
	detect("python", "uv")
	write("environment.yml", "name: fixture\n")
	detect("conda", "python", "uv")

	for _, marker := range []string{"ruff.toml", ".ruff.toml"} {
		write(marker, "line-length = 100\n")
		detect("conda", "python", "ruff", "uv")
		if err := os.Remove(filepath.Join(workspace, marker)); err != nil {
			t.Fatal(err)
		}
	}

	for _, system := range []struct {
		id    string
		tasks []string
	}{
		{"uv", []string{"lock", "sync"}},
		{"conda", []string{"env-update"}},
		{"ruff", []string{"check", "format"}},
	} {
		tree, err := kernel.BuildModelTree(ctx, manifest, system.id, core.BuildModelTreeRequest{})
		if err != nil {
			t.Fatalf("%s task tree: %v", system.id, err)
		}
		var ids []string
		for _, group := range tree.Nodes {
			for _, node := range group.Children {
				if node.Kind == core.BuildTreeTask && node.ProjectID == "" && node.TargetID == "" {
					ids = append(ids, node.TaskID)
				}
			}
		}
		slices.Sort(ids)
		if !slices.Equal(ids, system.tasks) {
			t.Errorf("%s workspace tasks = %v, want %v", system.id, ids, system.tasks)
		}
	}

	invocation, err := kernel.PlanBuildInvocation(ctx, manifest, "ruff", core.BuildInvocationRequest{
		Root: "nested", Platform: "macos",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(invocation.Executables) == 0 {
		t.Fatal("Ruff invocation has no executable candidates")
	}
	first := invocation.Executables[0]
	if first.Kind != "projectFile" || first.Path != "nested/.venv/bin/ruff" ||
		!slices.Equal(first.Requires, []string{"nested/.venv/pyvenv.cfg"}) {
		t.Fatalf("first Ruff candidate = %+v, want project-local Ruff with its environment marker", first)
	}
}

func TestPythonSupportPluginContractPlansInstallAndImmutability(t *testing.T) {
	archive := pythonArchiveForE2E(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()

	systemPython, providerHome, registeredHomes := registeredPythonEnvironments(t, ctx)
	kernel := core.NewClient()
	appStore := store.At(t.TempDir())
	service, err := pluginservice.Open(kernel, appStore, filepath.Join(t.TempDir(), "Lithe Plugins"))
	if err != nil {
		t.Fatal(err)
	}
	installedDir := installPythonArchive(t, ctx, service, archive)
	beforeDigest := pythonPackageDigest(t, installedDir)
	// Runs after the build client and workspace have closed, including on failure.
	t.Cleanup(func() {
		service.Host.Stop(pythonSupportPluginID)
		after := pythonPackageDigest(t, installedDir)
		if !maps.Equal(beforeDigest, after) {
			t.Errorf("installed package files or hashes changed (before %d, after %d)", len(beforeDigest), len(after))
		}
	})

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
	trustProjectCode(&lspDirs)
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

	// 5. Verify debugpy launch and attach arguments against the host contract.
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

	// Run Build and pytest as a user who explicitly trusted this fixture.
	buildProject := &project{root: workspace}
	buildProject.trust.codeAllowed.Store(true)
	buildWsState := t.TempDir()
	providerRequest := pluginbackend.StartRequest{
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
	}
	trustProjectCode(&providerRequest)
	providerClient, err := buildprovider.Start(ctx, service.Backend, providerRequest)
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
		ProjectCodeAllowed:      buildProject.trust.allowed(),
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
	home, version := pythonInstallationForE2E(t, ctx, pytestTool.Executable)
	unpin := pinPythonForE2E(t, ctx, kernel, workspace, home, version)
	workbench := &App{kernel: kernel, plugins: service, store: appStore, text: i18n.For(i18n.English)}
	discoveryOperation := core.NewOperation()
	discoveryCtx := core.WithOrigin(ctx, core.Origin{Operation: discoveryOperation})
	decodedDiscovery, err := workbench.buildTestDiscovery(discoveryCtx, buildProject, instance, kernel, false)
	if err != nil {
		t.Fatalf("workbench command discovery: %v", err)
	}
	// The toolchain checks below resolve the workspace without a pin.
	unpin()
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
		Root:               ".",
		WorkspaceRoot:      workspace,
		Project:            chosenTest.Project,
		Target:             chosenTest.Target,
		Suite:              chosenTest.Suite,
		Case:               chosenTest.Case,
		Projects:           []string{"."},
		ProjectCodeAllowed: buildProject.trust.allowed(),
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
			service.ToolchainOptions(workspace, toolchain.Options{Home: providerHome, Environment: map[string]string{}}))
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
		service.ToolchainOptions("", toolchain.Options{Global: true, Home: providerHome, Environment: map[string]string{}}))
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
	for _, tool := range untrustedSnap.Tools {
		if tool.ID == "python" && tool.Effective != nil && tool.Effective.Executable == expectedVenvPython {
			t.Fatalf("untrusted workspace must NOT auto-select .venv interpreter %s", expectedVenvPython)
		}
	}
	if _, err := untrustedSnap.SaveWorkspaceTrust(ctx, kernel, true); err != nil {
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
