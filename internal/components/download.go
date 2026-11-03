package components

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// downloadRecord привязывает частичный файл к сильному ETag и конкретному закреплённому запросу.
// Без подтверждённого валидатора повтор начинается с нуля, а не склеивает разные версии.
type downloadRecord struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	ETag   string `json:"etag"`
}

// obtainArtifact выбирает только явный офлайн-файл либо адрес из manifest.
// Cache и staging находятся в выбранной папке компонентов на одном диске.
func (m *Manager) obtainArtifact(ctx context.Context, root string, a Artifact, local string) (string, error) {
	if local != "" {
		info, err := os.Stat(local)
		if err != nil {
			return "", err
		}
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("офлайн-источник не является обычным файлом")
		}
		return local, nil
	}
	cache := filepath.Join(root, ".downloads")
	if err := os.MkdirAll(cache, 0700); err != nil {
		return "", err
	}
	name := filepath.Join(cache, a.ID+"-"+a.SHA256+".part")
	var record downloadRecord
	data, _ := os.ReadFile(name + ".json")
	json.Unmarshal(data, &record)
	offset := int64(0)
	if info, err := os.Stat(name); err == nil && info.Mode().IsRegular() {
		offset = info.Size()
	}
	if offset == a.Bytes {
		return name, nil
	}
	if offset > a.Bytes || record.URL != a.URL || record.SHA256 != a.SHA256 || record.ETag == "" || strings.HasPrefix(record.ETag, "W/") {
		offset = 0
	}
	m.installUpdate("downloading", a.Component, offset, a.Bytes, "Загрузка закреплённого компонента; подтверждённая часть сохраняется для повтора.")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept-Encoding", "identity")
	if offset > 0 {
		req.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
		req.Header.Set("If-Range", record.ETag)
	}
	response, err := m.installOptions.client.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	expected := fmt.Sprintf("bytes %d-%d/%d", offset, a.Bytes-1, a.Bytes)
	confirmedRange := offset > 0 && response.StatusCode == http.StatusPartialContent && response.Header.Get("Content-Range") == expected && response.Header.Get("ETag") == record.ETag
	if response.StatusCode != http.StatusOK && !confirmedRange && offset > 0 {
		response.Body.Close()
		// Неподтверждённый Range не склеивается с кэшем: выполняется один полный запрос.
		full, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, a.URL, nil)
		if requestErr != nil {
			return "", requestErr
		}
		full.Header.Set("Accept-Encoding", "identity")
		response, err = m.installOptions.client.Do(full)
		if err != nil {
			return "", err
		}
		defer response.Body.Close()
		offset = 0
	}
	if response.StatusCode == http.StatusOK {
		offset = 0
	} else if !confirmedRange || offset == 0 {
		return "", fmt.Errorf("сервер не подтвердил загрузку: HTTP %d", response.StatusCode)
	}
	if coding := response.Header.Get("Content-Encoding"); coding != "" && coding != "identity" {
		return "", fmt.Errorf("сервер изменил кодирование закреплённых байтов")
	}
	// Размер в manifest относится к точным bytes закреплённого SHA, а не к плавающей оценке сервера.
	// При известном Content-Length несовпадение отклоняется до записи, без подмены expected размера.
	if response.ContentLength >= 0 && response.ContentLength != a.Bytes-offset {
		return "", fmt.Errorf("сервер сообщает другой размер компонента: ожидается %d байт, получено %d; файл не установлен", a.Bytes-offset, response.ContentLength)
	}
	etag := response.Header.Get("ETag")
	if strings.HasPrefix(etag, "W/") {
		etag = ""
	}
	metadata, _ := json.Marshal(downloadRecord{URL: a.URL, SHA256: a.SHA256, ETag: etag})
	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_APPEND
	}
	f, err := os.OpenFile(name, flags, 0600)
	if err != nil {
		return "", err
	}
	// Валидатор записывается после обнуления старого файла и до новых байтов: сбой не связывает старый payload с новым ETag.
	if err = atomicJSON(cache, filepath.Base(name)+".json", metadata); err != nil {
		f.Close()
		return "", err
	}
	writer := &downloadWriter{file: f, manager: m, completed: offset, total: a.Bytes}
	_, err = io.CopyBuffer(writer, io.LimitReader(response.Body, a.Bytes-offset+1), make([]byte, 256*1024))
	if err == nil && writer.completed != a.Bytes {
		err = fmt.Errorf("загрузка оборвалась: получено %s из %s байт", strconv.FormatInt(writer.completed, 10), strconv.FormatInt(a.Bytes, 10))
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	return name, nil
}

// downloadWriter ограничивает размер сетевого ответа и обновляет прогресс после фактической записи.
type downloadWriter struct {
	file             *os.File
	manager          *Manager
	completed, total int64
}

// Write учитывает только фактически записанные байты, поэтому ошибка диска не завышает прогресс.
func (w *downloadWriter) Write(p []byte) (int, error) {
	if w.completed+int64(len(p)) > w.total {
		return 0, fmt.Errorf("сервер прислал больше закреплённого размера")
	}
	n, err := w.file.Write(p)
	w.completed += int64(n)
	w.manager.installProgress(w.completed, w.total)
	return n, err
}

// verifyPayload проверяет размер и SHA с отменой, не доверяя имени локального файла или HTTP-заголовкам.
func verifyPayload(ctx context.Context, name string, size int64, expected string) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()
	info, statErr := f.Stat()
	if statErr != nil {
		return statErr
	}
	if info.Size() != size {
		return fmt.Errorf("выбранный файл не соответствует размеру закреплённого компонента: ожидается %d байт, получено %d", size, info.Size())
	}
	hash := sha256.New()
	count, err := io.CopyBuffer(hash, contextReader{ctx, f}, make([]byte, 256*1024))
	if err != nil {
		return err
	}
	if count != size || hex.EncodeToString(hash.Sum(nil)) != expected {
		return fmt.Errorf("файл не совпадает с закреплённым SHA-256/размером")
	}
	return nil
}
