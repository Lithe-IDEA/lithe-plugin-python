package workbench

import (
	"cmp"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/i18n"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
	"github.com/1lck/Lithe-IDEA/desktop/internal/toolchain"
)

func TestPythonSupportPluginRunCurrentFile(t *testing.T) {
	checkPythonCurrentFileRun(t, false)
}

// TestPythonSupportPluginRunCurrentFilePinnedInterpreter pins another
// interpreter for the project, as the Toolchains page does, and expects the
// run to use it over the project's .venv.
func TestPythonSupportPluginRunCurrentFilePinnedInterpreter(t *testing.T) {
	checkPythonCurrentFileRun(t, true)
}

func checkPythonCurrentFileRun(t *testing.T, pinned bool) {
	t.Helper()
	archive := pythonArchiveForE2E(t)
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	venv := filepath.Join(root, ".venv")
	python := "python3"
	if runtime.GOOS == "windows" {
		python = "python"
	}
	if output, err := exec.CommandContext(ctx, python, "-m", "venv", "--without-pip", venv).CombinedOutput(); err != nil {
		t.Fatalf("create project environment: %v\n%s", err, output)
	}
	source := filepath.Join(root, "main.py")
	for name, contents := range map[string]string{
		"pyproject.toml": "[project]\nname = 'current-file-run'\nversion = '0.1.0'\n",
		"main.py":        "import sys\n\nif __name__ == '__main__':\n    print('current file ran')\n    print(sys.prefix)\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	kernel := core.NewClient()
	preferences := store.At(t.TempDir())
	// A headless test has no AppKit event loop to query the system appearance.
	if err := preferences.Save(settingsFile, settings{Theme: themeDark}); err != nil {
		t.Fatal(err)
	}
	// The toolchain resolver reads persisted trust before probing a project .venv.
	trust, err := toolchain.ReadWorkspaceTrust(ctx, kernel, preferences.Dir(), root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := trust.Save(ctx, kernel, true, false); err != nil {
		t.Fatal(err)
	}
	h := newHarnessWithOptions(t, Options{
		Kernel: kernel, PluginKernel: kernel, PluginRoot: t.TempDir(), Store: preferences,
		Languages: []string{"en"},
	})
	installPythonArchive(t, ctx, h.app.plugins, archive)
	h.app.reloadPluginLanguages()
	wantPrefix := venv
	if pinned {
		home, version := pythonInstallationForE2E(t, ctx, cmp.Or(os.Getenv("PYTEST_PYTHON"), python))
		wantPrefix = home
		addPythonInstallationForE2E(t, ctx, h, home)
		pinPythonForE2E(t, ctx, kernel, root, home, version)
	}
	h.open(root)
	p := h.app.project
	if p == nil {
		t.Fatal("the workspace did not open")
	}
	openSource(t, h, p, source)
	h.app.post(func(a *App) {
		a.chooseTitleConfiguration(p, "")
		a.titleRun(p)
	})
	notRunnable := i18n.Shared(h.app.language(), "desktop.title.currentFileNotRunnable")
	awaitStateWithin(t, h, 20*time.Second, "the current file to start running", func() bool {
		for _, notice := range noticeTexts(h.app) {
			if notice == notRunnable {
				var models []string
				for _, instance := range p.build.instances {
					models = append(models, instance.BuildSystemID+": "+instance.modelError)
				}
				t.Fatalf("the toolbar rejected the Python entrypoint: %s\nbuild models: %q", notice, models)
			}
		}
		return p.runConfigs.selected != ""
	})
	run := awaitProcessRun(t, h, p, "main.py", nil)
	checkOutput := func(output string) {
		t.Helper()
		if !strings.Contains(output, "current file ran") || !strings.Contains(output, wantPrefix) {
			t.Fatalf("expected the program to run with sys.prefix %q:\n%s", wantPrefix, output)
		}
	}
	checkOutput(run.output.all())
	saved := p.runConfigs.configuration(p.runConfigs.selected)
	if saved == nil {
		t.Fatal("the toolbar did not select the saved run configuration")
	}
	if ref, ok := saved.BuildReference(); !ok || ref.Run != "main" || ref.TargetID != "" {
		t.Fatalf("current file saved the wrong build reference: %+v", ref)
	}

	for i := range p.build.instances {
		instance := &p.build.instances[i]
		if instance.BuildSystemID != "python" {
			continue
		}
		for _, target := range instance.Model.Targets {
			if target.Name == "main.py" {
				action, ok := buildPrimaryAction(instance, &target)
				if !ok || action.entryID == "" {
					t.Fatal("main.py no longer has a command run in the Build panel")
				}
				h.app.post(func(a *App) {
					a.selectBuildInstance(p, i)
					a.runBuildTargetAction(p, target.ID, action)
				})
				checkOutput(awaitProcessRun(t, h, p, "main.py", run).output.all())
				return
			}
		}
	}
	t.Fatal("the build model no longer exposes the main.py target")
}
