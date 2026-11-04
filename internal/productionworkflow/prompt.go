package productionworkflow

import (
	"os"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/providers"
	"songframe-go/resources"
)

// promptContract — инструкция и JSON-контракт задания агента производства после текста скилла
// (production-workflow.ts оригинала дословно). Владелец промпта — этот проход; текст входит в SHA
// задания агента.
const promptContract = "" +
	"Форма: description={\"schemaVersion\":1,\"stage\":\"description\",\"description\":\"текст\",\"requestSeconds\":целое,\"keyframes\":[{\"id\":\"K01\",\"role\":\"first\",\"timeSeconds\":0,\"prompt\":\"полный промпт изображения\",\"referencePaths\":[\"source/...\"]},...,{\"id\":\"KNN\",\"role\":\"last\",\"timeSeconds\":requestSeconds,\"prompt\":\"...\",\"referencePaths\":[]}]}; " +
	"prompt={\"schemaVersion\":1,\"stage\":\"prompt\",\"prompt\":\"полный видеопромпт\"}; request={\"schemaVersion\":1,\"stage\":\"request\",\"request\":{\"model\":\"точное имя из capabilities\",\"command\":\"точное имя команды из capabilities\",\"parameters\":{\"duration\":requestSeconds,...параметры capabilities},\"inputs\":[{\"flag\":\"input\",\"slot\":\"слот из capabilities\",\"path\":\"объявленный путь\",\"role\":\"назначение файла\"}],\"outputs\":1}}. " +
	"Команду, параметры и слоты входов бери только из capabilities выбранной модели; какой слот служит первым и последним кадром, а какой референсом, — в указаниях провайдера видео. " +
	"flag — input с объявленным slot либо короткий флаг из inputFlags без slot; не смешивай эти способы в одном запросе. " +
	"Никаких других полей. ID опор K01,K02,... подряд, first на 0 и last на requestSeconds, middle строго между. Сохраняй утверждённую постановку, внешность и непрерывность. " +
	"settings.model — необязательное предпочтение. Сначала выбери по capabilities модель, совместимую с длительностью, разрешением, пропорциями и всеми референсами задачи. " +
	"Если предпочтение несовместимо, предложи другую модель и её собственные объявленные параметры; не переноси флаги другой модели и не уменьшай требования ради предпочтения. " +
	"Соблюдай settings.duration_rule и выбери ближайшую поддерживаемую длительность, если capabilities доступны. Не выдумывай возможности моделей, путь WAV и цену. Для липсинка нужен готовый точный WAV: на этапе request передай speech.path входом объявленного звукового слота модели, а duration запроса выбери не меньше длины speech (sourceSeconds) и выбери модель с таким слотом (какой слот — в указаниях провайдера видео); если на этапе request speech нет, сообщи диагностическую ошибку вместо произвольной команды. На этапах description и prompt speech может ещё отсутствовать: приложение режет WAV в блоке «Речь» после описания, длиной requestSeconds от начала окна; не прерывайся из-за этого. Для речевого плана requestSeconds выбирай в пределах lipSync.min..lipSync.max (длина звука, которую принимает провайдер) и по правилу длительности; запас после окна уходит в монтаж обрезкой. Пути только из allowedPaths."

// skillText — скилл ai-clip-scene и указания провайдеров, выбранных в проекте: SKILL.md,
// references/app-proposal.md, references/prompt-template.md, раздел «Указания агенту» документа
// провайдера видео и изображений. Пустые части пропускаются, части разделены пустой строкой.
// Файлы встроены в бинарник вместо чтения из корня комплекса.
func skillText(videoProvider, imageProvider any) string {
	parts := []string{}
	for _, file := range []string{"SKILL.md", "references/app-proposal.md", "references/prompt-template.md"} {
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
	return skillText(videoProvider, imageProvider) + "\n\nРежим приложения: output=proposal, stage=" + stage +
		". Верни ровно один JSON без Markdown, записей файлов, shell и вызовов инструментов. " + promptContract
}

// readText — text() оригинала: содержимое файла или "" без файла; ошибка чтения возвращается.
func readText(path string) (string, error) {
	if !jscompat.Exists(path) {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", jscompat.FsError("open", path, err)
	}
	return jscompat.DecodeUTF8(data), nil
}

// contextInput — сведения задания, которых нет в Context: этап, врезки непрерывности, объявления
// моделей и замечание.
type contextInput struct {
	stage               string
	briefs              *jscompat.Object
	description, prompt any
	lipSync             *mediaproviders.LipSync
	capabilities        *jscompat.Array
	capabilitiesProblem string
	inputFlags          []string
	note                any
}

// agentContext — JSON контекста задания (порядок ключей оригинала): план, кастинг, врезки,
// настройки, текущий пакет, допустимые пути, возможности моделей и замечание.
func agentContext(c *Context, input contextInput) string {
	value := jscompat.NewObject()
	value.Set("stage", input.stage)
	value.Set("scene", c.Scene)
	value.Set("shot", c.Scene)
	value.Set("cast", c.Cast)
	value.Set("references", c.References)
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
		limits := jscompat.NewObject()
		limits.Set("min", input.lipSync.Min)
		limits.Set("max", input.lipSync.Max)
		value.Set("lipSync", limits)
	}
	value.Set("allowedPaths", stringsArray(c.AllowedPaths))
	value.Set("windowSeconds", c.Window)
	value.Set("capabilities", input.capabilities)
	value.Set("capabilitiesProblem", input.capabilitiesProblem)
	value.Set("inputFlags", stringsArray(input.inputFlags))
	value.Set("note", input.note)
	return jscompat.Stringify(value)
}

// stringsArray — массив строк JS.
func stringsArray(items []string) *jscompat.Array {
	values := make([]any, len(items))
	for index, item := range items {
		values[index] = item
	}
	return &jscompat.Array{Items: values}
}
