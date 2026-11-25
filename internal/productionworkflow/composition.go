package productionworkflow

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
	"songframe/internal/viewframe"
)

// Снимок вида из камеры — «схема композиции» опор плана с точкой съёмки. Серая болванка объёма схемы локации из
// точки камеры держит у генератора изображений ракурс, высоту камеры, горизонт, места и размеры героев, которые
// текст фактов кадра передаёт хуже. Объём рисует только интерфейс (WebGL), поэтому снимок делает он: вид плана
// отдаёт всё, из чего снимок строится, и отпечаток этих данных; интерфейс рисует нужные кадры и сохраняет их
// в пакет попытки (plan/batches, вне Git клипа) вместе с отпечатком. Снимок свежий, пока отпечаток совпадает:
// смена точки съёмки, схемы или фигур героев делает его устаревшим, и интерфейс снимает заново. Генерация опор
// провайдером-агентом передаёт свежий снимок агенту (mediaapi.ImagesInput.Composition); платный провайдер одной
// опоры его не получает — серый стиль болванки мог бы перейти в результат. Выключатель в шаге опор пишет в
// workflow.json попытки composition_snapshot: false; без поля снимок включён.

const (
	// compositionRecord — запись сохранённого снимка в пакете: отпечаток и файлы кадров.
	compositionRecord = "composition.json"
	// compositionKey — поле workflow.json: false — снимок выключен для попытки.
	compositionKey = "composition_snapshot"
	// compositionVersion — версия отпечатка: меняется вместе с тем, как интерфейс рисует болванку.
	compositionVersion = "3"
)

// CompositionView — снимок вида из камеры в виде плана (View.Composition): включён ли, отпечаток и данные для
// рисования, кадры (start и, если кадр меняется, end) и сохранённые свежие файлы.
type CompositionView struct {
	Enabled   bool               `json:"enabled"`
	Digest    string             `json:"digest"`
	Phases    []string           `json:"phases"`
	Viewpoint json.RawMessage    `json:"viewpoint"`
	Scheme    json.RawMessage    `json:"scheme"`
	Heights   map[string]float64 `json:"heights"`
	Vehicles  []string           `json:"vehicles"`
	// Frames — сохранённые снимки, если они свежие; пусто — снимка нет или он устарел.
	Frames []CompositionFrame `json:"frames"`
	// figures — сколько героев точки съёмки стоит на болванке (персонажи и транспорт).
	figures int
}

// CompositionFrame — сохранённый снимок кадра phase (start или end), абсолютный путь PNG.
type CompositionFrame struct {
	Phase string `json:"phase"`
	Path  string `json:"path"`
}

// CompositionImage — снимок кадра от интерфейса: phase и PNG в base64.
type CompositionImage struct {
	Phase string `json:"phase"`
	Data  string `json:"data"`
}

// compositionViewpoint — точка съёмки, из которой можно снять вид: камера на схеме, не сверху, есть схема
// локации и пакет попытки.
func (c *Context) compositionViewpoint() (viewframe.Viewpoint, bool) {
	if c.Viewpoint == nil || c.LocationScheme == nil || c.PackageDir == "" {
		return viewframe.Viewpoint{}, false
	}
	viewpoint, err := viewframe.ParseViewpoint(c.Viewpoint)
	if err != nil || viewpoint.Camera == nil || viewpoint.Side == "top" {
		return viewframe.Viewpoint{}, false
	}
	return viewpoint, true
}

// composition — снимок для вида плана; nil — снимать нечего или провайдер изображений не агент (agentImages).
func (c *Context) composition(agentImages bool) (*CompositionView, error) {
	viewpoint, ok := c.compositionViewpoint()
	if !ok || !agentImages {
		return nil, nil
	}
	heights := map[string]float64{}
	vehicles := []string{}
	for _, subject := range viewpoint.Subjects {
		if height, ok := c.Figures.Heights[subject.Entity]; ok {
			heights[subject.Entity] = height
		}
		if c.Figures.Vehicles[subject.Entity] {
			vehicles = append(vehicles, subject.Entity)
		}
	}
	viewpointJSON := json.RawMessage(dynvalue.Stringify(c.Viewpoint))
	schemeJSON, err := json.Marshal(c.LocationScheme)
	if err != nil {
		return nil, err
	}
	phases := []string{viewframe.PhaseStart}
	if viewpoint.Changes() {
		phases = append(phases, viewframe.PhaseEnd)
	}
	digestJSON, err := json.Marshal(map[string]any{
		"version": compositionVersion, "viewpoint": viewpointJSON, "scheme": json.RawMessage(schemeJSON), "heights": heights, "vehicles": vehicles, "phases": phases,
	})
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(digestJSON)
	view := &CompositionView{
		Enabled: c.workflowValue(compositionKey) != false, Digest: hex.EncodeToString(sum[:]), Phases: phases,
		Viewpoint: viewpointJSON, Scheme: schemeJSON, Heights: heights, Vehicles: vehicles, Frames: []CompositionFrame{},
		figures: len(viewpoint.Subjects),
	}
	view.Frames = c.freshComposition(view.Digest, phases)
	return view, nil
}

// freshComposition — сохранённые снимки пакета, если запись совпадает с отпечатком digest и есть файл каждого
// кадра phases; иначе пусто.
func (c *Context) freshComposition(digest string, phases []string) []CompositionFrame {
	record, err := readJSON(filepath.Join(c.PackageDir, compositionRecord))
	if err != nil || dynvalue.Get(record, "digest") != digest {
		return []CompositionFrame{}
	}
	frames := []CompositionFrame{}
	for _, phase := range phases {
		path := filepath.Join(c.PackageDir, compositionFile(phase))
		if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
			return []CompositionFrame{}
		}
		frames = append(frames, CompositionFrame{Phase: phase, Path: path})
	}
	return frames
}

// compositionFile — имя файла снимка кадра phase в пакете.
func compositionFile(phase string) string {
	return "composition-" + phase + ".png"
}

// compositionFor — свежий снимок для опоры с ролью role: последняя берёт кадр end, если он есть, остальные — start.
// Второе значение false — снимок выключен или его нет; ошибка — включён, но устарел или не сохранён.
func compositionFor(view *CompositionView, role string) (CompositionFrame, bool, error) {
	if view == nil || !view.Enabled {
		return CompositionFrame{}, false, nil
	}
	if len(view.Frames) == 0 {
		return CompositionFrame{}, false, errors.New(textCompositionStale)
	}
	frame := view.Frames[0]
	if role == "last" {
		frame = view.Frames[len(view.Frames)-1]
	}
	return frame, true, nil
}

// agentImageProvider — провайдер изображений проекта создаёт опоры заданием агента (у него есть исполнитель).
func agentImageProvider(generation any) bool {
	provider, _ := dynvalue.Get(dynvalue.Get(generation, "image"), "provider").(string)
	info, ok := mediaproviders.Lookup(provider)
	return ok && info.Executor != ""
}

// SaveComposition сохраняет снимки вида из камеры плана shot в пакет packageDir: digest — отпечаток, по которому
// интерфейс рисовал, images — PNG каждого кадра снимка. Отпечаток, разошедшийся с текущим (точку съёмки успели
// поменять), отклоняется: интерфейс снимет заново по новому виду.
func (w *Workflow) SaveComposition(project, shot, packageDir, digest string, images []CompositionImage) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	if view.PackageDir == nil || view.Composition == nil {
		return View{}, errors.New(textCompositionUnavailable)
	}
	if view.Composition.Digest != digest {
		return View{}, errors.New(textCompositionStale)
	}
	files := map[string][]byte{}
	for _, image := range images {
		data, err := base64.StdEncoding.DecodeString(image.Data)
		if err != nil || !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) || !slices.Contains(view.Composition.Phases, image.Phase) {
			return View{}, errors.New(textCompositionInvalid)
		}
		files[image.Phase] = data
	}
	if len(files) != len(view.Composition.Phases) {
		return View{}, errors.New(textCompositionInvalid)
	}
	dir := *view.PackageDir
	for phase, data := range files {
		if err := os.WriteFile(filepath.Join(dir, compositionFile(phase)), data, 0o666); err != nil {
			return View{}, err
		}
	}
	record := dynvalue.NewObject()
	record.Set("schemaVersion", float64(1))
	record.Set("digest", digest)
	if err := writeProjectJSON(filepath.Join(dir, compositionRecord), record); err != nil {
		return View{}, err
	}
	return w.view(project, shot, dir)
}

// SetComposition включает или выключает снимок вида из камеры для попытки packageDir плана shot.
func (w *Workflow) SetComposition(project, shot, packageDir string, enabled bool) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	if view.PackageDir == nil || view.Composition == nil {
		return View{}, errors.New(textCompositionUnavailable)
	}
	workflow, err := packageDocument(*view.PackageDir, textWorkflowMissing)
	if err != nil {
		return View{}, err
	}
	if enabled {
		workflow.Delete(compositionKey)
	} else {
		workflow.Set(compositionKey, false)
	}
	if err := writeProjectJSON(filepath.Join(*view.PackageDir, "workflow.json"), workflow); err != nil {
		return View{}, err
	}
	return w.view(project, shot, *view.PackageDir)
}
