package scenario

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"

	"songframe-go/internal/jscompat"
)

// sortUTF16 сортирует ключи как `a < b` в JS: по кодовым единицам UTF-16.
func sortUTF16(keys []string) {
	sort.SliceStable(keys, func(i, j int) bool { return jscompat.LessUTF16(keys[i], keys[j]) })
}

// SceneFingerprints — sceneFingerprints: SHA-256 канонического JSON контекста плана — сам план,
// направление его части, общее визуальное направление и вычисленное состояние. Ключ — String(id).
// Ошибка вычисления состояния делает весь реестр непригодным для сверки (как исключение оригинала).
func SceneFingerprints(data any, initial *jscompat.Object) (*jscompat.Object, error) {
	states, err := ResolveStates(data, initial)
	if err != nil {
		return nil, err
	}
	sequenceList := jscompat.Coalesce(jscompat.Get(data, "sequences"), &jscompat.Array{})
	sequences, ok := jscompat.AsArray(sequenceList)
	if !ok {
		return nil, &jscompat.TypeError{Message: "(data.sequences ?? []).map is not a function"}
	}
	directions := newOrderedMap[any]()
	for _, sequence := range sequences {
		id, err := jscompat.Prop(sequence, "id")
		if err != nil {
			return nil, err
		}
		directions.set(id, jscompat.Coalesce(jscompat.Get(sequence, "direction"), ""))
	}
	scenes, err := jscompat.Iterate(jscompat.Get(data, "scenes"))
	if err != nil {
		return nil, err
	}
	visual := jscompat.Coalesce(jscompat.Get(data, "visual_direction"), "")
	result := jscompat.NewObject()
	for _, scene := range scenes {
		id, err := jscompat.Prop(scene, "id")
		if err != nil {
			return nil, err
		}
		direction, found := directions.get(jscompat.Get(scene, "sequence"))
		if !found {
			direction = ""
		}
		context := jscompat.NewObject()
		context.Set("scene", scene)
		context.Set("sequence_direction", jscompat.Coalesce(direction, ""))
		context.Set("visual_direction", visual)
		if state, ok := states.Get(jscompat.ToString(id)); ok {
			context.Set("state", state)
		}
		digest := sha256.Sum256([]byte(CanonicalJSON(context)))
		result.Set(jscompat.ToString(id), hex.EncodeToString(digest[:]))
	}
	return result, nil
}
