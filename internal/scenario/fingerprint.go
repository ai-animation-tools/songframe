package scenario

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"

	"songframe/internal/dynvalue"
)

// sortUTF16 сортирует ключи по кодовым единицам UTF-16 (dynvalue.LessUTF16).
func sortUTF16(keys []string) {
	sort.SliceStable(keys, func(i, j int) bool { return dynvalue.LessUTF16(keys[i], keys[j]) })
}

// SceneFingerprints — SHA-256 канонического JSON контекста плана — сам план, направление его
// части, общее визуальное направление и вычисленное состояние. Ключ — строковая запись id. Ошибка
// вычисления состояния делает весь реестр непригодным для сверки.
func SceneFingerprints(data any, initial *dynvalue.Object) (*dynvalue.Object, error) {
	states, err := ResolveStates(data, initial)
	if err != nil {
		return nil, err
	}
	sequenceList := dynvalue.Coalesce(dynvalue.Get(data, "sequences"), &dynvalue.Array{})
	sequences, ok := dynvalue.AsArray(sequenceList)
	if !ok {
		return nil, &dynvalue.TypeError{Message: "data.sequences: ожидается список"}
	}
	directions := newOrderedMap[any]()
	for _, sequence := range sequences {
		id, err := dynvalue.Prop(sequence, "id")
		if err != nil {
			return nil, err
		}
		directions.set(id, dynvalue.Coalesce(dynvalue.Get(sequence, "direction"), ""))
	}
	scenes, err := dynvalue.Iterate(dynvalue.Get(data, "scenes"))
	if err != nil {
		return nil, err
	}
	visual := dynvalue.Coalesce(dynvalue.Get(data, "visual_direction"), "")
	result := dynvalue.NewObject()
	for _, scene := range scenes {
		id, err := dynvalue.Prop(scene, "id")
		if err != nil {
			return nil, err
		}
		direction, found := directions.get(dynvalue.Get(scene, "sequence"))
		if !found {
			direction = ""
		}
		context := dynvalue.NewObject()
		context.Set("scene", scene)
		context.Set("sequence_direction", dynvalue.Coalesce(direction, ""))
		context.Set("visual_direction", visual)
		if state, ok := states.Get(dynvalue.ToString(id)); ok {
			context.Set("state", state)
		}
		digest := sha256.Sum256([]byte(CanonicalJSON(context)))
		result.Set(dynvalue.ToString(id), hex.EncodeToString(digest[:]))
	}
	return result, nil
}
