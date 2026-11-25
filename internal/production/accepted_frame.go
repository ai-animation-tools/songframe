package production

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"songframe/internal/mediacmd"
	"songframe/internal/shoteffects"
)

// AcceptedFrame — кадр принятого видео плана, сохранённый для работы вне клипа: файл PNG, папка
// с ним (её открывает «Открыть папку») и номер кадра в принятом видео.
type AcceptedFrame struct {
	Path   string `json:"path"`
	Folder string `json:"folder"`
	Frame  int    `json:"frame"`
}

// TakeAcceptedFrame сохраняет кадр frame принятого видео комплекта плана shot в PNG полного
// размера в папку folder/<имя папки проекта>: референс или своя опора следующего плана. Кадр
// берётся из video.mp4 комплекта, а не из ролика с эффектом, — свет и дождь плана в опору не
// переходят. Файлы проекта не меняются; одноимённый прежний кадр заменяется целиком (тот же кадр
// того же видео даёт те же байты), незаконченный PNG своего имени не получает.
func TakeAcceptedFrame(ctx context.Context, project, shot string, frame int, folder string) (*AcceptedFrame, error) {
	if !acceptedShotID.MatchString(shot) {
		return nil, fmt.Errorf("неверный код плана: %q", shot)
	}
	video, _, frames, err := shoteffects.AcceptedVideo(project, shot)
	if err != nil {
		return nil, err
	}
	if frame < 0 || frame >= frames {
		return nil, errors.New(textFrameOutside(frame, frames))
	}
	if folder == "" {
		return nil, errors.New("не задана папка для кадра")
	}
	target := filepath.Join(folder, filepath.Base(filepath.Clean(project)))
	if err := os.MkdirAll(target, 0o755); err != nil {
		return nil, fmt.Errorf("не создать папку для кадра %s: %w", target, err)
	}
	name := filepath.Join(target, fmt.Sprintf("%s-кадр-%04d.png", shot, frame))
	temporary, err := os.CreateTemp(target, ".frame-*.png")
	if err != nil {
		return nil, fmt.Errorf("не записать кадр в %s: %w", target, err)
	}
	temporary.Close()
	defer os.Remove(temporary.Name())
	result, err := mediacmd.Run(ctx, mediacmd.FFmpeg(), "-hide_banner", "-loglevel", "error", "-y", "-i", video,
		"-vf", fmt.Sprintf(`select=eq(n\,%d)`, frame), "-frames:v", "1", "-f", "image2", "-c:v", "png", temporary.Name())
	if err != nil {
		return nil, err
	}
	if info, statErr := os.Stat(temporary.Name()); result.Code != 0 || statErr != nil || info.Size() == 0 {
		return nil, fmt.Errorf("FFmpeg не извлёк кадр %d: %s", frame, mediacmd.Tail(result.Stderr, 2000))
	}
	if err := os.Rename(temporary.Name(), name); err != nil {
		return nil, fmt.Errorf("не сохранить кадр %s: %w", name, err)
	}
	return &AcceptedFrame{Path: name, Folder: target, Frame: frame}, nil
}
