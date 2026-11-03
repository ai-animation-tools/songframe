// Package wire готовит ответы Wails-сервисов к TS-контракту. Контракт window.api не
// различает «нет списка» и «пустой список»: массивы и словари всегда приходят как [] и {}.
// Сгенерированные bindings после scripts/bindings.sh тоже объявляют их не-null, поэтому
// гарантию даёт только Fill на границе сервиса и тест internal/app.
package wire

import "reflect"

// Fill возвращает копию значения, в которой все достижимые nil-срезы и nil-словари
// заменены пустыми. Указатели (nullable-поля контракта) сохраняют nil; ненулевые
// указатели и вложенные структуры обходятся. Значение не должно содержать циклов.
func Fill[T any](value T) T {
	v := reflect.ValueOf(&value).Elem()
	fill(v)
	return value
}

// Done применяет Fill к результату метода сервиса, не трогая ошибку.
func Done[T any](value T, err error) (T, error) { return Fill(value), err }

func fill(v reflect.Value) {
	switch v.Kind() {
	case reflect.Pointer:
		if !v.IsNil() {
			fill(v.Elem())
		}
	case reflect.Interface:
		if !v.IsNil() {
			inner := reflect.New(v.Elem().Type()).Elem()
			inner.Set(v.Elem())
			fill(inner)
			v.Set(inner)
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).IsExported() {
				fill(v.Field(i))
			}
		}
	case reflect.Slice:
		if v.IsNil() {
			if v.CanSet() {
				v.Set(reflect.MakeSlice(v.Type(), 0, 0))
			}
			return
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return
		}
		for i := 0; i < v.Len(); i++ {
			fill(v.Index(i))
		}
	case reflect.Array:
		for i := 0; i < v.Len(); i++ {
			fill(v.Index(i))
		}
	case reflect.Map:
		if v.IsNil() {
			if v.CanSet() {
				v.Set(reflect.MakeMap(v.Type()))
			}
			return
		}
		for _, key := range v.MapKeys() {
			item := reflect.New(v.Type().Elem()).Elem()
			item.Set(v.MapIndex(key))
			fill(item)
			v.SetMapIndex(key, item)
		}
	}
}
