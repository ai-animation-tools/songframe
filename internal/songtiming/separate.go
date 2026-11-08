package songtiming

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"songframe-go/internal/components"
	"songframe-go/internal/filedigest"
	"songframe-go/internal/jobs"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/songml"
)

// separate — шаг выделения вокала (separate_vocals оригинала). Порядок публикации: полный
// трек декодируется и разделяется в памяти, WAV пишется во временный файл каталога попытки и
// переименовывается в vocals.wav, result.json пишется последним — только он делает попытку
// видимой. Перед каждой публикацией сверяется SHA исходника. Любая ошибка или отмена удаляет
// каталог попытки целиком: частичный результат не остаётся в кэше.
func (s *Service) separate(ctx context.Context, step *jobs.StepContext, project, sourceSHA, output string) (resultErr error) {
	paths, err := s.ready(ctx, operationSeparate)
	if err != nil {
		return err
	}
	model := knownModels[0]
	modelPath := paths["voc-ft/model"]
	modelSHA, ok := filedigest.File(modelPath)
	if !ok || modelSHA != model.SHA256 {
		return errors.New("SHA-256 модели не совпадает с закреплённой версией. Скачайте модель заново.")
	}
	track := filepath.Join(project, "source", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(output), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(output, 0o700); err != nil {
		return err
	}
	defer func() {
		if resultErr != nil || ctx.Err() != nil {
			os.RemoveAll(output)
		}
	}()
	unchanged := func(stage string) error {
		digest, err := fileSHA256(track)
		if err != nil || digest != sourceSHA {
			return errors.New("Исходный трек изменился " + stage + ". Результат не опубликован.")
		}
		return nil
	}
	started := time.Now()
	signal, err := songml.DecodeStereo(ctx, paths["ffmpeg/ffmpeg"], track)
	if err != nil {
		return err
	}
	step.Log(fmt.Sprintf("Декодировано: %.1f с stereo 44,1 кГц.\n", float64(len(signal[0]))/songml.VocalSampleRate))
	if err := components.PrepareORT(ctx, paths["ort-cpu/ort-library"]); err != nil {
		return err
	}
	session, err := songml.Open(ctx, modelPath, threads())
	if err != nil {
		return err
	}
	step.Log(fmt.Sprintf("ONNX Runtime %s, потоков: %d, загрузка модели %.1f с.\n", session.Version, session.Threads, session.LoadSeconds))
	vocals, err := session.Separate(ctx, signal, func(done, total int) {
		step.Log(fmt.Sprintf("Выделение вокала: %d/%d\n", done, total))
	})
	session.Close()
	if err != nil {
		return err
	}
	if err := unchanged("во время выделения вокала"); err != nil {
		return err
	}
	audio := filepath.Join(output, "vocals.wav")
	if err := writeWAV(audio, vocals); err != nil {
		return err
	}
	if err := unchanged("перед публикацией вокала"); err != nil {
		return err
	}
	audioSHA, err := fileSHA256(audio)
	if err != nil {
		return err
	}
	data := metadata{
		SchemaVersion: 1, SourceSHA256: sourceSHA, ModelID: model.ID, ModelSHA256: modelSHA, RecipeVersion: 1,
		SampleRate: songml.VocalSampleRate, Channels: 2, Samples: int64(len(vocals[0])), AudioFile: "vocals.wav",
		AudioSHA256: audioSHA, CreatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000000-07:00"),
	}
	if err := unchanged("перед публикацией результата"); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := projectfs.WriteJSON(filepath.Join(output, "result.json"), data); err != nil {
		return err
	}
	step.Log(fmt.Sprintf("Готово за %.1f с: %s\n", time.Since(started).Seconds(), audio))
	return nil
}

// writeWAV пишет PCM16 во временный файл каталога и переименовывает его в итоговое имя.
func writeWAV(path string, signal [2][]float32) error {
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	err = songml.WriteStereoWAV(file, signal)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporary, path)
}
