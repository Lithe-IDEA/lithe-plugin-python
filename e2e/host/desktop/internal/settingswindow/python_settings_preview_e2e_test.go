//go:build vivahead

package settingswindow

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/i18n"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugininstall"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginservice"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginsettings"
	"github.com/1lck/Lithe-IDEA/desktop/internal/plugintrust"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
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

func TestPythonPluginSettingsPreview(t *testing.T) {
	archive := os.Getenv("LITHE_TEST_PYTHON_PLUGIN_ARCHIVE")
	if archive == "" {
		t.Skip("set LITHE_TEST_PYTHON_PLUGIN_ARCHIVE to the packaged Python plugin")
	}
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
		theme, title, toggle, draft string
		language                    i18n.Language
	}{
		{"light", "Preview", "Complete function parentheses", "Includes changes not applied yet", i18n.English},
		{"dark", "效果预览", "补全函数括号", "含未应用的修改", i18n.Chinese},
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
			}), Values{Theme: look.theme, Language: look.language.Code()})
			w.sess.page = pageLanguages
			w.sess.open[pageLanguages] = true
			config := w.config()
			config.Width, config.Height = 1080, 800
			session, err := headless.Open(config, nil, headless.Options{})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(session.Close)
			t.Cleanup(w.closeRegion)
			d := &windowDriver{t: t, w: w, driver: session.Driver()}
			const page = "language:python"
			d.until("installed Python settings page", func() bool { return w.dynamic.selected(page) != nil })
			w.selectSettingsPage(pageLanguages, page)
			d.until("Python settings preview and completion toggle", func() bool {
				if err := w.pluginSettings.failed; err != nil {
					t.Fatalf("load settings: %v", err)
				}
				if w.region != nil && w.region.session.Err() != nil {
					t.Fatalf("draw preview: %v", w.region.session.Err())
				}
				return d.text(look.title) && d.has(look.toggle)
			})
			if d.text(look.draft) || !d.text("greet") {
				t.Fatal("the preview did not show the saved default")
			}
			capture := func(state string) {
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
				if err := session.Screenshot(filepath.Join(out, "python-settings-preview-"+look.theme+"-"+state+".png")); err != nil {
					t.Fatal(err)
				}
			}
			capture("saved")
			d.click(look.toggle)
			d.until("preview of the unsaved completion change", func() bool { return d.text(look.draft) && d.text("greet()") })
			capture("draft")
			if _, err := os.Stat(w.pluginSettings.editor.Snapshot.GlobalPath()); !os.IsNotExist(err) {
				t.Fatalf("preview wrote the draft to the settings file: %v", err)
			}
		})
	}
}
