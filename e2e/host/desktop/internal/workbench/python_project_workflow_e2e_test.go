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

func TestPythonSupportPluginStandaloneBuildPanel(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		files map[string]string
		tasks map[string][]string
	}{
		{
			name:  "uv-without-ruff",
			files: map[string]string{"pyproject.toml": "[project]\nname = 'plain'\nversion = '0.1.0'\n", "uv.lock": "version = 1\n"},
			tasks: map[string][]string{"uv": {"lock", "sync"}},
		},
		{
			name: "uv-conda-and-ruff",
			files: map[string]string{
				"pyproject.toml":   "[project]\nname = 'tools'\nversion = '0.1.0'\n",
				"uv.lock":          "version = 1\n",
				"environment.yaml": "name: fixture\ndependencies:\n  - python\n",
				".ruff.toml":       "line-length = 100\n",
			},
			tasks: map[string][]string{"uv": {"lock", "sync"}, "conda": {"env-update"}, "ruff": {"check", "format"}},
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			root := filepath.Join(t.TempDir(), scenario.name)
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			for name, contents := range scenario.files {
				if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			runConda := runtime.GOOS != "windows" && len(scenario.tasks["conda"]) != 0
			if runConda {
				tools := t.TempDir()
				python, err := exec.LookPath("python3")
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(python, filepath.Join(tools, "python")); err != nil {
					t.Fatal(err)
				}
				// Some systems expose a launcher on PATH even without a Python runtime behind it.
				if err := os.WriteFile(filepath.Join(tools, "python3"), []byte("#!/bin/sh\nexit 29\n"), 0o700); err != nil {
					t.Fatal(err)
				}
				const conda = "#!/bin/sh\n[ \"$#\" = 5 ] && [ \"$*\" = 'env update --file environment.yaml --prune' ] && [ -f \"$4\" ]\n"
				if err := os.WriteFile(filepath.Join(tools, "conda"), []byte(conda), 0o700); err != nil {
					t.Fatal(err)
				}
				t.Setenv("PATH", tools+string(os.PathListSeparator)+os.Getenv("PATH"))
			}
			kernel := core.NewClient()
			preferences := store.At(t.TempDir())
			if err := preferences.Save(settingsFile, settings{Theme: themeDark}); err != nil {
				t.Fatal(err)
			}
			options := Options{
				Kernel: kernel, PluginKernel: kernel, PluginRoot: t.TempDir(), Store: preferences,
				Languages: []string{"zh-Hans"},
			}
			openHarness := newHarnessWithOptions
			out := os.Getenv("LITHE_PYTHON_VISUAL_DIR")
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
			installPythonArchive(t, ctx, h.app.plugins, pythonArchiveForE2E(t))
			h.open(root)
			p := h.app.project
			h.app.reduceChrome(core.SetChromeOpen(itemBuild, true))
			h.awaitBuildDetection(p)
			p.setAllBuildGroups(true)

			condaIndex := -1
			for index, instance := range p.build.instances {
				id := instance.BuildSystemID
				if id == "conda" {
					condaIndex = index
				}
				if id == "python" {
					continue
				}
				if _, expected := scenario.tasks[id]; !expected {
					t.Errorf("unexpected build system %q", id)
				}
				if !instance.modelLoaded || instance.modelError != "" || p.buildSyncSession(instance.ID) != nil {
					t.Errorf("%s loaded=%v, model error=%q, sync session=%v", id, instance.modelLoaded, instance.modelError, p.buildSyncSession(instance.ID))
				}
			}
			visible := make(map[[2]string]bool)
			for _, row := range laidOutBuildRows(t, h, p) {
				if row.kind == buildRowTask && row.node != nil && row.node.ProjectID == "" && row.node.TargetID == "" {
					id := p.build.instances[row.instance].BuildSystemID
					visible[[2]string{id, row.node.TaskID}] = true
				}
			}
			for id, tasks := range scenario.tasks {
				for _, task := range tasks {
					if !visible[[2]string{id, task}] {
						t.Errorf("missing visible workspace task %s/%s", id, task)
					}
				}
			}
			if session != nil {
				h.settle()
				if err := session.Screenshot(filepath.Join(out, "python-build-"+scenario.name+".png")); err != nil {
					t.Fatal(err)
				}
			}
			if runConda && condaIndex >= 0 {
				h.app.selectBuildInstance(p, condaIndex)
				operation, err := h.app.runBuildTask(p, "", "", "env-update", nil)
				if err != nil {
					t.Fatal(err)
				}
				awaitStateWithin(t, h, 10*time.Second, "Conda environment update to finish", func() bool { return !operation.session.running })
				if operation.session.outcome != runSucceeded {
					t.Fatalf("Conda environment update: %s\n%s", operation.session.summary, operation.session.output.all())
				}
			}
		})
	}
}

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
	// A Conda environment file is this workspace's only build marker.
	write(filepath.Join(root, "environment.yml"), "name: manual-run\ndependencies:\n  - python\n")
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

	var instanceIndex int
	awaitStateWithin(t, h, 10*time.Second, "the Python model with a project", func() bool {
		for index := range p.build.instances {
			candidate := &p.build.instances[index]
			if candidate.BuildSystemID == "python" && candidate.modelLoaded && len(candidate.Model.Projects) == 1 {
				instanceIndex = index
				return true
			}
		}
		return false
	})
	instance := &p.build.instances[instanceIndex]
	h.app.post(func(a *App) {
		a.selectBuildInstance(p, instanceIndex)
		a.reduceChrome(core.SetChromeOpen(itemBuild, true))
	})
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
	const rootPackage = "root-demo:1.0"
	awaitStateWithin(t, h, 10*time.Second, "the installed Python package in the Build panel", func() bool {
		return h.labelBounds(rootPackage).Width > 0
	})
	point := center(h.labelBounds(rootPackage))
	if err := h.driver.Click(point.X, point.Y); err != nil {
		t.Fatal(err)
	}
	awaitStateWithin(t, h, 10*time.Second, "the transitive package in the Build panel", func() bool {
		return h.shows("child-demo:2.0")
	})
	capture(t, "python-dependency-tree")
}
