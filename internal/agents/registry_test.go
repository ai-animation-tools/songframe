package agents

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// frontendFile читает исходник renderer: реестр и тексты Go обязаны совпадать с ним.
func frontendFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", path))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

var providerBlock = regexp.MustCompile(`(?s)\n  (\w+): \{\n    title: '([^']*)',\n    executable: '([^']*)',\n    loginCommand: '([^']*)',\n    statusCommand: '([^']*)',\n    installUrl: '([^']*)',\n    loginUrl: '([^']*)',\n    accountUrl: '([^']*)',\n    reviewImageBudgetBytes: (\d+) \* 1024 \* 1024\n  \}`)

func TestRegistryMatchesFrontend(t *testing.T) {
	blocks := providerBlock.FindAllStringSubmatch(frontendFile(t, "agent-providers.ts"), -1)
	if len(blocks) != len(ProviderIDs) {
		t.Fatalf("в реестре renderer %d агентов, в Go %d", len(blocks), len(ProviderIDs))
	}
	for index, block := range blocks {
		megabytes, _ := strconv.Atoi(block[9])
		want := ProviderInfo{Title: block[2], Executable: block[3], LoginCommand: block[4], StatusCommand: block[5], InstallURL: block[6], LoginURL: block[7], AccountURL: block[8], ReviewImageBudgetBytes: megabytes * 1024 * 1024}
		if ProviderIDs[index] != block[1] || Providers[block[1]] != want {
			t.Fatalf("агент %s: Go %+v, renderer %+v", block[1], Providers[block[1]], want)
		}
	}
	if Title("") != textAgentLabel || Title(Codex) != "Codex" {
		t.Fatal("Title")
	}
}

// textExceptions — тексты Go, которые renderer собирает шаблоном по виду медиа; шаблон
// проверяется отдельно в TestTextsMatchFrontend.
var textExceptions = map[string]bool{
	"textMediaImageRequired": true, "textMediaVideoRequired": true,
	"textAvailableImageRequired": true, "textAvailableVideoRequired": true,
}

// TestTextsMatchFrontend: каждый постоянный текст texts.go дословно есть в словарях renderer
// (agents, settings, ai-access, common) или в реестре агентов.
func TestTextsMatchFrontend(t *testing.T) {
	var sources strings.Builder
	for _, name := range []string{"texts/agents.ts", "texts/settings.ts", "texts/ai-access.ts", "texts/common.ts", "texts/cover.ts", "cover-generation.ts"} {
		if data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", name)); err == nil {
			sources.Write(data)
		}
	}
	all := sources.String()
	file, err := parser.ParseFile(token.NewFileSet(), "texts.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	ast.Inspect(file, func(node ast.Node) bool {
		spec, ok := node.(*ast.ValueSpec)
		if !ok || len(spec.Values) != 1 {
			return true
		}
		literal, ok := spec.Values[0].(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, _ := strconv.Unquote(literal.Value)
		name := spec.Names[0].Name
		if textExceptions[name] {
			return true
		}
		if !strings.Contains(all, "'"+value+"'") && !strings.Contains(all, "`"+value+"`") {
			t.Errorf("%s = %q нет в текстах renderer", name, value)
		}
		checked++
		return true
	})
	for _, template := range []string{
		"`Сначала выберите провайдера ${kind === 'image' ? 'изображений' : 'видео'} в настройках проекта.`",
		"`Сначала выберите доступного провайдера ${kind === 'image' ? 'изображений' : 'видео'} в настройках проекта.`",
	} {
		if !strings.Contains(all, template) {
			t.Errorf("нет шаблона %s", template)
		}
	}
	if mediaSelectionRequired(KindImage) != textMediaImageRequired || mediaSelectionRequired(KindVideo) != textMediaVideoRequired {
		t.Error("mediaSelectionRequired")
	}
	if checked < 40 {
		t.Fatalf("проверено только %d текстов", checked)
	}
	for status, phase := range statusPhase {
		if !strings.Contains(all, "'"+phase+"'") {
			t.Errorf("подпись состояния %s %q нет в текстах renderer", status, phase)
		}
	}
}
