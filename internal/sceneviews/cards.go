package sceneviews

import (
	"path/filepath"
	"runtime"

	"songframe-go/internal/animaticcards"
	"songframe-go/internal/projectviews"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// approvedKeyframes — approved_keyframes(root, sid): опоры пакета плана, если все они приняты и
// их файлы на месте; очередь plan/awaiting/<план> приоритетнее рабочих папок plan/batches/*
// (по имени), принятые пакеты (stage accepted) не считаются. Нечитаемый как UTF-8 или JSON
// workflow.json пропускается (ValueError), прочие ошибки чтения и неверная форма — исключения
// Python. nil — подходящего пакета нет.
func approvedKeyframes(root, sid string) ([]*pycompat.Dict, error) {
	batches := pycompat.Glob(pycompat.JoinPath(root, "plan/batches"), "*/workflow.json")
	pycompat.SortPaths(batches)
	candidates := append([]string{pycompat.JoinPath(root, "plan/awaiting", sid, "workflow.json")}, batches...)
	for _, path := range candidates {
		if !pycompat.IsFile(path) {
			continue
		}
		text, err := pycompat.ReadText(path)
		if err != nil {
			if pycompat.Is(err, pycompat.ValueError) {
				continue
			}
			return nil, err
		}
		data, err := pycompat.LoadsJSON(text)
		if err != nil {
			if pycompat.Is(err, pycompat.ValueError) {
				continue
			}
			return nil, err
		}
		shot, err := pycompat.DictGet(data, "shot", nil)
		if err != nil {
			return nil, err
		}
		stage, _ := pycompat.DictGet(data, "stage", nil)
		if !pycompat.Equal(shot, sid) || pycompat.Equal(stage, "accepted") {
			continue
		}
		framesValue, _ := pycompat.DictGet(data, "keyframes", nil)
		if !pycompat.Truthy(framesValue) {
			framesValue = []any{}
		}
		frames, err := pycompat.Iter(framesValue)
		if err != nil {
			return nil, err
		}
		parent := filepath.Dir(path)
		files := make([]string, len(frames))
		for index, frame := range frames {
			value, err := pycompat.DictGet(frame, "path", nil)
			if err != nil {
				return nil, err
			}
			if !pycompat.Truthy(value) {
				value = ""
			}
			name, ok := value.(string)
			if !ok {
				return nil, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathClass(), pycompat.TypeName(value))
			}
			files[index] = pycompat.JoinPath(parent, name)
		}
		if len(frames) == 0 || !allApproved(frames) || !allFiles(files) {
			continue
		}
		result := []*pycompat.Dict{}
		for index, frame := range frames {
			id, err := pycompat.GetItem(frame, "id")
			if err != nil {
				return nil, err
			}
			role, _ := pycompat.DictGet(frame, "role", nil)
			seconds, _ := pycompat.DictGet(frame, "time_seconds", nil)
			relative, err := pycompat.RelativeTo(files[index], root)
			if err != nil {
				return nil, err
			}
			digest, err := projectviews.FileSHA(files[index])
			if err != nil {
				return nil, err
			}
			result = append(result, pytoolRecord("id", id, "role", role, "time_seconds", seconds, "path", relative, "sha256", digest))
		}
		return result, nil
	}
	return nil, nil
}

// allApproved — all(k.get("approved") and k.get("path") for k in frames).
func allApproved(frames []any) bool {
	for _, frame := range frames {
		dict := frame.(*pycompat.Dict)
		if !pycompat.Truthy(dict.Value("approved")) || !pycompat.Truthy(dict.Value("path")) {
			return false
		}
	}
	return true
}

// allFiles — all(f.is_file() for f in files).
func allFiles(files []string) bool {
	for _, file := range files {
		if !pycompat.IsFile(file) {
			return false
		}
	}
	return true
}

// receipt — пригодная квитанция карточек на диске (cards — её записи по плану) или nil.
type receipt struct {
	cards *pycompat.Dict
}

// loadReceipt — существующая plan/animatic/cards/manifest.json, если она подтверждает входы
// текущих карточек: объект, тот же отпечаток текста реестра, те же поля проекта и те же хеши
// референсов, cards — объект. Любая ошибка чтения или вычисления означает «квитанции нет»: тогда
// карточки перерисовываются, а исключение (если оно есть у оригинала) возникнет в том же месте,
// что и у него.
func loadReceipt(sources *projectviews.Sources, prepared *projectviews.Prepared) *receipt {
	text, err := pycompat.ReadText(pycompat.JoinPath(sources.Root, cardsManifest))
	if err != nil {
		return nil
	}
	value, err := pycompat.LoadsJSON(text)
	if err != nil {
		return nil
	}
	document, ok := value.(*pycompat.Dict)
	if !ok {
		return nil
	}
	registry, err := sources.TextSHA("plan/scenes.json")
	if err != nil || !pycompat.Equal(document.Value("registry_sha256"), registry) {
		return nil
	}
	project, err := sources.JSON("plan/project.json")
	if err != nil {
		return nil
	}
	if match, err := projectviews.ProjectInputsMatch(document, project, false); err != nil || !match {
		return nil
	}
	hashes, err := referenceHashes(sources, prepared)
	if err != nil || !pycompat.Equal(document.Value("reference_hashes"), hashes) {
		return nil
	}
	cards, ok := document.Value("cards").(*pycompat.Dict)
	if !ok {
		return nil
	}
	return &receipt{cards: cards}
}

// confirmedFile — запись {path, sha256} квитанции совпадает с ожидаемым путём, и файл на диске
// имеет записанный SHA-256; возвращается этот SHA-256.
func confirmedFile(root string, entry any, path string) (string, bool) {
	record, ok := entry.(*pycompat.Dict)
	if !ok || !pycompat.Equal(record.Value("path"), path) {
		return "", false
	}
	digest, ok := record.Value("sha256").(string)
	target := pycompat.JoinPath(root, path)
	if !ok || !pycompat.IsFile(target) {
		return "", false
	}
	actual, err := projectviews.FileSHA(target)
	if err != nil || actual != digest {
		return "", false
	}
	return digest, true
}

// confirmed — запись карточки плана sid в квитанции, если она подтверждает файлы на диске при
// текущих опорах (nil у текстовой карточки): та же ссылка, тот же список опор, то же наличие
// .last.png и совпадающие SHA-256. Возвращается новая запись карточки и её ожидаемые файлы.
func (r *receipt) confirmed(root, sid string, keyframes []*pycompat.Dict) (*pycompat.Dict, []expectedFile, bool) {
	if r == nil {
		return nil, nil, false
	}
	entry, ok := r.cards.Value(sid).(*pycompat.Dict)
	if !ok {
		return nil, nil, false
	}
	path := cardPath(sid, ".png")
	digest, ok := confirmedFile(root, entry, path)
	if !ok {
		return nil, nil, false
	}
	result := pytoolRecord("path", path, "sha256", digest)
	files := []expectedFile{{path: path, digest: digest}}
	if keyframes == nil {
		if entry.Has("keyframes") || entry.Has("last") {
			return nil, nil, false
		}
		return result, files, true
	}
	list := keyframeList(keyframes)
	if !entry.Has("keyframes") || !pycompat.Equal(entry.Value("keyframes"), list) {
		return nil, nil, false
	}
	result.Set("keyframes", list)
	withLast := len(keyframes) >= 2
	if entry.Has("last") != withLast {
		return nil, nil, false
	}
	if withLast {
		lastPath := cardPath(sid, ".last.png")
		lastDigest, ok := confirmedFile(root, entry.Value("last"), lastPath)
		if !ok {
			return nil, nil, false
		}
		result.Set("last", pytoolRecord("path", lastPath, "sha256", lastDigest))
		files = append(files, expectedFile{path: lastPath, digest: lastDigest})
	}
	return result, files, true
}

// keyframeList — список опор значением Python для квитанции и сравнения.
func keyframeList(keyframes []*pycompat.Dict) []any {
	list := make([]any, len(keyframes))
	for index, keyframe := range keyframes {
		list[index] = keyframe
	}
	return list
}

// expectedCards — expected_cards(sources, directory): ожидаемые карточки планов без комплекта
// assets (текстовая карточка или карточка принятых опор с .last.png при двух и более опорах) —
// записи квитанции по плану и ожидаемые файлы в порядке планов. Карточка, подтверждённая
// квитанцией (см. комментарий пакета), не перерисовывается; остальные рисует animaticcards в
// память.
func expectedCards(sources *projectviews.Sources, prepared *projectviews.Prepared) (*pycompat.Dict, []expectedFile, error) {
	root := sources.Root
	raw, err := sources.JSON("plan/project.json")
	if err != nil {
		return nil, nil, err
	}
	// Карточкам нужны название и ссылки; generation проверяется перед генерацией.
	project, err := sceneregistry.ValidateProject(raw, false)
	if err != nil {
		return nil, nil, err
	}
	saved := loadReceipt(sources, prepared)
	cards := pycompat.NewDict()
	files := []expectedFile{}
	for _, scene := range prepared.Items {
		sid := scene.Value("id").(string)
		if prepared.Packages.Has(sid) {
			continue
		}
		keyframes, err := approvedKeyframes(root, sid)
		if err != nil {
			return nil, nil, err
		}
		if entry, confirmed, ok := saved.confirmed(root, sid, keyframes); ok {
			cards.Set(sid, entry)
			files = append(files, confirmed...)
			continue
		}
		path := cardPath(sid, ".png")
		if keyframes != nil {
			// Согласованные опоры заменяют текстовую карточку: сборка покажет переход от первой к последней.
			card, last, err := animaticcards.RenderKeyframeCard(scene, project, keyframes, root, true)
			if err != nil {
				return nil, nil, err
			}
			entry := pytoolRecord("path", path, "sha256", digestBytes(card), "keyframes", keyframeList(keyframes))
			files = append(files, expectedFile{path: path, digest: digestBytes(card), data: card})
			if last != nil {
				lastPath := cardPath(sid, ".last.png")
				entry.Set("last", pytoolRecord("path", lastPath, "sha256", digestBytes(last)))
				files = append(files, expectedFile{path: lastPath, digest: digestBytes(last), data: last})
			}
			cards.Set(sid, entry)
			continue
		}
		references, ok := prepared.Data.Value("references").(*pycompat.Dict)
		if !ok {
			return nil, nil, pycompat.Raise(pycompat.TypeError, "%s indices must be integers or slices, not str", pycompat.TypeName(prepared.Data.Value("references")))
		}
		card, err := animaticcards.RenderCard(scene, project, references, root)
		if err != nil {
			return nil, nil, err
		}
		cards.Set(sid, pytoolRecord("path", path, "sha256", digestBytes(card)))
		files = append(files, expectedFile{path: path, digest: digestBytes(card), data: card})
	}
	return cards, files, nil
}

// referenceHashes — {v["path"]: sources.digest(v["path"]) for v in data["references"].values()}:
// SHA-256 байтов исходных референсов, от которых зависят карточки.
func referenceHashes(sources *projectviews.Sources, prepared *projectviews.Prepared) (*pycompat.Dict, error) {
	value := prepared.Data.Value("references")
	references, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'values'", pycompat.TypeName(value))
	}
	result := pycompat.NewDict()
	for _, key := range references.Keys() {
		pathValue, err := pycompat.GetItem(references.Value(key), "path")
		if err != nil {
			return nil, err
		}
		path, ok := pathValue.(string)
		if !ok {
			if _, err := pycompat.HashKey(pathValue); err != nil {
				return nil, err
			}
			return nil, pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", pathClass(), pycompat.TypeName(pathValue))
		}
		digest, err := sources.Digest(path)
		if err != nil {
			return nil, err
		}
		result.Set(path, digest)
	}
	return result, nil
}

// cardsReceipt — текст plan/animatic/cards/manifest.json: отпечаток текста реестра, поля проекта
// для карточек, хеши референсов и записи карточек; json.dumps(ensure_ascii=False, indent=2) + "\n".
func cardsReceipt(sources *projectviews.Sources, prepared *projectviews.Prepared, cards *pycompat.Dict) (string, error) {
	registry, err := sources.TextSHA("plan/scenes.json")
	if err != nil {
		return "", err
	}
	project, err := sources.JSON("plan/project.json")
	if err != nil {
		return "", err
	}
	inputs, err := projectviews.ProjectInputs(project, false)
	if err != nil {
		return "", err
	}
	hashes, err := referenceHashes(sources, prepared)
	if err != nil {
		return "", err
	}
	document := pytoolRecord(
		"schema_version", pycompat.NewInt(1),
		"generated_from", "plan/scenes.json",
		"registry_sha256", registry,
		"project_inputs", inputs,
		"reference_hashes", hashes,
		"cards", cards,
	)
	text, err := pycompat.DumpsJSON(document, pycompat.DumpOptions{Indent: 2, Pretty: true})
	if err != nil {
		return "", err
	}
	return text + "\n", nil
}

// pytoolRecord — упорядоченный словарь Python из пар ключ-значение.
func pytoolRecord(pairs ...any) *pycompat.Dict { return pytool.Record(pairs...) }

// pathClass — имя класса Path в тексте TypeError оператора «/» pathlib.
func pathClass() string {
	if runtime.GOOS == "windows" {
		return "WindowsPath"
	}
	return "PosixPath"
}
