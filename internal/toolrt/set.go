package toolrt

// Set — множество значений JSON: равные по == значения (1, 1.0, True) — один
// элемент, нехешируемые (список, словарь) — TypeError «нельзя использовать как ключ». Порядок добавления
// сохраняется только для перебора в тестах; вывод инструментов сортирует элементы сам.
type Set struct {
	items map[string]any
	order []string
}

// NewSet — пустое множество.
func NewSet() *Set { return &Set{items: map[string]any{}} }

// SetOf — множество из перебираемого значения (Iter): элементы списка, ключи словаря или
// символы строки.
func SetOf(value any) (*Set, error) {
	items, err := Iter(value)
	if err != nil {
		return nil, err
	}
	result := NewSet()
	for _, item := range items {
		if err := result.Add(item); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// Add — добавление элемента; равный уже имеющемуся не добавляется, нехешируемый — TypeError.
func (s *Set) Add(value any) error {
	key, err := HashKey(value)
	if err != nil {
		return err
	}
	if _, ok := s.items[key]; !ok {
		s.items[key] = value
		s.order = append(s.order, key)
	}
	return nil
}

// Has — есть ли элемент в множестве; нехешируемое значение — TypeError.
func (s *Set) Has(value any) (bool, error) {
	key, err := HashKey(value)
	if err != nil {
		return false, err
	}
	_, ok := s.items[key]
	return ok, nil
}

// Contains — Has для заведомо хешируемого значения (строки, числа).
func (s *Set) Contains(value any) bool {
	found, _ := s.Has(value)
	return found
}

// Len — число элементов.
func (s *Set) Len() int { return len(s.items) }

// Items — элементы в порядке добавления.
func (s *Set) Items() []any {
	result := make([]any, len(s.order))
	for index, key := range s.order {
		result[index] = s.items[key]
	}
	return result
}

// Equal — множества состоят из равных элементов.
func (s *Set) Equal(other *Set) bool {
	if len(s.items) != len(other.items) {
		return false
	}
	for key := range s.items {
		if _, ok := other.items[key]; !ok {
			return false
		}
	}
	return true
}

// SubsetOf — все элементы множества есть в other.
func (s *Set) SubsetOf(other *Set) bool {
	for key := range s.items {
		if _, ok := other.items[key]; !ok {
			return false
		}
	}
	return true
}

// Minus — разность множеств: элементы без имеющихся в other, в порядке добавления.
func (s *Set) Minus(other *Set) *Set {
	result := NewSet()
	for _, key := range s.order {
		if _, ok := other.items[key]; !ok {
			result.items[key] = s.items[key]
			result.order = append(result.order, key)
		}
	}
	return result
}
