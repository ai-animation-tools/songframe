package app

import "testing"

// TestOpenExternal — браузер ОС получает только веб-адреса: пути, file: и javascript: отклоняются.
func TestOpenExternal(t *testing.T) {
	opened := []string{}
	service := NewShellService(nil, nil, func(address string) error {
		opened = append(opened, address)
		return nil
	})
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
	if err := NewShellService(nil, nil, nil).OpenExternal("https://example.test"); err == nil {
		t.Fatal("без браузера ОС ошибки нет")
	}
}
