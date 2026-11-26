package shotworkflow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"songframe/internal/toolrt"
)

// Прежние варианты опор попытки. Новый кандидат опоры (доработка, свой файл, повторное создание) не
// стирает прежний файл: тот переезжает в frames/history попытки рядом с записью о нём, и его можно
// вернуть кандидатом. Так ошибочное указание к доработке не уничтожает удачную опору. Хранятся
// последние historyKeep вариантов каждой опоры: опора весит мегабайты, а нужны обычно один-два шага
// назад. Архив — часть папки попытки и переносится вместе с ней; в комплект принятого плана он не
// попадает: приёмка берёт только опоры из workflow.json.

const (
	// historyKeep — сколько прежних вариантов одной опоры хранится; старшие удаляются.
	historyKeep = 5
	// variantSuffix — запись о варианте рядом с его изображением: SHA, отметка генератора и время.
	variantSuffix = ".json"
)

// FrameVariant — прежний вариант опоры для показа: имя записи (Kxx-время), абсолютный путь
// изображения и время, когда вариант перестал быть текущим (формат Now).
type FrameVariant struct {
	Name      string `json:"name"`
	ImagePath string `json:"imagePath"`
	SavedAt   string `json:"savedAt"`
}

// variantRecord — содержимое записи варианта. Provider и GeneratorPrompt возвращаются опоре при
// возврате варианта: без отметки генератора учёт расхода принял бы её за свой файл.
type variantRecord struct {
	Image           string  `json:"image"`
	SHA256          string  `json:"sha256"`
	Provider        *string `json:"provider,omitempty"`
	GeneratorPrompt *string `json:"generator_prompt,omitempty"`
	SavedAt         string  `json:"saved_at"`
}

// historyDir — каталог прежних вариантов опор попытки.
func historyDir(directory string) string { return filepath.Join(directory, "frames", "history") }

// ownFramePath — путь опоры id в пакете, если это её собственный файл frames/<id>.<ext>; копия
// другой опоры или файл вне frames — "".
func ownFramePath(directory string, keyframe *toolrt.Dict) string {
	path, ok := keyframe.Value("path").(string)
	id := toolrt.Str(keyframe.Value("id"))
	if !ok || path == "" || filepath.ToSlash(filepath.Dir(filepath.FromSlash(path))) != "frames" ||
		!strings.HasPrefix(filepath.Base(path), id+".") {
		return ""
	}
	return filepath.Join(directory, filepath.FromSlash(path))
}

// stamp — время Now в имени файла: «2026-11-26T14:26:56+00:00» → «20261126T142656Z».
func stamp() string {
	value := strings.TrimSuffix(Now(), "+00:00")
	return strings.NewReplacer("-", "", ":", "").Replace(value) + "Z"
}

// archiveFrame переносит собственный файл опоры в историю, если новый кандидат с другим SHA
// (next) его заменит. Опора без файла, копия другой опоры и тот же файл не архивируются.
func archiveFrame(directory string, keyframe *toolrt.Dict, next string) error {
	current := ownFramePath(directory, keyframe)
	if current == "" || !toolrt.IsFile(current) {
		return nil
	}
	digest, err := sha(current)
	if err != nil {
		return err
	}
	if digest == next {
		return nil
	}
	folder := historyDir(directory)
	if err := os.MkdirAll(folder, 0o777); err != nil {
		return toolrt.OSErrorFrom(err, folder)
	}
	id := toolrt.Str(keyframe.Value("id"))
	name := id + "-" + stamp()
	for index := 2; toolrt.IsFile(filepath.Join(folder, name+variantSuffix)); index++ {
		name = id + "-" + stamp() + "-" + strconv.Itoa(index)
	}
	image := name + strings.ToLower(filepath.Ext(current))
	if err := os.Rename(current, filepath.Join(folder, image)); err != nil {
		return toolrt.OSErrorFrom(err, current)
	}
	entry := variantRecord{Image: image, SHA256: digest, SavedAt: Now()}
	if provider, ok := keyframe.Value("provider").(string); ok {
		entry.Provider = &provider
	}
	if prompt, ok := keyframe.Value("generator_prompt").(string); ok {
		entry.GeneratorPrompt = &prompt
	}
	data, err := json.MarshalIndent(entry, "", "  ")
	if err != nil {
		return err
	}
	target := filepath.Join(folder, name+variantSuffix)
	if err := os.WriteFile(target, append(data, '\n'), 0o666); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	return pruneVariants(folder, id)
}

// variantNames — имена записей вариантов опоры id от старых к новым (время в имени сортируется).
func variantNames(folder, id string) ([]string, error) {
	entries, err := os.ReadDir(folder)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, folder)
	}
	names := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && strings.HasPrefix(name, id+"-") && strings.HasSuffix(name, variantSuffix) {
			names = append(names, strings.TrimSuffix(name, variantSuffix))
		}
	}
	slices.Sort(names)
	return names, nil
}

// pruneVariants оставляет historyKeep последних вариантов опоры id.
func pruneVariants(folder, id string) error {
	names, err := variantNames(folder, id)
	if err != nil || len(names) <= historyKeep {
		return err
	}
	for _, name := range names[:len(names)-historyKeep] {
		entry, err := readVariant(folder, name)
		if err == nil {
			_ = os.Remove(filepath.Join(folder, entry.Image))
		}
		if err := os.Remove(filepath.Join(folder, name+variantSuffix)); err != nil && !os.IsNotExist(err) {
			return toolrt.OSErrorFrom(err, folder)
		}
	}
	return nil
}

// readVariant читает запись варианта; имя изображения — только файл в том же каталоге.
func readVariant(folder, name string) (variantRecord, error) {
	var entry variantRecord
	path := filepath.Join(folder, name+variantSuffix)
	data, err := os.ReadFile(path)
	if err != nil {
		return entry, toolrt.OSErrorFrom(err, path)
	}
	if err := json.Unmarshal(data, &entry); err != nil {
		return entry, valueError("Запись прежнего варианта опоры повреждена: " + name)
	}
	if entry.Image != filepath.Base(entry.Image) || !contains(imageSuffixes, strings.ToLower(filepath.Ext(entry.Image))) {
		return entry, valueError("Запись прежнего варианта опоры повреждена: " + name)
	}
	return entry, nil
}

// FrameVariants — прежние варианты опоры id попытки от новых к старым; записи без изображения
// пропускаются. Без истории — пустой список.
func FrameVariants(directory, id string) ([]FrameVariant, error) {
	folder := historyDir(directory)
	names, err := variantNames(folder, id)
	if err != nil {
		return nil, err
	}
	variants := []FrameVariant{}
	for index := len(names) - 1; index >= 0; index-- {
		entry, err := readVariant(folder, names[index])
		if err != nil {
			continue
		}
		image := filepath.Join(folder, entry.Image)
		if toolrt.IsFile(image) {
			variants = append(variants, FrameVariant{Name: names[index], ImagePath: image, SavedAt: entry.SavedAt})
		}
	}
	return variants, nil
}

// RestoreFrameVariant — прежний вариант name снова становится кандидатом опоры id: текущий файл
// уходит в историю, вариант — на место frames/<id>.<ext> с прежней отметкой генератора. Условия —
// как у возврата утверждённой опоры (reopen): видеопромпт не утверждён, запроса нет, этап из
// reopenStages. Опора снимается с утверждения, видеопромпт согласуется заново, этап —
// keyframes_review без вопроса: вопрос о кандидате задаёт производство.
func RestoreFrameVariant(directory, id, name string) error {
	data, err := load(directory)
	if err != nil {
		return err
	}
	keyframe, err := keyframeOf(data, id)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(name, id+"-") || name != filepath.Base(name) {
		return valueError(id + ": такого прежнего варианта нет.")
	}
	prompt, _ := data.Value("prompt").(*toolrt.Dict)
	if (prompt != nil && toolrt.Truthy(prompt.Value("approved"))) || toolrt.Truthy(data.Value("request_dir")) {
		return valueError("Видеопромпт уже утверждён или запрос подготовлен: прежний вариант опоры в этой попытке не вернуть; создайте исправленную попытку.")
	}
	stage := toolrt.Str(data.Value("stage"))
	if !contains(reopenStages, stage) {
		return valueError("На этапе " + stage + " опору не заменить: сначала завершите текущую отправку изображения и выберите её результат.")
	}
	folder := historyDir(directory)
	entry, err := readVariant(folder, name)
	if err != nil {
		return err
	}
	image := filepath.Join(folder, entry.Image)
	if !toolrt.IsFile(image) {
		return valueError(id + ": файла прежнего варианта нет.")
	}
	digest, err := sha(image)
	if err != nil {
		return err
	}
	if digest != entry.SHA256 {
		return valueError(id + ": файл прежнего варианта изменён после сохранения.")
	}
	if err := archiveFrame(directory, keyframe, digest); err != nil {
		return err
	}
	target := filepath.Join(directory, "frames", id+strings.ToLower(filepath.Ext(entry.Image)))
	if err := os.Rename(image, target); err != nil {
		return toolrt.OSErrorFrom(err, image)
	}
	if err := os.Remove(filepath.Join(folder, name+variantSuffix)); err != nil {
		return toolrt.OSErrorFrom(err, folder)
	}
	keyframe.Set("path", "frames/"+filepath.Base(target))
	keyframe.Set("sha256", digest)
	keyframe.Set("approved", false)
	keyframe.Delete("provider")
	keyframe.Delete("generator_prompt")
	if entry.Provider != nil {
		keyframe.Set("provider", *entry.Provider)
	}
	if entry.GeneratorPrompt != nil {
		keyframe.Set("generator_prompt", *entry.GeneratorPrompt)
	}
	frames, err := approvedFrames(data)
	if err != nil {
		return err
	}
	frames.Delete(id)
	// Промпт строился по прежним опорам и согласуется заново, как после возврата опоры.
	if prompt != nil && prompt.Len() > 0 {
		data.Set("prompt", unapprovedPrompt(prompt))
	}
	data.Set("approved_prompt_sha256", nil)
	data.Set("stage", "keyframes_review")
	data.Set("wait_reason", nil)
	data.Set("pending_decision", nil)
	data.Set("decision", nil)
	_, err = save(directory, data)
	return err
}
