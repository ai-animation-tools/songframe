package agents

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// Поиск и разворачивание обёрток Windows проверяются в Linux: платформа передаётся явно.

func executableFile(t *testing.T, path, body string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

// npmShim — обёртка, которую npm создаёт в %APPDATA%\npm для глобального пакета.
func npmShim(t *testing.T, path, target string) string {
	return executableFile(t, path, strings.Join([]string{
		"@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
		`IF EXIST "%dp0%\node.exe" (`, `  SET "_prog=%dp0%\node.exe"`, ") ELSE (", `  SET "_prog=node"`, "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")",
		`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\` + target + `" %*`, "",
	}, "\r\n"))
}

func TestWindowsFindExecutable(t *testing.T) {
	work := t.TempDir()
	first, second := filepath.Join(work, "first"), filepath.Join(work, "second")
	executableFile(t, filepath.Join(first, "codex"), "")
	executableFile(t, filepath.Join(first, "codex.cmd"), "")
	executableFile(t, filepath.Join(first, "codex.exe"), "")
	executableFile(t, filepath.Join(second, "claude.cmd"), "")
	env := []string{"Path=" + strings.Join([]string{"relative", first, second}, string(os.PathListSeparator))}
	if path, _ := FindExecutable("codex", env, "win32"); path != filepath.Join(first, "codex.exe") {
		t.Fatalf("codex: %s", path)
	}
	if path, _ := FindExecutable("claude", env, "win32"); path != filepath.Join(second, "claude.cmd") {
		t.Fatalf("claude: %s", path)
	}
	if _, found := FindExecutable("node", env, "win32"); found {
		t.Fatal("node не должен находиться")
	}
	result, err := CheckAgent(t.Context(), Settings{Provider: Claude}, CheckOptions{Env: []string{"Path="}, Home: work, System: []string{}, Platform: "win32"})
	want := `Claude Code не найден в PATH, %USERPROFILE%\.local\bin и %APPDATA%\npm. Установите его по официальной инструкции и повторите проверку.`
	if err != nil || result.Availability != NotFound || result.Message != want {
		t.Fatalf("не найден в Windows: %+v %v", result, err)
	}
}

func TestWindowsEnvironment(t *testing.T) {
	work := t.TempDir()
	home := filepath.Join(work, "home")
	env := AgentEnvironment([]string{"Path=" + filepath.Join(work, "bin"), "APPDATA=" + filepath.Join(work, "Roaming"), "ProgramFiles=" + filepath.Join(work, "Program Files")}, home, nil, "win32")
	keys := []string{}
	value := ""
	for _, entry := range env {
		key, text, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, "PATH") {
			keys = append(keys, key)
			value = text
		}
	}
	want := []string{filepath.Join(work, "bin"), filepath.Join(home, ".local", "bin"), filepath.Join(work, "Roaming", "npm"), filepath.Join(work, "Program Files", "nodejs")}
	if !slices.Equal(keys, []string{"Path"}) || !slices.Equal(strings.Split(value, string(os.PathListSeparator)), want) {
		t.Fatalf("Path: %v %q", keys, value)
	}
	linux := AgentEnvironment([]string{"PATH=/opt/bin:rel:/usr/bin", "X=1"}, "/home/u", nil, "linux")
	if !slices.Equal(linux, []string{"PATH=/opt/bin:/usr/bin:/home/u/.local/bin:/usr/local/bin:/bin", "X=1"}) {
		t.Fatalf("Linux: %v", linux)
	}
}

func TestWindowsShim(t *testing.T) {
	work := t.TempDir()
	npm := filepath.Join(work, "npm")
	wrapper := npmShim(t, filepath.Join(npm, "codex.cmd"), `node_modules\@openai\codex\bin\codex.js`)
	script := filepath.Join(npm, "node_modules", "@openai", "codex", "bin", "codex.js")
	node := executableFile(t, filepath.Join(work, "nodejs", "node.exe"), "")
	env := []string{"Path=" + strings.Join([]string{npm, filepath.Dir(node)}, string(os.PathListSeparator))}
	check := func(got Command, file string, args ...string) {
		t.Helper()
		if got.File != file || !slices.Equal(got.Args, args) {
			t.Fatalf("команда %+v, ожидалось %s %v", got, file, args)
		}
	}
	check(AgentCommand(wrapper, []string{"exec", "-"}, env, "win32"), node, script, "exec", "-")
	check(AgentCommand("codex", []string{"--version"}, env, "win32"), node, script, "--version")
	local := executableFile(t, filepath.Join(npm, "node.exe"), "")
	check(AgentCommand(wrapper, nil, env, "win32"), local, script)

	claude := npmShim(t, filepath.Join(work, "claude.cmd"), `node_modules\@anthropic-ai\claude-code\bin\claude.exe`)
	check(AgentCommand(claude, []string{"-p"}, nil, "win32"), filepath.Join(work, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"), "-p")
	other := executableFile(t, filepath.Join(work, "other.cmd"), "@echo off\r\nclaude.exe %*\r\n")
	check(AgentCommand(other, []string{"-p"}, nil, "win32"), other, "-p")
	check(AgentCommand(claude, []string{"-p"}, nil, "linux"), claude, "-p")
	// Без node.exe рядом и в PATH остаётся голое имя: запуск даст штатную ошибку.
	lonely := npmShim(t, filepath.Join(t.TempDir(), "codex.cmd"), `bin\codex.js`)
	check(AgentCommand(lonely, nil, nil, "win32"), "node.exe", filepath.Join(filepath.Dir(lonely), "bin", "codex.js"))
}
