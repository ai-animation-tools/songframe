package sceneregistry

import (
	"path/filepath"
	"strings"

	"songframe/internal/castregistry"
	"songframe/internal/toolrt"
)

// keyed — словарь по коду плана с ключами любого хешируемого значения toolrt: порядок первого
// появления ключа, значение — последнее.
type keyed struct {
	order  []any
	index  map[string]int
	values []any
}

func newKeyed() *keyed { return &keyed{index: map[string]int{}} }

// set — запись значения по ключу; нехешируемый ключ — TypeError.
func (k *keyed) set(key, value any) error {
	hash, err := toolrt.HashKey(key)
	if err != nil {
		return err
	}
	if position, ok := k.index[hash]; ok {
		k.values[position] = value
		return nil
	}
	k.index[hash] = len(k.order)
	k.order = append(k.order, key)
	k.values = append(k.values, value)
	return nil
}

// get — значение по ключу: (значение, есть ли ключ); нехешируемый ключ — TypeError.
func (k *keyed) get(key any) (any, bool, error) {
	hash, err := toolrt.HashKey(key)
	if err != nil {
		return nil, false, err
	}
	position, ok := k.index[hash]
	if !ok {
		return nil, false, nil
	}
	return k.values[position], true, nil
}

// InitialStatesFor — начальное состояние сущностей из plan/cast.json
// проекта; без кастинга или при ValueError чтения кастинга — пустое. Прочие исключения чтения
// (TypeError на данных неожиданной формы) передаются вызывающему.
func InitialStatesFor(root string) (*toolrt.Dict, error) {
	cast, err := castregistry.Load(root)
	if err != nil {
		if toolrt.Is(err, toolrt.ValueError) {
			return toolrt.NewDict(), nil
		}
		return nil, err
	}
	return castregistry.InitialStates(cast), nil
}

// DerivedFormat — текст неверной формы derived_from.
const DerivedFormat = `derived_from должен быть объектом {"shot": "Mxx"}.`

// DerivedProblem — нарушение derived_from: код плана (значение реестра, обычно строка) и текст.
type DerivedProblem struct {
	Shot    any
	Message string
}

// DerivedFromProblems — нарушения необязательного derived_from.
// Производный план собирается из материала одного исходного плана: цепочки запрещены, чтобы монтаж
// и представления всегда указывали план с собственной генерацией. Не-словари в списке пропускаются.
func DerivedFromProblems(scenes any) ([]DerivedProblem, error) {
	items, err := toolrt.Iter(scenes)
	if err != nil {
		return nil, err
	}
	byID := newKeyed()
	for _, item := range items {
		if scene, ok := item.(*toolrt.Dict); ok {
			if err := byID.set(scene.Value("id"), scene); err != nil {
				return nil, err
			}
		}
	}
	problems := []DerivedProblem{}
	for position, sid := range byID.order {
		scene := byID.values[position].(*toolrt.Dict)
		value, ok := scene.Get("derived_from")
		if !ok {
			continue
		}
		var source any
		if link, isDict := value.(*toolrt.Dict); isDict && link.Len() == 1 && link.Has("shot") {
			source = link.Value("shot")
		}
		text, isString := source.(string)
		switch {
		case !isString || !ShotID.MatchString(text):
			problems = append(problems, DerivedProblem{sid, DerivedFormat})
		case toolrt.Equal(source, sid):
			problems = append(problems, DerivedProblem{sid, "derived_from не может ссылаться на сам план."})
		default:
			target, found, _ := byID.get(source)
			switch {
			case !found:
				problems = append(problems, DerivedProblem{sid, "derived_from ссылается на неизвестный план " + text + "."})
			case target.(*toolrt.Dict).Has("derived_from"):
				problems = append(problems, DerivedProblem{sid, "источник " + text + " сам собирается из другого плана; укажите исходный план."})
			}
		}
	}
	return problems, nil
}

// Validate — проверка реестра: кадровые границы планов проверяются до чтения медиа (схема 1,
// 30 кадров/с, непрерывная шкала без повторов кодов, известные части и референсы, монтажный конец
// равен концу песни с точностью до кадра), затем derived_from и сюжетные состояния (ResolveStates).
// initial — начальное состояние сущностей (InitialStatesFor проекта; nil — пустое). Возвращает тот
// же документ; первая найденная проблема — ValueError.
func Validate(data any, initial *toolrt.Dict) (*toolrt.Dict, error) {
	schema, err := toolrt.DictGet(data, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	document := data.(*toolrt.Dict)
	if !toolrt.Equal(schema, toolrt.NewInt(1)) || !toolrt.Equal(document.Value("fps"), toolrt.NewInt(30)) || !toolrt.Truthy(document.Value("scenes")) {
		return nil, valueError("Неизвестная схема или пустой реестр сцен.")
	}
	seen := map[string]bool{}
	end := toolrt.NewInt(0)
	sequenceList, _ := toolrt.DictGet(document, "sequences", []any{})
	sequences, err := toolrt.Iter(sequenceList)
	if err != nil {
		return nil, err
	}
	groups := map[string]bool{}
	for _, sequence := range sequences {
		id, err := toolrt.GetItem(sequence, "id")
		if err != nil {
			return nil, err
		}
		hash, err := toolrt.HashKey(id)
		if err != nil {
			return nil, err
		}
		groups[hash] = true
	}
	scenes, err := toolrt.Iter(document.Value("scenes"))
	if err != nil {
		return nil, err
	}
	for _, scene := range scenes {
		if err := validateWindow(document, scene, seen, groups, &end); err != nil {
			return nil, err
		}
	}
	if err := checkEnd(document, end); err != nil {
		return nil, err
	}
	problems, err := DerivedFromProblems(document.Value("scenes"))
	if err != nil {
		return nil, err
	}
	if len(problems) > 0 {
		return nil, valueError("%s: %s", toolrt.Str(problems[0].Shot), problems[0].Message)
	}
	if _, err := ResolveStates(document, initial); err != nil {
		return nil, err
	}
	return document, nil
}

// validateWindow — проверка одного плана для Validate. Порядок условий зафиксирован эталонами:
// короткое замыкание условий определяет, какое исключение возникнет на неполных данных.
func validateWindow(document *toolrt.Dict, scene any, seen, groups map[string]bool, end *toolrt.Int) error {
	sid, err := toolrt.GetItem(scene, "id")
	if err != nil {
		return err
	}
	matched, err := fullmatch(ShotID, sid)
	if err != nil {
		return err
	}
	broken := func() error {
		return valueError("%s: повтор, разрыв или неверная граница сцены.", toolrt.Str(sid))
	}
	if !matched || seen[sid.(string)] {
		return broken()
	}
	start, err := toolrt.GetItem(scene, "start_frame")
	if err != nil {
		return err
	}
	if !toolrt.IsExactInt(start) {
		return broken()
	}
	finish, err := toolrt.GetItem(scene, "end_frame_exclusive")
	if err != nil {
		return err
	}
	if !toolrt.IsExactInt(finish) || !toolrt.Equal(start, *end) {
		return broken()
	}
	if later, _ := toolrt.LessEqual(finish, *end); later {
		return broken()
	}
	sequence, err := toolrt.GetItem(scene, "sequence")
	if err != nil {
		return err
	}
	hash, err := toolrt.HashKey(sequence)
	if err != nil {
		return err
	}
	if !groups[hash] {
		return broken()
	}
	referenceList, err := toolrt.GetItem(scene, "references")
	if err != nil {
		return err
	}
	references, err := toolrt.Iter(referenceList)
	if err != nil {
		return err
	}
	for _, reference := range references {
		if toolrt.Equal(reference, "—") {
			continue
		}
		known, err := toolrt.GetItem(document, "references")
		if err != nil {
			return err
		}
		found, err := toolrt.Contains(known, reference)
		if err != nil {
			return err
		}
		if !found {
			return valueError("%s: неизвестный референс.", sid.(string))
		}
	}
	seen[sid.(string)] = true
	*end = finish.(toolrt.Int)
	return nil
}

// checkEnd — монтажный конец: |end/fps − end_seconds| < 1/fps в десятичной арифметике toolrt
// (28 значащих цифр).
func checkEnd(document *toolrt.Dict, end toolrt.Int) error {
	fps, err := toolrt.GetItem(document, "fps")
	if err != nil {
		return err
	}
	divisor, err := toolrt.DecimalOperand(fps, "/")
	if err != nil {
		return err
	}
	frames, _ := toolrt.NewDecimal(end)
	edit, err := frames.Div(divisor)
	if err != nil {
		return err
	}
	audio, err := toolrt.GetItem(document, "audio")
	if err != nil {
		return err
	}
	seconds, err := toolrt.GetItem(audio, "end_seconds")
	if err != nil {
		return err
	}
	song, err := toolrt.NewDecimal(seconds)
	if err != nil {
		return err
	}
	difference, err := edit.Sub(song)
	if err != nil {
		return err
	}
	frame, err := toolrt.DecimalInt(1).Div(divisor)
	if err != nil {
		return err
	}
	order, err := difference.Abs().Cmp(frame)
	if err != nil {
		return err
	}
	if order >= 0 {
		return valueError("Монтажный конец расходится с концом песни.")
	}
	return nil
}

// Load — plan/scenes.json, проверенный Validate с начальным состоянием кастинга
// проекта. Ошибки чтения и разбора — OSError, UnicodeDecodeError или JSONDecodeError toolrt.
func Load(root string) (*toolrt.Dict, error) {
	value, err := toolrt.LoadJSONFile(filepath.Join(root, filepath.FromSlash(ScenesPath)))
	if err != nil {
		return nil, err
	}
	initial, err := InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	return Validate(value, initial)
}

// joinShots — коды цепочки state_from через « → ».
func joinShots(chain []any) string {
	parts := make([]string, len(chain))
	for index, item := range chain {
		parts[index] = toolrt.Str(item)
	}
	return strings.Join(parts, " → ")
}
