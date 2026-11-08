package covergen

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unsafe"
)

// TestTextsMatchFrontend — сообщения обложки и референса совпадают со словарями
// frontend/src/shared/texts (sourcesTexts.main, referenceGenerationMessages, referenceImageTexts,
// applicationTexts): у текстов с подстановкой сверяются неизменные части шаблона.
func TestTextsMatchFrontend(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "..", "frontend", "src", "shared", "texts", "*.ts"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("словари текстов не найдены: %v", err)
	}
	var frontend strings.Builder
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		frontend.Write(data)
	}
	dictionary := frontend.String()
	check := func(label, text string) {
		t.Helper()
		if text == "" || !strings.Contains(dictionary, text) {
			t.Errorf("%s: текста %q нет в frontend/src/shared/texts", label, text)
		}
	}
	for name, set := range map[string]texts{"cover": coverTexts, "reference": referenceTexts} {
		value := reflect.ValueOf(&set).Elem()
		for index := 0; index < value.NumField(); index++ {
			field := value.Field(index)
			label := name + "." + value.Type().Field(index).Name
			// Поля неэкспортируемые: доступ к функциям — через адрес поля.
			switch item := reflect.NewAt(field.Type(), unsafe.Pointer(field.UnsafeAddr())).Elem(); item.Kind() {
			case reflect.String:
				check(label, item.String())
			case reflect.Func:
				// Подстановка заменяется маркером: части шаблона вокруг неё должны быть в словаре.
				result := item.Call([]reflect.Value{reflect.ValueOf("\x00")})[0].String()
				for _, part := range strings.Split(result, "\x00") {
					if part != "" {
						check(label, part)
					}
				}
			}
		}
	}
	for label, text := range map[string]string{"archiveFailed": textArchiveFailed, "referenceNotReady": textReferenceNotReady, "cropFailed": textCropFailed} {
		check(label, text)
	}
}
