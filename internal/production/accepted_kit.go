package production

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"songframe/internal/dynvalue"
)

// AcceptedKit — то, как получено видео принятого плана, по снимку комплекта assets/shots/Mxx.
// Рабочий пакет попытки при приёмке удаляется, поэтому страница «Производство» показывает
// принятый план по комплекту: источник генерации, опоры, промпт и срез речи. Только чтение;
// пути — к существующим файлам комплекта. Поле отсутствующего в комплекте сведения — null.
type AcceptedKit struct {
	// Provider — id провайдера видео из снимка запроса (generation-request.json).
	Provider *string `json:"provider"`
	// GenerationID — номер генерации у сервиса; null у ручной генерации и ручной загрузки.
	GenerationID *string `json:"generationId"`
	// ManualGeneration — manual_generation снимка запроса как есть: видео создано вне приложения.
	ManualGeneration json.RawMessage `json:"manualGeneration,omitempty"`
	// Prompt — текст видеопромпта, переданного в генерацию.
	Prompt *string `json:"prompt"`
	// Images — изображения, переданные в генерацию (опоры), в порядке входов.
	Images []string `json:"images"`
	// Speech — срез речи речевого плана; null без него.
	Speech *AcceptedSpeech `json:"speech"`
}

// AcceptedSpeech — WAV среза речи комплекта и его границы в песне из audio-recipe.json
// (null, если рецепта нет).
type AcceptedSpeech struct {
	Path  string   `json:"path"`
	Start *float64 `json:"start"`
	End   *float64 `json:"end"`
}

// acceptedShotID — код плана, допустимый в имени папки комплекта: без него путь мог бы выйти из assets/shots.
var acceptedShotID = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// AcceptedKitFor — сведения комплекта плана shot; nil, если комплекта нет или он не из генерации
// (у производного плана снимка запроса нет).
func AcceptedKitFor(project, shot string) (*AcceptedKit, error) {
	if !acceptedShotID.MatchString(shot) {
		return nil, fmt.Errorf("неверный код плана: %q", shot)
	}
	dir := filepath.Join(project, "assets", "shots", shot)
	manifest := readJSON(filepath.Join(dir, "manifest.json"))
	generation := dynvalue.Get(manifest, "generation")
	if !dynvalue.IsRecord(generation) {
		return nil, nil
	}
	kit := &AcceptedKit{Images: []string{}}
	if path, err := existingAssetFile(dir, dynvalue.GetPath(generation, "request", "path")); err != nil {
		return nil, err
	} else if path != nil {
		request := readJSON(*path)
		if provider, ok := dynvalue.Get(request, "provider").(string); ok && provider != "" {
			kit.Provider = &provider
		}
		if manual := dynvalue.Get(request, "manual_generation"); dynvalue.IsRecord(manual) {
			kit.ManualGeneration = dynvalue.Raw(manual)
		}
	}
	if id, ok := dynvalue.Get(generation, "generation_id").(string); ok && id != "" {
		kit.GenerationID = &id
	}
	if path, err := existingAssetFile(dir, dynvalue.GetPath(generation, "prompt", "path")); err != nil {
		return nil, err
	} else if path != nil {
		data, err := os.ReadFile(*path)
		if err != nil {
			return nil, err
		}
		text := string(data)
		kit.Prompt = &text
	}
	inputs, _ := dynvalue.AsArray(dynvalue.Get(generation, "inputs"))
	for _, input := range inputs {
		if dynvalue.Get(input, "slot") != "image" {
			continue
		}
		path, err := existingAssetFile(dir, dynvalue.Get(input, "path"))
		if err != nil {
			return nil, err
		}
		if path != nil {
			kit.Images = append(kit.Images, *path)
		}
	}
	if path, err := existingAssetFile(dir, dynvalue.GetPath(generation, "audio", "path")); err != nil {
		return nil, err
	} else if path != nil {
		kit.Speech = &AcceptedSpeech{Path: *path}
		// Рецепт кладётся рядом с WAV под постоянным именем; манифест на него не ссылается.
		interval, _ := dynvalue.AsArray(dynvalue.Get(readJSON(filepath.Join(dir, "audio-recipe.json")), "source_interval_seconds"))
		if len(interval) == 2 && dynvalue.IsFinite(interval[0]) && dynvalue.IsFinite(interval[1]) {
			start, end := dynvalue.ToNumber(interval[0]), dynvalue.ToNumber(interval[1])
			kit.Speech.Start, kit.Speech.End = &start, &end
		}
	}
	return kit, nil
}
