package productionworkflow

import (
	"context"
	"errors"
)

// TextFramesNotMigrated — отказ генерации и импорта опор до этапа 45g.3: задание провайдера-агента
// изображений, платный запрос опоры и разбор его результата ещё не перенесены.
const TextFramesNotMigrated = "Действие ещё не перенесено в Go-версию SongFrame: создание и импорт опор переносит этап 45g.3."

// textFramesNotMigrated — разбор предложения опор, созданного заданием провайдера-агента, без
// подключённого CollectImages.
const textFramesNotMigrated = TextFramesNotMigrated

// GenerateFrames — generateFrames оригинала: следующая по плану опора создаётся заданием
// провайдера-агента или готовится платным запросом одной опоры. Этап 45g.3 переносит его поверх
// ReadContext (NextFrame, UndecidedFrame, FrameNotes, RulesFor), Snapshot и Store; до этого
// метод отказывает понятным текстом без побочных эффектов.
func (w *Workflow) GenerateFrames(ctx context.Context, project, shot, packageDir string) (View, error) {
	return View{}, errors.New(TextFramesNotMigrated)
}

// ImportFrames — importFrames оригинала: свои изображения для неутверждённых опор становятся
// готовым предложением опор (CheckFrameCandidates, Snapshot, Store). Перенос — этап 45g.3; до
// этого метод отказывает понятным текстом без побочных эффектов.
func (w *Workflow) ImportFrames(project, shot, packageDir string, images []FrameCandidate) (View, error) {
	return View{}, errors.New(TextFramesNotMigrated)
}
