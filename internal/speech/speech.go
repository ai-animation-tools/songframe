// Package speech — речевые планы (speech.ts оригинала): строки песни в окне плана для выбора
// границ среза липсинка и подготовленный точный WAV пакета (audio/speech.wav и его рецепт
// audio/audio-recipe.json, которые режет штатный cut_speech). Пакет только читает файлы проекта.
//
// Потребители: production.speechPlan и вид пакета (PackageView.speech), приёмка речевого плана
// (accept_shot получает --audio/--audio-recipe отсюда) и проход агента производства (проверка
// длины WAV относительно lipSync провайдера).
package speech

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
)

// Тексты productionTexts.main.speech оригинала.
const textSceneRegistryUnreadable = "Не удалось прочитать реестр сцен."

func textShotMissing(shot string) string {
	return shot + ": план отсутствует в реестре сцен."
}

// Line — SpeechLine: строка песни (текст из source/text.md или null) и её границы в секундах.
type Line struct {
	Text  *string `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// Interval — отрезок песни в секундах.
type Interval struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// Range — допустимая длина звукового входа провайдера видео (поле lipSync реестра), секунды.
type Range struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// Limits — ограничения предложения среза: длительность запроса пакета (timing.request_seconds)
// и lipSync провайдера видео проекта. nil — ограничения нет (lipSync null — липсинк не
// поддерживается).
type Limits struct {
	RequestSeconds *float64
	LipSync        *Range
}

// Plan — SpeechPlan: окно плана, строки разметки в нём и предложенные границы среза.
type Plan struct {
	Shot     string    `json:"shot"`
	Window   Interval  `json:"window"`
	Lines    []Line    `json:"lines"`
	Proposed *Interval `json:"proposed"`
	LipSync  *Range    `json:"lipSync"`
}

// Package — PackageSpeech: подготовленный срез пакета.
type Package struct {
	// Path — абсолютный путь WAV в audio/ пакета; Recipe — путь audio/audio-recipe.json.
	Path   string  `json:"path"`
	Recipe string  `json:"recipe"`
	Start  float64 `json:"start"`
	End    float64 `json:"end"`
	Lines  []Line  `json:"lines"`
}

// readJSON — readJson оригинала: null (nil) при отсутствии файла и любой ошибке разбора.
func readJSON(path string) any {
	value, ok := jscompat.ReadJSONFile(path)
	if !ok {
		return nil
	}
	return value
}

// finite — typeof value === 'number' && Number.isFinite(value).
func finite(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && jscompat.IsFinite(number)
}

// newline — /\r?\n/ оригинала.
var newline = regexp.MustCompile(`\r?\n`)

// round3 — Math.round(value * 1000) / 1000: половина округляется к +∞, как в JS.
func round3(value float64) float64 {
	return math.Floor(value*1000+0.5) / 1000
}

// PlanFor — speechPlan(project, shot, limits). Срез начинается с начала окна: в монтаже клип плана
// тоже начинается с этой точки песни, и губы совпадают со звуком без сдвига. Длина — не меньше
// окна, длительности запроса и минимума звукового входа провайдера. Ошибка — реестр не читается
// или плана в нём нет (тексты оригинала).
func PlanFor(project, shot string, limits Limits) (Plan, error) {
	scenes := readJSON(filepath.Join(project, "plan", "scenes.json"))
	list, isList := jscompat.AsArray(jscompat.Get(scenes, "scenes"))
	fps, fpsOK := finite(jscompat.Get(scenes, "fps"))
	if !jscompat.IsRecord(scenes) || !isList || !fpsOK {
		return Plan{}, errors.New(textSceneRegistryUnreadable)
	}
	var scene any
	for _, item := range list {
		if jscompat.IsRecord(item) && jscompat.StrictEqual(jscompat.Get(item, "id"), shot) {
			scene = item
			break
		}
	}
	startFrame, startOK := finite(jscompat.Get(scene, "start_frame"))
	endFrame, endOK := finite(jscompat.Get(scene, "end_frame_exclusive"))
	if !jscompat.IsRecord(scene) || !startOK || !endOK {
		return Plan{}, errors.New(textShotMissing(shot))
	}
	window := Interval{Start: startFrame / fps, End: endFrame / fps}
	timing := readJSON(filepath.Join(project, "plan", "audio", "timing.json"))
	var text []string
	if data, err := os.ReadFile(filepath.Join(project, "source", "text.md")); err == nil {
		text = newline.Split(jscompat.DecodeUTF8(data), -1)
	}
	lines := []Line{}
	if timingLines, ok := jscompat.AsArray(jscompat.Get(timing, "lines")); ok && jscompat.IsRecord(timing) {
		for _, line := range timingLines {
			start, startOK := finite(jscompat.Get(line, "start"))
			end, endOK := finite(jscompat.Get(line, "end"))
			if !jscompat.IsRecord(line) || !startOK || !endOK || !(end > window.Start && start < window.End) {
				continue
			}
			entry := Line{Start: start, End: end}
			if number, ok := jscompat.Get(line, "source_line").(float64); ok && jscompat.IsInteger(number) && number > 0 && number <= float64(len(text)) {
				value := jscompat.Trim(text[int(number)-1])
				entry.Text = &value
			}
			lines = append(lines, entry)
		}
	}
	length := window.End - window.Start
	if limits.RequestSeconds != nil {
		length = math.Max(length, *limits.RequestSeconds)
	} else {
		length = math.Max(length, 0)
	}
	if limits.LipSync != nil {
		length = math.Max(length, limits.LipSync.Min)
	} else {
		length = math.Max(length, 0)
	}
	proposed := Interval{Start: round3(window.Start), End: round3(window.Start + length)}
	return Plan{Shot: shot, Window: window, Lines: lines, Proposed: &proposed, LipSync: limits.LipSync}, nil
}

// ReadPackage — readPackageSpeech(packageDir): подготовленный срез пакета или nil. Без рецепта,
// с неверными границами, именем с разделителем пути или без файла WAV считается, что среза нет.
func ReadPackage(packageDir string) *Package {
	recipePath := filepath.Join(packageDir, "audio", "audio-recipe.json")
	recipe := readJSON(recipePath)
	interval, isInterval := jscompat.AsArray(jscompat.Get(recipe, "source_interval_seconds"))
	output := jscompat.Get(recipe, "output")
	if !jscompat.IsRecord(recipe) || !isInterval || !jscompat.IsRecord(output) {
		return nil
	}
	item := func(index int) any {
		if index < len(interval) {
			return interval[index]
		}
		return jscompat.Undefined
	}
	start, startOK := finite(item(0))
	end, endOK := finite(item(1))
	name, nameOK := jscompat.Get(output, "path").(string)
	if !startOK || !endOK || !nameOK || strings.ContainsAny(name, `/\`) {
		return nil
	}
	path := filepath.Join(packageDir, "audio", name)
	if !jscompat.Exists(path) {
		return nil
	}
	lines := []Line{}
	if list, ok := jscompat.AsArray(jscompat.Get(recipe, "timing_lines")); ok {
		for _, line := range list {
			lineStart, startOK := finite(jscompat.Get(line, "start"))
			lineEnd, endOK := finite(jscompat.Get(line, "end"))
			if !jscompat.IsRecord(line) || !startOK || !endOK {
				continue
			}
			entry := Line{Start: lineStart, End: lineEnd}
			if text, ok := jscompat.Get(line, "text").(string); ok {
				entry.Text = &text
			}
			lines = append(lines, entry)
		}
	}
	return &Package{Path: path, Recipe: recipePath, Start: start, End: end, Lines: lines}
}
