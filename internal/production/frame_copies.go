package production

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/projectfs"
)

// Копии опор. План опор пакета (keyframe-prompts.json) может отметить опору копией более ранней
// (copyOf): например, конечный кадр, повторяющий удержание промежуточного. Такую опору не создают и
// не загружают: когда источник утверждён, его файл побайтно копируется в frames/<копия>.<расширение>
// и утверждается штатным shot_workflow approve. Одинаковые байты дают настоящее удержание кадра,
// а не два похожих изображения, между которыми модель видео стала бы переходить.
//
// Источником может быть и кадр принятого плана (путь от проекта к <пакет>/continuity/<план>-
// <first|last>.png): например, первый кадр, продолжающий последний кадр предыдущего плана без
// смены точки. Такой кадр уже принят вместе с монтажом того плана и извлечён в пакет при
// применении описания, поэтому копия заполняется при первом утверждении после этого — обычно
// при утверждении описания, до создания остальных опор, которые могут на неё опираться.

// frameCopies — пары «копия → источник» из плана опор пакета; нет файла или копий — пусто.
// Ответ агента с copyOf уже проверен при применении описания (internal/productionworkflow).
func frameCopies(directory string) map[string]string {
	data, err := os.ReadFile(filepath.Join(directory, "keyframe-prompts.json"))
	if err != nil {
		return nil
	}
	var prompts []struct {
		ID     string `json:"id"`
		CopyOf string `json:"copyOf"`
	}
	if json.Unmarshal(data, &prompts) != nil {
		return nil
	}
	copies := map[string]string{}
	for _, prompt := range prompts {
		if prompt.CopyOf != "" {
			copies[prompt.ID] = prompt.CopyOf
		}
	}
	return copies
}

// fillFrameCopies — копии утверждённых источников получают их файл и утверждение. Копия, уже
// утверждённая с теми же байтами, не трогается; после нового утверждения источника (возврат на
// доработку) копия обновляется. Неутверждённый источник копию не меняет: прежнее утверждение
// копии не мешает, пока видеопромпт требует всех опор, а источник — нового решения.
func (s *Service) fillFrameCopies(project, directory string) error {
	copies := frameCopies(directory)
	if len(copies) == 0 {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(directory, "workflow.json"))
	if err != nil {
		return err
	}
	var workflow struct {
		Keyframes []struct {
			ID       string  `json:"id"`
			Path     *string `json:"path"`
			SHA256   *string `json:"sha256"`
			Approved bool    `json:"approved"`
		} `json:"keyframes"`
	}
	if err := json.Unmarshal(data, &workflow); err != nil {
		return err
	}
	frames := map[string]copySource{}
	for _, item := range workflow.Keyframes {
		value := copySource{approved: item.Approved}
		if item.Path != nil {
			value.path = *item.Path
		}
		if item.SHA256 != nil {
			value.sha = *item.SHA256
		}
		frames[item.ID] = value
	}
	for _, item := range workflow.Keyframes {
		id := item.ID
		source, isCopy := copies[id]
		original, found := frames[source]
		if isCopy && !found {
			original, found = shotFrameSource(project, directory, source)
		}
		if !isCopy || !found || !original.approved || original.path == "" {
			continue
		}
		if current := frames[id]; current.approved && current.sha == original.sha {
			continue
		}
		from := filepath.Join(directory, filepath.FromSlash(original.path))
		bytes, err := os.ReadFile(from)
		if err != nil {
			return errors.New(textFrameCopyFailed(id, source))
		}
		info, err := os.Stat(from)
		if err != nil {
			return errors.New(textFrameCopyFailed(id, source))
		}
		target := filepath.Join(directory, "frames", id+strings.ToLower(filepath.Ext(from)))
		if err := projectfs.WriteFile(target, bytes, info.Mode().Perm()); err != nil {
			return errors.New(textFrameCopyFailed(id, source))
		}
		result, err := s.run(project, "shot_workflow", "approve", "--dir", directory, id, target)
		if err != nil || !ok(result) {
			return errors.New(textFrameCopyFailed(id, source))
		}
	}
	return nil
}

// copySource — файл источника копии: путь от папки пакета, SHA-256 и утверждён ли он.
type copySource struct {
	path, sha string
	approved  bool
}

// shotFrameSource — источник копии, заданный путём кадра принятого плана от проекта. Годится только
// файл внутри папки continuity этого пакета; он считается утверждённым. Нет файла или путь вне
// пакета — false: копия остаётся незаполненной, как при неутверждённом источнике.
func shotFrameSource(project, directory, source string) (copySource, bool) {
	file := filepath.Join(project, filepath.FromSlash(source))
	relative, err := filepath.Rel(directory, file)
	if err != nil || filepath.Dir(relative) != "continuity" {
		return copySource{}, false
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return copySource{}, false
	}
	sum := sha256.Sum256(data)
	return copySource{path: filepath.ToSlash(relative), sha: hex.EncodeToString(sum[:]), approved: true}, true
}

// shotFrameName — имя кадра другого плана в папке continuity пакета.
var shotFrameName = regexp.MustCompile(`^(M\d{2}(?:\.\d+)?)-(first|last)\.png$`)

// shotFrameOf — план и положение кадра (first или last), если источник копии — кадр другого плана,
// а не ID опоры.
func shotFrameOf(source string) (shot, position string, ok bool) {
	folder, name := path.Split(source)
	match := shotFrameName.FindStringSubmatch(name)
	if match == nil || path.Base(path.Clean(folder)) != "continuity" {
		return "", "", false
	}
	return match[1], match[2], true
}
