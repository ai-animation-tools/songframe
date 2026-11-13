package components

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// InstallPackage — предложение закреплённого пакета для текущей платформы.
// TemporaryBytes учитывает файл загрузки и staging без удаления прежней версии.
type InstallPackage struct {
	Component      string `json:"component"`
	ID             string `json:"id"`
	Version        string `json:"version"`
	Bytes          int64  `json:"bytes"`
	InstallBytes   int64  `json:"installBytes"`
	TemporaryBytes int64  `json:"temporaryBytes"`
	License        string `json:"license"`
	URL            string `json:"url"`
	Supported      bool   `json:"supported"`
	Reason         string `json:"reason"`
}

// InstallRequest перечисляет выбранные компоненты, а LocalFiles заменяет сеть офлайн-файлом.
// Ключ LocalFiles — component; внешние файлы только читаются и никогда не перемещаются.
type InstallRequest struct {
	Components []string          `json:"components"`
	LocalFiles map[string]string `json:"localFiles"`
}

// InstallLog — ограниченный журнал установки; пути и ошибки остаются в отдельном профиле.
type InstallLog struct {
	Time    string `json:"time"`
	Message string `json:"message"`
}

// InstallSnapshot отделяет прогресс установки от функциональной готовности Manager.State.
// Installed подтверждает опубликованные байты, а не успешный native probe.
type InstallSnapshot struct {
	Status         string       `json:"status"`
	Component      string       `json:"component"`
	CompletedBytes int64        `json:"completedBytes"`
	TotalBytes     int64        `json:"totalBytes"`
	Message        string       `json:"message"`
	Log            []InstallLog `json:"log"`
}

// installOptions заменяет только границы сети/диска в проверках отказов.
type installOptions struct {
	client    *http.Client
	freeSpace func(string) (uint64, error)
	rename    func(string, string) error
}

// activeInstallation адресует неизменяемый payload внутри папки одного артефакта.
// Единственная точка смены активной версии — атомарная замена маленького active.json.
type activeInstallation struct {
	Version   string `json:"version"`
	Directory string `json:"directory"`
}

// initializeInstallation восстанавливает диагностическое состояние без продолжения сетевых действий.
// Частичная загрузка остаётся на диске для следующего явного повтора.
func (m *Manager) initializeInstallation() {
	m.installOptions = installOptions{client: &http.Client{Timeout: 30 * time.Minute}, freeSpace: availableSpace, rename: os.Rename}
	m.installation = InstallSnapshot{Status: "idle", Log: []InstallLog{}}
	data, err := os.ReadFile(filepath.Join(m.profile, "component-installation.json"))
	if err == nil {
		var saved InstallSnapshot
		if json.Unmarshal(data, &saved) == nil {
			if saved.Log == nil {
				saved.Log = []InstallLog{}
			}
			m.installation = saved
			switch saved.Status {
			case "downloading", "verifying", "extracting", "installing":
				m.installation.Status = "cancelled"
				m.installation.Message = "Установка прервана закрытием приложения. Повтор продолжит подтверждённую загрузку."
				m.installation.Log = append(m.installation.Log, InstallLog{time.Now().UTC().Format(time.RFC3339), m.installation.Message})
			}
		}
	}
}

// Catalog не обращается к сети и не объявляет неподтверждённую платформу поддержанной.
func (m *Manager) Catalog() []InstallPackage {
	result := []InstallPackage{}
	for _, id := range []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"} {
		a, ok := m.artifact(id)
		p := InstallPackage{Component: id, Supported: ok, Reason: "Нет закреплённого пакета для этой платформы."}
		if ok {
			p.ID = a.ID
			p.Version = a.Version
			p.Bytes = a.Bytes
			p.InstallBytes = a.InstallBytes
			p.TemporaryBytes = a.Bytes + a.UnpackedBytes
			p.License = a.License.ID
			p.URL = a.URL
			p.Reason = ""
		}
		result = append(result, p)
	}
	return result
}

// Installation возвращает копию журнала, не удерживая блокировку во время отрисовки UI.
func (m *Manager) Installation() InstallSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	result := m.installation
	result.Log = append([]InstallLog{}, result.Log...)
	return result
}

// CancelInstall отменяет сеть, копирование и распаковку; публикация имеет короткую атомарную границу.
func (m *Manager) CancelInstall() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.installCancel != nil {
		m.installCancel()
	}
}

// Install выполняется в фоне Wails-вызова и сериализован с Check/Configure.
// Успешные внешние компоненты не скачиваются повторно; ошибки не удаляют старый active payload.
func (m *Manager) Install(ctx context.Context, request InstallRequest) (InstallSnapshot, error) {
	return m.install(ctx, request, false)
}

// Download устанавливает закреплённые компоненты и после успешной публикации подключает managed.
// Неисправный внешний путь не мешает явной загрузке замены; соседние компоненты не переключаются.
func (m *Manager) Download(ctx context.Context, ids []string) (InstallSnapshot, error) {
	return m.install(ctx, InstallRequest{Components: ids}, true)
}

// install сериализует загрузку/импорт с выбором путей и переключает только успешно опубликованные компоненты.
// managed — внутреннее намерение Connect/Download, оно не добавляет технический флаг в transport DTO.
func (m *Manager) install(ctx context.Context, request InstallRequest, managed bool) (result InstallSnapshot, resultErr error) {
	if !m.work.TryLock() {
		return m.Installation(), &busyError{"сначала завершите проверку или установку компонентов"}
	}
	defer m.work.Unlock()
	if len(request.Components) == 0 {
		return m.Installation(), fmt.Errorf("не выбраны компоненты")
	}
	seen := map[string]bool{}
	for _, id := range request.Components {
		if _, ok := m.artifact(id); !ok || seen[id] {
			return m.Installation(), fmt.Errorf("неподдержанный или повторный компонент: %s", id)
		}
		seen[id] = true
	}
	for id := range request.LocalFiles {
		if !seen[id] {
			return m.Installation(), fmt.Errorf("офлайн-файл не относится к выбранным компонентам: %s", id)
		}
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	m.mu.Lock()
	m.installCancel = cancel
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.installCancel = nil
		m.mu.Unlock()
		if resultErr != nil {
			status := "error"
			if ctx.Err() != nil {
				status = "cancelled"
			}
			m.installUpdate(status, "", 0, 0, resultErr.Error())
		}
		result = m.Installation()
	}()
	m.installUpdate("verifying", "", 0, 0, "Подготовка установки выбранных компонентов.")
	m.mu.Lock()
	root := m.selection.ManagedDirectory
	if root == "" {
		root = filepath.Join(m.profile, "components")
	}
	problem := m.problem
	m.mu.Unlock()
	if problem != "" {
		return result, errors.New(problem)
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return result, fmt.Errorf("папка компонентов: %w", err)
	}
	for _, id := range request.Components {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		a, _ := m.artifact(id)
		reused := false
		if managed && request.LocalFiles[id] != "" && m.reuseManaged(ctx, root, a) {
			// Повторный выбор того же корректного архива не создаёт новую native identity.
			// Выбранный файл всё равно обязан пройти SHA: ошибочный импорт нельзя молча игнорировать.
			if err := verifyPayload(ctx, request.LocalFiles[id], a.Bytes, a.SHA256); err != nil {
				return result, err
			}
			reused = true
			m.installUpdate("verifying", id, a.Bytes, a.Bytes, "Выбранный архив проверен; уже установленный компонент используется повторно.")
		}
		if request.LocalFiles[id] == "" {
			var reuseErr error
			if managed {
				reused = m.reuseManaged(ctx, root, a)
			} else {
				reused, reuseErr = m.reuseBeforeInstall(ctx, id)
			}
			if reuseErr != nil {
				return result, reuseErr
			}
			if reused {
				m.installUpdate("verifying", id, 0, 0, "Компонент уже проверен; повторная загрузка не требуется.")
			}
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if !reused {
			if err := m.installArtifact(ctx, root, a, request.LocalFiles[id]); err != nil {
				return result, fmt.Errorf("%s: %w", id, err)
			}
		}
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if managed {
			if err := m.useManaged(id); err != nil {
				return result, err
			}
		}
	}
	m.installUpdate("installed", "", 0, 0, "Файлы установлены. Готовность функций проверяется автоматически.")
	return result, nil
}

// reuseManaged проверяет только принадлежащий приложению payload, игнорируя заменяемый внешний путь.
// Ошибка или отсутствие закреплённых bytes разрешают явную загрузку, но не выдаются за пригодность.
func (m *Manager) reuseManaged(ctx context.Context, root string, a Artifact) bool {
	base := managedArtifactDirectory(root, a)
	files := map[string]string{}
	for _, file := range a.Files {
		files[file.Path] = filepath.Join(base, filepath.FromSlash(file.Path))
	}
	c := candidate{state: ComponentState{ID: a.Component, Source: "managed"}, artifact: a, files: files, signature: signature(files)}
	return m.verifyFiles(ctx, c, false) == nil
}

// useManaged переключает один успешно установленный компонент, сохраняя effective path его соседа.
// При общем корне CTC сосед получает свой прежний явный файл, а выбранный компонент — настоящее managed обнаружение.
func (m *Manager) useManaged(id string) error {
	m.mu.Lock()
	selection := m.selection
	m.mu.Unlock()
	previous := selection
	switch id {
	case "ffmpeg":
		selection.FFmpegDirectory = ""
	case "ort-cpu":
		selection.ORTDirectory, selection.ORTLibraryFile = "", ""
	case "voc-ft":
		selection.VocalsFile = ""
	case "ctc-ru":
		if selection.CTCDirectory != "" && selection.CTCVocabFile == "" {
			artifact, _ := m.artifact("ctc-vocab")
			selection.CTCVocabFile = filepath.Join(selection.CTCDirectory, filepath.FromSlash(artifact.Entrypoints["vocab"]))
		}
		selection.CTCDirectory, selection.CTCModelFile = "", ""
	case "ctc-vocab":
		if selection.CTCDirectory != "" && selection.CTCModelFile == "" {
			artifact, _ := m.artifact("ctc-ru")
			selection.CTCModelFile = filepath.Join(selection.CTCDirectory, filepath.FromSlash(artifact.Entrypoints["model"]))
		}
		selection.CTCDirectory, selection.CTCVocabFile = "", ""
	default:
		return fmt.Errorf("неизвестный компонент")
	}
	if selection == previous {
		return nil
	}
	_, err := m.configureLocked(selection)
	return err
}

// reuseBeforeInstall проверяет найденные байты до сетевого запроса, даже если UI ещё не вызывал Check.
// Явный неисправный путь требует решения пользователя: скачивание в другую папку его молча не заменяет.
func (m *Manager) reuseBeforeInstall(ctx context.Context, id string) (bool, error) {
	m.mu.Lock()
	var found candidate
	for _, c := range m.discover() {
		if c.state.ID == id {
			found = c
			break
		}
	}
	m.mu.Unlock()
	if found.state.Status != "unchecked" {
		if found.state.Source == "explicit" {
			return false, fmt.Errorf("%s: выбранный путь недоступен; выберите другой путь или забудьте его перед установкой", id)
		}
		return false, nil
	}
	var err error
	if id == "ffmpeg" {
		wanted := []string{}
		for _, capability := range m.manifest.Capabilities {
			for _, dependency := range capability.Requires {
				if dependency == "ffmpeg" {
					wanted = append(wanted, capability.ID)
					break
				}
			}
		}
		err = m.checkMedia(ctx, found, false, wanted)
		if err == nil {
			m.mu.Lock()
			saved := m.checked[id]
			m.mu.Unlock()
			if saved.status == "ready" {
				return true, nil
			}
			err = fmt.Errorf("не все требуемые медиавозможности доступны")
		}
	} else {
		err = m.verifyFiles(ctx, found, false)
		if err == nil && id == "ort-cpu" && found.state.Source == "explicit" {
			// Внешний runtime не закреплён SHA нашего архива: перед отказом от загрузки
			// подтверждаем его пригодность тем же loader/API probe, что и явная Check.
			var report ORTReport
			report, err = m.options.ort(ctx, found.state.Paths["ort-library"], nil)
			if err == nil {
				m.save(found, "ready", fmt.Sprintf("ORT CPU API %d проверен.", report.API), report.Version)
			} else {
				status := errorStatus(ctx)
				if report.RestartRequired {
					status = "restart_required"
				}
				m.save(found, status, err.Error(), report.Version)
			}
		}
		if err == nil {
			return true, nil
		}
	}
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if found.state.Source == "explicit" {
		return false, fmt.Errorf("%s: выбранная установка непригодна: %w; выберите другой путь или забудьте его", id, err)
	}
	return false, nil
}

// installUpdate сохраняет только переходы фаз; частый прогресс живёт в памяти.
// Ошибка журнала не маскирует результат установки и видна в снимке.
func (m *Manager) installUpdate(status, component string, completed, total int64, message string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.installation.Status = status
	if component != "" {
		m.installation.Component = component
	}
	m.installation.CompletedBytes = completed
	m.installation.TotalBytes = total
	m.installation.Message = message
	m.installation.Log = append(m.installation.Log, InstallLog{time.Now().UTC().Format(time.RFC3339), message})
	if len(m.installation.Log) > 100 {
		m.installation.Log = m.installation.Log[len(m.installation.Log)-100:]
	}
	data, _ := json.MarshalIndent(m.installation, "", "  ")
	if err := atomicJSON(m.profile, "component-installation.json", data); err != nil {
		m.installation.Message = message + " Журнал не сохранён: " + err.Error()
	}
}

// installProgress публикует число байтов без записи журнала на каждом сетевом блоке.
func (m *Manager) installProgress(completed, total int64) {
	m.mu.Lock()
	m.installation.CompletedBytes = completed
	m.installation.TotalBytes = total
	m.mu.Unlock()
}

// managedArtifactDirectory разрешает только относительный непосредственный payload собственного артефакта.
// Без указателя active.json текущей версии payload берётся из каталога <id>/<version>.
func managedArtifactDirectory(root string, a Artifact) string {
	base := filepath.Join(root, a.ID)
	data, err := os.ReadFile(filepath.Join(base, "active.json"))
	var active activeInstallation
	if err == nil && json.Unmarshal(data, &active) == nil && active.Version == a.Version && active.Directory != "" && filepath.Base(active.Directory) == active.Directory && active.Directory != "." && active.Directory != ".." && !strings.ContainsAny(active.Directory, `\/:`) {
		return filepath.Join(base, active.Directory)
	}
	return filepath.Join(base, a.Version)
}

// atomicJSON публикует настройки только после Sync; временный файл лежит на том же диске.
func atomicJSON(directory, name string, data []byte) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(directory, ".state-*.tmp")
	if err != nil {
		return err
	}
	temp := f.Name()
	defer os.Remove(temp)
	_, err = f.Write(append(data, '\n'))
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, filepath.Join(directory, name))
}

// installArtifact проверяет доступное место до загрузки и публикует проверенный staging как новое поколение.
// Неизменяемые поколения позволяют не перезаписывать библиотеку уже загруженного ORT.
func (m *Manager) installArtifact(ctx context.Context, root string, a Artifact, local string) error {
	if err := os.MkdirAll(filepath.Join(root, a.ID), 0700); err != nil {
		return err
	}
	free, err := m.installOptions.freeSpace(root)
	if err != nil {
		return fmt.Errorf("не удалось проверить место: %w", err)
	}
	required := uint64(a.Bytes + a.UnpackedBytes + 1024*1024)
	if free < required {
		return fmt.Errorf("недостаточно места: нужно ещё %d байт, доступно %d", required, free)
	}
	test, err := os.CreateTemp(root, ".write-check-*")
	if err != nil {
		return fmt.Errorf("нет права записи: %w", err)
	}
	test.Close()
	os.Remove(test.Name())
	payload, err := m.obtainArtifact(ctx, root, a, local)
	if err != nil {
		return err
	}
	m.installUpdate("verifying", a.Component, 0, a.Bytes, "Проверка SHA-256 загрузки.")
	if err = verifyPayload(ctx, payload, a.Bytes, a.SHA256); err != nil {
		if local == "" && ctx.Err() == nil {
			os.Remove(payload)
			os.Remove(payload + ".json")
		}
		return err
	}
	base := filepath.Join(root, a.ID)
	staging, err := os.MkdirTemp(base, ".staging-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	m.installUpdate("extracting", a.Component, 0, a.InstallBytes, "Распаковка в отдельную временную папку.")
	if err = extractArtifact(ctx, payload, staging, a); err != nil {
		return err
	}
	m.installUpdate("verifying", a.Component, 0, a.InstallBytes, "Проверка обязательных файлов распакованного компонента.")
	files := map[string]string{}
	for _, f := range a.Files {
		files[f.Path] = filepath.Join(staging, filepath.FromSlash(f.Path))
	}
	candidate := candidate{state: ComponentState{ID: a.Component, Source: "managed"}, artifact: a, files: files, signature: signature(files)}
	if err = m.verifyFiles(ctx, candidate, true); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	m.installUpdate("installing", a.Component, a.Bytes, a.Bytes, "Атомарное подключение проверенного поколения.")
	name := a.Version + "-" + strings.TrimPrefix(filepath.Base(staging), ".staging-")
	destination := filepath.Join(base, name)
	if err = m.installOptions.rename(staging, destination); err != nil {
		return err
	}
	published := map[string]string{}
	for _, file := range a.Files {
		published[file.Path] = filepath.Join(destination, filepath.FromSlash(file.Path))
	}
	// Rename меняет пути, но не bytes. Переносим только SHA-подтверждение и лишь
	// при прежних size/mtime/mode всех файлов; native ready новая версия ещё не получает.
	if signatureAt(published, files) != candidate.signature {
		os.RemoveAll(destination)
		return fmt.Errorf("проверенный состав компонента изменился при подключении")
	}
	publishedSignature := signature(published)
	// После перемещения до active.json сбой оставляет только неиспользуемое поколение, старая версия доступна.
	data, _ := json.Marshal(activeInstallation{Version: a.Version, Directory: name})
	if err = atomicJSON(base, "active.json", data); err != nil {
		os.RemoveAll(destination)
		return err
	}
	m.mu.Lock()
	delete(m.checked, a.Component)
	m.hashes[publishedSignature] = "verified"
	// Отклонение managed FFmpeg относится к конкретному fingerprint: чужая установка
	// не сбрасывает fallback, новое поколение FFmpeg само получит другую signature.
	m.mu.Unlock()
	if local == "" {
		os.Remove(payload)
		os.Remove(payload + ".json")
	}
	m.installUpdate("installed", a.Component, a.Bytes, a.Bytes, "Проверенные файлы подключены; функциональная проверка выполняется отдельно.")
	return nil
}

// contextReader останавливает хеширование, локальное копирование и распаковку между блоками чтения.
type contextReader struct {
	ctx    context.Context
	reader io.Reader
}

// Read проверяет отмену до следующего блока ввода, сохраняя обычный контракт io.Reader.
func (r contextReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.Read(p)
}
