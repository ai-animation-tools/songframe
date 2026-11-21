package productionworkflow

import (
	"os"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
	"songframe/internal/providers"
	"songframe/resources"
)

// promptContract — инструкция и JSON-контракт задания агента производства после текста скилла.
// Владелец промпта — этот проход; текст входит в SHA задания агента и зафиксирован эталоном
// testdata/golden/production-workflow.
const promptContract = "" +
	"Форма: description={\"schemaVersion\":1,\"stage\":\"description\",\"description\":\"текст\",\"requestSeconds\":целое,\"keyframes\":[{\"id\":\"K01\",\"role\":\"first\",\"timeSeconds\":0,\"prompt\":\"полный промпт изображения\",\"referencePaths\":[\"source/...\"]},...,{\"id\":\"KNN\",\"role\":\"last\",\"timeSeconds\":requestSeconds,\"prompt\":\"...\",\"referencePaths\":[]}]}; " +
	"prompt={\"schemaVersion\":1,\"stage\":\"prompt\",\"prompt\":\"полный видеопромпт на языке указаний провайдера\",\"translation\":\"тот же промпт по-русски\"}. " +
	"Никаких других полей, кроме необязательного copyOf опоры. ID опор K01,K02,... подряд, first на 0 и last на requestSeconds, middle строго между. " +
	"Опора, которая кадр в кадр повторяет более раннюю (удержание без видимых изменений), — копия: {\"id\":\"K03\",\"role\":\"last\",\"timeSeconds\":requestSeconds,\"prompt\":\"\",\"referencePaths\":[],\"copyOf\":\"K02\"}; источник — более ранняя опора, не копия; приложение не создаёт копию, а берёт файл источника после его утверждения. Источником копии может быть и кадр из continuityFrames (copyOf — его path): так первая опора плана, продолжающего кадр принятого плана без смены точки, становится самим этим кадром. Сохраняй утверждённую постановку, внешность и непрерывность. " +
	"Запрос видео (модель, параметры, входы) по утверждённым опорам и видеопромпту собирает приложение; settings.model — предпочтение модели для него. " +
	"Соблюдай settings.duration_rule и выбери ближайшую длительность, которую по capabilities поддерживает модель, принимающая все опоры плана. Не выдумывай возможности моделей, путь WAV и цену. На этапах description и prompt speech может ещё отсутствовать: приложение режет WAV в блоке «Речь» после описания, длиной requestSeconds от начала окна; не прерывайся из-за этого. Для речевого плана requestSeconds выбирай в пределах lipSync.min..lipSync.max (длина звука, которую принимает провайдер) и по правилу длительности; запас после окна уходит в монтаж обрезкой. Пути только из allowedPaths. " +
	"Если manualGeneration=true, видео плана создаёт пользователь вне приложения в форме сайта провайдера по одной опоре, звуку среза и видеопромпту. На этапе description — ровно одна опора K01 с role first и timeSeconds 0, без last. На этапе prompt не используй обозначения входов (图片1, 音频1 и подобные): пиши «изображение» и «аудио» — «Изображение задаёт внешность…», «используй изображение как визуальный референс», «движения губ точно совпадают с исполнением в аудио». Запроса к сервису нет: правила lipSync и capabilities к такому плану не относятся, и отсутствие в capabilities режима lip sync или звукового слота — не причина отказа. requestSeconds — наименьшее целое число, удовлетворяющее settings.duration_rule относительно окна, без сетки длительностей моделей: такой длины приложение режет срез речи, который пользователь загрузит на сайт. " +
	"Если manualVideo=true, для этой попытки пользователь выбрал создать видео вне приложения в форме сайта сервиса по утверждённым опорам и видеопромпту. На этапе prompt не используй обозначения входов (图片1 и подобные): называй опоры словами — «первое изображение», «последнее изображение», «промежуточное изображение». " +
	"Длина видеопромпта — не больше promptMaxChars символов (предел провайдера видео); если promptMaxChars нет, предела нет. " +
	"Если передан keyframeCount, число опор выбрал пользователь: на этапе description верни ровно keyframeCount опор; при keyframeCount=1 — одна опора K01 с role first и timeSeconds 0, без last; при 2 — first и last; больше — first, last и middle между ними. Без keyframeCount число опор выбирай сам. " +
	"На этапе description противоречие сценария, из-за которого непротиворечивые опоры не подготовить, — не текст, а отказ blocked={\"schemaVersion\":1,\"stage\":\"blocked\",\"reason\":\"итог одной фразой\",\"problems\":[{\"phase\":\"before|after\",\"entity\":\"ID сущности\",\"property\":\"ключ свойства\",\"conflict\":\"текущее значение и его источник из stateSources, с чем и почему оно расходится\",\"fix\":\"новое значение свойства или null\"},{\"field\":\"action|camera|continuity|references\",\"conflict\":\"...\"}]} по разделу «Противоречия сценария»."

// skillText — скилл ai-clip-scene и указания провайдеров, выбранных в проекте: SKILL.md,
// references/app-proposal.md, references/prompt-template.md, на этапе prompt — примеры принятых
// видеопромптов (описанию они не нужны и только удлинили бы его задание), раздел «Указания агенту»
// документа провайдера видео и изображений. Пустые части пропускаются, части разделены пустой
// строкой. Файлы встроены в бинарник вместо чтения из корня комплекса.
func skillText(stage string, videoProvider, imageProvider any) string {
	parts := []string{}
	files := []string{"SKILL.md", "references/app-proposal.md", "references/prompt-template.md"}
	if stage == "prompt" {
		files = append(files, "references/video-prompt-examples.md")
	}
	for _, file := range files {
		if text, err := resources.SkillFile(resources.SkillScene, file); err == nil && text != "" {
			parts = append(parts, text)
		}
	}
	// Особенности сервисов приходят из документов провайдеров, выбранных в проекте.
	if guide, ok := providers.Guide(mediaproviders.Video, videoProvider); ok && guide != "" {
		parts = append(parts, guide)
	}
	if guide, ok := providers.Guide(mediaproviders.Image, imageProvider); ok && guide != "" {
		parts = append(parts, guide)
	}
	return strings.Join(parts, "\n\n")
}

// agentPrompt — промпт задания этапа stage: скилл и режим приложения output=proposal.
func agentPrompt(stage string, videoProvider, imageProvider any) string {
	return skillText(stage, videoProvider, imageProvider) + "\n\nРежим приложения: output=proposal, stage=" + stage +
		". Верни ровно один JSON без Markdown. Файлы не записывай; материалы клипа по путям из контекста можно открывать и смотреть. " + promptContract
}

// readText — содержимое файла или "" без файла; ошибка чтения возвращается.
func readText(path string) (string, error) {
	if !dynvalue.Exists(path) {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	return dynvalue.DecodeUTF8(data), nil
}

// contextInput — сведения задания, которых нет в Context: этап, врезки непрерывности, объявления
// моделей и замечание.
type contextInput struct {
	stage               string
	briefs              *dynvalue.Object
	description, prompt any
	lipSync             *mediaproviders.LipSync
	manual              bool
	// manualVideo — попытка с выбранным способом «Вручную вне приложения» (не речевой план без
	// липсинка, у того manual).
	manualVideo         bool
	capabilities        *dynvalue.Array
	capabilitiesProblem string
	note                any
	// promptMaxChars — предел длины видеопромпта провайдера для этапа prompt; 0 — ключ не пишется.
	promptMaxChars int
	// keyframeCount — число опор, выбранное пользователем для этапа description; 0 — ключ не пишется.
	keyframeCount int
	// shotFrames — кадры других планов этапа description (shotFramesTree); nil — ключ не пишется.
	shotFrames *dynvalue.Object
	// stateSources — источники значений врезок этапа description (stateSourcesTree); nil — ключ
	// не пишется.
	stateSources *dynvalue.Object
	// attachedFrames и materials — опоры, приложенные к заданию prompt, и пути к материалам клипа
	// (promptAttachments); nil — ключ не пишется.
	attachedFrames *dynvalue.Array
	materials      *dynvalue.Object
}

// agentContext — JSON контекста задания (порядок ключей зафиксирован эталоном): план, кастинг, врезки,
// настройки, текущий пакет, допустимые пути, возможности моделей и замечание.
func agentContext(c *Context, input contextInput) string {
	value := dynvalue.NewObject()
	value.Set("stage", input.stage)
	value.Set("scene", c.Scene)
	value.Set("shot", c.Scene)
	value.Set("cast", c.Cast)
	value.Set("references", c.References)
	// Факты кадра передаются только плану с точкой съёмки: контекст остальных не меняется.
	if c.Frame != nil {
		value.Set("frame", c.Frame)
	}
	value.Set("brief", input.briefs)
	value.Set("settings", c.Settings)
	if c.Workflow == nil {
		value.Set("existing", nil)
	} else {
		value.Set("existing", c.Workflow)
	}
	value.Set("description", input.description)
	value.Set("prompt", input.prompt)
	value.Set("keyframes", c.FramePrompts)
	value.Set("speech", c.Speech.tree())
	if input.lipSync == nil {
		value.Set("lipSync", nil)
	} else {
		limits := dynvalue.NewObject()
		limits.Set("min", input.lipSync.Min)
		limits.Set("max", input.lipSync.Max)
		value.Set("lipSync", limits)
	}
	// Признак ручной генерации передаётся только такому плану: контекст остальных не меняется.
	if input.manual {
		value.Set("manualGeneration", true)
	}
	// Выбранный для попытки ручной способ передаётся только ей: контекст остальных не меняется.
	if input.manualVideo {
		value.Set("manualVideo", true)
	}
	value.Set("allowedPaths", stringsArray(c.AllowedPaths))
	value.Set("windowSeconds", c.Window)
	value.Set("capabilities", input.capabilities)
	value.Set("capabilitiesProblem", input.capabilitiesProblem)
	value.Set("note", input.note)
	// Предел передаётся только этапу prompt с известным пределом: контекст остальных не меняется.
	if input.promptMaxChars > 0 {
		value.Set("promptMaxChars", float64(input.promptMaxChars))
	}
	// Выбранное число опор передаётся только при явном выборе: контекст «авто» не меняется.
	if input.keyframeCount > 0 {
		value.Set("keyframeCount", float64(input.keyframeCount))
	}
	// Кадры других планов передаются только описанию плана со связанными планами: контекст
	// остальных не меняется.
	if input.shotFrames != nil {
		value.Set("continuityFrames", input.shotFrames)
	}
	// Источники значений врезок передаются только описанию: по ним агент называет, где задано
	// противоречивое значение. Контекст остальных этапов не меняется.
	if input.stateSources != nil {
		value.Set("stateSources", input.stateSources)
	}
	// Опоры и материалы передаются только этапу prompt: контекст описания не меняется.
	if input.attachedFrames != nil {
		value.Set("attachedFrames", input.attachedFrames)
	}
	if input.materials != nil {
		value.Set("materials", input.materials)
	}
	return dynvalue.Stringify(value)
}

// stringsArray — список строк как массив dynvalue для сериализации входов промпта.
func stringsArray(items []string) *dynvalue.Array {
	values := make([]any, len(items))
	for index, item := range items {
		values[index] = item
	}
	return &dynvalue.Array{Items: values}
}
