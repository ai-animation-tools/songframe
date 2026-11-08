package lintregistry

import (
	"strings"
	"sync"

	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

// Поддерживаемое подмножество JSON Schema: type, const, enum, required, properties,
// additionalProperties, items, pattern, minimum, minItems, minLength, anyOf, $ref.
// Сравнения — по toolrt.Equal (1 == 1.0 == true), значения в текстах — в записи toolrt.Repr.
// Порядок проверок и ранний выход после неверного типа или anyOf определяют состав отчёта,
// сверяемого эталоном testdata/golden/lint-registry.

var (
	schemasOnce sync.Once
	schemas     map[string]*toolrt.Dict
	patternsMu  sync.Mutex
	patterns    = map[string]*toolregex.Regexp{}
)

// loadSchema — встроенная схема schemas/<name>.schema.json; все схемы читаются один раз.
func loadSchema(name string) *toolrt.Dict {
	schemasOnce.Do(func() {
		schemas = map[string]*toolrt.Dict{}
		for _, kind := range []string{"cast", "manifest", "request", "scenes", "workflow"} {
			data, err := schemaFiles.ReadFile("schemas/" + kind + ".schema.json")
			if err != nil {
				panic(err)
			}
			text, err := toolrt.DecodeUTF8(data)
			if err != nil {
				panic(err)
			}
			value, err := toolrt.LoadsJSON(text)
			if err != nil {
				panic(err)
			}
			schemas[kind] = value.(*toolrt.Dict)
		}
	})
	return schemas[name]
}

// validateSchema — проблемы значения по встроенной схеме name от корня «$».
func validateSchema(value any, name string) []string {
	schema := loadSchema(name)
	return validate(value, schema, schema, "$")
}

// compiled — регулярное выражение pattern схемы (toolregex) с кэшем скомпилированных шаблонов.
func compiled(pattern string) *toolregex.Regexp {
	patternsMu.Lock()
	defer patternsMu.Unlock()
	if found, ok := patterns[pattern]; ok {
		return found
	}
	result := toolregex.MustCompile(pattern, 0)
	patterns[pattern] = result
	return result
}

// resolveRef — схема по ссылке $ref «#/a/b» относительно корня схемы: начальные «#» и «/»
// отбрасываются, остальное разбирается по «/». Схема без $ref возвращается как есть.
func resolveRef(schema, root *toolrt.Dict) *toolrt.Dict {
	ref, ok := schema.Value("$ref").(string)
	if !ok {
		return schema
	}
	var node any = root
	for _, part := range strings.Split(strings.TrimLeft(ref, "#/"), "/") {
		node = node.(*toolrt.Dict).Value(part)
	}
	return node.(*toolrt.Dict)
}

// typeOK — соответствует ли значение типу JSON Schema: одно имя типа или список имён. bool не
// считается ни integer, ни number.
func typeOK(value any, expected any) bool {
	names := []any{expected}
	if list, ok := expected.([]any); ok {
		names = list
	}
	for _, name := range names {
		var hit bool
		switch name {
		case "object":
			_, hit = value.(*toolrt.Dict)
		case "array":
			_, hit = value.([]any)
		case "string":
			_, hit = value.(string)
		case "integer":
			hit = toolrt.IsExactInt(value)
		case "number":
			_, isFloat := value.(float64)
			hit = toolrt.IsExactInt(value) || isFloat
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

// schemaTypeNames — имена типов JSON Schema в тексте отчёта: те же слова, что виды значений
// toolrt.TypeName, чтобы ожидаемое и найденное читались одинаково (number — целое или дробное).
var schemaTypeNames = map[string]string{
	"object":  "объект",
	"array":   "список",
	"string":  "строка",
	"number":  "число",
	"integer": "целое число",
	"boolean": "логическое значение",
	"null":    "null",
}

// typeNames — ожидаемый тип схемы словами: одно имя или список имён через «или».
func typeNames(expected any) string {
	names := []any{expected}
	if list, ok := expected.([]any); ok {
		names = list
	}
	words := make([]string, len(names))
	for index, name := range names {
		text := toolrt.Str(name)
		if word, ok := schemaTypeNames[text]; ok {
			text = word
		}
		words[index] = text
	}
	return strings.Join(words, " или ")
}

// validate — рекурсивная проверка значения по схеме; path — JSONPath-подобный путь «$.a[0]».
func validate(value any, schemaValue *toolrt.Dict, root *toolrt.Dict, path string) []string {
	schema := resolveRef(schemaValue, root)
	errors := []string{}
	if options, ok := schema.Get("anyOf"); ok {
		all := true
		for _, option := range options.([]any) {
			if len(validate(value, option.(*toolrt.Dict), root, path)) == 0 {
				all = false
			}
		}
		if all {
			errors = append(errors, path+": не подходит ни один из допустимых вариантов")
		}
		return errors
	}
	if constant, ok := schema.Get("const"); ok && !toolrt.Equal(value, constant) {
		errors = append(errors, path+": ожидается "+toolrt.Repr(constant)+", найдено "+toolrt.Repr(value))
	}
	if enum, ok := schema.Get("enum"); ok {
		if found, _ := toolrt.Contains(enum, value); !found {
			errors = append(errors, path+": значение "+toolrt.Repr(value)+" вне допустимых "+toolrt.Str(enum))
		}
	}
	if expected, ok := schema.Get("type"); ok && !typeOK(value, expected) {
		return append(errors, path+": ожидается "+typeNames(expected)+", найдено "+toolrt.TypeName(value))
	}
	if text, ok := value.(string); ok {
		if pattern, ok := schema.Value("pattern").(string); ok {
			if _, found := compiled(pattern).Search(text); !found {
				errors = append(errors, path+": значение "+toolrt.Repr(value)+" не соответствует шаблону")
			}
		}
		if minimum, ok := schema.Get("minLength"); ok {
			if shorter, _ := toolrt.Less(toolrt.NewInt(int64(toolrt.Len(text))), minimum); shorter {
				errors = append(errors, path+": пустое значение")
			}
		}
	}
	if _, isBool := value.(bool); toolrt.IsNumber(value) && !isBool {
		if minimum, ok := schema.Get("minimum"); ok {
			if less, _ := toolrt.Less(value, minimum); less {
				errors = append(errors, path+": "+toolrt.Str(value)+" меньше "+toolrt.Str(minimum))
			}
		}
	}
	if document, ok := value.(*toolrt.Dict); ok {
		if required, ok := schema.Value("required").([]any); ok {
			for _, key := range required {
				if found, _ := toolrt.Contains(document, key); !found {
					errors = append(errors, path+": нет обязательного поля "+toolrt.Str(key))
				}
			}
		}
		properties, _ := schema.Value("properties").(*toolrt.Dict)
		additional, hasAdditional := schema.Get("additionalProperties")
		for _, key := range document.Keys() {
			item := document.Value(key)
			if properties != nil && properties.Has(key) {
				errors = append(errors, validate(item, properties.Value(key).(*toolrt.Dict), root, path+"."+key)...)
			} else if nested, ok := additional.(*toolrt.Dict); ok {
				errors = append(errors, validate(item, nested, root, path+"."+key)...)
			} else if hasAdditional && additional == false {
				errors = append(errors, path+": неизвестное поле "+key)
			}
		}
	}
	if list, ok := value.([]any); ok {
		if minimum, ok := schema.Get("minItems"); ok {
			if shorter, _ := toolrt.Less(toolrt.NewInt(int64(len(list))), minimum); shorter {
				errors = append(errors, path+": нужно не менее "+toolrt.Str(minimum)+" элементов")
			}
		}
		if items, ok := schema.Value("items").(*toolrt.Dict); ok {
			for index, element := range list {
				errors = append(errors, validate(element, items, root, path+"["+itoa(index)+"]")...)
			}
		}
	}
	return errors
}
