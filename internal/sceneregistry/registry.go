package sceneregistry

import (
	"path/filepath"
	"strings"

	"songframe-go/internal/castregistry"
	"songframe-go/internal/pycompat"
)

// keyed — словарь Python с ключами любого хешируемого типа (dict-comprehension по id планов):
// порядок первого появления ключа, значение — последнее, как у dict.
type keyed struct {
	order  []any
	index  map[string]int
	values []any
}

func newKeyed() *keyed { return &keyed{index: map[string]int{}} }

// set — d[key] = value.
func (k *keyed) set(key, value any) error {
	hash, err := pycompat.HashKey(key)
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

// get — d.get(key): (значение, есть ли ключ); нехешируемый ключ — TypeError.
func (k *keyed) get(key any) (any, bool, error) {
	hash, err := pycompat.HashKey(key)
	if err != nil {
		return nil, false, err
	}
	position, ok := k.index[hash]
	if !ok {
		return nil, false, nil
	}
	return k.values[position], true, nil
}

// InitialStatesFor — initial_states_for(root): начальное состояние сущностей из plan/cast.json
// проекта; без кастинга или при ValueError чтения кастинга — пустое. Прочие исключения чтения
// (TypeError на данных неожиданной формы) передаются вызывающему, как в оригинале.
func InitialStatesFor(root string) (*pycompat.Dict, error) {
	cast, err := castregistry.Load(root)
	if err != nil {
		if pycompat.Is(err, pycompat.ValueError) {
			return pycompat.NewDict(), nil
		}
		return nil, err
	}
	return castregistry.InitialStates(cast), nil
}

// DerivedFormat — DERIVED_FORMAT: текст неверной формы derived_from.
const DerivedFormat = `derived_from должен быть объектом {"shot": "Mxx"}.`

// DerivedProblem — нарушение derived_from: код плана (значение Python, обычно строка) и текст.
type DerivedProblem struct {
	Shot    any
	Message string
}

// DerivedFromProblems — derived_from_problems(scenes): нарушения необязательного derived_from.
// Производный план собирается из материала одного исходного плана: цепочки запрещены, чтобы монтаж
// и представления всегда указывали план с собственной генерацией. Не-словари в списке пропускаются.
func DerivedFromProblems(scenes any) ([]DerivedProblem, error) {
	items, err := pycompat.Iter(scenes)
	if err != nil {
		return nil, err
	}
	byID := newKeyed()
	for _, item := range items {
		if scene, ok := item.(*pycompat.Dict); ok {
			if err := byID.set(scene.Value("id"), scene); err != nil {
				return nil, err
			}
		}
	}
	problems := []DerivedProblem{}
	for position, sid := range byID.order {
		scene := byID.values[position].(*pycompat.Dict)
		value, ok := scene.Get("derived_from")
		if !ok {
			continue
		}
		var source any
		if link, isDict := value.(*pycompat.Dict); isDict && link.Len() == 1 && link.Has("shot") {
			source = link.Value("shot")
		}
		text, isString := source.(string)
		switch {
		case !isString || !ShotID.MatchString(text):
			problems = append(problems, DerivedProblem{sid, DerivedFormat})
		case pycompat.Equal(source, sid):
			problems = append(problems, DerivedProblem{sid, "derived_from не может ссылаться на сам план."})
		default:
			target, found, _ := byID.get(source)
			switch {
			case !found:
				problems = append(problems, DerivedProblem{sid, "derived_from ссылается на неизвестный план " + text + "."})
			case target.(*pycompat.Dict).Has("derived_from"):
				problems = append(problems, DerivedProblem{sid, "источник " + text + " сам собирается из другого плана; укажите исходный план."})
			}
		}
	}
	return problems, nil
}

// Validate — validate(data, initial): кадровые границы планов проверяются до чтения медиа (схема 1,
// 30 кадров/с, непрерывная шкала без повторов кодов, известные части и референсы, монтажный конец
// равен концу песни с точностью до кадра), затем derived_from и сюжетные состояния (ResolveStates).
// initial — начальное состояние сущностей (InitialStatesFor проекта; nil — пустое). Возвращает тот
// же документ; первая найденная проблема — ValueError.
func Validate(data any, initial *pycompat.Dict) (*pycompat.Dict, error) {
	schema, err := pycompat.DictGet(data, "schema_version", nil)
	if err != nil {
		return nil, err
	}
	document := data.(*pycompat.Dict)
	if !pycompat.Equal(schema, pycompat.NewInt(1)) || !pycompat.Equal(document.Value("fps"), pycompat.NewInt(30)) || !pycompat.Truthy(document.Value("scenes")) {
		return nil, valueError("Неизвестная схема или пустой реестр сцен.")
	}
	seen := map[string]bool{}
	end := pycompat.NewInt(0)
	sequenceList, _ := pycompat.DictGet(document, "sequences", []any{})
	sequences, err := pycompat.Iter(sequenceList)
	if err != nil {
		return nil, err
	}
	groups := map[string]bool{}
	for _, sequence := range sequences {
		id, err := pycompat.GetItem(sequence, "id")
		if err != nil {
			return nil, err
		}
		hash, err := pycompat.HashKey(id)
		if err != nil {
			return nil, err
		}
		groups[hash] = true
	}
	scenes, err := pycompat.Iter(document.Value("scenes"))
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
		return nil, valueError("%s: %s", pycompat.Str(problems[0].Shot), problems[0].Message)
	}
	if _, err := ResolveStates(document, initial); err != nil {
		return nil, err
	}
	return document, nil
}

// validateWindow — проверка одного плана validate: условия в порядке оригинала (короткое замыкание
// `or` определяет, какое исключение возникнет на неполных данных).
func validateWindow(document *pycompat.Dict, scene any, seen, groups map[string]bool, end *pycompat.Int) error {
	sid, err := pycompat.GetItem(scene, "id")
	if err != nil {
		return err
	}
	matched, err := fullmatch(ShotID, sid)
	if err != nil {
		return err
	}
	broken := func() error {
		return valueError("%s: повтор, разрыв или неверная граница сцены.", pycompat.Str(sid))
	}
	if !matched || seen[sid.(string)] {
		return broken()
	}
	start, err := pycompat.GetItem(scene, "start_frame")
	if err != nil {
		return err
	}
	if !pycompat.IsExactInt(start) {
		return broken()
	}
	finish, err := pycompat.GetItem(scene, "end_frame_exclusive")
	if err != nil {
		return err
	}
	if !pycompat.IsExactInt(finish) || !pycompat.Equal(start, *end) {
		return broken()
	}
	if later, _ := pycompat.LessEqual(finish, *end); later {
		return broken()
	}
	sequence, err := pycompat.GetItem(scene, "sequence")
	if err != nil {
		return err
	}
	hash, err := pycompat.HashKey(sequence)
	if err != nil {
		return err
	}
	if !groups[hash] {
		return broken()
	}
	referenceList, err := pycompat.GetItem(scene, "references")
	if err != nil {
		return err
	}
	references, err := pycompat.Iter(referenceList)
	if err != nil {
		return err
	}
	for _, reference := range references {
		if pycompat.Equal(reference, "—") {
			continue
		}
		known, err := pycompat.GetItem(document, "references")
		if err != nil {
			return err
		}
		found, err := pycompat.Contains(known, reference)
		if err != nil {
			return err
		}
		if !found {
			return valueError("%s: неизвестный референс.", sid.(string))
		}
	}
	seen[sid.(string)] = true
	*end = finish.(pycompat.Int)
	return nil
}

// checkEnd — монтажный конец: |end/fps − end_seconds| < 1/fps в Decimal (28 значащих цифр).
func checkEnd(document *pycompat.Dict, end pycompat.Int) error {
	fps, err := pycompat.GetItem(document, "fps")
	if err != nil {
		return err
	}
	divisor, err := pycompat.DecimalOperand(fps, "/")
	if err != nil {
		return err
	}
	frames, _ := pycompat.NewDecimal(end)
	edit, err := frames.Div(divisor)
	if err != nil {
		return err
	}
	audio, err := pycompat.GetItem(document, "audio")
	if err != nil {
		return err
	}
	seconds, err := pycompat.GetItem(audio, "end_seconds")
	if err != nil {
		return err
	}
	song, err := pycompat.NewDecimal(seconds)
	if err != nil {
		return err
	}
	difference, err := edit.Sub(song)
	if err != nil {
		return err
	}
	frame, err := pycompat.DecimalInt(1).Div(divisor)
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

// Load — load(root): plan/scenes.json, проверенный Validate с начальным состоянием кастинга
// проекта. Ошибки чтения и разбора — OSError, UnicodeDecodeError или JSONDecodeError Python.
func Load(root string) (*pycompat.Dict, error) {
	value, err := pycompat.LoadJSONFile(filepath.Join(root, filepath.FromSlash(ScenesPath)))
	if err != nil {
		return nil, err
	}
	initial, err := InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	return Validate(value, initial)
}

// joinShots — " → ".join(chain) цепочки state_from.
func joinShots(chain []any) string {
	parts := make([]string, len(chain))
	for index, item := range chain {
		parts[index] = pycompat.Str(item)
	}
	return strings.Join(parts, " → ")
}
