package lintregistry

import (
	"strings"
	"sync"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
)

// Поддерживаемое подмножество JSON Schema: type, const, enum, required, properties,
// additionalProperties, items, pattern, minimum, minItems, minLength, anyOf, $ref.
// Сравнения — по правилам Python (1 == 1.0 == True), тексты — с repr значений. Порядок проверок
// и ранний выход после неверного типа или anyOf определяют состав отчёта, сверяемого эталоном
// testdata/golden/lint-registry.

var (
	schemasOnce sync.Once
	schemas     map[string]*pycompat.Dict
	patternsMu  sync.Mutex
	patterns    = map[string]*pyre.Regexp{}
)

// loadSchema — load_schema(name): встроенная схема schemas/<name>.schema.json.
func loadSchema(name string) *pycompat.Dict {
	schemasOnce.Do(func() {
		schemas = map[string]*pycompat.Dict{}
		for _, kind := range []string{"cast", "manifest", "request", "scenes", "workflow"} {
			data, err := schemaFiles.ReadFile("schemas/" + kind + ".schema.json")
			if err != nil {
				panic(err)
			}
			text, err := pycompat.DecodeUTF8(data)
			if err != nil {
				panic(err)
			}
			value, err := pycompat.LoadsJSON(text)
			if err != nil {
				panic(err)
			}
			schemas[kind] = value.(*pycompat.Dict)
		}
	})
	return schemas[name]
}

// validateSchema — validate(value, load_schema(name)).
func validateSchema(value any, name string) []string {
	schema := loadSchema(name)
	return validate(value, schema, schema, "$")
}

// compiled — re.search(pattern) с кэшем скомпилированных шаблонов схем.
func compiled(pattern string) *pyre.Regexp {
	patternsMu.Lock()
	defer patternsMu.Unlock()
	if found, ok := patterns[pattern]; ok {
		return found
	}
	result := pyre.MustCompile(pattern, 0)
	patterns[pattern] = result
	return result
}

// resolveRef — resolve_ref: «#/a/b» относительно корня схемы (lstrip("#/") и разбор по «/»).
func resolveRef(schema, root *pycompat.Dict) *pycompat.Dict {
	ref, ok := schema.Value("$ref").(string)
	if !ok {
		return schema
	}
	var node any = root
	for _, part := range strings.Split(strings.TrimLeft(ref, "#/"), "/") {
		node = node.(*pycompat.Dict).Value(part)
	}
	return node.(*pycompat.Dict)
}

// typeOK — type_ok(value, expected): одно имя типа или список имён.
func typeOK(value any, expected any) bool {
	names := []any{expected}
	if list, ok := expected.([]any); ok {
		names = list
	}
	for _, name := range names {
		var hit bool
		switch name {
		case "object":
			_, hit = value.(*pycompat.Dict)
		case "array":
			_, hit = value.([]any)
		case "string":
			_, hit = value.(string)
		case "integer":
			hit = pycompat.IsExactInt(value)
		case "number":
			_, isFloat := value.(float64)
			hit = pycompat.IsExactInt(value) || isFloat
		case "boolean":
			_, hit = value.(bool)
		case "null":
			hit = value == nil
		}
		if hit {
			return true
		}
	}
	return false
}

// validate — рекурсивная проверка значения по схеме; path — JSONPath-подобный путь «$.a[0]».
func validate(value any, schemaValue *pycompat.Dict, root *pycompat.Dict, path string) []string {
	schema := resolveRef(schemaValue, root)
	errors := []string{}
	if options, ok := schema.Get("anyOf"); ok {
		all := true
		for _, option := range options.([]any) {
			if len(validate(value, option.(*pycompat.Dict), root, path)) == 0 {
				all = false
			}
		}
		if all {
			errors = append(errors, path+": не подходит ни один из допустимых вариантов")
		}
		return errors
	}
	if constant, ok := schema.Get("const"); ok && !pycompat.Equal(value, constant) {
		errors = append(errors, path+": ожидается "+pycompat.Repr(constant)+", найдено "+pycompat.Repr(value))
	}
	if enum, ok := schema.Get("enum"); ok {
		if found, _ := pycompat.Contains(enum, value); !found {
			errors = append(errors, path+": значение "+pycompat.Repr(value)+" вне допустимых "+pycompat.Str(enum))
		}
	}
	if expected, ok := schema.Get("type"); ok && !typeOK(value, expected) {
		return append(errors, path+": ожидается тип "+pycompat.Str(expected)+", найдено "+pycompat.TypeName(value))
	}
	if text, ok := value.(string); ok {
		if pattern, ok := schema.Value("pattern").(string); ok {
			if _, found := compiled(pattern).Search(text); !found {
				errors = append(errors, path+": значение "+pycompat.Repr(value)+" не соответствует шаблону")
			}
		}
		if minimum, ok := schema.Get("minLength"); ok {
			if shorter, _ := pycompat.Less(pycompat.NewInt(int64(pycompat.Len(text))), minimum); shorter {
				errors = append(errors, path+": пустое значение")
			}
		}
	}
	if _, isBool := value.(bool); pycompat.IsNumber(value) && !isBool {
		if minimum, ok := schema.Get("minimum"); ok {
			if less, _ := pycompat.Less(value, minimum); less {
				errors = append(errors, path+": "+pycompat.Str(value)+" меньше "+pycompat.Str(minimum))
			}
		}
	}
	if document, ok := value.(*pycompat.Dict); ok {
		if required, ok := schema.Value("required").([]any); ok {
			for _, key := range required {
				if found, _ := pycompat.Contains(document, key); !found {
					errors = append(errors, path+": нет обязательного поля "+pycompat.Str(key))
				}
			}
		}
		properties, _ := schema.Value("properties").(*pycompat.Dict)
		additional, hasAdditional := schema.Get("additionalProperties")
		for _, key := range document.Keys() {
			item := document.Value(key)
			if properties != nil && properties.Has(key) {
				errors = append(errors, validate(item, properties.Value(key).(*pycompat.Dict), root, path+"."+key)...)
			} else if nested, ok := additional.(*pycompat.Dict); ok {
				errors = append(errors, validate(item, nested, root, path+"."+key)...)
			} else if hasAdditional && additional == false {
				errors = append(errors, path+": неизвестное поле "+key)
			}
		}
	}
	if list, ok := value.([]any); ok {
		if minimum, ok := schema.Get("minItems"); ok {
			if shorter, _ := pycompat.Less(pycompat.NewInt(int64(len(list))), minimum); shorter {
				errors = append(errors, path+": нужно не менее "+pycompat.Str(minimum)+" элементов")
			}
		}
		if items, ok := schema.Value("items").(*pycompat.Dict); ok {
			for index, element := range list {
				errors = append(errors, validate(element, items, root, path+"["+itoa(index)+"]")...)
			}
		}
	}
	return errors
}
