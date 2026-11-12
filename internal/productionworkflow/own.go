package productionworkflow

import (
	"context"
	"errors"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaproviders"
	"songframe/internal/toolrt"
)

// Свой текст пользователя вместо прохода агента (D-043, D-045): описание с планом опор или
// видеопромпт, написанные или исправленные вручную. Текст становится предложением без задания
// агента и применяется тем же Apply: те же проверки ответа, снимок входов, журнал замены пакета и
// запись файлов попытки. Принятие (ответ approve на вопрос этапа) делает интерфейс сразу после
// применения, как и для принятого предложения агента: автор своего текста — сам пользователь.

// OwnKeyframe — опора своего плана опор (строка keyframe-prompts.json).
type OwnKeyframe struct {
	ID             string   `json:"id"`
	Role           string   `json:"role"`
	TimeSeconds    float64  `json:"timeSeconds"`
	Prompt         string   `json:"prompt"`
	ReferencePaths []string `json:"referencePaths"`
}

// OwnInput — свой текст этапа: Stage description (Description, RequestSeconds, Keyframes) или
// prompt (Prompt). PackageDir — выбранная попытка; пусто — новая попытка с описанием.
type OwnInput struct {
	Project        string        `json:"project"`
	Shot           string        `json:"shot"`
	PackageDir     string        `json:"packageDir,omitempty"`
	Stage          string        `json:"stage"`
	Description    string        `json:"description,omitempty"`
	RequestSeconds float64       `json:"requestSeconds,omitempty"`
	Keyframes      []OwnKeyframe `json:"keyframes,omitempty"`
	Prompt         string        `json:"prompt,omitempty"`
}

// ownDocument — свой текст в форме ответа агента этапа: его разбирает и проверяет ParseProposal.
func ownDocument(input OwnInput) string {
	document := dynvalue.NewObject()
	document.Set("schemaVersion", float64(1))
	document.Set("stage", input.Stage)
	if input.Stage == "prompt" {
		document.Set("prompt", input.Prompt)
		return dynvalue.Stringify(document)
	}
	document.Set("description", input.Description)
	document.Set("requestSeconds", input.RequestSeconds)
	frames := make([]any, 0, len(input.Keyframes))
	for _, frame := range input.Keyframes {
		item := dynvalue.NewObject()
		item.Set("id", frame.ID)
		item.Set("role", frame.Role)
		item.Set("timeSeconds", frame.TimeSeconds)
		item.Set("prompt", frame.Prompt)
		paths := make([]any, len(frame.ReferencePaths))
		for index, path := range frame.ReferencePaths {
			paths[index] = path
		}
		item.Set("referencePaths", &dynvalue.Array{Items: paths})
		frames = append(frames, item)
	}
	document.Set("keyframes", &dynvalue.Array{Items: frames})
	return dynvalue.Stringify(document)
}

// SaveOwn записывает свой текст этапа description или prompt и применяет его к попытке. Этап
// должен быть доступен так же, как запуск агента: описание — для плана без попытки (новая
// попытка), для неоплаченной попытки (та же) или оплаченной (новая с retry_of); промпт — после
// утверждения всех опор, пока запрос не отправлен. Открытый вопрос о тексте того же этапа (например,
// промпт агента сверх предела) не мешает: свой текст заменяет его и спрашивается заново. Ошибка проверки текста возвращается до записи;
// число опор — от 1 до предела провайдера видео, у речевого плана ручной генерации — ровно одна;
// промпт — не длиннее предела провайдера.
func (w *Workflow) SaveOwn(ctx context.Context, input OwnInput) (View, error) {
	if input.Stage != "description" && input.Stage != "prompt" {
		return View{}, errors.New(textStartParametersInvalid)
	}
	w.mu.Lock()
	id, packageDir, err := w.prepareOwn(input)
	w.mu.Unlock()
	if err != nil {
		return View{}, err
	}
	return w.Apply(ctx, input.Project, input.Shot, packageDir, id)
}

// prepareOwn — под мьютексом: проверка доступности этапа, разбор своего текста по правилам этапа
// и запись готового предложения без задания агента. Возвращает номер предложения и пакет, к
// которому его применит Apply.
func (w *Workflow) prepareOwn(input OwnInput) (string, string, error) {
	start := StartInput{Project: input.Project, Shot: input.Shot, PackageDir: input.PackageDir, Action: "revise", Stage: &input.Stage, own: true}
	if input.PackageDir == "" {
		start.Action, start.Stage = "prepare", nil
	}
	prepared, err := w.prepare(start)
	if err != nil {
		return "", "", err
	}
	c := prepared.context
	if prepared.stage != input.Stage {
		return "", "", errors.New(textStageUnavailable)
	}
	rules := c.RulesFor(input.Stage)
	rules.Own = true
	if input.Stage == "description" {
		// Число опор своего плана выбрал сам пользователь: применение соблюдает его точно, а одна
		// опора допустима и вне ручного режима.
		count := len(input.Keyframes)
		if c.SingleFrame && count != 1 {
			return "", "", errors.New(textManualSingleFrame)
		}
		if limit := mediaproviders.KeyframeLimit(c.Settings.Value("provider")); count < 1 || count > limit {
			return "", "", errors.New(textKeyframeCountRange(limit))
		}
		if !c.SingleFrame {
			rules.Keyframes = count
		}
	}
	// Свой промпт сразу утверждается: длиннее предела провайдера его нельзя ни утвердить, ни
	// записать, иначе попытка осталась бы с неутверждаемым промптом без агента.
	if limit := c.PromptLimit(); input.Stage == "prompt" && limit > 0 {
		if chars := toolrt.Len(input.Prompt); chars > limit {
			return "", "", errors.New(textOwnPromptOverLimit(chars, limit))
		}
	}
	after, err := ParseProposal(ownDocument(input), rules)
	if err != nil {
		return "", "", err
	}
	before := ""
	if c.PackageDir != "" {
		file := "description.md"
		if input.Stage == "prompt" {
			file = "video-prompt.txt"
		}
		if before, err = readText(filepath.Join(c.PackageDir, file)); err != nil {
			return "", "", err
		}
	}
	id := randomUUID()
	proposal := proposalTree(id, "", input.Stage, before)
	proposal.Set("status", "ready")
	proposal.Set("after", after)
	// Отметка своего текста: интерфейс и журнал отличают его от ответа агента.
	proposal.Set("own", true)
	stored := &Stored{Tree: dynvalue.NewObject()}
	stored.Tree.Set("proposal", proposal)
	if c.PackageDir == "" {
		stored.Tree.Set("packageDir", nil)
	} else {
		stored.Tree.Set("packageDir", c.PackageDir)
	}
	stored.Tree.Set("target", prepared.target)
	stored.Tree.Set("hashes", prepared.hashes)
	stored.Tree.Set("rules", rules.Tree())
	stored.Tree.Set("capabilities", &dynvalue.Array{Items: []any{}})
	if err := w.store.Write(c.Project, input.Shot, stored); err != nil {
		return "", "", err
	}
	return id, c.PackageDir, nil
}

// ReferenceImages — изображения проекта, которые может назвать опора своего плана: те же
// разрешённые входы плана shot (allowedPaths задания агента), только изображения, по порядку.
func (w *Workflow) ReferenceImages(project, shot string) ([]string, error) {
	c, err := ReadContext(project, shot, "")
	if err != nil {
		return nil, err
	}
	images := []string{}
	for _, path := range c.AllowedPaths {
		if imagePath.MatchString(path) {
			images = append(images, path)
		}
	}
	return images, nil
}
