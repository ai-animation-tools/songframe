// Package shotworkflow ведёт workflow.json рабочего пакета одного плана (инструмент
// shot_workflow): создание, план опор, кандидаты и принятие
// опор, промпт, вопросы и ответы приложения, этапы, image-ветка платных опор, перенос в очередь
// plan/awaiting и проверка целостности.
//
// Пакет вызывает менеджер производства через tools.Run("shot_workflow", …): аргументы, тексты
// stdout/stderr, коды завершения и байты записанных файлов зафиксированы эталонами
// testdata/golden/shot-workflow. Ожидаемые отказы (ValueError, OSError, KeyError, TypeError)
// печатаются в stderr с кодом 1 — текст ValueError как есть, прочие «Ошибка файлов пакета; сырой
// вывод скрыт.»; остальные исключения toolrt (AttributeError на данных неожиданной формы) дают
// необработанную ошибку (toolrt.Unhandled). Пакет не обращается к сервисам генерации и не меняет attempt.json и оригиналы.
package shotworkflow

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"songframe/internal/shotstatus"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Этапы пакета: единый порядок подготовки видео, image-ветка и возврат на исправление.
var (
	stages      = []string{"description_review", "keyframes_review", "prompt_review", "request_choice", "ready", "submitted", "downloaded", "edit_review", "accepted"}
	imageStages = []string{"image_request_choice", "image_submitted", "image_downloaded"}
	// decisionStages — этапы, на которых приложение задаёт вопрос (ask).
	decisionStages = []string{"description_review", "keyframes_review", "prompt_review", "request_choice", "downloaded", "edit_review", "image_request_choice"}
	verdicts       = []string{"approve", "revise", "send", "park", "accept", "retry", "review"}
	modes          = []string{"shot", "frame"}
	// noteScopes — замечание только к опоре или к ней и следующим генерациям опор пакета.
	noteScopes = []string{"frame", "following"}
	// reopenStages — утверждённую опору можно вернуть, пока не началась отправка изображения.
	reopenStages  = []string{"keyframes_review", "prompt_review", "image_request_choice", revision}
	imageSuffixes = []string{".png", ".jpg", ".jpeg", ".webp"}
)

const revision = "needs_revision"

// defaultQuestion — вопрос и варианты ответа этапа по умолчанию.
var defaultQuestions = map[string]struct {
	question string
	options  []string
}{
	"description_review":   {"Сгенерировать опоры по этому плану?", []string{"approve", "revise"}},
	"keyframes_review":     {"Утвердить опоры?", []string{"approve", "revise"}},
	"prompt_review":        {"Утвердить видеопромпт?", []string{"approve", "revise"}},
	"request_choice":       {"Отправить запрос или сохранить пакет в очередь?", []string{"send", "park", "revise"}},
	"image_request_choice": {"Отправить запрос изображения или сохранить его на потом?", []string{"send", "park", "revise"}},
	"downloaded":           {"Принять результат, исправить или собрать пробу?", []string{"accept", "retry", "review", "revise"}},
	"edit_review":          {"Принять этот монтажный участок?", []string{"accept", "revise"}},
}

// Now — время отметок asked_at/at/selected_at: UTC с точностью до секунды в isoformat
// «2026-11-04T12:00:00+00:00». Эталоны записаны с фиксированным временем, тест подменяет Now.
var Now = func() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05") + "+00:00"
}

func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}

// containsValue — value входит в список строк: совпасть может только строка.
func containsValue(items []string, value any) bool {
	text, ok := value.(string)
	return ok && contains(items, text)
}

// valueError — ValueError с текстом, который CLI печатает пользователю.
func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

// Parser — аргументы инструмента (toolrt.Command): верхний парсер с обязательной подкомандой action.
func Parser() *toolrt.Command {
	dir := toolrt.Action{Name: "--dir", Required: true}
	waitChoices := append([]string(nil), shotstatus.WaitReasons...)
	sort.Strings(waitChoices)
	sub := func(name string, actions ...toolrt.Action) *toolrt.Command {
		return &toolrt.Command{Name: name, Actions: actions}
	}
	shows := []*toolrt.Command{}
	for _, name := range []string{"show", "check"} {
		shows = append(shows, sub(name, dir, toolrt.Action{Name: "--json", Kind: toolrt.StoreTrue}))
	}
	return &toolrt.Command{
		Prog:        "shot_workflow",
		Description: "Ведение workflow.json рабочего пакета плана: этапы, опоры, промпт, очередь; @link README.md",
		Dest:        "action",
		Subcommands: append([]*toolrt.Command{
			sub("init", toolrt.Action{Name: "shot"}, dir,
				toolrt.Action{Name: "--mode", Choices: modes, Default: "shot"},
				toolrt.Action{Name: "--batch", Help: "Имя партии независимых планов, готовящихся вместе"},
				toolrt.Action{Name: "--retry-of", Help: "Пакет того же плана, для которого создаётся исправленная попытка"}),
			sub("plan-keyframes", dir,
				toolrt.Action{Name: "--request-seconds", Int: true, Required: true},
				toolrt.Action{Name: "--middle", Kind: toolrt.AppendValue, Metavar: "СЕК:ЗАМЕТКА"}),
			sub("approve", dir, toolrt.Action{Name: "keyframe"}, toolrt.Action{Name: "path"}),
			sub("approve-prompt", dir, toolrt.Action{Name: "--file"}),
			sub("set-stage", dir, toolrt.Action{Name: "stage"},
				toolrt.Action{Name: "--wait-reason", Choices: waitChoices},
				toolrt.Action{Name: "--request-dir"}),
			sub("set-image-request", dir,
				toolrt.Action{Name: "--frame", Required: true},
				toolrt.Action{Name: "--request-dir", Required: true}),
			sub("select-image", dir, toolrt.Action{Name: "--file", Required: true}),
			sub("park", dir, toolrt.Action{Name: "--wait-reason", Choices: waitChoices, Default: "user_saved"}),
			sub("propose", dir, toolrt.Action{Name: "keyframe"}, toolrt.Action{Name: "path"}),
			sub("ask", dir,
				toolrt.Action{Name: "--stage", Required: true, Choices: decisionStages},
				toolrt.Action{Name: "--question"},
				toolrt.Action{Name: "--options", Help: "Через запятую: " + strings.Join(verdicts, ",")},
				toolrt.Action{Name: "--frame", Help: "Вопрос об одной опоре Kxx (только keyframes_review)"}),
			sub("decide", dir,
				toolrt.Action{Name: "--verdict", Required: true, Choices: verdicts},
				toolrt.Action{Name: "--note", Default: ""},
				toolrt.Action{Name: "--note-scope", Choices: noteScopes, Default: "following"},
				toolrt.Action{Name: "--json", Kind: toolrt.StoreTrue}),
			sub("reopen", dir, toolrt.Action{Name: "keyframe"},
				toolrt.Action{Name: "--note", Required: true},
				toolrt.Action{Name: "--note-scope", Choices: noteScopes, Default: "following"}),
			sub("set-note", dir,
				toolrt.Action{Name: "--id", Int: true, Required: true},
				toolrt.Action{Name: "--active", Choices: []string{"true", "false"}, Required: true}),
		}, shows...),
	}
}

// optional — значение необязательной строковой опции (nil — не задана).
func optional(args toolrt.Namespace, key string) *string {
	if text, ok := args[key].(string); ok {
		return &text
	}
	return nil
}

// Run — инструмент shot_workflow на корне проекта root (уже выбранном tools.Run).
func Run(root string, argv []string) toolcli.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return toolcli.Output{Code: exit.Code, Stdout: toolrt.TextMode(exit.Stdout), Stderr: toolrt.TextMode(exit.Stderr)}
	}
	out := &toolcli.Printer{}
	tool := &workflowTool{root: root}
	dir := args["dir"].(string)
	err := func() error {
		switch args["action"] {
		case "init":
			data, err := tool.init(args["shot"].(string), dir, args["mode"].(string), optional(args, "batch"), optional(args, "retry_of"))
			if err != nil {
				return err
			}
			timing, _ := data.Value("timing").(*toolrt.Dict)
			return out.Print("Пакет " + toolrt.Str(data.Value("shot")) + " создан: этап " + toolrt.Str(data.Value("stage")) + ", окно " + toolrt.Str(timing.Value("window_seconds")) + " с.")
		case "plan-keyframes":
			middles := []middle{}
			list, _ := args["middle"].([]string)
			for _, item := range list {
				seconds, note, _ := strings.Cut(item, ":")
				value, err := toolrt.FloatFromString(seconds)
				if err != nil {
					return err
				}
				if note == "" {
					note = "промежуточная опора"
				}
				middles = append(middles, middle{value, note})
			}
			if _, err := tool.planKeyframes(dir, args["request_seconds"].(toolrt.Int), middles); err != nil {
				return err
			}
			return printTable(out, tool, dir)
		case "approve":
			data, err := tool.approve(dir, args["keyframe"].(string), args["path"].(string), false)
			if err != nil {
				return err
			}
			next := "все опоры приняты, можно approve-prompt"
			if current := data.Value("current_keyframe"); toolrt.Truthy(current) {
				next = toolrt.Str(current)
			}
			return out.Print(args["keyframe"].(string) + " принята; следующая: " + next + ".")
		case "approve-prompt":
			data, warnings, err := tool.approvePrompt(dir, optional(args, "file"))
			if err != nil {
				return err
			}
			text := "Промпт принят: " + toolrt.Str(data.Value("approved_prompt_sha256"))
			if len(warnings) > 0 {
				text += "\n" + strings.Join(warnings, "\n")
			}
			return out.Print(text)
		case "set-stage":
			data, err := tool.setStage(dir, args["stage"].(string), optional(args, "wait_reason"), optional(args, "request_dir"))
			if err != nil {
				return err
			}
			return out.Print("Этап: " + toolrt.Str(data.Value("stage")) + ".")
		case "set-image-request":
			data, err := tool.setImageRequest(dir, args["frame"].(string), args["request_dir"].(string))
			if err != nil {
				return err
			}
			return out.Print("Запрос опоры " + toolrt.Str(data.Value("image_frame_id")) + " ждёт отдельного подтверждения: " + toolrt.Str(data.Value("image_request_dir")) + ".")
		case "select-image":
			data, err := tool.selectImage(dir, args["file"].(string))
			if err != nil {
				return err
			}
			return out.Print(toolrt.Str(data.Value("image_frame_id")) + ": кандидат выбран; художественное принятие отдельно.")
		case "park":
			target, err := tool.park(dir, args["wait_reason"].(string))
			if err != nil {
				return err
			}
			return out.Print("Пакет перенесён: " + target)
		case "propose":
			if _, err := tool.approve(dir, args["keyframe"].(string), args["path"].(string), true); err != nil {
				return err
			}
			return out.Print(args["keyframe"].(string) + " предложена как кандидат; ждёт решения пользователя.")
		case "ask":
			var options []string
			if text := optional(args, "options"); text != nil && *text != "" {
				options = strings.Split(*text, ",")
			}
			data, err := tool.ask(dir, args["stage"].(string), optional(args, "question"), options, optional(args, "frame"))
			if err != nil {
				return err
			}
			pending := data.Value("pending_decision").(*toolrt.Dict)
			parts := []string{}
			for _, option := range pending.Value("options").([]any) {
				parts = append(parts, option.(string))
			}
			return out.Print("Вопрос записан для приложения: " + toolrt.Str(pending.Value("question")) + " (" + strings.Join(parts, ", ") + ").")
		case "decide":
			note := args["note"].(string)
			data, err := tool.decide(dir, args["verdict"].(string), note, args["note_scope"].(string))
			if err != nil {
				return err
			}
			if args["json"] == true {
				text, err := toolrt.DumpsJSON(data.Value("decision"), toolrt.DumpOptions{})
				if err != nil {
					return err
				}
				return out.Print(text)
			}
			text := "Ответ записан: " + args["verdict"].(string)
			if note != "" {
				text += " (" + note + ")"
			}
			return out.Print(text)
		case "reopen":
			if _, err := tool.reopen(dir, args["keyframe"].(string), args["note"].(string), args["note_scope"].(string)); err != nil {
				return err
			}
			return out.Print(args["keyframe"].(string) + " возвращена на доработку; видеопромпт согласуется заново.")
		case "set-note":
			active := args["active"] == "true"
			if _, err := tool.setNote(dir, args["id"].(toolrt.Int), active); err != nil {
				return err
			}
			state := "выключено."
			if active {
				state = "включено."
			}
			return out.Print("Замечание " + args["id"].(toolrt.Int).String() + " " + state)
		default:
			info, err := tool.report(dir)
			if err != nil {
				return err
			}
			if args["json"] == true {
				text, err := toolcli.JSON(info.dict)
				if err != nil {
					return err
				}
				if err := out.Print(text); err != nil {
					return err
				}
			} else {
				text, err := table(info)
				if err != nil {
					return err
				}
				if err := out.Print(text); err != nil {
					return err
				}
			}
			if args["action"] == "check" && len(info.problems) > 0 {
				return exitCode(1)
			}
			return nil
		}
	}()
	return finish(out, err)
}

// exitCode — завершение инструмента с кодом code после вывода. Это не ошибка данных: finish
// возвращает код без текста, Error нужен только для интерфейса error.
type exitCode int

func (e exitCode) Error() string { return fmt.Sprintf("завершение с кодом %d", int(e)) }

// finish — обработка исключений Run: ожидаемые типы — текст в stderr и код 1.
func finish(out *toolcli.Printer, err error) toolcli.Output {
	if err == nil {
		return out.Exit(0)
	}
	if code, ok := err.(exitCode); ok {
		return out.Exit(int(code))
	}
	// Ошибки Go вне модели исключений возникают только в файловых операциях — это OSError.
	if _, isToolError := err.(*toolrt.Exception); !isToolError {
		return out.Fail("Ошибка файлов пакета; сырой вывод скрыт.")
	}
	if !toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, toolrt.TypeError) {
		return out.Crash(err)
	}
	if toolrt.Is(err, toolrt.ValueError) && !toolrt.Is(err, toolrt.JSONDecodeError) {
		return out.Fail(err.Error())
	}
	return out.Fail("Ошибка файлов пакета; сырой вывод скрыт.")
}

// printTable печатает таблицу сводки пакета dir.
func printTable(out *toolcli.Printer, tool *workflowTool, dir string) error {
	info, err := tool.report(dir)
	if err != nil {
		return err
	}
	text, err := table(info)
	if err != nil {
		return err
	}
	return out.Print(text)
}
