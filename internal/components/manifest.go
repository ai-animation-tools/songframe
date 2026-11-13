// Package components обнаруживает, проверяет и устанавливает производственные зависимости
// (FFmpeg/ffprobe, ONNX Runtime и модели) по их закреплённому составу.
//
// Закреплённый состав — manifest.json (manifest.go): его чтение не ищет программы, не загружает
// библиотеки и не обращается к сети. Manager (manager.go) хранит выбор пользователя, обнаруживает
// файлы и проверяет готовность функций по запросу (media.go, ort.go); установка (install.go,
// download.go, extract.go) скачивает или принимает офлайн-архив, сверяет SHA и публикует пакет в
// папку компонентов, connect.go подключает уже готовые файлы.
package components

import (
	"bytes"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
)

// manifestJSON входит в версию приложения: плавающего серверного реестра нет.
// Артефакты остаются внешними файлами и не попадают в бинарник вместе с описанием.
//
//go:embed manifest.json
var manifestJSON []byte

// Manifest связывает пакеты, операции и проверки; он не представляет состояние установки.
// Нативная приёмка платформы и успешная проверка архива имеют разные владельцы.
type Manifest struct {
	SchemaVersion int             `json:"schema_version"`
	RecordedOn    string          `json:"recorded_on"`
	Platforms     []Platform      `json:"platforms"`
	Probes        []Probe         `json:"probes"`
	Capabilities  []Capability    `json:"capabilities"`
	Artifacts     []Artifact      `json:"artifacts"`
	Recipe        json.RawMessage `json:"recipe"`
}

// Platform явно сообщает предел приёмки, даже когда архив для неё уже проверен.
type Platform struct {
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// Probe задаёт проверяемый контракт следующего шага; один список версий его не заменяет.
// Command содержит только переносимую команду разработчика, а не пользовательский shell API.
type Probe struct {
	ID      string   `json:"id"`
	Command string   `json:"command"`
	Checks  []string `json:"checks"`
}

// Capability объединяет зависимости конкретной операции и ссылки на реальные recipes.
// Требования списков FFmpeg дополняются функциональным probe с синтетическими файлами.
type Capability struct {
	ID        string              `json:"id"`
	Purpose   string              `json:"purpose"`
	Consumers []string            `json:"consumers"`
	Requires  []string            `json:"requires"`
	Features  map[string][]string `json:"features"`
	Probes    []string            `json:"probes"`
}

// Artifact описывает точный архив или файл и необходимые части его содержимого.
// Verified означает проверку байтов; NativeStatus и License отдельно ограничивают готовность.
type Artifact struct {
	ID            string            `json:"id"`
	Component     string            `json:"component"`
	Version       string            `json:"version"`
	OS            string            `json:"os"`
	Arch          string            `json:"arch"`
	URL           string            `json:"url"`
	SHA256        string            `json:"sha256"`
	Bytes         int64             `json:"bytes"`
	UnpackedBytes int64             `json:"unpacked_bytes"`
	InstallBytes  int64             `json:"install_bytes"`
	Format        string            `json:"format"`
	Root          string            `json:"root"`
	Files         []File            `json:"files"`
	Entrypoints   map[string]string `json:"entrypoints"`
	Preserve      []string          `json:"preserve"`
	License       License           `json:"license"`
	ABI           ABI               `json:"abi"`
	Requires      []string          `json:"requires"`
	Probes        []string          `json:"probes"`
	Evidence      []string          `json:"evidence"`
	Verified      string            `json:"verified"`
	NativeStatus  string            `json:"native_status"`
	Model         json.RawMessage   `json:"model,omitempty"`
}

// File фиксирует entrypoint или обязательное уведомление внутри закреплённого пакета.
// Path отсчитывается от Root архива; SHA относится к файлу после распаковки.
type File struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Target string `json:"target,omitempty"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// License сохраняет происхождение условий и незакрытые вопросы распространения.
// Отсутствие подтверждённой лицензии нельзя трактовать как разрешение по лицензии приложения.
type License struct {
	ID      string   `json:"id"`
	Status  string   `json:"status"`
	Sources []string `json:"sources"`
	Note    string   `json:"note"`
}

// ABI фиксирует требования загрузчика, C API и внешних системных библиотек.
// HeaderAPI — максимум заголовка поставщика, RequiredAPI — запрос закреплённого binding.
type ABI struct {
	Kind         string   `json:"kind"`
	RequiredAPI  int      `json:"required_api"`
	HeaderAPI    int      `json:"header_api"`
	Minimum      string   `json:"minimum"`
	Dependencies []string `json:"dependencies"`
	Note         string   `json:"note"`
}

// Load возвращает отдельный снимок встроенного реестра и проверяет его связи.
// Повреждённый manifest не должен приводить к частично выбранному набору компонентов.
func Load() (Manifest, error) { return parse(manifestJSON) }

// parse отвергает неизвестные поля и второй JSON-документ, чтобы опечатка не исчезла при чтении.
func parse(data []byte) (Manifest, error) {
	var m Manifest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&m); err != nil {
		return m, fmt.Errorf("manifest компонентов: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return m, fmt.Errorf("после manifest есть лишние данные")
	}
	return m, m.Validate()
}

// Validate проверяет целостность адресов, состава и ссылок без I/O и загрузки ORT.
// Наличие пакета в реестре не является результатом его функционального probe.
func (m Manifest) Validate() error {
	if m.SchemaVersion != 1 || m.RecordedOn == "" || len(m.Artifacts) == 0 || !objectKeys(m.Recipe, "pipeline", "binding", "mdx", "ctc") {
		return fmt.Errorf("неполный заголовок manifest")
	}
	probes, components, ids := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, p := range m.Probes {
		if p.ID == "" || probes[p.ID] || len(p.Checks) == 0 {
			return fmt.Errorf("некорректный probe %q", p.ID)
		}
		probes[p.ID] = true
	}
	for _, a := range m.Artifacts {
		components[a.Component] = true
	}
	for _, a := range m.Artifacts {
		if a.ID == "" || ids[a.ID] || a.Component == "" || a.Version == "" || a.OS == "" || a.Arch == "" {
			return fmt.Errorf("неполный или повторный пакет %q", a.ID)
		}
		ids[a.ID] = true
		u, err := url.Parse(a.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" || !digest(a.SHA256) || a.Bytes <= 0 || a.UnpackedBytes <= 0 || a.InstallBytes <= 0 || a.UnpackedBytes < a.InstallBytes {
			return fmt.Errorf("неполный источник %s", a.ID)
		}
		if a.Format != "file" && a.Format != "tar.gz" && a.Format != "tar.xz" && a.Format != "zip" {
			return fmt.Errorf("неизвестный формат %s", a.ID)
		}
		if a.Root != "" && !relative(a.Root) {
			return fmt.Errorf("неверный корень %s", a.ID)
		}
		if len(a.Files) == 0 || len(a.Probes) == 0 || len(a.Evidence) == 0 || a.Verified == "" || a.NativeStatus == "" || a.ABI.Kind == "" || a.License.ID == "" || a.License.Status == "" || len(a.License.Sources) == 0 {
			return fmt.Errorf("нет состава, лицензии, ABI или проверки %s", a.ID)
		}
		paths := map[string]bool{}
		var selectedBytes int64
		for _, f := range a.Files {
			if !relative(f.Path) || paths[f.Path] || (f.Type != "file" && f.Type != "symlink") || (f.Type == "file" && (f.Bytes <= 0 || !digest(f.SHA256))) || (f.Type == "symlink" && (!relative(f.Target) || f.Bytes != 0 || f.SHA256 != "")) {
				return fmt.Errorf("неверный файл %s: %s", a.ID, f.Path)
			}
			paths[f.Path] = true
			selectedBytes += f.Bytes
		}
		if selectedBytes != a.InstallBytes {
			return fmt.Errorf("размер выбранного состава не совпал: %s", a.ID)
		}
		if len(a.Entrypoints) == 0 {
			return fmt.Errorf("нет entrypoint %s", a.ID)
		}
		for role, entry := range a.Entrypoints {
			if role == "" || !paths[entry] {
				return fmt.Errorf("неверный entrypoint %s: %s", a.ID, entry)
			}
		}
		for _, file := range a.Files {
			if file.Type == "symlink" && !paths[path.Join(path.Dir(file.Path), file.Target)] {
				return fmt.Errorf("потерян target ссылки %s: %s", a.ID, file.Path)
			}
		}
		if a.Component == "voc-ft" || a.Component == "ctc-ru" {
			if !objectKeys(a.Model, "inputs", "outputs", "opsets", "ir_version", "external_initializers") {
				return fmt.Errorf("нет ONNX-контракта %s", a.ID)
			}
		}
		if a.Component == "ctc-vocab" && !objectKeys(a.Model, "vocab") {
			return fmt.Errorf("нет контракта словаря")
		}
		if err := references(a.ID, a.Requires, components); err != nil {
			return err
		}
		if err := references(a.ID, a.Probes, probes); err != nil {
			return err
		}
	}
	capIDs := map[string]bool{}
	for _, c := range m.Capabilities {
		if c.ID == "" || capIDs[c.ID] || c.Purpose == "" || len(c.Consumers) == 0 || len(c.Requires) == 0 || len(c.Probes) == 0 {
			return fmt.Errorf("неполная возможность %q", c.ID)
		}
		capIDs[c.ID] = true
		if err := references(c.ID, c.Requires, components); err != nil {
			return err
		}
		if err := references(c.ID, c.Probes, probes); err != nil {
			return err
		}
	}
	if len(m.Platforms) == 0 || len(m.Capabilities) == 0 {
		return fmt.Errorf("нет матрицы платформ или операций")
	}
	for _, p := range m.Platforms {
		if p.OS == "" || p.Arch == "" || p.Reason == "" || (p.Status != "pending_native" && p.Status != "unconfirmed") {
			return fmt.Errorf("неподтверждённая готовность платформы %s/%s", p.OS, p.Arch)
		}
	}
	return nil
}

// references обнаруживает потерянную зависимость до обращения к сети или запуску программы.
func references(owner string, values []string, known map[string]bool) error {
	for _, v := range values {
		if !known[v] {
			return fmt.Errorf("%s ссылается на неизвестную зависимость %q", owner, v)
		}
	}
	return nil
}

// relative принимает только переносимые пути внутри архива, без выхода в родительскую папку.
func relative(value string) bool {
	return value != "" && value != "." && !strings.ContainsAny(value, "\\:") && !path.IsAbs(value) && path.Clean(value) == value && value != ".." && !strings.HasPrefix(value, "../")
}

// digest проверяет форму SHA-256; совпадение с файлом проверяется при подключении или установке.
func digest(value string) bool {
	b, err := hex.DecodeString(value)
	return err == nil && len(b) == 32 && strings.ToLower(value) == value
}

// objectKeys отвергает null и отсутствие обязательных частей ML-контракта.
// Подробные численные параметры сохраняются в реестре дословно, без второй копии DSP в загрузчике.
func objectKeys(raw json.RawMessage, keys ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return false
	}
	for _, key := range keys {
		if len(fields[key]) == 0 || bytes.Equal(bytes.TrimSpace(fields[key]), []byte("null")) {
			return false
		}
	}
	return true
}
