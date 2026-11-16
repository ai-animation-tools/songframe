package agents

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
)

// claudeImageResult — событие stream-json, в котором Claude Code повторяет прочитанное изображение:
// строка с base64 заданного размера, как после чтения опоры или референса проекта.
func claudeImageResult(size int) string {
	return `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01","type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` +
		strings.Repeat("A", size) + `"}}]}]},"parent_tool_use_id":null}`
}

// TestJSONLinesOversize — длинная строка пропускается без накопления, если обработчик её опознал,
// при любом разбиении на фрагменты; соседние строки разбираются, отброшенные байты считаются точно.
func TestJSONLinesOversize(t *testing.T) {
	long := `{"type":"big","data":"` + strings.Repeat("x", 100) + `"}`
	stream := `{"a":1}` + "\n" + long + "\n" + `{"a":2}` + "\n"
	for _, size := range []int{1, 7, 32, len(stream)} {
		values := []string{}
		prefixes := [][]byte{}
		parser := NewJSONLines(func(value *dynvalue.Object) error {
			values = append(values, dynvalue.Stringify(value))
			return nil
		}, 32)
		parser.Oversize = func(prefix []byte) (bool, error) {
			prefixes = append(prefixes, append([]byte(nil), prefix...))
			return bytes.HasPrefix(prefix, []byte(`{"type":"big"`)), nil
		}
		data := []byte(stream)
		for len(data) > 0 {
			n := min(size, len(data))
			if err := parser.Push(data[:n]); err != nil {
				t.Fatalf("фрагменты по %d: %v", size, err)
			}
			data = data[n:]
		}
		if err := parser.Finish(); err != nil {
			t.Fatal(err)
		}
		if strings.Join(values, " ") != `{"a":1} {"a":2}` {
			t.Fatalf("фрагменты по %d: значения %v", size, values)
		}
		if parser.Skipped() != len(long)+1 {
			t.Fatalf("фрагменты по %d: отброшено %d, ожидалось %d", size, parser.Skipped(), len(long)+1)
		}
		// Обработчик вызывается один раз и получает начало строки, а не её середину.
		if len(prefixes) != 1 || !bytes.HasPrefix([]byte(long), prefixes[0]) || len(prefixes[0]) <= 32 {
			t.Fatalf("фрагменты по %d: начала %q", size, prefixes)
		}
	}
}

// TestJSONLinesOversizeRefused — неопознанная длинная строка и ошибка обработчика обрывают разбор,
// незавершённая пропускаемая строка в конце вывода просто отбрасывается.
func TestJSONLinesOversizeRefused(t *testing.T) {
	noop := func(*dynvalue.Object) error { return nil }
	refused := NewJSONLines(noop, 8)
	refused.Oversize = func([]byte) (bool, error) { return false, nil }
	var agentErr *Error
	if err := refused.Push([]byte(`{"a":"123456"}` + "\n")); !errors.As(err, &agentErr) || agentErr.Code != CodeOutputLimit || agentErr.Detail != textLineTooLarge {
		t.Fatalf("отказ пропустить: %v", err)
	}
	failing := NewJSONLines(noop, 8)
	stop := errors.New("стоп")
	failing.Oversize = func([]byte) (bool, error) { return false, stop }
	if err := failing.Push([]byte(`{"a":"123456"`)); !errors.Is(err, stop) {
		t.Fatalf("ошибка обработчика: %v", err)
	}
	tail := NewJSONLines(noop, 8)
	tail.Oversize = func([]byte) (bool, error) { return true, nil }
	if err := tail.Push([]byte(`{"a":"123456`)); err != nil {
		t.Fatal(err)
	}
	if err := tail.Finish(); err != nil || tail.Skipped() != 12 {
		t.Fatalf("хвост: %v, отброшено %d", err, tail.Skipped())
	}
}

// TestClaudeOversize — пропускается только событие user с результатом инструмента; оно отмечает
// завершение инструмента так же, как обычный разбор. Codex длинные строки не пропускает.
func TestClaudeOversize(t *testing.T) {
	adapter := NewAdapter(Claude).(OversizeHandler)
	prefix := []byte(claudeImageResult(oversizePrefix))[:oversizePrefix]
	updates, skip := adapter.Oversize(prefix)
	if !skip || len(updates) != 1 || updates[0].Type != UpdateToolFinished || updates[0].Tool != phaseReading {
		t.Fatalf("результат инструмента: %v %+v", skip, updates)
	}
	for _, line := range []string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"` + strings.Repeat("я", 600) + `"}]}}`,
		`{"type":"result","subtype":"success","result":"` + strings.Repeat("я", 600) + `"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"` + strings.Repeat("я", 600) + `"}]}}`,
	} {
		if _, skip := adapter.Oversize([]byte(line)[:oversizePrefix]); skip {
			t.Fatalf("пропущено событие %.40s", line)
		}
	}
	if _, ok := NewAdapter(Codex).(OversizeHandler); ok {
		t.Fatal("Codex не печатает прочитанные файлы и длинные строки не пропускает")
	}
}

// TestManagerClaudeReadsImages — задание Claude, прочитавшее несколько больших изображений, завершается
// результатом: события с base64 больше предела строки, а вместе — больше общего предела вывода.
func TestManagerClaudeReadsImages(t *testing.T) {
	image := claudeImageResult(DefaultLineBytes * 2)
	rules := append(append([]fakeRule{}, claudeReady...), fakeRule{Prefix: []string{"-p"}, Lines: []string{
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Read"}]}}`,
		image,
		`{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"Read"}]}}`,
		image,
		`{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"Готово"}],"stop_reason":"end_turn"}}`,
		`{"type":"result","subtype":"success","result":"Готово"}`,
	}})
	manager, _, _ := testManager(t, &Settings{Provider: Claude}, map[string]fakeScenario{"claude": {Rules: rules}}, Options{OutputBytes: len(image)})
	log := watch(manager)
	if _, err := manager.Start(StartInput{Project: testProject(t, "{}"), Task: "T", Prompt: "P"}); err != nil {
		t.Fatal(err)
	}
	if event := log.wait(t); event.Job.Status != StatusCompleted || event.Job.Result != "Готово" {
		t.Fatalf("итог %+v", event.Job)
	}
}
