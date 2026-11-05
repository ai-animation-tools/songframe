package app

import (
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// boundServices — все сервисы, которые main регистрирует в Wails. Новый сервис
// добавляется сюда вместе с регистрацией, иначе его DTO не проверяются.
var boundServices = []any{
	&AppService{}, &ShellService{}, &ProjectService{}, &NativeService{}, &ComponentsService{}, &NativeCheckService{}, &JobsService{}, &TimingService{}, &SourcesService{},
	&CastService{}, &ScenarioService{}, &ToolsService{}, &ChecksService{},
	&AgentsService{}, &AIService{}, &VideoReviewService{},
	&ScenarioWorkflowService{}, &EnvironmentService{}, &MediaService{}, &CoverService{}, &ReferenceImagesService{},
	&ProductionService{}, &DashboardService{}, &AnimaticService{}, &MontageWindowService{}, &MontageService{},
}

// hasCollection сообщает, может ли значение типа сериализоваться с null вместо [] или {}.
func hasCollection(t reflect.Type, seen map[reflect.Type]bool) bool {
	if seen[t] {
		return false
	}
	seen[t] = true
	switch t.Kind() {
	case reflect.Slice:
		return true
	case reflect.Map:
		return true
	case reflect.Pointer, reflect.Array:
		return hasCollection(t.Elem(), seen)
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			if t.Field(i).IsExported() && hasCollection(t.Field(i).Type, seen) {
				return true
			}
		}
	}
	return false
}

// TestBoundMethodsFillCollections — тест сериализации DTO (D-027): каждый экспортируемый
// метод сервиса Wails, результат которого содержит срезы или словари, проводит ответ
// через wire.Fill/wire.Done. Тогда bindings без `| null` у коллекций честны, а UI не
// получает null там, где контракт обещает массив.
func TestBoundMethodsFillCollections(t *testing.T) {
	bodies := map[string]string{}
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil || fn.Body == nil {
				continue
			}
			var receiver strings.Builder
			_ = printer.Fprint(&receiver, fset, fn.Recv.List[0].Type)
			var body strings.Builder
			_ = printer.Fprint(&body, fset, fn.Body)
			bodies[strings.TrimPrefix(receiver.String(), "*")+"."+fn.Name.Name] = body.String()
		}
	}
	for _, service := range boundServices {
		kind := reflect.TypeOf(service)
		for i := 0; i < kind.NumMethod(); i++ {
			method := kind.Method(i)
			if method.Name == "ServiceShutdown" || method.Type.NumOut() == 0 {
				continue
			}
			result := method.Type.Out(0)
			if !hasCollection(result, map[reflect.Type]bool{}) {
				continue
			}
			key := kind.Elem().Name() + "." + method.Name
			body, ok := bodies[key]
			if !ok {
				t.Errorf("%s: тело метода не найдено", key)
				continue
			}
			if !strings.Contains(body, "wire.Fill(") && !strings.Contains(body, "wire.Done(") {
				t.Errorf("%s возвращает %s без wire.Fill/wire.Done", key, result)
			}
		}
	}
}
