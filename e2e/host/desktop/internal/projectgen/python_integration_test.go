package projectgen

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
	"github.com/1lck/Lithe-IDEA/desktop/internal/toolchain"
)

func pythonPluginDirectory(t *testing.T) (string, []byte) {
	t.Helper()
	directory := os.Getenv("LITHE_PLUGIN_PYTHON_DIR")
	if directory == "" {
		t.Skip("LITHE_PLUGIN_PYTHON_DIR is not set")
	}
	manifest, err := os.ReadFile(filepath.Join(directory, "plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	return directory, manifest
}

func localPythonInstallations(t *testing.T, ctx context.Context, manifest []byte) []core.ProjectToolInstallation {
	t.Helper()
	snapshot, err := toolchain.Load(ctx, core.NewClient(), t.TempDir(), ".", []json.RawMessage{manifest}, toolchain.Options{})
	if err != nil {
		t.Fatal(err)
	}
	var found []core.ProjectToolInstallation
	for _, tool := range snapshot.Tools {
		if tool.ID != "python" {
			continue
		}
		for _, installation := range tool.Installations {
			found = append(found, core.ProjectToolInstallation{
				Home:       installation.Home,
				Executable: installation.Executable,
				Version:    installation.Version,
			})
		}
		for _, shell := range tool.Shell {
			if shell.Home != "" && shell.Executable != "" && shell.Version != nil {
				found = append(found, core.ProjectToolInstallation{
					Home:       shell.Home,
					Executable: shell.Executable,
					Version:    *shell.Version,
				})
			}
		}
	}
	return found
}

func TestPythonPluginGeneratorCreatesProjectAndVirtualenv(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	directory, manifest := pythonPluginDirectory(t)
	pythonCmd := "python3"
	if runtime.GOOS == "windows" {
		pythonCmd = "python"
	}
	if _, err := exec.LookPath(pythonCmd); err != nil {
		t.Fatalf("%s is not on PATH: %v", pythonCmd, err)
	}

	kernel := core.NewClient()
	catalog, err := kernel.ProjectGeneratorCatalogOf(ctx, []core.ProjectGeneratorPlugin{
		{Manifest: manifest, Enabled: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Issues) != 0 || len(catalog.Generators) != 1 {
		t.Fatalf("unexpected generator catalog: %+v", catalog)
	}

	installations := localPythonInstallations(t, ctx, manifest)
	values := map[string]any{
		"environment":   "venv",
		"addSampleCode": true,
	}
	edited := []string{"environment", "addSampleCode"}
	if len(installations) > 0 {
		values["python"] = installations[0].Home
		edited = append(edited, "python")
	}

	input := core.ProjectGeneratorFormInput{
		ProjectName: "DemoApp",
		Values:      values,
		Edited:      edited,
		Tools:       map[string][]core.ProjectToolInstallation{"python": installations},
	}

	form, err := kernel.ProjectGeneratorFormOf(ctx, manifest, "python-project", input)
	if err != nil || !form.Valid {
		t.Fatalf("form = %+v, err = %v", form, err)
	}
	plan, err := kernel.ProjectGenerationPlanOf(ctx, manifest, "python-project", directory, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(installations) > 0 && len(plan.ToolPins) != 1 {
		t.Fatalf("expected 1 project tool pin, got %+v", plan.ToolPins)
	}

	parent := t.TempDir()
	var savedPins []core.ProjectPlanToolPin
	res := Run(ctx, Request{
		Parent:  parent,
		Name:    "DemoApp",
		Plan:    plan,
		Kernel:  kernel,
		Resolve: LookPathResolver,
		SavePins: func(_ context.Context, _ string, p core.ProjectGenerationPlan) error {
			savedPins = append(savedPins, p.ToolPins...)
			return nil
		},
	})
	if res.Failure != nil {
		t.Fatalf("projectgen.Run failed: %v (tail: %s)", res.Failure, res.Failure.Tail)
	}
	if len(installations) > 0 && len(savedPins) != 1 {
		t.Fatalf("expected saved project pin, got %+v", savedPins)
	}

	for _, rel := range []string{"pyproject.toml", ".gitignore", "main.py", filepath.Join(".venv", "pyvenv.cfg")} {
		if _, statErr := os.Stat(filepath.Join(res.Path, rel)); statErr != nil {
			t.Fatalf("expected generated %s: %v", rel, statErr)
		}
	}

	venvPython := filepath.Join(res.Path, ".venv", "bin", "python3")
	if runtime.GOOS == "windows" {
		venvPython = filepath.Join(res.Path, ".venv", "Scripts", "python.exe")
	}
	cmd := exec.CommandContext(ctx, venvPython, "main.py")
	cmd.Dir = res.Path
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("running generated main.py with .venv failed: %v\n%s", err, out)
	}
	if strings.TrimSpace(string(out)) != "Hello from DemoApp!" {
		t.Fatalf("unexpected sample output: %q", string(out))
	}
}
