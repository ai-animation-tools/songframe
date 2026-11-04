package agents

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// Settings — AgentSettings контракта: исполнитель и необязательная модель. Путь к программе не
// хранится: CLI всегда находится автоматическим поиском, найденный файл виден в проверке.
type Settings struct {
	Provider string `json:"provider"`
	Model    string `json:"model,omitempty"`
}

// SettingsFile — имя файла настроек в каталоге состояния (тот же, что у Electron).
const SettingsFile = "settings.json"

// Normalize — normalizeAgentSettings для типизированного ввода из renderer: nil — выбора нет,
// неизвестный исполнитель или модель с нулевым символом — ошибка, модель без пробелов по краям,
// пустая модель опускается. Лишние поля (прежний executablePath) отбрасывает уже разбор JSON.
func Normalize(value *Settings) (*Settings, error) {
	if value == nil {
		return nil, nil
	}
	if !IsProvider(value.Provider) {
		return nil, errors.New(textSelectAgent)
	}
	if strings.ContainsRune(value.Model, 0) {
		return nil, errors.New(textInvalidModel)
	}
	return &Settings{Provider: value.Provider, Model: jscompat.Trim(value.Model)}, nil
}

// normalizeValue — normalizeAgentSettings для значения из settings.json со строгими типами JS.
func normalizeValue(value any) (*Settings, error) {
	if jscompat.IsNullish(value) {
		return nil, nil
	}
	object, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errors.New(textInvalidAgentSettings)
	}
	provider, _ := object.Value("provider").(string)
	if !IsProvider(provider) {
		return nil, errors.New(textSelectAgent)
	}
	model := ""
	if raw := object.Value("model"); raw != jscompat.Undefined {
		text, ok := raw.(string)
		if !ok || strings.ContainsRune(text, 0) {
			return nil, errors.New(textInvalidModel)
		}
		model = jscompat.Trim(text)
	}
	return &Settings{Provider: provider, Model: model}, nil
}

// object — запись настроек в порядке ключей оригинала: provider, затем model при наличии.
func (s Settings) object() *jscompat.Object {
	object := jscompat.NewObject()
	object.Set("provider", s.Provider)
	if s.Model != "" {
		object.Set("model", s.Model)
	}
	return object
}

// normalizeProfiles — профили по исполнителям: ключ — id реестра, значение — его же настройки.
// Undefined — профилей нет; иное не-объектное значение, чужой или неизвестный агент — ошибка.
func normalizeProfiles(value any) (*jscompat.Object, error) {
	result := jscompat.NewObject()
	if value == jscompat.Undefined {
		return result, nil
	}
	object, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errors.New(textInvalidProfiles)
	}
	for _, provider := range object.Keys() {
		if !IsProvider(provider) {
			return nil, errors.New(textUnknownAgent)
		}
		normalized, err := normalizeValue(object.Value(provider))
		if err != nil {
			return nil, err
		}
		if normalized == nil || normalized.Provider != provider {
			return nil, errors.New(textProfileAgentMismatch)
		}
		result.Set(provider, normalized.object())
	}
	return result, nil
}

// SettingsStore владеет settings.json каталога состояния Go-версии (SettingsStore оригинала).
//
// Файл общий для глобального выбора агента (agent), личных профилей исполнителей (agentProfiles)
// и полей других областей (toolsRootOverride и будущих): запись меняет только свои ключи, а
// остальные сохраняет в исходном порядке. Повреждённый файл не перезаписывается — чтение и запись
// возвращают ошибку с путём. Мьютекс сериализует чтение-изменение-запись параллельных вызовов Wails.
type SettingsStore struct {
	dir string
	mu  sync.Mutex
}

// NewSettingsStore привязывает настройки к каталогу состояния приложения.
func NewSettingsStore(localDir string) *SettingsStore { return &SettingsStore{dir: localDir} }

// LocalDir — каталог состояния: рядом с settings.json лежат история заданий и рабочие папки.
func (s *SettingsStore) LocalDir() string { return s.dir }

func (s *SettingsStore) file() string { return filepath.Join(s.dir, SettingsFile) }

// read — SettingsStore.read: снимок файла с нормализованными agent и agentProfiles на их местах.
func (s *SettingsStore) read() (*jscompat.Object, error) {
	value, err := readLocal(s.file())
	if err != nil {
		return nil, err
	}
	if value == nil {
		return jscompat.NewObject(), nil
	}
	object, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errors.New(textInvalidSettingsFile(s.file()))
	}
	if root := object.Value("toolsRootOverride"); !jscompat.IsNullish(root) {
		if _, isString := root.(string); !isString {
			return nil, errors.New(textInvalidSettingsFile(s.file()))
		}
	}
	// Старый файл без agent остаётся рабочим: выбор провайдера не появляется неявно.
	agent, agentErr := normalizeValue(object.Value("agent"))
	profiles, profilesErr := normalizeProfiles(object.Value("agentProfiles"))
	if agentErr != nil || profilesErr != nil {
		return nil, errors.New(textInvalidAgentFile(s.file()))
	}
	result := object.Clone()
	if agent != nil {
		result.Set("agent", agent.object())
	}
	if jscompat.Truthy(object.Value("agentProfiles")) {
		result.Set("agentProfiles", profiles)
	}
	return result, nil
}

// field — пара ключ/значение изменения; jscompat.Undefined удаляет ключ при записи.
type field struct {
	key   string
	value any
}

// write — SettingsStore.write: {...read(), ...patch} с повторной нормализацией и атомарной записью.
func (s *SettingsStore) write(patch ...field) error {
	merged, err := s.read()
	if err != nil {
		return err
	}
	for _, item := range patch {
		merged.Set(item.key, item.value)
	}
	agent, err := normalizeValue(merged.Value("agent"))
	if err != nil {
		return err
	}
	if agent != nil {
		merged.Set("agent", agent.object())
	} else {
		merged.Delete("agent")
	}
	if profiles := merged.Value("agentProfiles"); jscompat.Truthy(profiles) {
		normalized, err := normalizeProfiles(profiles)
		if err != nil {
			return err
		}
		merged.Set("agentProfiles", normalized)
	}
	return projectfs.WriteFile(s.file(), []byte(jscompat.StringifyIndent(merged, "  ")+"\n"), 0)
}

// Agent — сохранённый текстовый агент или nil, если выбор не сделан.
func (s *SettingsStore) Agent() (*Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	saved, err := s.read()
	if err != nil {
		return nil, err
	}
	return normalizeValue(saved.Value("agent"))
}

// ProviderAgent — профиль исполнителя: выбранный агент того же исполнителя или его личный
// профиль. Модель другого CLI не переносится при смене исполнителя.
func (s *SettingsStore) ProviderAgent(provider string) (*Settings, error) {
	if !IsProvider(provider) {
		return nil, errors.New(textUnknownAgent)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	saved, err := s.read()
	if err != nil {
		return nil, err
	}
	if agent, _ := normalizeValue(saved.Value("agent")); agent != nil && agent.Provider == provider {
		return agent, nil
	}
	return normalizeValue(jscompat.Get(saved.Value("agentProfiles"), provider))
}

// withProfile — {...saved.agentProfiles, [provider]: agent}: прежние профили на своих местах.
func withProfile(saved *jscompat.Object, agent Settings) *jscompat.Object {
	profiles := jscompat.NewObject()
	if existing, ok := saved.Value("agentProfiles").(*jscompat.Object); ok {
		profiles = existing.Clone()
	}
	profiles.Set(agent.Provider, agent.object())
	return profiles
}

// SaveProviderAgent сохраняет личный профиль исполнителя, не выбирая его неявно; профиль
// выбранного агента обновляет и сам выбор.
func (s *SettingsStore) SaveProviderAgent(value *Settings) (Settings, error) {
	agent, err := Normalize(value)
	if err != nil {
		return Settings{}, err
	}
	if agent == nil {
		return Settings{}, errors.New(textProfileRequired)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	saved, err := s.read()
	if err != nil {
		return Settings{}, err
	}
	patch := []field{{"agentProfiles", withProfile(saved, *agent)}}
	if current, _ := normalizeValue(saved.Value("agent")); current != nil && current.Provider == agent.Provider {
		patch = append(patch, field{"agent", agent.object()})
	}
	return *agent, s.write(patch...)
}

// SaveAgent меняет только глобальный выбор (nil — отключить агента) и профиль выбранного
// исполнителя; профили других исполнителей и прочие поля файла сохраняются.
func (s *SettingsStore) SaveAgent(value *Settings) (*Settings, error) {
	agent, err := Normalize(value)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	saved, err := s.read()
	if err != nil {
		return nil, err
	}
	if agent == nil {
		return nil, s.write(field{"agent", jscompat.Undefined})
	}
	return agent, s.write(field{"agent", agent.object()}, field{"agentProfiles", withProfile(saved, *agent)})
}

// ImageAgent — программа-агент провайдера изображений (executor из реестра медиа) и модель из
// настроек проекта. Модель текстового агента сюда не переносится: пустая модель оставляет выбор
// самой программе. Пустой или неизвестный executor — провайдер не исполняется агентом.
func ImageAgent(executor, model string) (Settings, error) {
	if !IsProvider(executor) {
		return Settings{}, errors.New(textImageAgentRequired)
	}
	return Settings{Provider: executor, Model: jscompat.Trim(model)}, nil
}

// readLocal — readLocalJson оригинала: отсутствие файла — (nil, nil); повреждённый или
// не-объектный JSON — ошибка с путём, файл не трогается.
func readLocal(path string) (any, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, readFailed(path, jscompat.FsError("open", path, err).Error())
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	if err != nil {
		return nil, readFailed(path, err.Error())
	}
	if _, isObject := value.(*jscompat.Object); !isObject && !jscompat.IsArray(value) {
		return nil, readFailed(path, "ожидался JSON-объект")
	}
	return value, nil
}

func readFailed(path, reason string) error {
	return errors.New("Не удалось прочитать " + path + ": " + reason + ". Файл сохранён; исправьте его или перенесите в резервную папку.")
}
