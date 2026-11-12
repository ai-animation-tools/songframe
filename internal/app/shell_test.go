package app

import "testing"

// TestOpenExternal — браузер ОС получает только веб-адреса: пути, file: и javascript: отклоняются.
func TestOpenExternal(t *testing.T) {
	opened := []string{}
	service := NewShellService(nil, nil, func(address string) error {
		opened = append(opened, address)
		return nil
	}, nil)
	for _, address := range []string{"https://example.test/app?a=1", "http://example.test"} {
		if err := service.OpenExternal(address); err != nil {
			t.Fatalf("%s: %v", address, err)
		}
	}
	for _, address := range []string{"", "/clip/source", "file:///etc/passwd", "javascript:alert(1)", "https://"} {
		if err := service.OpenExternal(address); err == nil {
			t.Fatalf("%q открыт", address)
		}
	}
	if len(opened) != 2 {
		t.Fatalf("открыто %v", opened)
	}
	if err := NewShellService(nil, nil, nil, nil).OpenExternal("https://example.test"); err == nil {
		t.Fatal("без браузера ОС ошибки нет")
	}
}

// TestClipboardText — текст буфера отдаётся как есть, отказ Wails и отсутствие буфера — ошибкой.
func TestClipboardText(t *testing.T) {
	service := NewShellService(nil, nil, nil, func() (string, bool) { return "строка\nвторая", true })
	if text, err := service.ClipboardText(); err != nil || text != "строка\nвторая" {
		t.Fatalf("%q, %v", text, err)
	}
	if _, err := NewShellService(nil, nil, nil, func() (string, bool) { return "", false }).ClipboardText(); err == nil {
		t.Fatal("отказ буфера без ошибки")
	}
	if _, err := NewShellService(nil, nil, nil, nil).ClipboardText(); err == nil {
		t.Fatal("без буфера ошибки нет")
	}
}
