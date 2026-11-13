package components

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// Selection хранит в каталоге состояния только явно выбранные пути; пустое поле разрешает обнаружение.
// FFmpegDirectory содержит пару программ, ORTDirectory — корень внешнего runtime с библиотекой в lib/.
// ORTLibraryFile и отдельные CTC-файлы имеют приоритет над общими папками; выбор одного файла не меняет соседа.
type Selection struct {
	FFmpegDirectory  string `json:"ffmpegDirectory"`
	ORTDirectory     string `json:"ortDirectory"`
	ORTLibraryFile   string `json:"ortLibraryFile"`
	VocalsFile       string `json:"vocalsFile"`
	CTCDirectory     string `json:"ctcDirectory"`
	CTCModelFile     string `json:"ctcModelFile"`
	CTCVocabFile     string `json:"ctcVocabFile"`
	ManagedDirectory string `json:"managedDirectory"`
}

// ComponentState отделяет найденные файлы от функциональной готовности.
// Paths фиксируются для операции; Source не разрешает удаление внешних файлов.
type ComponentState struct {
	ID      string            `json:"id"`
	Status  string            `json:"status"`
	Reason  string            `json:"reason"`
	Source  string            `json:"source"`
	Paths   map[string]string `json:"paths"`
	Version string            `json:"version"`
}

// OperationState объясняет недоступность конкретной функции без блокировки чтения проекта.
type OperationState struct {
	ID       string   `json:"id"`
	Status   string   `json:"status"`
	Reason   string   `json:"reason"`
	Requires []string `json:"requires"`
}

// Snapshot — независимый снимок обнаружения; State не запускает процессы и не хеширует веса.
type Snapshot struct {
	Selection  Selection        `json:"selection"`
	Components []ComponentState `json:"components"`
	Operations []OperationState `json:"operations"`
	Checking   bool             `json:"checking"`
	Problem    string           `json:"problem"`
}

// candidate связывает публичный статус с проверяемым составом и fingerprint метаданных.
// Signature меняется при переносе, исчезновении, размере или времени модификации файла.
type candidate struct {
	state     ComponentState
	artifact  Artifact
	files     map[string]string
	signature string
}

// checkedState кэширует подтверждение только для неизменного набора файлов текущего сеанса.
// После перезапуска явная проверка повторяется, а просмотр страниц не перечитывает веса.
type checkedState struct {
	signature string
	status    string
	reason    string
	version   string
}

// managerOptions выделяет только реальные границы ОС и процессов для контрактных проверок.
type managerOptions struct {
	os       string
	arch     string
	lookPath func(string) (string, error)
	media    func(context.Context, Manifest, FFmpegPair) (MediaReport, error)
	ort      func(context.Context, string, []ModelFile) (ORTReport, error)
}

// Manager владеет настройками компонентов в каталоге состояния и проверками по запросу.
// Создание/State не загружают ORT и не скачивают пакеты; установка имеет отдельное состояние и отмену.
type Manager struct {
	mu              sync.Mutex
	work            sync.Mutex
	profile         string
	manifest        Manifest
	options         managerOptions
	selection       Selection
	problem         string
	checked         map[string]checkedState
	hashes          map[string]string
	rejectedManaged string
	mediaSignature  string
	mediaOperations map[string]ProbeOutcome
	cancel          context.CancelFunc
	installation    InstallSnapshot
	installCancel   context.CancelFunc
	installOptions  installOptions
}

// NewManager читает только настройки компонентов из каталога состояния profile.
// Повреждённая настройка остаётся диагностикой, а не причиной отказа запуска окна.
func NewManager(profile string) (*Manager, error) {
	manifest, err := Load()
	if err != nil {
		return nil, err
	}
	return newManager(profile, manifest, managerOptions{runtime.GOOS, runtime.GOARCH, exec.LookPath, ProbeFFmpeg, CheckORT}), nil
}

// newManager подменяет платформенные границы в тестах, сохраняя тот же порядок обнаружения.
func newManager(profile string, manifest Manifest, options managerOptions) *Manager {
	m := &Manager{profile: profile, manifest: manifest, options: options, checked: map[string]checkedState{}, hashes: map[string]string{}, mediaOperations: map[string]ProbeOutcome{}}
	m.initializeInstallation()
	data, err := os.ReadFile(filepath.Join(profile, "components.json"))
	if errors.Is(err, os.ErrNotExist) {
		return m
	}
	if err != nil {
		m.problem = "Не удалось прочитать настройки компонентов: " + err.Error()
		return m
	}
	if err = json.Unmarshal(data, &m.selection); err != nil {
		m.selection = Selection{}
		m.problem = "Повреждены настройки компонентов: " + err.Error()
	}
	return m
}

// ErrBusy распознаёт отказ Check/Install из-за уже идущей проверки или установки (errors.Is).
// Фоновые задания (разметка, загрузка моделей) по нему ждут и повторяют, а не падают.
var ErrBusy = errors.New("компоненты заняты другой проверкой или установкой")

// busyError сохраняет прежний текст сообщения для UI и отвечает на errors.Is(err, ErrBusy).
type busyError struct{ text string }

func (e *busyError) Error() string        { return e.text }
func (e *busyError) Is(target error) bool { return target == ErrBusy }

// Configure атомарно сохраняет выбор, сохраняя проверки неизменившихся файлов по fingerprint.
// Во время проверки или установки выбор отклоняется; соответствующая отмена остаётся доступной.
func (m *Manager) Configure(selection Selection) (Snapshot, error) {
	if !m.work.TryLock() {
		return m.State(), fmt.Errorf("сначала остановите проверку или установку компонентов")
	}
	defer m.work.Unlock()
	return m.configureLocked(selection)
}

// configureLocked сохраняет выбор под уже захваченным work, в том числе после успешной установки.
// Подтверждения неизменных реальных файлов сохраняются и при автоматическом переходе на managed.
func (m *Manager) configureLocked(selection Selection) (Snapshot, error) {
	for _, p := range []*string{&selection.FFmpegDirectory, &selection.ORTDirectory, &selection.ORTLibraryFile, &selection.VocalsFile, &selection.CTCDirectory, &selection.CTCModelFile, &selection.CTCVocabFile, &selection.ManagedDirectory} {
		if *p != "" {
			value, err := filepath.Abs(*p)
			if err != nil {
				return m.State(), err
			}
			*p = value
		}
	}
	data, err := json.MarshalIndent(selection, "", "  ")
	if err != nil {
		return m.State(), err
	}
	if err = os.MkdirAll(m.profile, 0o700); err != nil {
		return m.State(), fmt.Errorf("папка настроек компонентов: %w", err)
	}
	temp, err := os.CreateTemp(m.profile, ".components-*.tmp")
	if err != nil {
		return m.State(), err
	}
	name := temp.Name()
	defer os.Remove(name)
	_, err = temp.Write(append(data, '\n'))
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, filepath.Join(m.profile, "components.json"))
	}
	if err != nil {
		return m.State(), fmt.Errorf("сохранение выбора компонентов: %w", err)
	}
	m.mu.Lock()
	m.selection = selection
	m.problem = ""
	// Все подтверждения привязаны к реальным paths/size/mtime: чужое поле настройки
	// не повод заново читать веса или создавать sessions, новые файлы теряют ready сами.
	m.mu.Unlock()
	return m.State(), nil
}

// State выполняет только stat/LookPath и возвращает причины по каждой операции.
// Изменённый файл теряет ready даже без явной повторной проверки.
func (m *Manager) State() Snapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	candidates := m.discover()
	result := Snapshot{Selection: m.selection, Components: []ComponentState{}, Operations: []OperationState{}, Checking: m.cancel != nil, Problem: m.problem}
	states := map[string]ComponentState{}
	for _, c := range candidates {
		state := c.state
		if saved, ok := m.checked[state.ID]; ok && saved.signature == c.signature && state.Status == "unchecked" {
			state.Status = saved.status
			state.Reason = saved.reason
			state.Version = saved.version
		}
		if m.problem != "" {
			state.Status = "error"
			state.Reason = m.problem
		}
		states[state.ID] = state
		result.Components = append(result.Components, state)
	}
	for _, op := range m.operations() {
		outcome := ProbeOutcome{Status: "ready", Reason: "Компоненты не требуются."}
		for _, dependency := range op.Requires {
			state := states[dependency]
			current := ProbeOutcome{Status: state.Status, Reason: state.Reason}
			if dependency == "ffmpeg" && m.mediaSignature == candidates[0].signature && candidates[0].state.Status == "unchecked" {
				id := op.ID
				if id == "known-text-ctc" || id == "ctc-existing-vocals" || id == "prepare-vocals" {
					id = "audio-pcm"
				}
				if media, ok := m.mediaOperations[id]; ok {
					current = media
				}
			}
			if current.Status != "ready" {
				outcome = ProbeOutcome{Status: current.Status, Reason: dependency + ": " + current.Reason}
				break
			}
			outcome = ProbeOutcome{Status: "ready", Reason: "Компоненты проверены."}
		}
		op.Status = outcome.Status
		op.Reason = outcome.Reason
		result.Operations = append(result.Operations, op)
	}
	return result
}

// operations дополняет manifest независимыми функциями чтения и CTC по готовому вокалу.
// Существующий WAV не требует повторной подготовки Voc FT.
func (m *Manager) operations() []OperationState {
	ops := []OperationState{{ID: "project-view", Requires: []string{}}, {ID: "timing-view", Requires: []string{}}}
	for _, cap := range m.manifest.Capabilities {
		ops = append(ops, OperationState{ID: cap.ID, Requires: append([]string{}, cap.Requires...)})
	}
	return append(ops, OperationState{ID: "prepare-vocals", Requires: []string{"ffmpeg", "ort-cpu", "voc-ft"}}, OperationState{ID: "ctc-existing-vocals", Requires: []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"}})
}

// discover соблюдает явный путь → управляемая версия → PATH только для FFmpeg.
// Если выбранный пользователем путь исчез, другой источник молча не подставляется.
func (m *Manager) discover() []candidate {
	result := []candidate{}
	for _, id := range []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		a, found := m.artifact(id)
		c := candidate{state: ComponentState{ID: id, Status: "missing", Reason: "Компонент не найден.", Paths: map[string]string{}}, artifact: a, files: map[string]string{}}
		if !found && id != "ffmpeg" {
			c.state.Status = "incompatible"
			c.state.Reason = "Нет подтверждённого пакета для этой платформы."
			result = append(result, c)
			continue
		}
		explicit, explicitFile := "", ""
		switch id {
		case "ffmpeg":
			explicit = m.selection.FFmpegDirectory
		case "ort-cpu":
			explicit, explicitFile = m.selection.ORTDirectory, m.selection.ORTLibraryFile
		case "voc-ft":
			explicitFile = m.selection.VocalsFile
		case "ctc-ru":
			explicit, explicitFile = m.selection.CTCDirectory, m.selection.CTCModelFile
		case "ctc-vocab":
			explicit, explicitFile = m.selection.CTCDirectory, m.selection.CTCVocabFile
		}
		managed := m.selection.ManagedDirectory
		if managed == "" {
			managed = filepath.Join(m.profile, "components")
		}
		managed = managedArtifactDirectory(managed, a)
		base := managed
		c.state.Source = "managed"
		if explicit != "" || explicitFile != "" {
			base = explicit
			c.state.Source = "explicit"
		}
		if id == "ffmpeg" && explicit != "" {
			extension := ""
			if m.options.os == "windows" {
				extension = ".exe"
			}
			c.state.Paths = map[string]string{"ffmpeg": filepath.Join(base, "ffmpeg"+extension), "ffprobe": filepath.Join(base, "ffprobe"+extension)}
			c.files = map[string]string{"ffmpeg": c.state.Paths["ffmpeg"], "ffprobe": c.state.Paths["ffprobe"]}
		} else {
			for _, f := range a.Files {
				name := filepath.Join(base, filepath.FromSlash(f.Path))
				if explicitFile != "" && (id != "ort-cpu" || f.Path == a.Entrypoints["ort-library"]) {
					name = explicitFile
				}
				c.files[f.Path] = name
			}
			for role, name := range a.Entrypoints {
				c.state.Paths[role] = c.files[name]
			}
			if id == "ort-cpu" && c.state.Source == "explicit" {
				// У внешней установки проверяется открываемая библиотека и native ABI,
				// а notices и aliases принадлежат целостности нашего управляемого пакета.
				entrypoint := a.Entrypoints["ort-library"]
				c.files = map[string]string{entrypoint: c.state.Paths["ort-library"]}
			}
		}
		// Непригодная управляемая версия не затеняет подходящую системную пару.
		// Только явный пользовательский путь запрещает переход к другому источнику.
		if id == "ffmpeg" && explicit == "" {
			complete := found && len(c.files) > 0
			for _, name := range c.files {
				info, err := os.Stat(name)
				if err != nil || !info.Mode().IsRegular() {
					complete = false
					break
				}
			}
			if !complete || signature(c.files) == m.rejectedManaged {
				c.state.Source = "path"
				c.files = map[string]string{}
				c.state.Paths = map[string]string{}
				for _, role := range []string{"ffmpeg", "ffprobe"} {
					name, err := m.options.lookPath(role)
					if err == nil {
						absolute, e := filepath.Abs(name)
						if e == nil {
							name = absolute
						}
						c.files[role] = name
						c.state.Paths[role] = name
					}
				}
			}
		}

		c.signature = signature(c.files)
		c.state.Status = "unchecked"
		c.state.Reason = "Готовность найденных файлов ещё не подтверждена."
		if len(c.files) == 0 {
			c.state.Status = "missing"
			c.state.Reason = "FFmpeg и ffprobe не найдены в PATH."
		}
		if id == "ffmpeg" && len(c.state.Paths) < 2 {
			c.state.Status = "missing"
			c.state.Reason = "Не найдена полная пара FFmpeg/ffprobe."
		}
		// Сначала проверяются рабочие entrypoints: отсутствие runtime не должно
		// объясняться отсутствием LICENSE. Остальной состав имеет стабильный порядок.
		for _, key := range candidateFileOrder(c) {
			name := c.files[key]
			info, err := os.Stat(name)
			if err != nil || !info.Mode().IsRegular() {
				c.state.Status = "missing"
				c.state.Reason = "Не найден обязательный файл: " + name
				if id == "ort-cpu" && name == c.state.Paths["ort-library"] {
					c.state.Reason = "Не найдена библиотека ONNX Runtime: " + name
				}
				break
			}
		}
		result = append(result, c)
	}
	return result
}

// candidateFileOrder ставит operational entrypoints перед лицензионными материалами.
// Явный порядок ролей и сортировка остальных файлов стабилизируют причины при опросе UI.
func candidateFileOrder(c candidate) []string {
	keys := make([]string, 0, len(c.files))
	all := make([]string, 0, len(c.files))
	for key := range c.files {
		all = append(all, key)
	}
	sort.Strings(all)
	seen := map[string]bool{}
	for _, role := range []string{"ffmpeg", "ffprobe", "ort-library", "model", "vocab"} {
		entrypoint := c.state.Paths[role]
		if entrypoint == "" {
			continue
		}
		for _, key := range all {
			if c.files[key] == entrypoint && !seen[key] {
				keys = append(keys, key)
				seen[key] = true
				break
			}
		}
	}
	rest := make([]string, 0, len(c.files))
	for _, key := range all {
		if !seen[key] {
			rest = append(rest, key)
		}
	}
	return append(keys, rest...)
}

// artifact выбирает только закреплённые OS/arch; модели общие для платформ.
func (m *Manager) artifact(component string) (Artifact, bool) {
	for _, a := range m.manifest.Artifacts {
		if a.Component == component && ((a.OS == m.options.os && a.Arch == m.options.arch) || (a.OS == "any" && a.Arch == "any")) {
			return a, true
		}
	}
	return Artifact{}, false
}

// signature фиксирует stat всех файлов без чтения больших весов; порядок задаётся сортировкой JSON.
func signature(files map[string]string) string { return signatureAt(files, files) }

// signatureAt читает metadata фактических файлов, подставляя известные прежние пути в fingerprint.
// Установщик так подтверждает неизменность проверенного staging после атомарного rename без повторного SHA.
func signatureAt(files, labels map[string]string) string {
	records := map[string]string{}
	for key, name := range files {
		label := labels[key]
		info, err := os.Stat(name)
		if err != nil {
			records[key] = label + "|" + err.Error()
			continue
		}
		records[key] = fmt.Sprintf("%s|%d|%d|%s", label, info.Size(), info.ModTime().UnixNano(), info.Mode())
	}
	data, _ := json.Marshal(records)
	return string(data)
}

// Cancel останавливает только проверку компонентов; чтение проектов от неё не зависит.
func (m *Manager) Cancel() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cancel != nil {
		m.cancel()
	}
}

// Check проверяет зависимости выбранных функций без скачивания или изменения исходных файлов.
// Force заново хеширует набор; обычный повтор использует подтверждение неизменных метаданных.
func (m *Manager) Check(ctx context.Context, operationIDs []string, force bool) (result Snapshot, resultErr error) {
	if !m.work.TryLock() {
		return m.State(), &busyError{"проверка или установка компонентов уже выполняется"}
	}
	defer m.work.Unlock()
	needed := map[string]bool{}
	known := map[string]bool{}
	for _, op := range m.operations() {
		known[op.ID] = true
		for _, id := range operationIDs {
			if id == op.ID {
				for _, dep := range op.Requires {
					needed[dep] = true
				}
			}
		}
	}
	for _, id := range operationIDs {
		if !known[id] {
			return m.State(), fmt.Errorf("неизвестная операция: %s", id)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	m.mu.Lock()
	if m.problem != "" {
		problem := m.problem
		m.mu.Unlock()
		return m.State(), errors.New(problem)
	}
	m.cancel = cancel
	score, total := mediaScore(MediaReport{Operations: m.mediaOperations}, operationIDs)
	current := m.discover()[0]
	if force || (m.rejectedManaged != "" && (score < total || current.state.Status != "unchecked" || current.signature != m.mediaSignature)) {
		m.rejectedManaged = ""
	}
	candidates := m.discover()
	m.mu.Unlock()
	defer func() { m.mu.Lock(); m.cancel = nil; result.Checking = false; m.mu.Unlock() }()
	var failures []string
	models := []ModelFile{}
	for _, c := range candidates {
		if !needed[c.state.ID] {
			continue
		}
		if c.state.Status != "unchecked" {
			failures = append(failures, c.state.Reason)
			continue
		}
		if c.state.ID == "ffmpeg" {
			if err := m.checkMedia(ctx, c, force, operationIDs); err != nil {
				failures = append(failures, err.Error())
			}
			continue
		}
		if err := m.verifyFiles(ctx, c, force); err != nil {
			m.save(c, errorStatus(ctx), err.Error(), "")
			failures = append(failures, err.Error())
			continue
		}
		if c.state.ID == "ctc-vocab" {
			if err := verifyVocab(c.state.Paths["vocab"]); err != nil {
				m.save(c, "incompatible", err.Error(), "")
				failures = append(failures, err.Error())
				continue
			}
			m.save(c, "ready", "SHA и согласованный словарь проверены.", c.artifact.Version)
		} else if c.state.ID != "ort-cpu" {
			models = append(models, ModelFile{Artifact: c.artifact, Path: c.state.Paths["model"]})
		}
	}
	if needed["ort-cpu"] {
		ort := candidates[1]
		m.mu.Lock()
		verified, ok := m.hashes[ort.signature]
		m.mu.Unlock()

		m.mu.Lock()
		savedRuntime := m.checked["ort-cpu"]
		already := !force && savedRuntime.signature == ort.signature && savedRuntime.status == "ready"
		for _, model := range models {
			for _, c := range candidates {
				if c.state.ID == model.Artifact.Component {
					saved := m.checked[c.state.ID]
					already = already && saved.signature == c.signature && saved.status == "ready"
				}
			}
		}
		m.mu.Unlock()
		if ort.state.Status == "unchecked" && ok && verified == "verified" && ctx.Err() == nil && !already {
			report, err := m.options.ort(ctx, ort.state.Paths["ort-library"], models)
			if err != nil {
				status := errorStatus(ctx)
				if report.RestartRequired {
					status = "restart_required"
				}
				m.save(ort, status, err.Error(), report.Version)
				if ctx.Err() != nil {
					for _, c := range candidates {
						for _, model := range models {
							if c.state.ID == model.Artifact.Component {
								m.save(c, "cancelled", err.Error(), "")
							}
						}
					}
				}
				failures = append(failures, err.Error())
			} else {
				m.save(ort, "ready", fmt.Sprintf("ORT CPU API %d проверен.", report.API), report.Version)
				for _, c := range candidates {
					if outcome, ok := report.Models[c.state.ID]; ok {
						m.save(c, outcome.Status, outcome.Reason, c.artifact.Version)
					}
				}
			}
		}
		if ctx.Err() == nil {
			m.waitForRuntime(candidates, models)
		}
	}
	if ctx.Err() != nil {
		return m.State(), ctx.Err()
	}
	if len(failures) > 0 {
		return m.State(), fmt.Errorf("компоненты: %s", strings.Join(failures, "; "))
	}
	return m.State(), nil
}

// waitForRuntime даёт проверенной по SHA модели конечное состояние ожидания зависимости.
// Собственные ошибки SHA/графа не заменяются ожиданием ORT; следующий Check использует прежний SHA и запускает native session после появления runtime.
func (m *Manager) waitForRuntime(candidates []candidate, models []ModelFile) {
	var runtime ComponentState
	for _, state := range m.State().Components {
		if state.ID == "ort-cpu" {
			runtime = state
			break
		}
	}
	if runtime.Status == "ready" {
		return
	}
	verified := map[string]bool{}
	for _, model := range models {
		verified[model.Artifact.Component] = true
	}
	for _, c := range candidates {
		if !verified[c.state.ID] {
			continue
		}
		m.mu.Lock()
		saved := m.checked[c.state.ID]
		m.mu.Unlock()
		if saved.signature == c.signature && (saved.status == "incompatible" || saved.status == "error") {
			continue
		}
		reason := "Файл модели проверен. Для проверки и работы модели нужен ONNX Runtime CPU: " + runtime.Reason
		m.save(c, "blocked", reason, c.artifact.Version)
	}
}

// save публикует подтверждение только если файлы не изменились во время проверки.
func (m *Manager) save(c candidate, status, reason, version string) {
	if signature(c.files) != c.signature {
		status = "incompatible"
		reason = "Файлы изменились во время проверки."
	}
	m.mu.Lock()
	m.checked[c.state.ID] = checkedState{c.signature, status, reason, version}
	m.mu.Unlock()
}

// errorStatus отличает отменённую операцию от несовместимого компонента.
func errorStatus(ctx context.Context) string {
	if ctx.Err() != nil {
		return "cancelled"
	}
	return "incompatible"
}

// verifyFiles хеширует управляемый пакет и все модели; внешние программы проверяются по функциям.
// Кэш хранится только в памяти и сбрасывается по изменённым stat/путям или Force.
func (m *Manager) verifyFiles(ctx context.Context, c candidate, force bool) error {
	if c.state.ID == "ffmpeg" && c.state.Source != "managed" {
		return nil
	}
	m.mu.Lock()
	cached := m.hashes[c.signature] == "verified"
	m.mu.Unlock()
	if cached && !force {
		return nil
	}
	m.mu.Lock()
	delete(m.hashes, c.signature)
	m.mu.Unlock()
	if c.state.ID == "ort-cpu" && c.state.Source == "explicit" {
		if err := verifyExternalORTFile(ctx, c); err != nil {
			return err
		}
		m.mu.Lock()
		m.hashes[c.signature] = "verified"
		m.mu.Unlock()
		return nil
	}
	for _, file := range c.artifact.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := c.files[file.Path]
		if file.Type == "symlink" {
			target, err := os.Readlink(name)
			if err != nil || target != file.Target {
				return fmt.Errorf("неверная ссылка %s", name)
			}
			continue
		}
		f, err := os.Open(name)
		if err != nil {
			return err
		}
		// Неверный размер сразу исключает закреплённый файл: случайно выбранное
		// большое медиа не нужно целиком читать ради заранее невозможного SHA.
		info, statErr := f.Stat()
		if statErr != nil {
			f.Close()
			return statErr
		}
		if info.Size() != file.Bytes {
			f.Close()
			return fmt.Errorf("файл не совпадает с закреплённым SHA/размером: %s", name)
		}
		hash := sha256.New()
		buffer := make([]byte, 256*1024)
		var count int64
		for {
			if err = ctx.Err(); err != nil {
				break
			}
			var n int
			n, err = f.Read(buffer)
			if n > 0 {
				hash.Write(buffer[:n])
				count += int64(n)
			}
			if err == io.EOF {
				err = nil
				break
			}
			if err != nil {
				break
			}
		}
		f.Close()
		if err != nil {
			return err
		}
		if count != file.Bytes || hex.EncodeToString(hash.Sum(nil)) != file.SHA256 {
			return fmt.Errorf("файл не совпадает с закреплённым SHA/размером: %s", name)
		}
	}
	if signature(c.files) != c.signature {
		return fmt.Errorf("состав компонента изменился во время проверки")
	}
	m.mu.Lock()
	m.hashes[c.signature] = "verified"
	m.mu.Unlock()
	return nil
}

// verifyExternalORTFile проверяет открытие выбранной библиотеки без требований к упаковке поставщика.
// Допустимость ABI, CPU provider и зависимостей подтверждает CheckORT; models сохраняют SHA из lock.
func verifyExternalORTFile(ctx context.Context, c candidate) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	library := c.state.Paths["ort-library"]
	f, err := os.Open(library)
	if err != nil {
		return fmt.Errorf("не удалось открыть библиотеку ONNX Runtime: %w", err)
	}
	info, statErr := f.Stat()
	closeErr := f.Close()
	if statErr != nil {
		return statErr
	}
	if closeErr != nil {
		return closeErr
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("библиотека ONNX Runtime должна быть обычным файлом: %s", library)
	}
	if signature(c.files) != c.signature {
		return fmt.Errorf("библиотека ONNX Runtime изменилась во время проверки")
	}
	return ctx.Err()
}

// verifyVocab проверяет соглашение о blank/separator и непрерывных ID, не загружая модель.
func verifyVocab(name string) error {
	data, err := os.ReadFile(name)
	if err != nil {
		return err
	}
	values := map[string]int{}
	if err = json.Unmarshal(data, &values); err != nil {
		return err
	}
	if len(values) != 39 || values["<pad>"] != 0 || values["|"] != 4 || values["ё"] != 6 {
		return fmt.Errorf("словарь не соответствует закреплённым 39 классам")
	}
	seen := map[int]bool{}
	for _, id := range values {
		if id < 0 || id >= 39 || seen[id] {
			return fmt.Errorf("повторный или неверный ID словаря")
		}
		seen[id] = true
	}
	return nil
}

// checkMedia при отказе управляемого пакета пробует PATH, сохраняя явный выбор пользователя.
// Ошибка новой проверки уничтожает прежнее подтверждение, даже если stat бинарника не изменился.
func (m *Manager) checkMedia(ctx context.Context, c candidate, force bool, wanted []string) error {
	for attempt := 0; attempt < 2; attempt++ {
		m.mu.Lock()
		cached := m.mediaSignature == c.signature && len(m.mediaOperations) > 0
		cachedScore, total := mediaScore(MediaReport{Operations: m.mediaOperations}, wanted)
		m.mu.Unlock()
		if cached && !force && (c.state.Source != "managed" || cachedScore == total) {
			return nil
		}
		m.mu.Lock()
		m.mediaSignature = ""
		m.mediaOperations = map[string]ProbeOutcome{}
		m.mu.Unlock()
		err := m.verifyFiles(ctx, c, force)
		var report MediaReport
		if err == nil {
			report, err = m.options.media(ctx, m.manifest, FFmpegPair{FFmpeg: c.state.Paths["ffmpeg"], FFprobe: c.state.Paths["ffprobe"]})
		}
		if err != nil {
			if c.state.Source == "managed" && ctx.Err() == nil {
				m.mu.Lock()
				m.rejectedManaged = c.signature
				next := m.discover()[0]
				m.mu.Unlock()
				if next.state.Status == "unchecked" && next.state.Source == "path" {
					c = next
					continue
				}
			}
			m.save(c, errorStatus(ctx), err.Error(), "")
			return err
		}

		score, total := mediaScore(report, wanted)
		if c.state.Source == "managed" && score < total && ctx.Err() == nil {
			// При частичном отказе выбираем пару, пригодную для запрошенных функций.
			// Если PATH хуже, сохраняем рабочую часть управляемого комплекта.
			m.mu.Lock()
			previous := m.rejectedManaged
			m.rejectedManaged = c.signature
			alternative := m.discover()[0]
			m.rejectedManaged = previous
			m.mu.Unlock()
			if alternative.state.Source == "path" && alternative.state.Status == "unchecked" {
				other, otherErr := m.options.media(ctx, m.manifest, FFmpegPair{FFmpeg: alternative.state.Paths["ffmpeg"], FFprobe: alternative.state.Paths["ffprobe"]})
				otherScore, _ := mediaScore(other, wanted)
				if otherErr == nil && otherScore > score {
					m.mu.Lock()
					m.rejectedManaged = c.signature
					m.mu.Unlock()
					c = alternative
					report = other
				}
			}
		}
		status, reason := "ready", "Пара FFmpeg/ffprobe проверена."
		for _, outcome := range report.Operations {
			if outcome.Status != "ready" {
				status = "incompatible"
				reason = "Часть медиавозможностей недоступна."
			}
		}
		m.mu.Lock()
		m.mediaSignature = c.signature
		m.mediaOperations = report.Operations
		m.mu.Unlock()
		m.save(c, status, reason, report.Version)
		return nil
	}
	return fmt.Errorf("не найдена пригодная пара FFmpeg/ffprobe")
}

// mediaScore сравнивает пригодность пары только для запрошенных функций.
// ML-пути используют audio-pcm, поэтому отказ экспорта не меняет выбор для CTC.
func mediaScore(report MediaReport, wanted []string) (ready, total int) {
	seen := map[string]bool{}
	for _, id := range wanted {
		if id == "known-text-ctc" || id == "ctc-existing-vocals" || id == "prepare-vocals" {
			id = "audio-pcm"
		}
		if id == "project-view" || id == "timing-view" || seen[id] {
			continue
		}
		seen[id] = true
		total++
		if report.Operations[id].Status == "ready" {
			ready++
		}
	}
	return ready, total
}
