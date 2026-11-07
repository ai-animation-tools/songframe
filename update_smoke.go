package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"songframe-go/internal/appversion"
	"songframe-go/internal/updates"
)

// updateSmokeRequest — проверка обновления готовой поставки без GitHub: подставной выпуск
// Version отдаёт файл Package, менеджер скачивает и сверяет его. В Linux он заменяет запущенный
// AppImage и перезапускает его с GUI smoke (отчёт в RelaunchReport); в Windows запускает
// скачанный установщик, как кнопка «Установить и перезапустить», и приложение закрывается.
type updateSmokeRequest struct {
	Package        string `json:"package"`
	Version        string `json:"version"`
	RelaunchReport string `json:"relaunchReport,omitempty"`
}

// updateSmokeReport — состояния менеджера после каждого шага.
type updateSmokeReport struct {
	CurrentVersion string       `json:"currentVersion"`
	AppImage       string       `json:"appImage"`
	Check          updates.View `json:"check"`
	Download       updates.View `json:"download"`
	Install        updates.View `json:"install"`
	Relaunched     bool         `json:"relaunched"`
	Launched       bool         `json:"launchedInstaller"`
	Files          []string     `json:"downloadedFiles"`
}

// releaseTransport отвечает на запросы менеджера описанием выпуска и байтами пакета, не
// выходя в сеть; адреса остаются настоящими адресами GitHub, которые проверяет менеджер.
type releaseTransport struct {
	release []byte
	data    []byte
}

func (t releaseTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	recorder := httptest.NewRecorder()
	switch url := request.URL.String(); {
	case url == updates.LatestURL:
		recorder.Write(t.release)
	case strings.HasPrefix(url, "https://github.com/"+updates.Repository+"/releases/download/"):
		recorder.Write(t.data)
	default:
		recorder.WriteHeader(http.StatusNotFound)
	}
	return recorder.Result(), nil
}

// runUpdateSmoke проходит check → download → install настоящим менеджером обновления.
// В Linux запускается только из AppImage (переменная APPIMAGE): заменяется именно запущенный
// файл, а перезапуск идёт тем же помощником, что у кнопки в настройках. В Windows скачанный
// установщик запускается так же, как кнопкой.
func runUpdateSmoke(ctx context.Context, input, output string) error {
	if !filepath.IsAbs(input) || !filepath.IsAbs(output) {
		return fmt.Errorf("update-smoke: нужны абсолютные пути input и report")
	}
	kind := updates.KindAppImage
	appImage := os.Getenv("APPIMAGE")
	if runtime.GOOS == "windows" {
		kind, appImage = updates.KindWindows, ""
	} else if appImage == "" {
		return fmt.Errorf("update-smoke: запустите сам AppImage, переменная APPIMAGE не задана")
	}
	data, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	var request updateSmokeRequest
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || !filepath.IsAbs(request.Package) || (kind == updates.KindAppImage && !filepath.IsAbs(request.RelaunchReport)) {
		return fmt.Errorf("update-smoke: запрос с абсолютными package и relaunchReport: %v", err)
	}
	payload, err := os.ReadFile(request.Package)
	if err != nil {
		return err
	}
	name := updates.PackageName(request.Version, kind)
	sum := sha256.Sum256(payload)
	release, _ := json.Marshal(map[string]any{
		"tag_name": "v" + request.Version, "draft": false, "prerelease": false,
		"assets": []map[string]any{{
			"name": name, "size": len(payload), "digest": "sha256:" + hex.EncodeToString(sum[:]),
			"browser_download_url": "https://github.com/" + updates.Repository + "/releases/download/v" + request.Version + "/" + name,
		}},
	})
	result, err := os.OpenFile(output, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("update-smoke: создание нового отчёта: %w", err)
	}
	defer result.Close()
	directory, err := os.MkdirTemp("", "songframe-update-smoke-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(directory)
	report := updateSmokeReport{CurrentVersion: appversion.Version, AppImage: appImage}
	manager := updates.New(updates.Options{
		CurrentVersion: appversion.Version, Kind: kind, Directory: directory, AppImage: appImage,
		Client: &http.Client{Transport: releaseTransport{release: release, data: payload}},
		Launch: func(file string) error {
			report.Launched = true
			return updates.LaunchInstaller(file)
		},
		Relaunch: func(path string) error {
			report.Relaunched = true
			return updates.RelaunchAppImage(path, "--smoke", "--smoke-report", request.RelaunchReport, "--smoke-timeout", "60s")
		},
		Quit:   func() {},
		Reveal: func(string) error { return fmt.Errorf("показ файла не ожидается") },
	})
	report.Check = manager.Check(ctx)
	report.Download = manager.Download(ctx)
	entries, _ := os.ReadDir(directory)
	for _, entry := range entries {
		report.Files = append(report.Files, entry.Name())
	}
	report.Install = manager.Install()
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if _, err := result.Write(append(encoded, '\n')); err != nil {
		return err
	}
	if !(report.Relaunched || report.Launched) || report.Download.Status != updates.StatusReady {
		return fmt.Errorf("update-smoke: обновление не дошло до перезапуска")
	}
	return nil
}
