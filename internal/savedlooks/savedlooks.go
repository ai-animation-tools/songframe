// Package savedlooks хранит привязки «референс → сохранённый образ провайдера» и считает их
// статусы. Привязка живёт в каталоге состояния приложения, а не в проекте: ID образа
// действителен только в аккаунте провайдера, поэтому ключ записи — аккаунт, папка проекта и ID
// референса на «Исходниках». Формат проекта от привязок не зависит; перенос проекта в другую
// папку или на другой компьютер теряет связь, и пользователь привязывает готовые образы заново.
//
// Запись помнит SHA-256 снимков референса на момент создания или привязки образа: если какого-то
// из них больше нет среди изображений референса, образ устарел. Статусы всех референсов проекта
// считаются по одному бесплатному списку библиотеки аккаунта (mediaapi.SavedLooks).
package savedlooks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/projectfs"
	"songframe/internal/sources"
)

// Статусы образа референса.
const (
	// StatusNone — в текущем аккаунте образа у референса нет.
	StatusNone = "none"
	// StatusReady — образ привязан и есть в аккаунте.
	StatusReady = "ready"
	// StatusStale — образ есть в аккаунте, но снимки референса изменились после создания.
	StatusStale = "stale"
	// StatusMissing — привязанного образа больше нет в аккаунте (удалён на сайте провайдера).
	StatusMissing = "missing"
)

// Binding — привязка референса к образу в аккаунте провайдера.
type Binding struct {
	Account   string `json:"account"`
	Project   string `json:"project"`
	Reference string `json:"reference"`
	Look      string `json:"look"`
	// Name — имя образа в аккаунте на момент привязки.
	Name string `json:"name"`
	// Images — SHA-256 снимков референса, по которым образ создан; у образа, привязанного из
	// аккаунта, — все снимки референса на момент привязки.
	Images []string `json:"images"`
	// Created — образ создан приложением, а не привязан готовым.
	Created bool `json:"created"`
}

// file — saved-looks.json провайдера.
type file struct {
	SchemaVersion int       `json:"schema_version"`
	Bindings      []Binding `json:"bindings"`
}

// Store — привязки в каталоге состояния: <Dir>/providers/<провайдер>/saved-looks.json. Методы
// безопасны для параллельного вызова внутри процесса: чтение-изменение-запись идёт под общей
// блокировкой, файл заменяется атомарно.
type Store struct {
	Dir string
}

// mu — общая блокировка файлов привязок процесса.
var mu sync.Mutex

func textBroken(path string) string {
	return "Файл привязок образов повреждён: " + path + ". Удалите его и привяжите образы заново."
}

// path — файл привязок провайдера.
func (s Store) path(provider string) string {
	return filepath.Join(s.Dir, "providers", strings.ToLower(strings.TrimSpace(provider)), "saved-looks.json")
}

// ProjectKey — ключ проекта в привязках: настоящий путь папки (символические ссылки раскрыты),
// чтобы «Исходники», открытые по ссылке, и сборка запроса по настоящему пути нашли одну запись.
// Папки нет — абсолютный очищенный путь.
func ProjectKey(project string) string {
	absolute, err := filepath.Abs(project)
	if err != nil {
		return filepath.Clean(project)
	}
	if real, err := filepath.EvalSymlinks(absolute); err == nil {
		return real
	}
	return absolute
}

// read — все привязки провайдера; нет файла — пусто.
func (s Store) read(provider string) ([]Binding, error) {
	path := s.path(provider)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []Binding{}, nil
	}
	if err != nil {
		return nil, err
	}
	var content file
	if json.Unmarshal(data, &content) != nil || content.SchemaVersion != 1 {
		return nil, errors.New(textBroken(path))
	}
	if content.Bindings == nil {
		content.Bindings = []Binding{}
	}
	return content.Bindings, nil
}

// write — атомарная замена файла привязок.
func (s Store) write(provider string, bindings []Binding) error {
	return projectfs.WriteJSON(s.path(provider), file{SchemaVersion: 1, Bindings: bindings})
}

// update — чтение, изменение и запись под блокировкой.
func (s Store) update(provider string, change func([]Binding) []Binding) error {
	mu.Lock()
	defer mu.Unlock()
	bindings, err := s.read(provider)
	if err != nil {
		return err
	}
	return s.write(provider, change(bindings))
}

// same — привязка того же аккаунта, проекта и референса.
func (b Binding) same(account, project, reference string) bool {
	return b.Account == account && b.Project == project && b.Reference == reference
}

// Bind записывает привязку референса к образу; прежняя привязка того же референса в том же
// аккаунте заменяется. Проект приводится к ProjectKey, SHA снимков — без повторов, в порядке
// передачи.
func (s Store) Bind(provider string, binding Binding) error {
	binding.Project = ProjectKey(binding.Project)
	images := []string{}
	for _, sha := range binding.Images {
		if sha != "" && !slices.Contains(images, sha) {
			images = append(images, sha)
		}
	}
	binding.Images = images
	if binding.Account == "" || binding.Reference == "" || binding.Look == "" {
		return errors.New("Привязке образа нужны аккаунт, референс и образ.")
	}
	return s.update(provider, func(bindings []Binding) []Binding {
		bindings = slices.DeleteFunc(bindings, func(item Binding) bool {
			return item.same(binding.Account, binding.Project, binding.Reference)
		})
		return append(bindings, binding)
	})
}

// Unbind убирает привязку референса в аккаунте; сам образ в аккаунте остаётся.
func (s Store) Unbind(provider, account, project, reference string) error {
	project = ProjectKey(project)
	return s.update(provider, func(bindings []Binding) []Binding {
		return slices.DeleteFunc(bindings, func(item Binding) bool { return item.same(account, project, reference) })
	})
}

// ForgetLook убирает все привязки к образу аккаунта (во всех проектах) — после его удаления.
func (s Store) ForgetLook(provider, account, look string) error {
	return s.update(provider, func(bindings []Binding) []Binding {
		return slices.DeleteFunc(bindings, func(item Binding) bool { return item.Account == account && item.Look == look })
	})
}

// Bindings — привязки проекта в аккаунте.
func (s Store) Bindings(provider, account, project string) ([]Binding, error) {
	mu.Lock()
	bindings, err := s.read(provider)
	mu.Unlock()
	if err != nil {
		return nil, err
	}
	project = ProjectKey(project)
	result := []Binding{}
	for _, item := range bindings {
		if item.Account == account && item.Project == project {
			result = append(result, item)
		}
	}
	return result, nil
}

// Bound — есть ли у проекта привязки образов хоть в одном аккаунте провайдера: без них список
// библиотеки не нужен, и задание агента собирается без обращения к сети.
func (s Store) Bound(provider, project string) (bool, error) {
	mu.Lock()
	bindings, err := s.read(provider)
	mu.Unlock()
	if err != nil {
		return false, err
	}
	project = ProjectKey(project)
	return slices.ContainsFunc(bindings, func(item Binding) bool { return item.Project == project }), nil
}

// Reference — референс описи с текущими снимками.
type Reference struct {
	ID   string
	Kind string
	// Images — SHA-256 изображений референса в порядке описи.
	Images []string
}

// References — референсы source/manifest.json проекта; нет описи — пусто. Повреждённая опись —
// ошибка sources.ManifestInvalid.
func References(project string) ([]Reference, error) {
	result := []Reference{}
	if !dynvalue.Exists(sources.ManifestPath(project)) {
		return result, nil
	}
	manifest := sources.ReadManifest(project)
	items, ok := dynvalue.AsArray(dynvalue.Get(manifest, "references"))
	if manifest == nil || !ok {
		return nil, errors.New(sources.ManifestInvalid)
	}
	for _, item := range items {
		id, _ := dynvalue.Get(item, "id").(string)
		if id == "" {
			continue
		}
		kind, _ := dynvalue.Get(item, "kind").(string)
		reference := Reference{ID: id, Kind: kind, Images: []string{}}
		files, _ := dynvalue.AsArray(dynvalue.Get(item, "files"))
		for _, entry := range files {
			if sha, _ := dynvalue.Get(entry, "sha256").(string); sha != "" {
				reference.Images = append(reference.Images, sha)
			}
		}
		result = append(result, reference)
	}
	return result, nil
}

// State — статус образа одного референса.
type State struct {
	Reference string `json:"reference"`
	Status    string `json:"status"`
	// Look и Name — привязанный образ; пусто при StatusNone.
	Look string `json:"look,omitempty"`
	Name string `json:"name,omitempty"`
}

// Report — статусы образов референсов проекта в текущем аккаунте.
type Report struct {
	Account string `json:"account"`
	// Count — число образов в аккаунте (место в пределе библиотеки).
	Count int `json:"count"`
	// States — по референсу описи, в её порядке.
	States []State `json:"states"`
	// Looks — образы аккаунта для выбора готового образа.
	Looks []mediaapi.SavedLook `json:"looks"`
}

// Statuses — статусы референсов по привязкам аккаунта и библиотеке: нет привязки — none;
// образа нет в библиотеке — missing; снимка, по которому образ создан, больше нет у референса —
// stale; иначе ready. Имя образа берётся из библиотеки: его могли переименовать на сайте.
func Statuses(bindings []Binding, library mediaapi.SavedLookLibrary, references []Reference) Report {
	names := map[string]string{}
	for _, look := range library.Looks {
		names[look.ID] = look.Name
	}
	report := Report{Account: library.Account, Count: len(library.Looks), States: []State{}, Looks: library.Looks}
	if report.Looks == nil {
		report.Looks = []mediaapi.SavedLook{}
	}
	for _, reference := range references {
		state := State{Reference: reference.ID, Status: StatusNone}
		index := slices.IndexFunc(bindings, func(item Binding) bool {
			return item.Account == library.Account && item.Reference == reference.ID
		})
		if index >= 0 {
			binding := bindings[index]
			state.Look, state.Name = binding.Look, binding.Name
			name, present := names[binding.Look]
			switch {
			case !present:
				state.Status = StatusMissing
			case slices.ContainsFunc(binding.Images, func(sha string) bool { return !slices.Contains(reference.Images, sha) }):
				state.Status, state.Name = StatusStale, name
			default:
				state.Status, state.Name = StatusReady, name
			}
		}
		report.States = append(report.States, state)
	}
	return report
}

// Check — статусы образов референсов проекта одним бесплатным списком библиотеки аккаунта.
// Ошибка списка (нет входа, сбой сервиса) возвращается как есть: статусы без него неизвестны.
func (s Store) Check(ctx context.Context, looks mediaapi.SavedLooks, provider, project string, timeout time.Duration) (Report, error) {
	references, err := References(project)
	if err != nil {
		return Report{}, err
	}
	library, err := looks.ListSavedLooks(ctx, timeout)
	if err != nil {
		return Report{}, err
	}
	bindings, err := s.Bindings(provider, library.Account, project)
	if err != nil {
		return Report{}, err
	}
	return Statuses(bindings, library, references), nil
}
