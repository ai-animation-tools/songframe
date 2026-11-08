package sceneviews

import (
	"path/filepath"

	"songframe/internal/animaticcards"
	"songframe/internal/projectviews"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// approvedKeyframes — опоры пакета плана, если все они приняты и
// их файлы на месте; очередь plan/awaiting/<план> приоритетнее рабочих папок plan/batches/*
// (по имени), принятые пакеты (stage accepted) не считаются. Нечитаемый как UTF-8 или JSON
// workflow.json пропускается (ValueError), прочие ошибки чтения и неверная форма — исключения
// toolrt. nil — подходящего пакета нет.
func approvedKeyframes(root, sid string) ([]*toolrt.Dict, error) {
	batches := toolrt.Glob(toolrt.JoinPath(root, "plan/batches"), "*/workflow.json")
	toolrt.SortPaths(batches)
	candidates := append([]string{toolrt.JoinPath(root, "plan/awaiting", sid, "workflow.json")}, batches...)
	for _, path := range candidates {
		if !toolrt.IsFile(path) {
			continue
		}
		text, err := toolrt.ReadText(path)
		if err != nil {
			if toolrt.Is(err, toolrt.ValueError) {
				continue
			}
			return nil, err
		}
		data, err := toolrt.LoadsJSON(text)
		if err != nil {
			if toolrt.Is(err, toolrt.ValueError) {
				continue
			}
			return nil, err
		}
		shot, err := toolrt.DictGet(data, "shot", nil)
		if err != nil {
			return nil, err
		}
		stage, _ := toolrt.DictGet(data, "stage", nil)
		if !toolrt.Equal(shot, sid) || toolrt.Equal(stage, "accepted") {
			continue
		}
		framesValue, _ := toolrt.DictGet(data, "keyframes", nil)
		if !toolrt.Truthy(framesValue) {
			framesValue = []any{}
		}
		frames, err := toolrt.Iter(framesValue)
		if err != nil {
			return nil, err
		}
		parent := filepath.Dir(path)
		files := make([]string, len(frames))
		for index, frame := range frames {
			value, err := toolrt.DictGet(frame, "path", nil)
			if err != nil {
				return nil, err
			}
			if !toolrt.Truthy(value) {
				value = ""
			}
			name, ok := value.(string)
			if !ok {
				return nil, toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(value))
			}
			files[index] = toolrt.JoinPath(parent, name)
		}
		if len(frames) == 0 || !allApproved(frames) || !allFiles(files) {
			continue
		}
		result := []*toolrt.Dict{}
		for index, frame := range frames {
			id, err := toolrt.GetItem(frame, "id")
			if err != nil {
				return nil, err
			}
			role, _ := toolrt.DictGet(frame, "role", nil)
			seconds, _ := toolrt.DictGet(frame, "time_seconds", nil)
			relative, err := toolrt.RelativeTo(files[index], root)
			if err != nil {
				return nil, err
			}
			digest, err := projectviews.FileSHA(files[index])
			if err != nil {
				return nil, err
			}
			result = append(result, orderedRecord("id", id, "role", role, "time_seconds", seconds, "path", relative, "sha256", digest))
		}
		return result, nil
	}
	return nil, nil
}

// allApproved — у каждой опоры истинны approved и path.
func allApproved(frames []any) bool {
	for _, frame := range frames {
		dict := frame.(*toolrt.Dict)
		if !toolrt.Truthy(dict.Value("approved")) || !toolrt.Truthy(dict.Value("path")) {
			return false
		}
	}
	return true
}

// allFiles — все пути — существующие обычные файлы.
func allFiles(files []string) bool {
	for _, file := range files {
		if !toolrt.IsFile(file) {
			return false
		}
	}
	return true
}

// receipt — пригодная квитанция карточек на диске (cards — её записи по плану) или nil.
type receipt struct {
	cards *toolrt.Dict
}

// loadReceipt — существующая plan/animatic/cards/manifest.json, если она подтверждает входы
// текущих карточек: объект, тот же отпечаток текста реестра, те же поля проекта и те же хеши
// референсов, cards — объект. Любая ошибка чтения или вычисления означает «квитанции нет»: тогда
// карточки перерисовываются, а исключение, если оно есть, возникнет при перерисовке.
func loadReceipt(sources *projectviews.Sources, prepared *projectviews.Prepared) *receipt {
	text, err := toolrt.ReadText(toolrt.JoinPath(sources.Root, cardsManifest))
	if err != nil {
		return nil
	}
	value, err := toolrt.LoadsJSON(text)
	if err != nil {
		return nil
	}
	document, ok := value.(*toolrt.Dict)
	if !ok {
		return nil
	}
	registry, err := sources.TextSHA("plan/scenes.json")
	if err != nil || !toolrt.Equal(document.Value("registry_sha256"), registry) {
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
	if err != nil || !toolrt.Equal(document.Value("reference_hashes"), hashes) {
		return nil
	}
	cards, ok := document.Value("cards").(*toolrt.Dict)
	if !ok {
		return nil
	}
	return &receipt{cards: cards}
}

// confirmedFile — запись {path, sha256} квитанции совпадает с ожидаемым путём, и файл на диске
// имеет записанный SHA-256; возвращается этот SHA-256.
func confirmedFile(root string, entry any, path string) (string, bool) {
	record, ok := entry.(*toolrt.Dict)
	if !ok || !toolrt.Equal(record.Value("path"), path) {
		return "", false
	}
	digest, ok := record.Value("sha256").(string)
	target := toolrt.JoinPath(root, path)
	if !ok || !toolrt.IsFile(target) {
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
func (r *receipt) confirmed(root, sid string, keyframes []*toolrt.Dict) (*toolrt.Dict, []expectedFile, bool) {
	if r == nil {
		return nil, nil, false
	}
	entry, ok := r.cards.Value(sid).(*toolrt.Dict)
	if !ok {
		return nil, nil, false
	}
	path := cardPath(sid, ".png")
	digest, ok := confirmedFile(root, entry, path)
	if !ok {
		return nil, nil, false
	}
	result := orderedRecord("path", path, "sha256", digest)
	files := []expectedFile{{path: path, digest: digest}}
	if keyframes == nil {
		if entry.Has("keyframes") || entry.Has("last") {
			return nil, nil, false
		}
		return result, files, true
	}
	list := keyframeList(keyframes)
	if !entry.Has("keyframes") || !toolrt.Equal(entry.Value("keyframes"), list) {
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
		result.Set("last", orderedRecord("path", lastPath, "sha256", lastDigest))
		files = append(files, expectedFile{path: lastPath, digest: lastDigest})
	}
	return result, files, true
}

// keyframeList — список опор значением toolrt для квитанции и сравнения.
func keyframeList(keyframes []*toolrt.Dict) []any {
	list := make([]any, len(keyframes))
	for index, keyframe := range keyframes {
		list[index] = keyframe
	}
	return list
}

// expectedCards — ожидаемые карточки планов без комплекта
// assets (текстовая карточка или карточка принятых опор с .last.png при двух и более опорах) —
// записи квитанции по плану и ожидаемые файлы в порядке планов. Карточка, подтверждённая
// квитанцией (см. комментарий пакета), не перерисовывается; остальные рисует animaticcards в
// память.
func expectedCards(sources *projectviews.Sources, prepared *projectviews.Prepared) (*toolrt.Dict, []expectedFile, error) {
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
	cards := toolrt.NewDict()
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
			entry := orderedRecord("path", path, "sha256", digestBytes(card), "keyframes", keyframeList(keyframes))
			files = append(files, expectedFile{path: path, digest: digestBytes(card), data: card})
			if last != nil {
				lastPath := cardPath(sid, ".last.png")
				entry.Set("last", orderedRecord("path", lastPath, "sha256", digestBytes(last)))
				files = append(files, expectedFile{path: lastPath, digest: digestBytes(last), data: last})
			}
			cards.Set(sid, entry)
			continue
		}
		references, ok := prepared.Data.Value("references").(*toolrt.Dict)
		if !ok {
			return nil, nil, toolrt.New(toolrt.TypeError, "индекс должен быть целым числом, получено: строка")
		}
		card, err := animaticcards.RenderCard(scene, project, references, root)
		if err != nil {
			return nil, nil, err
		}
		cards.Set(sid, orderedRecord("path", path, "sha256", digestBytes(card)))
		files = append(files, expectedFile{path: path, digest: digestBytes(card), data: card})
	}
	return cards, files, nil
}

// referenceHashes — путь → SHA-256 для каждого референса data["references"]:
// SHA-256 байтов исходных референсов, от которых зависят карточки.
func referenceHashes(sources *projectviews.Sources, prepared *projectviews.Prepared) (*toolrt.Dict, error) {
	value := prepared.Data.Value("references")
	references, ok := value.(*toolrt.Dict)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(value))
	}
	result := toolrt.NewDict()
	for _, key := range references.Keys() {
		pathValue, err := toolrt.GetItem(references.Value(key), "path")
		if err != nil {
			return nil, err
		}
		path, ok := pathValue.(string)
		if !ok {
			if _, err := toolrt.HashKey(pathValue); err != nil {
				return nil, err
			}
			return nil, toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(pathValue))
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
// для карточек, хеши референсов и записи карточек; JSON с отступом два пробела, не-ASCII без
// экранирования и перевод строки в конце.
func cardsReceipt(sources *projectviews.Sources, prepared *projectviews.Prepared, cards *toolrt.Dict) (string, error) {
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
	document := orderedRecord(
		"schema_version", toolrt.NewInt(1),
		"generated_from", "plan/scenes.json",
		"registry_sha256", registry,
		"project_inputs", inputs,
		"reference_hashes", hashes,
		"cards", cards,
	)
	text, err := toolrt.DumpsJSON(document, toolrt.DumpOptions{Indent: 2, Pretty: true})
	if err != nil {
		return "", err
	}
	return text + "\n", nil
}

// orderedRecord — упорядоченный словарь из пар ключ-значение.
func orderedRecord(pairs ...any) *toolrt.Dict { return toolcli.Record(pairs...) }
