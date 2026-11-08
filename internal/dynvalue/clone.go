package dynvalue

// DeepClone — глубокая копия дерева JSON: объекты и массивы копируются на всю глубину с порядком
// ключей, примитивы переносятся как есть. Нужен
// там, где черновик отделяется от прочитанного документа: правка копии не должна менять
// прочитанное дерево, которое ещё сравнивается или сохраняется. Undefined внутри массива остаётся
// Undefined, а не null; в дереве из JSON его не бывает.
func DeepClone(value any) any {
	switch item := value.(type) {
	case *Object:
		result := &Object{keys: append([]string(nil), item.keys...), values: make(map[string]any, len(item.values))}
		for key, element := range item.values {
			result.values[key] = DeepClone(element)
		}
		return result
	case *Array:
		items := make([]any, len(item.Items))
		for index, element := range item.Items {
			items[index] = DeepClone(element)
		}
		return &Array{Items: items}
	}
	return value
}
