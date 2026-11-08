package kling

import (
	"context"
	"fmt"
	"regexp"

	"songframe-go/internal/mediaapi"
	"songframe-go/internal/providers/kling/mcp"
)

// Особенности Kling для слоя провайдеров приложения (internal/providers): правила нормализации
// платного запроса и строка страницы «Среда». Вход и проверка входа идут общим путём через
// mediaapi.Loginer и AuthStatusReader этого же адаптера.

// ID — id провайдера в реестре и таблице адаптеров.
const ID = mcp.ProviderID

// environmentHint — подсказка строки «Среда»: способ поставки и входа через браузер — особенность Kling.
const environmentHint = "Клиент входит в поставку. Войдите кнопкой входа в браузере; без сети состояние входа не определяется."

// watermarkMessage — отказ от устаревшей настройки watermark=true: проект использует оригиналы
// без логотипа, и старые options не должны разрешить новый запрос с водяным знаком.
const watermarkMessage = "Снимите устаревшую настройку watermark=true: оригиналы запрашиваются без логотипа."

// RequestRules — правила запроса Kling: синонимы разрешения и
// пропорций изображений, имена числа результатов, флаги входов, запрет логотипа, команды
// изображения по числу референсов и параметры, которые задаёт начальный кадр видео.
func RequestRules() mediaapi.RequestRules {
	return mediaapi.RequestRules{
		Aliases: map[string][]mediaapi.Alias{
			"image": {
				{Name: "resolution", Names: []string{"resolution", "img_resolution", "imgResolution"}},
				{Name: "aspect_ratio", Names: []string{"aspect_ratio", "aspectRatio"}},
			},
		},
		OutputCount: []string{"image_count", "imageCount"},
		InputFlags: []mediaapi.InputFlag{
			{Flag: "image", Pattern: regexp.MustCompile(`^(?:first_image|image(?:_\d+)?|keyframe_\d+)$`)},
			{Flag: "tailImage", Pattern: regexp.MustCompile(`^tail_image(?:_\d+)?$`)},
			{Flag: "audio", Pattern: regexp.MustCompile(`^audio(?:_\d+)?$`)},
			{Flag: "video", Pattern: regexp.MustCompile(`^video(?:_\d+)?$`)},
		},
		Enforced: []mediaapi.Enforced{{Name: "watermark", Value: false, Rejected: []any{true, "true"}, Message: watermarkMessage}},
		Image: mediaapi.ImageRules{
			Command: func(references int) string {
				if references > 0 {
					return "image_to_image"
				}
				return "text_to_image"
			},
			// image_N относится к N-му переданному референсу независимо от порядка ключей capabilities.
			ReferenceSlot: func(index int) string { return fmt.Sprintf("image_%d", index+1) },
			Series:        &mediaapi.ImageSeries{Names: []string{"story_mode", "storyMode"}, Off: false},
		},
		// Обычному плану до этапа запроса нужен только режим по опорам; остальные режимы агент
		// видит при запросе и для липсинка.
		DraftVideoCommands: []string{"image_to_video"},
		// Пропорции ролика с начальным кадром задаёт кадр; у части моделей aspect_ratio с кадром
		// не передаётся.
		FrameDefined: &mediaapi.FrameDefined{Slots: regexp.MustCompile(`^first_image$`), Parameters: []string{"aspect_ratio"}},
	}
}

// Environment — строка страницы «Среда»: клиент входит в поставку (отдельной программы нет),
// поэтому проверка только отмечает его наличие; состояние входа страница узнаёт отдельным
// запросом providerAuth. title — название из реестра провайдеров.
func Environment(title string) mediaapi.Environment {
	bundled := true
	return mediaapi.Environment{
		Checks: []mediaapi.EnvironmentCheck{{
			ID: ID, Label: title, Hint: environmentHint, ProductionOnly: true, Detail: mediaapi.TextEnvironmentWaiting,
			Status: "pending", Bundled: &bundled, LoginProvider: ID,
		}},
		Run: func(_ context.Context, update func(string, mediaapi.EnvironmentUpdate)) {
			ok, detail, elapsed := true, mediaapi.TextBundledClient, 0
			update(ID, mediaapi.EnvironmentUpdate{Status: "done", OK: &ok, Detail: &detail, ElapsedMs: &elapsed})
		},
	}
}
