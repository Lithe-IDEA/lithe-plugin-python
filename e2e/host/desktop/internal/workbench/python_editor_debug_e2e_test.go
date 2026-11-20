package workbench

import (
	"context"
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
	"github.com/1lck/Lithe-IDEA/desktop/internal/store"
)

// Drive the installed plugin through the window's normal Python editor and Debug paths.
// The debuggee records which interpreter actually ran it. The host has to discover
// the external environment selected by this project's .python-version.
func TestPythonSupportPluginEditorAndDebugger(t *testing.T) {
	archive := pythonArchiveForE2E(t)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	_, _, homes := registeredPythonEnvironments(t, ctx)
	interpreterHome := homes[1]
	preferences := store.At(t.TempDir())
	workspace, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, ".python-version"), []byte(filepath.Base(interpreterHome)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Only the selected interpreter contains this module. Its class name in a type
	// error proves the language server actually consulted that environment.
	interpreter := filepath.Join(interpreterHome, "bin", "python")
	if runtime.GOOS == "windows" {
		interpreter = filepath.Join(interpreterHome, "Scripts", "python.exe")
	}

	createModule := `import pathlib, sysconfig
path = pathlib.Path(sysconfig.get_path("purelib")) / "lithe_test_environment.py"
path.write_text("class ProjectInterpreterType: pass\n", encoding="utf-8")`
	if out, err := exec.CommandContext(ctx, interpreter, "-I", "-B", "-c", createModule).CombinedOutput(); err != nil {
		t.Fatalf("create module in the selected environment: %v\n%s", err, out)
	}
	source := filepath.Join(workspace, "main.py")
	code := `import sys
from pathlib import Path
from lithe_test_environment import ProjectInterpreterType

value: int = ProjectInterpreterType()
Path('interpreter.txt').write_text(sys.prefix, encoding='utf-8')
`
	if err := os.WriteFile(source, []byte(code), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(preferences.Dir(), settingsFile), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	logDir := t.TempDir()
	kernel := core.NewClient()
	h := newHarnessWithOptions(t, Options{
		Kernel: kernel, PluginKernel: kernel, PluginRoot: filepath.Join(t.TempDir(), "Lithe Plugins"), Store: preferences,
		Logs: &pluginFilesLog{directory: logDir}, LogKernel: kernel, Languages: []string{"en"},
	})
	installedDir := installPythonArchive(t, ctx, h.app.plugins, archive)
	before := pythonPackageDigest(t, installedDir)
	h.app.reloadPluginLanguages()
	h.settle()
	p := openDebugPanel(t, h, workspace)
	h.app.openFileAt(p, source, 1)
	awaitStateWithin(t, h, 30*time.Second, "Pyrefly to diagnose the open document", func() bool {
		if failure := h.app.pluginServerFailed["python"]; failure != nil {
			t.Fatalf("Pyrefly start: %s", failure.message)
		}
		return pythonDiagnosticMessage(h.app, source, "`ProjectInterpreterType` is not assignable to `int`") != ""
	})
	t.Logf("Pyrefly reported %q for the open editor document", problemMessages(h.app))
	h.app.startDebug(p)
	marker := filepath.Join(workspace, "interpreter.txt")
	awaitStateWithin(t, h, 30*time.Second, "debugpy to run the program and finish the session", func() bool {
		if p.debug.failure != "" {
			t.Fatalf("debugpy: %s", p.debug.failure)
		}
		_, err := os.Stat(marker)
		return err == nil && p.debug.activeSession() == nil
	})
	actualPrefix, err := os.ReadFile(marker)
	if err != nil {
		t.Fatal(err)
	}
	actual, err := os.Stat(string(actualPrefix))
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.Stat(interpreterHome)
	if err != nil || !os.SameFile(actual, want) {
		t.Fatalf("debuggee used interpreter home %q, want %q (%v)", actualPrefix, interpreterHome, err)
	}
	entries, err := os.ReadDir(logDir)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(entries, func(entry os.DirEntry) bool {
		return strings.HasPrefix(entry.Name(), "debugpy.adapter-") && strings.HasSuffix(entry.Name(), ".log")
	}) {
		t.Fatal("debugpy did not write its adapter log to the host log directory")
	}
	t.Log("debugpy ran the program with the project-selected interpreter and wrote its adapter log to the host log directory")
	h.app.closeProject()
	awaitStateWithin(t, h, 20*time.Second, "the workspace to close", func() bool { return h.app.project == nil })
	h.settle()
	h.app.plugins.Host.Stop(pythonSupportPluginID)
	if !maps.Equal(before, pythonPackageDigest(t, installedDir)) {
		t.Fatal("the editor and debugger changed the installed plugin files")
	}
}
