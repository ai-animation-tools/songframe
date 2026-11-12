// Package mediaproviders — Go-часть реестра провайдеров медиа (frontend/src/shared/media-providers.ts).
// Общий код Go узнаёт о провайдере только отсюда: виды медиа, программу-исполнитель и платность.
// Здесь лишь поля, нужные Go-стороне приложения; подписи и параметры интерфейса остаются в реестре
// renderer. Совпадение с ним проверяет TestRegistryMatchesFrontend.
package mediaproviders

import (
	"slices"
	"strings"
	"sync"

	"songframe/internal/dynvalue"
)

// Виды медиа.
const (
	Image = "image"
	Video = "video"
)

// Info — запись реестра.
type Info struct {
	Title string
	Kinds []string
	// Executor — программа-агент, которую приложение запускает для генерации; "" — провайдер
	// вызывается напрямую.
	Executor string
	// Paid — платный зафиксированный запрос: цена, баланс и отдельное подтверждение отправки.
	Paid bool
	// DefaultImageResolution — defaults.image.resolution реестра: разрешение обложки и референса,
	// если модель объявляет параметр, а проект его не задал; "" — значения по умолчанию нет.
	DefaultImageResolution string
	// DefaultImageAspectRatio и DefaultImageOutputs — defaults.image.aspect_ratio и .outputs
	// реестра: пропорции и число результатов платного запроса опоры, если проект их не задал;
	// "" и 0 — значения по умолчанию нет.
	DefaultImageAspectRatio string
	DefaultImageOutputs     int
	// LipSync — допустимая длина звукового входа липсинка в секундах; nil — провайдер не
	// синхронизирует губы с заданным звуком (речевой план для него недоступен).
	LipSync *LipSync
	// MaxKeyframes — maxKeyframes реестра: сколько опорных кадров принимает один запрос видео у
	// самой ёмкой модели провайдера; 0 — провайдер не объявляет предела (DefaultKeyframeLimit).
	MaxKeyframes int
	// Manual — manual реестра: сервиса нет, видео всех планов проекта создаёт пользователь вне
	// приложения по пакету ручной генерации; запроса, цены, входа и возможностей моделей нет.
	Manual bool
}

// DefaultKeyframeLimit — наибольшее число опор плана, если провайдер своего предела не объявляет.
const DefaultKeyframeLimit = 20

// KeyframeLimit — наибольшее число опор, которое пользователь может выбрать для плана: предел
// провайдера видео из реестра, без него — DefaultKeyframeLimit.
func KeyframeLimit(provider any) int {
	if id, ok := provider.(string); ok {
		if info, known := Lookup(id); known && info.MaxKeyframes > 0 {
			return info.MaxKeyframes
		}
	}
	return DefaultKeyframeLimit
}

// LipSync — поле lipSync реестра: границы длины звукового входа, секунды.
type LipSync struct {
	Min float64
	Max float64
}

var (
	mu sync.RWMutex
	// ids — порядок MEDIA_PROVIDER_IDS; providers — записи по id.
	ids       = []string{"kling", "codex", "manual"}
	providers = map[string]Info{
		"kling":  {Title: "Kling", Kinds: []string{Image, Video}, Paid: true, DefaultImageResolution: "2k", DefaultImageAspectRatio: "16:9", DefaultImageOutputs: 1, MaxKeyframes: 10},
		"codex":  {Title: "Codex", Kinds: []string{Image}, Executor: "codex"},
		"manual": {Title: "Вручную вне приложения", Kinds: []string{Video}, Manual: true},
	}
)

// Lookup — запись провайдера по точному id.
func Lookup(id string) (Info, bool) {
	mu.RLock()
	defer mu.RUnlock()
	info, ok := providers[id]
	return info, ok
}

// IDs — id провайдеров в порядке реестра.
func IDs() []string {
	mu.RLock()
	defer mu.RUnlock()
	return slices.Clone(ids)
}

// Supports — isMediaProvider: провайдер реестра поддерживает вид медиа.
func Supports(id any, kind string) bool {
	text, ok := id.(string)
	if !ok {
		return false
	}
	info, known := Lookup(text)
	return known && slices.Contains(info.Kinds, kind)
}

// Normalize — normalizeMediaProvider: регистр и крайние пробелы id несущественны.
func Normalize(value any) (string, bool) {
	text, ok := value.(string)
	if !ok {
		return "", false
	}
	id := strings.ToLower(dynvalue.Trim(text))
	_, known := Lookup(id)
	return id, known
}

// Register — тестовая регистрация провайдера (например, test). Возвращает откат к прежнему
// состоянию.
func Register(id string, info Info) (restore func()) {
	mu.Lock()
	defer mu.Unlock()
	previous, existed := providers[id]
	providers[id] = info
	if !existed {
		ids = append(ids, id)
	}
	return func() {
		mu.Lock()
		defer mu.Unlock()
		if existed {
			providers[id] = previous
			return
		}
		delete(providers, id)
		ids = slices.DeleteFunc(ids, func(item string) bool { return item == id })
	}
}

// ManualVideo — план делается ручной генерацией вне приложения: видео создаёт пользователь по
// пакету попытки. Так у способа видео проекта без сервиса (Manual) — для всех планов, а у
// провайдера без липсинка (LipSync == nil) — для плана с отметкой липсинка. Неизвестный
// провайдер — false.
func ManualVideo(provider any, lipsync bool) bool {
	id, ok := provider.(string)
	if !ok || !Supports(id, Video) {
		return false
	}
	info, ok := Lookup(id)
	return ok && (info.Manual || (lipsync && info.LipSync == nil))
}

// ManualID — id записи реестра со способом «вручную вне приложения» (Manual): им помечается
// запрос попытки, видео которой пользователь сделал сам, без сервиса. Пустая строка — такой записи нет.
func ManualID() string {
	mu.RLock()
	defer mu.RUnlock()
	for _, id := range ids {
		if providers[id].Manual {
			return id
		}
	}
	return ""
}
