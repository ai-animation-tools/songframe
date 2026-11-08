package sceneregistry_test

import (
	"os"
	"path/filepath"
	"sort"
	"testing"

	"songframe-go/internal/castregistry"
	"songframe-go/internal/golden"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/sceneregistry"
)

// Эталоны scene-registry: cases.json — чистые функции на синтетических данных, каталоги случаев —
// функции, читающие проект. Каждый исход — строка json.dumps результата или {type, message}
// исключения; пакет должен давать те же значения, порядок ключей и тексты.

// item — поле объекта эталона.
func item(value any, key string) any { return value.(*pycompat.Dict).Value(key) }

// TestRegistryCasesGolden — чистые функции на cases.json.
func TestRegistryCasesGolden(t *testing.T) {
	cases, ok := golden.PyFile(t, "scene-registry", "cases.json").([]any)
	if !ok || len(cases) == 0 {
		t.Fatal("scene-registry/cases.json: нет случаев")
	}
	for _, entry := range cases {
		name := golden.PyString(t, entry, "name")
		call := golden.PyString(t, entry, "call")
		args := item(entry, "args").(*pycompat.Dict)
		expected := item(entry, "expected").(*pycompat.Dict)
		t.Run(name, func(t *testing.T) {
			arg := func(key string) string { return golden.PyString(t, args, key) }
			switch call {
			case "registry":
				checkRegistry(t, args, expected)
			case "project":
				data := func() any { return golden.PyParse(t, arg("data")) }
				validate := func(generation bool) func() (any, error) {
					return func() (any, error) { return sceneregistry.ValidateProject(data(), generation) }
				}
				outcomes := map[string]func() (any, error){
					"validate":      validate(true),
					"validateLoose": validate(false),
					"video":         func() (any, error) { return sceneregistry.GenerationSettings(data(), "video") },
					"image":         func() (any, error) { return sceneregistry.GenerationSettings(data(), "image") },
					"other":         func() (any, error) { return sceneregistry.GenerationSettings(data(), "audio") },
				}
				checkOutcomes(t, expected, outcomes)
			case "status":
				updates := golden.PyDict(t, arg("updates"))
				clear := args.Value("clear") == true
				with := func() (*pycompat.Dict, error) {
					return sceneregistry.WithAcceptedFingerprints(golden.PyDict(t, arg("status")), updates, clear)
				}
				checkOutcomes(t, expected, map[string]func() (any, error){
					"accepted": func() (any, error) { return sceneregistry.AcceptedFingerprints(golden.PyDict(t, arg("status"))) },
					"with":     func() (any, error) { return with() },
					"withBytes": func() (any, error) {
						value, err := with()
						if err != nil {
							return nil, err
						}
						data, err := pycompat.EncodeIndented(value)
						return string(data), err
					},
				})
			case "seconds":
				value, err := sceneregistry.Seconds(golden.PyParse(t, arg("value")), pycompat.NewInt(30))
				golden.AssertOutcome(t, "seconds", expected.Value("seconds"), value, err, "")
			case "clock":
				value, err := sceneregistry.Clock(golden.PyParse(t, arg("value")))
				golden.AssertOutcome(t, "clock", expected.Value("clock"), value, err, "")
			case "acceptance":
				checkAcceptance(t, args, expected)
			default:
				t.Fatalf("неизвестный вызов %s", call)
			}
		})
	}
}

// checkOutcomes вызывает функции эталона в порядке ключей и сверяет каждый исход.
func checkOutcomes(t *testing.T, expected *pycompat.Dict, outcomes map[string]func() (any, error)) {
	t.Helper()
	keys := make([]string, 0, len(outcomes))
	for key := range outcomes {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		want, ok := expected.Get(key)
		if !ok {
			t.Fatalf("в эталоне нет исхода %s", key)
		}
		value, err := outcomes[key]()
		golden.AssertOutcome(t, key, want, value, err, "")
	}
}

// checkRegistry — validate, scene_fingerprints, _resolve_states, derived_from_problems, shots и
// по каждому коду плана scene_state и scene_fingerprint. Каждый вызов получает свою копию
// реестра: функции не должны видеть изменений друг друга.
func checkRegistry(t *testing.T, args, expected *pycompat.Dict) {
	t.Helper()
	data := func() any { return golden.PyParse(t, golden.PyString(t, args, "data")) }
	var initial *pycompat.Dict
	if text, ok := args.Value("initial").(string); ok {
		initial = golden.PyDict(t, text)
	}
	outcomes := map[string]func() (any, error){
		"validate": func() (any, error) {
			_, err := sceneregistry.Validate(data(), initial)
			return "ok", err
		},
		"fingerprints": func() (any, error) { return sceneregistry.SceneFingerprints(data(), initial) },
		"states":       func() (any, error) { return sceneregistry.ResolveStates(data(), initial) },
		"derived": func() (any, error) {
			scenes, err := pycompat.Item(data(), "scenes")
			if err != nil {
				return nil, err
			}
			problems, err := sceneregistry.DerivedFromProblems(scenes)
			result := []any{}
			for _, problem := range problems {
				result = append(result, []any{problem.Shot, problem.Message})
			}
			return result, err
		},
	}
	if expected.Has("shots") {
		outcomes["shots"] = func() (any, error) {
			shots, err := sceneregistry.Shots(data(), nil)
			result := []any{}
			for _, shot := range shots {
				result = append(result, shot)
			}
			return result, err
		}
	}
	for _, key := range []string{"state", "fingerprint"} {
		perShot := expected.Value(key).(*pycompat.Dict)
		for _, sid := range perShot.Keys() {
			sid, key := sid, key
			want := perShot.Value(sid)
			t.Run(key+" "+sid, func(t *testing.T) {
				var value any
				var err error
				if key == "state" {
					value, err = sceneregistry.SceneState(data(), sid, initial)
				} else {
					value, err = sceneregistry.SceneFingerprint(data(), sid, initial)
				}
				golden.AssertOutcome(t, key, want, value, err, "")
			})
		}
	}
	stripped := expected.Clone()
	stripped.Delete("state")
	stripped.Delete("fingerprint")
	checkOutcomes(t, stripped, outcomes)
}

// snapshots — функция снимка по словарю эталона {Mxx: sha}; JSON null — функции нет.
func snapshots(t *testing.T, text string) sceneregistry.Snapshot {
	values := golden.PyDict(t, text)
	if values == nil {
		return nil
	}
	return func(shot string) (string, bool) {
		value, ok := values.Value(shot).(string)
		return value, ok
	}
}

// checkAcceptance — shot_acceptance с результатом и словарём причин.
func checkAcceptance(t *testing.T, args, expected *pycompat.Dict) {
	t.Helper()
	arg := func(key string) string { return golden.PyString(t, args, key) }
	result, err := sceneregistry.ShotAcceptance(golden.PyParse(t, arg("data")), sceneregistry.AcceptanceInput{
		Kits:             golden.PyDict(t, arg("kits")),
		Accepted:         golden.PyDict(t, arg("accepted")),
		Initial:          golden.PyDict(t, arg("initial")),
		SourceSnapshot:   snapshots(t, arg("sourceSnapshots")),
		SourceReviews:    golden.PyDict(t, arg("reviews")),
		AcceptedSnapshot: snapshots(t, arg("acceptedSnapshots")),
	})
	if expected.Has("error") {
		golden.AssertOutcome(t, "acceptance", expected, nil, err, "")
		return
	}
	wrap := func(key string) *pycompat.Dict {
		outcome := pycompat.NewDict()
		outcome.Set("result", expected.Value(key))
		return outcome
	}
	golden.AssertOutcome(t, "result", wrap("result"), result.States, err, "")
	golden.AssertOutcome(t, "reasons", wrap("reasons"), result.Reasons, err, "")
}

// TestRegistryProjectsGolden — функции, читающие проект: кастинг, plan/project.json, файл
// принятия, load, project_shot_acceptance, снимки роликов и запись принятых отпечатков.
func TestRegistryProjectsGolden(t *testing.T) {
	for _, c := range golden.Load(t, "scene-registry") {
		t.Run(c.Name, func(t *testing.T) {
			root := c.CopyProject(t)
			expected := c.PyRead(t, "expected.json")
			check := func(key string, value any, err error) {
				t.Helper()
				golden.AssertOutcome(t, key, expected.Value(key), value, err, root)
			}
			cast, err := castregistry.Load(root)
			check("load_cast", cast, err)
			initial, err := sceneregistry.InitialStatesFor(root)
			check("initial_states_for", initial, err)
			project, err := sceneregistry.LoadProject(root, false)
			check("load_project", project, err)
			project, err = sceneregistry.LoadProject(root, true)
			check("load_project_generation", project, err)
			status, err := sceneregistry.ReadProductionStatus(root)
			check("read_production_status", status, err)
			loaded, err := sceneregistry.Load(root)
			var fingerprints *pycompat.Dict
			if err == nil {
				fingerprints, err = sceneregistry.SceneFingerprints(loaded, initial)
			}
			check("load", fingerprints, err)
			var acceptance any
			result, err := sceneregistry.ProjectShotAcceptance(root, nil)
			if err == nil {
				outcome := pycompat.NewDict()
				outcome.Set("result", result.States)
				outcome.Set("reasons", result.Reasons)
				acceptance = outcome
			}
			check("project_shot_acceptance", acceptance, err)
			checkSnapshots(t, root, golden.PyString(t, expected, "source_video_snapshot"))
			if write := c.PyRead(t, "case.json").Value("write"); write != nil {
				checkWrite(t, c, root, write.(*pycompat.Dict), expected)
			}
		})
	}
}

// checkSnapshots — source_video_snapshot для каждого комплекта assets/shots и отсутствующего M99,
// без и с allow_derived.
func checkSnapshots(t *testing.T, root, want string) {
	t.Helper()
	names := []string{}
	if entries, err := os.ReadDir(filepath.Join(root, "assets", "shots")); err == nil {
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	got := pycompat.NewDict()
	for _, name := range append(names, "M99") {
		pair := []any{}
		for _, derived := range []bool{false, true} {
			if sha, ok := sceneregistry.SourceVideoSnapshot(root, name, derived); ok {
				pair = append(pair, sha)
			} else {
				pair = append(pair, nil)
			}
		}
		got.Set(name, pair)
	}
	text, err := pycompat.DumpsJSON(got, pycompat.DumpOptions{})
	if err != nil || text != want {
		t.Errorf("source_video_snapshot:\n  ожидалось %s\n  получено  %s (%v)", want, text, err)
	}
}

// checkWrite — write_accepted_fingerprints: исход и байты plan/production-status.json.
func checkWrite(t *testing.T, c golden.Case, root string, write, expected *pycompat.Dict) {
	t.Helper()
	path := filepath.Join(root, "plan", "production-status.json")
	before, _ := os.ReadFile(path)
	err := sceneregistry.WriteAcceptedFingerprints(root, write.Value("updates").(*pycompat.Dict), write.Value("clear") == true)
	golden.AssertOutcome(t, "write", expected.Value("write"), nil, err, root)
	after, readErr := os.ReadFile(path)
	switch state := expected.Value("writeFile"); state {
	case "unchanged":
		if string(after) != string(before) {
			t.Errorf("файл принятия не должен меняться")
		}
	default:
		if readErr != nil {
			t.Fatalf("файл принятия (%s): %v", state, readErr)
		}
		if want := c.Read(t, "files/plan/production-status.json"); string(after) != string(want) {
			t.Errorf("байты plan/production-status.json:\n--- ожидалось\n%s\n--- получено\n%s", want, after)
		}
		if info, err := os.Stat(path); err == nil && info.Mode().Perm() != 0o600 {
			t.Errorf("права файла принятия %v, эталон создаёт 0600", info.Mode().Perm())
		}
	}
}
