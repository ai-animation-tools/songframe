package production

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"songframe/internal/dynvalue"
	"songframe/internal/spend"
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
	// OwnVideo — своё видео плана (generation.own_video): описания, опор и промпта у комплекта нет.
	OwnVideo bool `json:"ownVideo,omitempty"`
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
	kit := &AcceptedKit{Images: []string{}, OwnVideo: dynvalue.StrictEqual(dynvalue.Get(generation, "own_video"), true)}
	if path, err := existingAssetFile(dir, dynvalue.GetPath(generation, "request", "path")); err != nil {
		return nil, err
	} else if path != nil {
		request := readJSON(*path)
		if provider, ok := dynvalue.Get(request, "provider").(string); ok && provider != "" {
			kit.Provider = &provider
		}
		if manual := dynvalue.Get(request, "manual_generation"); dynvalue.IsRecord(manual) {
			kit.ManualGeneration = withJournalCost(project, shot, dynvalue.Raw(manual))
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

// withJournalCost — manual_generation снимка с ценой, исправленной пользователем после загрузки.
// Снимок комплекта защищён SHA и не переписывается, поэтому исправление живёт в журнале расхода
// (spend.SetAmount) и подставляется здесь; без исправления — снимок как есть.
func withJournalCost(project, shot string, manual json.RawMessage) json.RawMessage {
	entries, err := spend.Entries(project)
	if err != nil {
		return manual
	}
	entry := spend.AcceptedEntry(entries, shot, acceptedResult(project, shot))
	if entry == nil || !entry.UserAmount {
		return manual
	}
	var record map[string]any
	if json.Unmarshal(manual, &record) != nil {
		return manual
	}
	record["cost"] = nil
	if entry.Amount != nil && entry.Unit != nil {
		record["cost"] = map[string]any{"amount": *entry.Amount, "unit": *entry.Unit}
	}
	data, err := json.Marshal(record)
	if err != nil {
		return manual
	}
	return data
}
