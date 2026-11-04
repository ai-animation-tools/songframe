// Package shotworkflow — перенос tools/shot_workflow/shot_workflow.py замороженного оригинала:
// ведение workflow.json рабочего пакета одного плана (создание, план опор, кандидаты и принятие
// опор, промпт, вопросы и ответы приложения, этапы, image-ветка платных опор, перенос в очередь
// plan/awaiting и проверка целостности).
//
// Пакет вызывает менеджер производства через tools.Run("shot_workflow", …): аргументы, тексты
// stdout/stderr, коды завершения и байты записанных файлов совпадают с CLI оригинала (эталоны
// testdata/golden/shot-workflow). Ожидаемые отказы (ValueError, OSError, KeyError, TypeError)
// печатаются в stderr с кодом 1 — текст ValueError как есть, прочие «Ошибка файлов пакета; сырой
// вывод скрыт.»; остальные исключения Python (AttributeError на данных неожиданной формы) дают
// трассировку. Пакет не обращается к сервисам генерации и не меняет attempt.json и оригиналы.
package shotworkflow

import (
	"sort"
	"strings"
	"time"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
	"songframe-go/internal/shotstatus"
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

// defaultQuestion — DEFAULT_QUESTIONS: вопрос и варианты ответа этапа по умолчанию.
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

// Now — время отметок asked_at/at/selected_at (now() оригинала): UTC с точностью до секунды в
// isoformat «2026-11-04T12:00:00+00:00». Эталоны сняты с замороженным временем, тест подменяет Now.
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

// containsValue — `value in (строки…)` Python: со строками совпадает только строка.
func containsValue(items []string, value any) bool {
	text, ok := value.(string)
	return ok && contains(items, text)
}

// valueError — ValueError с текстом, который CLI печатает пользователю.
func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

// Parser — argparse оригинала: верхний парсер с обязательной подкомандой action.
func Parser() *pycompat.Command {
	dir := pycompat.Action{Name: "--dir", Required: true}
	waitChoices := append([]string(nil), shotstatus.WaitReasons...)
	sort.Strings(waitChoices)
	sub := func(name string, actions ...pycompat.Action) *pycompat.Command {
		return &pycompat.Command{Name: name, Actions: actions}
	}
	shows := []*pycompat.Command{}
	for _, name := range []string{"show", "check"} {
		shows = append(shows, sub(name, dir, pycompat.Action{Name: "--json", Kind: pycompat.StoreTrue}))
	}
	return &pycompat.Command{
		Prog:        "shot_workflow.py",
		Description: "Ведение workflow.json рабочего пакета плана: этапы, опоры, промпт, очередь; @link README.md",
		Dest:        "action",
		Subcommands: append([]*pycompat.Command{
			sub("init", pycompat.Action{Name: "shot"}, dir,
				pycompat.Action{Name: "--mode", Choices: modes, Default: "shot"},
				pycompat.Action{Name: "--batch", Help: "Имя партии независимых планов, готовящихся вместе"},
				pycompat.Action{Name: "--retry-of", Help: "Пакет того же плана, для которого создаётся исправленная попытка"}),
			sub("plan-keyframes", dir,
				pycompat.Action{Name: "--request-seconds", Int: true, Required: true},
				pycompat.Action{Name: "--middle", Kind: pycompat.AppendValue, Metavar: "СЕК:ЗАМЕТКА"}),
			sub("approve", dir, pycompat.Action{Name: "keyframe"}, pycompat.Action{Name: "path"}),
			sub("approve-prompt", dir, pycompat.Action{Name: "--file"}),
			sub("set-stage", dir, pycompat.Action{Name: "stage"},
				pycompat.Action{Name: "--wait-reason", Choices: waitChoices},
				pycompat.Action{Name: "--request-dir"}),
			sub("set-image-request", dir,
				pycompat.Action{Name: "--frame", Required: true},
				pycompat.Action{Name: "--request-dir", Required: true}),
			sub("select-image", dir, pycompat.Action{Name: "--file", Required: true}),
			sub("park", dir, pycompat.Action{Name: "--wait-reason", Choices: waitChoices, Default: "user_saved"}),
			sub("propose", dir, pycompat.Action{Name: "keyframe"}, pycompat.Action{Name: "path"}),
			sub("ask", dir,
				pycompat.Action{Name: "--stage", Required: true, Choices: decisionStages},
				pycompat.Action{Name: "--question"},
				pycompat.Action{Name: "--options", Help: "Через запятую: " + strings.Join(verdicts, ",")},
				pycompat.Action{Name: "--frame", Help: "Вопрос об одной опоре Kxx (только keyframes_review)"}),
			sub("decide", dir,
				pycompat.Action{Name: "--verdict", Required: true, Choices: verdicts},
				pycompat.Action{Name: "--note", Default: ""},
				pycompat.Action{Name: "--note-scope", Choices: noteScopes, Default: "following"},
				pycompat.Action{Name: "--json", Kind: pycompat.StoreTrue}),
			sub("reopen", dir, pycompat.Action{Name: "keyframe"},
				pycompat.Action{Name: "--note", Required: true},
				pycompat.Action{Name: "--note-scope", Choices: noteScopes, Default: "following"}),
			sub("set-note", dir,
				pycompat.Action{Name: "--id", Int: true, Required: true},
				pycompat.Action{Name: "--active", Choices: []string{"true", "false"}, Required: true}),
		}, shows...),
	}
}

// optional — значение необязательной строковой опции (nil — не задана).
func optional(args pycompat.Namespace, key string) *string {
	if text, ok := args[key].(string); ok {
		return &text
	}
	return nil
}

// Run — main() оригинала на корне проекта root (уже выбранном tools.Run).
func Run(root string, argv []string) pytool.Output {
	args, exit := Parser().ParseArgs(argv)
	if exit != nil {
		return pytool.Output{Code: exit.Code, Stdout: pycompat.TextMode(exit.Stdout), Stderr: pycompat.TextMode(exit.Stderr)}
	}
	out := &pytool.Printer{}
	tool := &workflowTool{root: root}
	dir := args["dir"].(string)
	err := func() error {
		switch args["action"] {
		case "init":
			data, err := tool.init(args["shot"].(string), dir, args["mode"].(string), optional(args, "batch"), optional(args, "retry_of"))
			if err != nil {
				return err
			}
			timing, _ := data.Value("timing").(*pycompat.Dict)
			return out.Print("Пакет " + pycompat.Str(data.Value("shot")) + " создан: этап " + pycompat.Str(data.Value("stage")) + ", окно " + pycompat.Str(timing.Value("window_seconds")) + " с.")
		case "plan-keyframes":
			middles := []middle{}
			list, _ := args["middle"].([]string)
			for _, item := range list {
				seconds, note, _ := strings.Cut(item, ":")
				value, err := pycompat.FloatFromString(seconds)
				if err != nil {
					return err
				}
				if note == "" {
					note = "промежуточная опора"
				}
				middles = append(middles, middle{value, note})
			}
			if _, err := tool.planKeyframes(dir, args["request_seconds"].(pycompat.Int), middles); err != nil {
				return err
			}
			return printTable(out, tool, dir)
		case "approve":
			data, err := tool.approve(dir, args["keyframe"].(string), args["path"].(string), false)
			if err != nil {
				return err
			}
			next := "все опоры приняты, можно approve-prompt"
			if current := data.Value("current_keyframe"); pycompat.Truthy(current) {
				next = pycompat.Str(current)
			}
			return out.Print(args["keyframe"].(string) + " принята; следующая: " + next + ".")
		case "approve-prompt":
			data, warnings, err := tool.approvePrompt(dir, optional(args, "file"))
			if err != nil {
				return err
			}
			text := "Промпт принят: " + pycompat.Str(data.Value("approved_prompt_sha256"))
			if len(warnings) > 0 {
				text += "\n" + strings.Join(warnings, "\n")
			}
			return out.Print(text)
		case "set-stage":
			data, err := tool.setStage(dir, args["stage"].(string), optional(args, "wait_reason"), optional(args, "request_dir"))
			if err != nil {
				return err
			}
			return out.Print("Этап: " + pycompat.Str(data.Value("stage")) + ".")
		case "set-image-request":
			data, err := tool.setImageRequest(dir, args["frame"].(string), args["request_dir"].(string))
			if err != nil {
				return err
			}
			return out.Print("Запрос опоры " + pycompat.Str(data.Value("image_frame_id")) + " ждёт отдельного подтверждения: " + pycompat.Str(data.Value("image_request_dir")) + ".")
		case "select-image":
			data, err := tool.selectImage(dir, args["file"].(string))
			if err != nil {
				return err
			}
			return out.Print(pycompat.Str(data.Value("image_frame_id")) + ": кандидат выбран; художественное принятие отдельно.")
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
			pending := data.Value("pending_decision").(*pycompat.Dict)
			parts := []string{}
			for _, option := range pending.Value("options").([]any) {
				parts = append(parts, option.(string))
			}
			return out.Print("Вопрос записан для приложения: " + pycompat.Str(pending.Value("question")) + " (" + strings.Join(parts, ", ") + ").")
		case "decide":
			note := args["note"].(string)
			data, err := tool.decide(dir, args["verdict"].(string), note, args["note_scope"].(string))
			if err != nil {
				return err
			}
			if args["json"] == true {
				text, err := pycompat.DumpsJSON(data.Value("decision"), pycompat.DumpOptions{})
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
			if _, err := tool.setNote(dir, args["id"].(pycompat.Int), active); err != nil {
				return err
			}
			state := "выключено."
			if active {
				state = "включено."
			}
			return out.Print("Замечание " + args["id"].(pycompat.Int).String() + " " + state)
		default:
			info, err := tool.report(dir)
			if err != nil {
				return err
			}
			if args["json"] == true {
				text, err := pytool.JSON(info.dict)
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

// exitCode — raise SystemExit(code) после вывода.
type exitCode int

func (e exitCode) Error() string { return "SystemExit" }

// finish — обработка исключений main(): ожидаемые типы — текст в stderr и код 1.
func finish(out *pytool.Printer, err error) pytool.Output {
	if err == nil {
		return out.Exit(0)
	}
	if code, ok := err.(exitCode); ok {
		return out.Exit(int(code))
	}
	// Ошибки Go вне модели исключений возникают только в файловых операциях — это OSError.
	if _, isPython := err.(*pycompat.Exception); !isPython {
		return out.Fail("Ошибка файлов пакета; сырой вывод скрыт.")
	}
	if !pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError, pycompat.TypeError) {
		return out.Crash(err)
	}
	if pycompat.Is(err, pycompat.ValueError) && !pycompat.Is(err, pycompat.JSONDecodeError) {
		return out.Fail(err.Error())
	}
	return out.Fail("Ошибка файлов пакета; сырой вывод скрыт.")
}

// printTable — print(table(report(dir))).
func printTable(out *pytool.Printer, tool *workflowTool, dir string) error {
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
