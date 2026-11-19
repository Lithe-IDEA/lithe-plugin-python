package workbench

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/1lck/Lithe-IDEA/desktop/internal/core"
	"github.com/1lck/Lithe-IDEA/desktop/internal/pluginservice"
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
	"github.com/vivaui/viva/app"
)

func TestPythonSupportPluginShebang(t *testing.T) {
	archive := pythonArchiveForE2E(t)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	kernel := core.NewClient()
	preferences := store.At(t.TempDir())
	service, err := pluginservice.Open(kernel, preferences, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	installPythonArchive(t, ctx, service, archive)
	if err := os.WriteFile(filepath.Join(preferences.Dir(), settingsFile), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	h := newHarnessWithOptions(t, Options{
		Kernel: kernel, PluginKernel: kernel, PluginRoot: service.Root, Store: preferences, Languages: []string{"en"},
		Logs: &pluginFilesLog{directory: t.TempDir()}, LogKernel: kernel,
	})
	h.app.reloadPluginLanguages()
	h.settle()
	root := t.TempDir()
	h.open(root)
	p := h.app.project
	path := filepath.Join(p.root, "script")
	const body = "#!/usr/bin/env -S python3 -I\ncount: int = 42\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	h.app.openFile(p, path)
	h.settle()
	doc := p.docs.byPath(path)
	if doc == nil || doc.languageID != "python" {
		t.Fatal("extensionless script did not open as Python")
	}
	if len(doc.view.SyntaxLine(nil, 1)) == 0 {
		t.Fatal("extensionless script has no Python syntax tokens")
	}
	awaitStateWithin(t, h, 15*time.Second, "Pyrefly to open the extensionless document", func() bool {
		if failure := h.app.pluginServerFailed["python"]; failure != nil {
			t.Fatalf("Pyrefly start: %s", failure.message)
		}
		return doc.sync.opened
	})
	if !doc.view.GoToNavigation(1, 13, false) {
		t.Fatal("could not place the caret before the integer literal")
	}
	input := doc.view.TextInput(app.TextInputContext{ID: doc.hit})
	if _, err := input.OnEvent(app.TextEvent{Kind: app.TextInsert, Text: `"bad" # `}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(doc.view.TextSnapshot().String(), `count: int = "bad" # 42`) {
		t.Fatal("extensionless script edit was not applied")
	}
	awaitStateWithin(t, h, 15*time.Second, "Pyrefly to diagnose the edited extensionless script", func() bool {
		return diagnosticsForFile(h.app, path) > 0 &&
			problemMessagesContain(h.app, "int") && problemMessagesContain(h.app, "bad")
	})
}
