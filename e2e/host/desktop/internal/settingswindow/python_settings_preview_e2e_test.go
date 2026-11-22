//go:build vivahead

package settingswindow

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/i18n"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugininstall"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginservice"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginsettings"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugintrust"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
	"github.com/1lck/Lithe-IDEA/desktop/internal/toolchain"
	"github.com/vivaui/viva/headless"
)

const pythonSettingsPlugin = "io.github.lithe-idea.python-support"

type pythonPreviewSource struct{ service *pluginservice.Service }

func (s pythonPreviewSource) Load(ctx context.Context, id string, language i18n.Language) (pluginservice.SettingsEditor, error) {
	return s.service.LoadSettingsEditor(ctx, id, "", language.Code())
}

func (s pythonPreviewSource) Save(ctx context.Context, editor pluginservice.SettingsEditor, scope string, edits []core.PluginSettingEdit) (pluginsettings.SaveResult, error) {
	return s.service.SaveSettingsEditor(ctx, editor, scope, edits, nil)
}

func (s pythonPreviewSource) View(ctx context.Context, editor pluginservice.SettingsEditor, region, function string, event, previous json.RawMessage, closing bool) (json.RawMessage, bool, error) {
	return s.service.CallView(ctx, pluginservice.SettingsViewCall(editor, region, function, "", event, previous, closing))
}

// pythonToolchains reads the installed plugins' tools for one workspace, as the workbench
// does, so the regions' tool rows show the interpreter Lithe resolves there. The test pins
// nothing.
type pythonToolchains struct {
	kernel  toolchain.Kernel
	service *pluginservice.Service
	root    string
}

func (l pythonToolchains) Load(ctx context.Context) (toolchain.Snapshot, error) {
	entries, err := l.service.Manager.Installed()
	if err != nil {
		return toolchain.Snapshot{}, err
	}
	plugins, err := l.service.ToolchainPlugins(ctx, entries)
	if err != nil {
		return toolchain.Snapshot{}, err
	}
	manifests := make([]json.RawMessage, 0, len(plugins))
	for _, plugin := range plugins {
		manifests = append(manifests, plugin.Manifest)
	}
	// Without a global root the project's own .venv may be probed, as a trusted project's is.
	return toolchain.Load(ctx, l.kernel, l.root, ".", manifests, l.service.ToolchainOptions(l.root, toolchain.Options{ProjectCodeAllowed: true}))
}

func (pythonToolchains) Save(_ context.Context, snapshot toolchain.Snapshot, _ []toolchain.Edit) (toolchain.Snapshot, error) {
	return snapshot, errors.New("the settings preview test pins no interpreter")
}

// pythonWorkspace is a project with its own .venv, made by the Python the suite runs pytest
// with, and that environment's version, which the tool rows show.
func pythonWorkspace(t *testing.T) (string, string) {
	t.Helper()
	python := os.Getenv("PYTEST_PYTHON")
	if python == "" {
		for _, name := range []string{"python3", "python"} {
			if found, err := exec.LookPath(name); err == nil {
				python = found
				break
			}
		}
	}
	if python == "" {
		t.Skip("set PYTEST_PYTHON or put python3 on PATH to make the project's .venv")
	}
	root := t.TempDir()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	venv := filepath.Join(root, ".venv")
	if out, err := exec.CommandContext(ctx, python, "-m", "venv", "--without-pip", venv).CombinedOutput(); err != nil {
		t.Fatalf("make the project's .venv: %v\n%s", err, out)
	}
	executable := filepath.Join(venv, "bin", "python")
	if _, err := os.Stat(executable); err != nil {
		executable = filepath.Join(venv, "Scripts", "python.exe")
	}
	out, err := exec.CommandContext(ctx, executable, "-c", "import platform; print(platform.python_version())").Output()
	if err != nil {
		t.Fatalf("read the .venv's version: %v", err)
	}
	return root, strings.TrimSpace(string(out))
}

// TestPythonPluginSettingsPreview opens the Python language page and the Python build page
// in the settings window and checks what the plugin's views draw there: the interpreter row
// above the preview cards, a draft shown before it is applied, and the order Lithe looks for
// the interpreter in.
func TestPythonPluginSettingsPreview(t *testing.T) {
	archive := os.Getenv("LITHE_TEST_PYTHON_PLUGIN_ARCHIVE")
	if archive == "" {
		t.Skip("set LITHE_TEST_PYTHON_PLUGIN_ARCHIVE to the packaged Python plugin")
	}
	root, version := pythonWorkspace(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	kernel := core.NewClient()
	service, err := pluginservice.Open(kernel, store.At(t.TempDir()), filepath.Join(t.TempDir(), "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Host.StopAll)
	plan, err := service.Installer.Prepare(ctx, plugininstall.Request{ArchivePath: archive, Root: service.Root, Source: plugintrust.Disk})
	if err != nil {
		t.Fatal(err)
	}
	if plan.ID != pythonSettingsPlugin {
		_ = service.Installer.Discard(plan)
		t.Fatalf("unexpected package ID %q", plan.ID)
	}
	if _, err := service.Installer.Commit(plan); err != nil {
		_ = service.Installer.Discard(plan)
		t.Fatal(err)
	}
	if err := service.Manager.SetEnabled(pythonSettingsPlugin, true); err != nil {
		t.Fatal(err)
	}
	for _, look := range []struct {
		theme, title, toggle, accepted, draft, order string
		language                                     i18n.Language
	}{
		{"light", "Preview", "Complete function parentheses", "After accepting greet", "Includes changes not applied yet",
			"How Lithe finds the Python interpreter", i18n.English},
		{"dark", "效果预览", "补全函数括号", "确认补全 greet 后", "含未应用的修改", "Lithe 按这个顺序找 Python 解释器", i18n.Chinese},
	} {
		t.Run(look.theme, func(t *testing.T) {
			w := newWindow(NewController(Options{
				Text: func() *i18n.Messages { return i18n.For(look.language) }, Language: func() i18n.Language { return look.language },
				SystemLanguage: look.language, SystemDark: func() bool { return look.theme == "dark" },
				SettingsPages: func(ctx context.Context, language i18n.Language) ([]core.SettingsPage, error) {
					return service.SettingsPages(ctx, language.Code())
				},
				SettingsNavigation: kernel.SettingsNavigation,
				PluginSettings:     pythonPreviewSource{service},
				Toolchains:         pythonToolchains{kernel: kernel, service: service, root: root},
			}), Values{Theme: look.theme, Language: look.language.Code()})
			w.sess.page = pageLanguages
			w.sess.open[pageLanguages] = true
			config := w.config()
			config.Width, config.Height = 1270, 1170
			session, err := headless.Open(config, nil, headless.Options{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(session.Close)
			t.Cleanup(w.closeRegion)
			d := &windowDriver{t: t, w: w, driver: session.Driver()}
			drawn := func(what string, cond func() bool) {
				t.Helper()
				d.until(what, func() bool {
					if err := w.pluginSettings.failed; err != nil {
						t.Fatalf("load settings: %v", err)
					}
					if w.region != nil && w.region.session.Err() != nil {
						t.Fatalf("draw the region: %v", w.region.session.Err())
					}
					return cond()
				})
			}
			capture := func(name string) {
				t.Helper()
				out := os.Getenv("LITHE_PYTHON_VISUAL_DIR")
				if out == "" {
					return
				}
				if err := os.MkdirAll(out, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := session.Advance(250 * time.Millisecond); err != nil {
					t.Fatal(err)
				}
				if err := session.Screenshot(filepath.Join(out, "python-settings-"+name+"-"+look.theme+".png")); err != nil {
					t.Fatal(err)
				}
			}

			const languagePage, buildPage = "language:python", "buildSystem:python"
			d.until("installed Python settings pages", func() bool {
				return w.dynamic.selected(languagePage) != nil && w.dynamic.selected(buildPage) != nil
			})
			w.selectSettingsPage(pageLanguages, languagePage)
			drawn("the interpreter row, the preview and the completion toggle", func() bool {
				return d.text(version) && d.text(look.title) && d.text(look.accepted) && d.has(look.toggle)
			})
			if d.text(look.draft) {
				t.Fatal("the preview marked a draft before anything was edited")
			}
			capture("language")

			d.click(look.toggle)
			drawn("the preview of the unapplied completion change", func() bool { return d.text(look.draft) })
			capture("language-draft")
			if _, err := os.Stat(w.pluginSettings.editor.Snapshot.GlobalPath()); !os.IsNotExist(err) {
				t.Fatalf("the preview wrote the draft to the settings file: %v", err)
			}

			w.openContributedPage(buildPage, pythonSettingsPlugin)
			drawn("the interpreter row and the lookup order on the Python build page", func() bool {
				return w.dynamicPage == buildPage && d.text(version) && d.text(look.order)
			})
			if d.text(look.title) {
				t.Fatal("the Python build page shows the language page's preview")
			}
			capture("build")
		})
	}
}
