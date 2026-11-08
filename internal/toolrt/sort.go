package toolrt

// SortByKeys — устойчивая сортировка items по уже вычисленным ключам keys: начальный монотонный
// участок (строго убывающий разворачивается), затем бинарные вставки остальных элементов.
// Сравнения ключей — Less в фиксированной последовательности, поэтому при NaN и несравнимых типах
// порядок и TypeError детерминированы и совпадают с эталонами вывода. При полностью упорядоченных
// ключах результат не зависит от алгоритма устойчивой сортировки, так что вставки годятся и для
// длинных списков.
func SortByKeys(items, keys []any) ([]any, error) {
	n := len(items)
	values := append([]any(nil), items...)
	order := append([]any(nil), keys...)
	if n < 2 {
		return values, nil
	}
	less := func(i, j int) (bool, error) { return Less(order[i], order[j]) }
	run := 2
	descending, err := less(1, 0)
	if err != nil {
		return nil, err
	}
	for run < n {
		smaller, err := less(run, run-1)
		if err != nil {
			return nil, err
		}
		if smaller != descending {
			break
		}
		run++
	}
	if descending {
		for left, right := 0, run-1; left < right; left, right = left+1, right-1 {
			values[left], values[right] = values[right], values[left]
			order[left], order[right] = order[right], order[left]
		}
	}
	for start := run; start < n; start++ {
		pivotValue, pivotKey := values[start], order[start]
		low, high := 0, start
		for low < high {
			middle := low + (high-low)/2
			smaller, err := Less(pivotKey, order[middle])
			if err != nil {
				return nil, err
			}
			if smaller {
				high = middle
			} else {
				low = middle + 1
			}
		}
		copy(values[low+1:start+1], values[low:start])
		copy(order[low+1:start+1], order[low:start])
		values[low], order[low] = pivotValue, pivotKey
	}
	return values, nil
}
