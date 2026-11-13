// Package updates обновляет приложение по явному действию пользователя: читает последний
// выпуск публичного репозитория на GitHub, скачивает пакет своей поставки и сверяет его с
// digest SHA-256 и размером из GitHub API — тем же, что проверяет публикация выпуска.
// Собственная подпись не нужна: пакеты и описание выпуска публикует только владелец репозитория.
//
// Поставки: AppImage и установщик Windows обновляются из приложения, deb-пакет пользователь
// ставит сам (приложение показывает скачанный файл). Версия разработки X.Y.Z-суффикс считается
// старше X.Y.Z-1 и младше выпуска X.Y.Z (SemVer).
//
// Обновление приложения не трогает компоненты, профиль и проекты: папка загрузок лежит в
// каталоге состояния и хранит только последний скачанный пакет.
package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Repository — единственный канал выпусков: публичный songframe.
const Repository = "ai-animation-tools/songframe"

// LatestURL — последний опубликованный выпуск без черновиков и prerelease.
const LatestURL = "https://api.github.com/repos/" + Repository + "/releases/latest"

// Сроки: описание выпуска — 20 с, пакет в сотни мегабайт — 30 мин.
const (
	checkTimeout    = 20 * time.Second
	downloadTimeout = 30 * time.Minute
	releaseLimit    = 8 << 20
)

// Kind — способ поставки запущенного приложения; от него зависят имя пакета и установка.
type Kind string

const (
	// KindAppImage — запуск из AppImage: новый файл атомарно заменяет прежний по тому же пути.
	KindAppImage Kind = "appimage"
	// KindDeb — установка deb-пакетом: файл в /usr принадлежит dpkg, пакет ставит пользователь.
	KindDeb Kind = "deb"
	// KindWindows — установка NSIS: скачанный установщик сам заменяет приложение.
	KindWindows Kind = "windows"
	// KindManual — Linux без AppImage и deb (запуск из исходников): AppImage меняют вручную.
	KindManual Kind = "manual"
)

// Состояния вида — UpdateStatus контракта frontend/src/shared/updates.ts.
const (
	StatusIdle        = "idle"
	StatusCurrent     = "current"
	StatusAvailable   = "available"
	StatusDownloading = "downloading"
	StatusReady       = "ready"
	StatusError       = "error"
)

// View — UpdateView контракта: без путей к файлам, адрес только у страницы выпуска.
// Progress — доля скачанного от 0 до 1; Installable — установка заменяет приложение и
// перезапускает его, иначе кнопка показывает скачанный файл.
type View struct {
	Status         string  `json:"status"`
	CurrentVersion string  `json:"currentVersion"`
	Version        string  `json:"version,omitempty"`
	ReleaseURL     string  `json:"releaseUrl,omitempty"`
	Progress       float64 `json:"progress,omitempty"`
	Installable    bool    `json:"installable,omitempty"`
	Message        string  `json:"message,omitempty"`
}

// Package — проверенное вложение выпуска для этой поставки.
type Package struct {
	Version string
	Page    string
	Name    string
	Size    int64
	SHA256  string
	URL     string
}

// Options — зависимости менеджера. Launch, Relaunch, Quit и Reveal задаёт точка сборки
// приложения; в тестах они подменяются, сеть — Client и LatestURL.
type Options struct {
	CurrentVersion string
	Kind           Kind
	// Directory — папка скачанных пакетов в каталоге состояния; очищается при новом скачивании.
	Directory string
	// AppImage — путь запущенного AppImage (переменная APPIMAGE) для KindAppImage.
	AppImage  string
	Client    *http.Client
	LatestURL string
	// Launch запускает установщик Windows отдельно от приложения.
	Launch func(file string) error
	// Relaunch запускает новый AppImage после выхода этого процесса.
	Relaunch func(appImage string) error
	// Quit завершает приложение после ответа binding; задания останавливаются штатно.
	Quit func()
	// Reveal показывает скачанный файл в файловом менеджере.
	Reveal func(file string) error
}

// Manager владеет состоянием обновления всего приложения: найденным выпуском, скачанным
// файлом и прогрессом. Одна операция за раз; View безопасен во время скачивания.
type Manager struct {
	options Options
	mu      sync.Mutex
	state   View
	found   *Package
	file    string
	busy    bool
}

// userError — сообщение для пользователя; прочие ошибки заменяются общим текстом операции.
type userError string

func (e userError) Error() string { return string(e) }

// New создаёт менеджер в состоянии idle с версией этой сборки.
func New(options Options) *Manager {
	if options.Client == nil {
		options.Client = http.DefaultClient
	}
	if options.LatestURL == "" {
		options.LatestURL = LatestURL
	}
	return &Manager{options: options, state: View{Status: StatusIdle, CurrentVersion: options.CurrentVersion}}
}

// PackageName — имя вложения выпуска для поставки, как его выпускают сценарии сборки.
func PackageName(version string, kind Kind) string {
	switch kind {
	case KindWindows:
		return "songframe-" + version + "-win-x64-setup.exe"
	case KindDeb:
		return "songframe-" + version + "-linux-amd64.deb"
	default:
		return "songframe-" + version + "-linux-x86_64.AppImage"
	}
}

var (
	releaseTag = regexp.MustCompile(`^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$`)
	semver     = regexp.MustCompile(`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$`)
	digest     = regexp.MustCompile(`^sha256:([a-f0-9]{64})$`)
)

// Newer сообщает, новее ли выпуск candidate (X.Y.Z) установленной версии current.
// Версия разработки X.Y.Z-суффикс младше выпуска X.Y.Z; непонятная current считается
// старше любого выпуска, чтобы не предлагать «обновление» неизвестной сборке.
func Newer(candidate, current string) bool {
	left, right := semver.FindStringSubmatch(candidate), semver.FindStringSubmatch(current)
	if left == nil || right == nil || left[4] != "" {
		return false
	}
	for index := 1; index <= 3; index++ {
		a, _ := strconv.Atoi(left[index])
		b, _ := strconv.Atoi(right[index])
		if a != b {
			return a > b
		}
	}
	return right[4] != ""
}

// release — нужные поля ответа GitHub; лишние игнорируются.
type release struct {
	TagName    string  `json:"tag_name"`
	Draft      bool    `json:"draft"`
	Prerelease bool    `json:"prerelease"`
	Assets     []asset `json:"assets"`
}

type asset struct {
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	Digest      string `json:"digest"`
	DownloadURL string `json:"browser_download_url"`
}

// ReleasePackage выбирает вложение своей поставки в выпуске новее current. Адрес обязан быть
// версионной ссылкой этого репозитория, digest — SHA-256, размер — положительным: иначе выпуск
// отвергается. Выпуск не новее current возвращает nil без ошибки и без разбора вложений:
// в более ранних выпусках может не быть пакета этой поставки (например, deb), и это не ошибка,
// а «актуальная версия».
func ReleasePackage(data []byte, kind Kind, current string) (*Package, error) {
	var value release
	if err := json.Unmarshal(data, &value); err != nil {
		return nil, userError(textInvalidRelease)
	}
	tag := releaseTag.FindStringSubmatch(value.TagName)
	if tag == nil || value.Draft || value.Prerelease {
		return nil, userError(textInvalidRelease)
	}
	version := tag[1]
	if !Newer(version, current) {
		return nil, nil
	}
	name := PackageName(version, kind)
	var found *asset
	for index := range value.Assets {
		if value.Assets[index].Name == name {
			found = &value.Assets[index]
			break
		}
	}
	if found == nil {
		return nil, userError(textPackageMissing)
	}
	url := "https://github.com/" + Repository + "/releases/download/v" + version + "/" + name
	sum := digest.FindStringSubmatch(found.Digest)
	if sum == nil || found.Size <= 0 || found.DownloadURL != url {
		return nil, userError(textInvalidRelease)
	}
	return &Package{
		Version: version, Page: "https://github.com/" + Repository + "/releases/tag/v" + version,
		Name: name, Size: found.Size, SHA256: sum[1], URL: url,
	}, nil
}

// View возвращает копию текущего состояния, в том числе прогресс идущего скачивания.
func (m *Manager) View() View {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// installable — установка без участия пользователя: AppImage на месте или установщик Windows.
func (m *Manager) installable() bool {
	return m.options.Kind == KindWindows || (m.options.Kind == KindAppImage && m.options.AppImage != "")
}

// set заменяет состояние, добавляя сведения найденного выпуска. Вызывается под mu.
func (m *Manager) set(next View) View {
	next.CurrentVersion = m.options.CurrentVersion
	if m.found != nil {
		next.Version, next.ReleaseURL, next.Installable = m.found.Version, m.found.Page, m.installable()
	}
	m.state = next
	return next
}

// exclusive выполняет одну операцию за раз: повторный вызов во время скачивания возвращает
// текущее состояние. Ошибка превращается в состояние error с сообщением для пользователя.
func (m *Manager) exclusive(failure string, action func() (View, error)) View {
	m.mu.Lock()
	if m.busy {
		defer m.mu.Unlock()
		return m.state
	}
	m.busy = true
	m.mu.Unlock()
	view, err := action()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.busy = false
	if err != nil {
		message := failure
		var user userError
		if errors.As(err, &user) {
			message = string(user)
		}
		return m.set(View{Status: StatusError, Message: message})
	}
	return view
}

// Check читает последний выпуск и сообщает, есть ли версия новее установленной.
func (m *Manager) Check(ctx context.Context) View {
	return m.exclusive(textCheckFailed, func() (View, error) {
		m.mu.Lock()
		m.found, m.file = nil, ""
		m.mu.Unlock()
		ctx, cancel := context.WithTimeout(ctx, checkTimeout)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, m.options.LatestURL, nil)
		if err != nil {
			return View{}, err
		}
		request.Header.Set("Accept", "application/vnd.github+json")
		response, err := m.options.Client.Do(request)
		if err != nil {
			return View{}, err
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			return View{}, userError(textCheckFailed)
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, releaseLimit))
		if err != nil {
			return View{}, err
		}
		found, err := ReleasePackage(data, m.options.Kind, m.options.CurrentVersion)
		if err != nil {
			return View{}, err
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if found == nil {
			return m.set(View{Status: StatusCurrent, Message: textCurrent}), nil
		}
		m.found = found
		return m.set(View{Status: StatusAvailable, Message: fmt.Sprintf(textAvailable, found.Version)}), nil
	})
}

// Download скачивает пакет найденного выпуска в .part и публикует его переименованием
// только после совпадения размера и SHA-256. Прежние пакеты удаляются: они занимают
// сотни мегабайт. Размер больше заявленного прерывает загрузку сразу.
func (m *Manager) Download(ctx context.Context) View {
	return m.exclusive(textDownloadFailed, func() (View, error) {
		m.mu.Lock()
		found := m.found
		m.file = ""
		m.mu.Unlock()
		if found == nil {
			return View{}, userError(textCheckFirst)
		}
		if err := os.RemoveAll(m.options.Directory); err != nil {
			return View{}, err
		}
		if err := os.MkdirAll(m.options.Directory, 0o755); err != nil {
			return View{}, err
		}
		file := filepath.Join(m.options.Directory, found.Name)
		m.mu.Lock()
		m.set(View{Status: StatusDownloading})
		m.mu.Unlock()
		if err := m.fetch(ctx, found, file); err != nil {
			_ = os.Remove(file + ".part")
			var user userError
			if !errors.As(err, &user) {
				err = userError(textDownloadFailed)
			}
			return View{}, err
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		m.file = file
		message := fmt.Sprintf(textReady, found.Version)
		switch {
		case m.installable():
		case m.options.Kind == KindDeb:
			message += " " + textReadyPackage
		default:
			message += " " + textReadyManual
		}
		return m.set(View{Status: StatusReady, Message: message}), nil
	})
}

// fetch пишет тело ответа в file.part, считая SHA-256 и прогресс, затем переименовывает.
func (m *Manager) fetch(ctx context.Context, found *Package, file string) error {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, found.URL, nil)
	if err != nil {
		return err
	}
	response, err := m.options.Client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return userError(textDownloadFailed)
	}
	partial := file + ".part"
	output, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	hash := sha256.New()
	size, err := m.copy(io.MultiWriter(output, hash), response.Body, found.Size)
	if closeErr := output.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if size != found.Size || hex.EncodeToString(hash.Sum(nil)) != found.SHA256 {
		return userError(textHashMismatch)
	}
	return os.Rename(partial, file)
}

// copy переносит данные блоками и обновляет долю скачанного; лишние байты — несовпадение.
func (m *Manager) copy(target io.Writer, source io.Reader, expected int64) (int64, error) {
	buffer := make([]byte, 256<<10)
	var size int64
	for {
		count, err := source.Read(buffer)
		if count > 0 {
			size += int64(count)
			if size > expected {
				return size, userError(textHashMismatch)
			}
			if _, writeErr := target.Write(buffer[:count]); writeErr != nil {
				return size, writeErr
			}
			m.mu.Lock()
			m.state.Progress = float64(size) / float64(expected)
			m.mu.Unlock()
		}
		if errors.Is(err, io.EOF) {
			return size, nil
		}
		if err != nil {
			return size, err
		}
	}
}

// Install ставит скачанный пакет. Windows: запускает установщик и закрывает приложение.
// AppImage: копия рядом и rename заменяют файл атомарно (запущенный процесс работает со
// старым inode, профиль AppArmor привязан к тому же пути), затем новый файл запускается
// после выхода. deb и запуск из исходников: показывает файл для ручной установки.
func (m *Manager) Install() View {
	return m.exclusive(textInstallFailed, func() (View, error) {
		m.mu.Lock()
		file, found := m.file, m.found
		m.mu.Unlock()
		if file == "" || found == nil {
			return View{}, userError(textCheckFirst)
		}
		switch {
		case m.options.Kind == KindWindows:
			if err := m.options.Launch(file); err != nil {
				return View{}, userError(textInstallFailed)
			}
		case m.installable():
			if err := replace(file, m.options.AppImage); err != nil {
				return View{}, userError(textInstallFailed)
			}
			if err := m.options.Relaunch(m.options.AppImage); err != nil {
				return View{}, userError(textInstallFailed)
			}
		default:
			if err := m.options.Reveal(file); err != nil {
				return View{}, err
			}
			return m.View(), nil
		}
		m.options.Quit()
		return m.View(), nil
	})
}

// replace копирует пакет в target.update рядом с AppImage и переименовывает поверх него.
func replace(file, target string) error {
	replacement := target + ".update"
	err := func() error {
		source, err := os.Open(file)
		if err != nil {
			return err
		}
		defer source.Close()
		output, err := os.OpenFile(replacement, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(output, source); err != nil {
			output.Close()
			return err
		}
		if err := output.Close(); err != nil {
			return err
		}
		if err := os.Chmod(replacement, 0o755); err != nil {
			return err
		}
		return os.Rename(replacement, target)
	}()
	if err != nil {
		_ = os.Remove(replacement)
	}
	return err
}

// DetectKind определяет поставку запущенного приложения: Windows — установщик, переменная
// APPIMAGE — AppImage, исполняемый файл в /usr — deb-пакет, иначе запуск из исходников.
func DetectKind(goos, appImage, executable string) Kind {
	switch {
	case goos == "windows":
		return KindWindows
	case appImage != "":
		return KindAppImage
	case strings.HasPrefix(filepath.ToSlash(executable), "/usr/"):
		return KindDeb
	default:
		return KindManual
	}
}
