package workbench

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
	"github.com/1lck/Lithe-IDEA/desktop/internal/toolchain"
	"github.com/vivaui/viva/app"
	"github.com/vivaui/viva/headless"
)

func TestPythonSupportPluginManualRunAndDependencies(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root = filepath.Join(root, "manual-run")
	venv := filepath.Join(root, ".venv")
	python := "python3"
	executable := filepath.Join(venv, "bin", "python")
	if runtime.GOOS == "windows" {
		python = "python"
		executable = filepath.Join(venv, "Scripts", "python.exe")
	}
	if output, err := exec.CommandContext(ctx, python, "-m", "venv", "--without-pip", venv).CombinedOutput(); err != nil {
		t.Fatalf("create project environment: %v\n%s", err, output)
	}
	site, err := exec.CommandContext(ctx, executable, "-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))").Output()
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	write := func(path, content string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	program := "import os, sys\nprint(sys.prefix)\nprint(os.getcwd())\nprint(sys.flags.dev_mode, os.environ['PROFILE_TEST'], repr(sys.argv[1:]))\n"
	write(filepath.Join(root, "requirements.txt"), "root-demo==1.0\n")
	write(filepath.Join(root, "manual script.py"), program)
	write(filepath.Join(work, "manual_module.py"), program)
	purelib := strings.TrimSpace(string(site))
	write(filepath.Join(purelib, "root_demo-1.0.dist-info", "METADATA"), "Name: root-demo\nVersion: 1.0\nRequires-Dist: child-demo\n")
	write(filepath.Join(purelib, "child_demo-2.0.dist-info", "METADATA"), "Name: child-demo\nVersion: 2.0\n")

	kernel := core.NewClient()
	preferences := store.At(t.TempDir())
	if err := preferences.Save(settingsFile, settings{Theme: themeDark}); err != nil {
		t.Fatal(err)
	}
	trust, err := toolchain.ReadWorkspaceTrust(ctx, kernel, preferences.Dir(), root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := trust.Save(ctx, kernel, true, false); err != nil {
		t.Fatal(err)
	}
	options := Options{
		Kernel: kernel, PluginKernel: kernel, PluginRoot: t.TempDir(), Store: preferences,
		Languages: []string{"zh-Hans"},
	}
	out := os.Getenv("LITHE_PYTHON_VISUAL_DIR")
	openHarness := newHarnessWithOptions
	var session *headless.Session
	if out != "" {
		if err := os.MkdirAll(out, 0o700); err != nil {
			t.Fatal(err)
		}
		openHarness = func(t testing.TB, options Options) *harness {
			return newHarnessWithDriver(t, options, func(config app.Config) (*app.Driver, func(), error) {
				config.Width, config.Height = 1280, 840
				var err error
				session, err = headless.Open(config, nil, headless.Options{})
				if err != nil {
					return nil, nil, err
				}
				return session.Driver(), session.Close, nil
			})
		}
	}
	h := openHarness(t, options)
	capture := func(t *testing.T, name string) {
		t.Helper()
		if session != nil {
			// The console prints temporary fixture paths that are irrelevant to the screenshots.
			h.app.post(func(a *App) { a.reduceChrome(core.SetChromeOpen(itemRun, false)) })
			h.settleChain()
			if err := session.Screenshot(filepath.Join(out, name+".png")); err != nil {
				t.Fatal(err)
			}
		}
	}
	installPythonArchive(t, ctx, h.app.plugins, pythonArchiveForE2E(t))
	h.open(root)
	p := h.app.project
	key := core.RunTypeKey{PluginID: pythonSupportPluginID, BuildSystemID: "python", Type: "python"}
	h.app.post(func(a *App) { a.loadTitleRunConfigs(p) })
	awaitStateWithin(t, h, 10*time.Second, "the Python run kind and build instance", func() bool {
		return p.runConfigs.runTypeKind(key) != nil && p.hasRunTypeInstance(key)
	})

	h.app.post(func(a *App) {
		a.openRunConfigDialog(p, "")
		p.runConfigs.dialog.newMenu = runConfigNewMenuToolbar
	})
	capture(t, "python-run-menu")

	for _, target := range []struct{ kind, field, value string }{
		{"script", "script", "manual script.py"},
		{"module", "module", "manual_module"},
	} {
		t.Run(target.kind, func(t *testing.T) {
			dialog := &p.runConfigs.dialog
			h.app.post(func(a *App) {
				a.openRunConfigDialog(p, "")
				a.addRunConfigDraft(p, declaredKind(key), map[string]json.RawMessage{
					"field:targetKind": json.RawMessage(`"` + target.kind + `"`),
				})
			})
			var form *runConfigForm
			awaitStateWithin(t, h, 10*time.Second, "the Python run editor", func() bool {
				draft := dialog.drafts[dialog.selected]
				if draft != nil {
					form = draft.form
				}
				return form != nil && form.ready() && form.texts["field:"+target.field] != nil
			})
			h.settle()
			if !h.shows("运行目标") {
				t.Fatal("the dialog does not show the localized Python run target")
			}
			label := "Manual Python " + target.kind
			h.app.post(func(a *App) {
				*form.texts["name"] = label
				*form.texts["field:"+target.field] = target.value
				*form.texts["field:interpreterOptions"] = "-X dev"
				*form.texts["workingDirectory"] = "work"
				*form.texts["programArguments"] = `"two words" plain`
				form.environment = []*runConfigVariable{{name: "PROFILE_TEST", value: "present"}}
				a.runConfigFormEdited(p, form)
			})
			awaitStateWithin(t, h, 10*time.Second, "the edited Python run form", func() bool { return !form.refreshing })
			capture(t, "python-run-"+target.kind)
			applyDialog(t, h, p, runConfigDialogRun)
			output := awaitProcessRun(t, h, p, label, nil).output.all()
			for _, want := range []string{venv, work, "True present ['two words', 'plain']"} {
				if !strings.Contains(output, want) {
					t.Fatalf("run output misses %q:\n%s", want, output)
				}
			}
		})
	}

	var instance *buildInstance
	awaitStateWithin(t, h, 10*time.Second, "the Python model with a project", func() bool {
		for index := range p.build.instances {
			candidate := &p.build.instances[index]
			if candidate.BuildSystemID == "python" && candidate.modelLoaded && len(candidate.Model.Projects) == 1 {
				instance = candidate
				return true
			}
		}
		return false
	})
	h.app.post(func(a *App) { a.reduceChrome(core.SetChromeOpen(itemBuild, true)) })
	var section buildRow
	awaitStateWithin(t, h, 10*time.Second, "the Dependencies section in the Build panel", func() bool {
		rows, _ := h.app.buildTreeRows(p)
		for _, row := range rows {
			if row.node != nil && row.node.Kind == core.BuildTreeDependencies && p.build.instances[row.instance].ID == instance.ID {
				section = row
				return true
			}
		}
		return false
	})
	h.app.post(func(a *App) {
		p.setBuildOpen(buildOpenKey(instance.ID, section.node.Key), buildOpenState{open: true, dependencies: true})
	})
	var dependencies *buildDependencies
	awaitStateWithin(t, h, 10*time.Second, "the installed Python package in the Build panel", func() bool {
		rows, _ := h.app.buildTreeRows(p)
		for _, row := range rows {
			if row.kind == buildRowDependency && row.label == "root-demo:1.0" {
				dependencies = p.build.dependencies[buildDependencyKey(instance.ID, section.node.ProjectID)]
				return true
			}
		}
		return false
	})
	h.app.post(func(a *App) { dependencies.open["0"] = true })
	awaitStateWithin(t, h, 10*time.Second, "the transitive package in the Build panel", func() bool {
		return h.shows("child-demo:2.0")
	})
	capture(t, "python-dependency-tree")
}
