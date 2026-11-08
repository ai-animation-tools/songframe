// Package regenerateshot повторяет генерацию плана по сохранённому запросу без нового
// согласования (инструмент regenerate_shot). Берёт зафиксированный запрос плана (последний
// пакет в plan/batches или plan/awaiting с подготовленной попыткой, иначе снимок принятого
// комплекта assets/shots/Mxx/generation-request.json), создаёт новый пакет с попыткой retry_of и
// вопросом отправки для приложения, печатает request_sha256 и оценку стоимости. Отправку выполняет
// приложение после ответа send. Данных запроса нет или они в чужом формате — код 3.
//
// Инструмент работает в процессе приложения: шаги shot_workflow выполняет shotworkflow.Run,
// подготовку попытки — mediarequest.Prepare (подключённый адаптер) или requestsnapshot.Prepare,
// оценку — costcheck. Коды, stdout и тексты ошибок зафиксированы эталоном
// testdata/golden/production-tools.
package regenerateshot

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"songframe/internal/assetpackage"
	"songframe/internal/costcheck"
	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/mediarequest"
	"songframe/internal/requestsnapshot"
	"songframe/internal/sceneregistry"
	"songframe/internal/shotworkflow"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// noData — код завершения «нет данных запроса».
const noData = 3

// lookupError — класс исключения «нет данных или они в чужом формате»; Run завершает его кодом noData.
const lookupError = "LookupError"

// packageRoots — папки рабочих пакетов и очереди.
var packageRoots = []string{"plan/batches", "plan/awaiting"}

// Parser — аргументы инструмента regenerate_shot (toolrt.ArgParser).
var Parser = toolrt.ArgParser{
	Prog:        "regenerate_shot",
	Description: "Повтор генерации плана по сохранённому запросу.",
	Flags: []toolrt.Flag{
		{Name: "--source", Value: true, Choices: []string{"auto", "package", "asset"}},
		{Name: "--work-dir", Value: true, Help: "Папка нового пакета; по умолчанию plan/batches/Mxx-attempt-NN"},
		{Name: "--no-account", Help: "Не запрашивать остаток у аккаунта"},
		{Name: "--pricing", Value: true, Help: "Файл тарифов вместо таблицы адаптера провайдера (прогоны без расхода)"},
		{Name: "--json"},
	},
	Positionals: []toolrt.Positional{{Name: "shot"}},
}

// lookup — LookupError с текстом.
func lookup(message string) error { return toolrt.New(lookupError, message) }

// inputNormalizer — необязательная возможность адаптера: снимок с короткими флагами входов
// приводится к объявленным слотам до проверки. Адаптер без неё получает спецификацию как есть.
type inputNormalizer interface {
	NormalizeInputs(ctx context.Context, spec *toolrt.Dict, timeout time.Duration) error
}

// dict — значение как словарь либо nil.
func dict(value any) *toolrt.Dict {
	result, _ := value.(*toolrt.Dict)
	return result
}

// nonEmpty — непустая после strip строка.
func nonEmpty(value any) bool {
	text, ok := value.(string)
	return ok && toolrt.Strip(text) != ""
}

// findPackageRequest — последняя по времени подготовленная попытка плана среди рабочих пакетов
// и очереди: папка пакета и путь request.json.
func findPackageRequest(root, shot string) (string, string) {
	type candidate struct {
		mtime               float64
		packageDir, request string
	}
	var candidates []candidate
	for _, base := range packageRoots {
		folder := toolrt.JoinPath(root, base)
		if !toolrt.IsDir(folder) {
			continue
		}
		for _, path := range toolrt.Glob(folder, "*/workflow.json") {
			data, _ := toolrt.ReadJSON(path)
			workflow := dict(data)
			if workflow == nil || !toolrt.Equal(workflow.Value("shot"), shot) || !toolrt.Truthy(workflow.Value("request_dir")) {
				continue
			}
			directory, ok := workflow.Value("request_dir").(string)
			if !ok {
				continue
			}
			request := toolrt.JoinPath(filepath.Dir(path), directory, "request.json")
			if info, err := os.Stat(request); err == nil && info.Mode().IsRegular() {
				candidates = append(candidates, candidate{float64(info.ModTime().UnixNano()) / 1e9, filepath.Dir(path), request})
			}
		}
	}
	if len(candidates) == 0 {
		return "", ""
	}
	// Порядок по (mtime, пакет, запрос): при равном времени решает путь.
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].mtime != candidates[j].mtime {
			return candidates[i].mtime < candidates[j].mtime
		}
		if candidates[i].packageDir != candidates[j].packageDir {
			return candidates[i].packageDir < candidates[j].packageDir
		}
		return candidates[i].request < candidates[j].request
	})
	last := candidates[len(candidates)-1]
	return last.packageDir, last.request
}

var sha256Text = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

// checkedPrompt — сверяет обязательный SHA-256 с точными байтами сохранённого промпта.
func checkedPrompt(path string, expected any, label string) (string, error) {
	text, ok := expected.(string)
	if !ok || !sha256Text.MatchString(text) {
		return "", lookup(label + ": у промпта нет корректного SHA-256.")
	}
	if !toolrt.IsFile(path) {
		return "", lookup(label + ": нет файла промпта " + toolrt.PathName(path) + ".")
	}
	digest, err := requestsnapshot.FileSHA(path)
	if err != nil {
		return "", err
	}
	if digest != strings.ToLower(text) {
		return "", lookup(label + ": хеш промпта отличается от сохранённого.")
	}
	return toolrt.ResolvePath(path), nil
}

// savedSpec — переносит в спецификацию prepare только явно перечисленные поля.
func savedSpec(data *toolrt.Dict, shot string, kind any, inputs []any, promptFile string) (*toolrt.Dict, error) {
	spec := toolrt.NewDict()
	for _, key := range []string{"provider", "command", "model", "parameters", "outputs"} {
		value, err := toolrt.Item(data, key)
		if err != nil {
			return nil, err
		}
		spec.Set(key, value)
	}
	spec.Set("schema_version", toolrt.NewInt(1))
	spec.Set("shot", shot)
	spec.Set("kind", kind)
	spec.Set("inputs", inputs)
	spec.Set("prompt_file", promptFile)
	if value, ok := data.Get("model_selection"); ok {
		spec.Set("model_selection", value)
	}
	return spec, nil
}

// entryFields — {key: item[key] for key in ("slot", "role", "sha256") if key in item}.
func entryFields(item *toolrt.Dict) *toolrt.Dict {
	entry := toolrt.NewDict()
	for _, key := range []string{"slot", "role", "sha256"} {
		if value, ok := item.Get(key); ok {
			entry.Set(key, value)
		}
	}
	return entry
}

// damaged — повреждение данных (KeyError, OSError, ValueError, TypeError) как LookupError с
// префиксом; прочие ошибки проходят как есть.
func damaged(prefix string, err error) error {
	if toolrt.IsAny(err, toolrt.KeyError, toolrt.OSError, toolrt.ValueError, toolrt.TypeError) {
		return lookup(prefix + err.Error())
	}
	return err
}

// specFromFrozen — спецификация из request.json попытки в общем зафиксированном формате.
func specFromFrozen(requestPath, shot string) (*toolrt.Dict, error) {
	value, _ := toolrt.ReadJSON(requestPath)
	data := dict(value)
	if data == nil || !toolrt.Equal(data.Value("schema_version"), toolrt.NewInt(1)) {
		return nil, lookup(requestPath + ": это не замороженный запрос попытки.")
	}
	spec, err := func() (*toolrt.Dict, error) {
		prompt, err := toolrt.Item(data, "prompt")
		if err != nil {
			return nil, err
		}
		promptDict := dict(prompt)
		if promptDict == nil || !nonEmpty(promptDict.Value("path")) {
			return nil, toolrt.New(toolrt.ValueError, "Промпт должен содержать path и sha256.")
		}
		rawInputs, err := toolrt.Item(data, "inputs")
		if err != nil {
			return nil, err
		}
		list, ok := rawInputs.([]any)
		if !ok {
			return nil, toolrt.New(toolrt.ValueError, "inputs должен быть списком.")
		}
		inputs := []any{}
		for _, raw := range list {
			item := dict(raw)
			if item == nil || !nonEmpty(item.Value("path")) {
				return nil, toolrt.New(toolrt.ValueError, "У входа нет непустого path.")
			}
			entry := entryFields(item)
			flag, err := toolrt.Item(item, "flag")
			if err != nil {
				return nil, err
			}
			entry.Set("flag", flag)
			entry.Set("path", toolrt.ResolvePath(toolrt.JoinPath(filepath.Dir(requestPath), item.Value("path").(string))))
			inputs = append(inputs, entry)
		}
		sha, err := toolrt.Item(promptDict, "sha256")
		if err != nil {
			return nil, err
		}
		promptFile, err := checkedPrompt(toolrt.JoinPath(filepath.Dir(requestPath), promptDict.Value("path").(string)), sha, requestPath)
		if err != nil {
			return nil, err
		}
		kind, err := toolrt.Item(data, "kind")
		if err != nil {
			return nil, err
		}
		return savedSpec(data, shot, kind, inputs, promptFile)
	}()
	if err != nil {
		return nil, damaged(requestPath+": повреждён замороженный запрос: ", err)
	}
	return spec, nil
}

// specFromAsset — снимок принятого комплекта по контракту accept_shot.
func specFromAsset(root, shot string) (*toolrt.Dict, error) {
	asset := toolrt.JoinPath(root, "assets", "shots", shot)
	value, _ := toolrt.ReadJSON(toolrt.JoinPath(asset, "generation-request.json"))
	data := dict(value)
	if data == nil {
		return nil, lookup("У плана " + shot + " нет снимка запроса в принятом комплекте.")
	}
	if provider := data.Value("provider"); !nonEmpty(provider) {
		return nil, lookup(shot + ": провайдер снимка " + toolrt.Repr(provider) + "; нужна непустая строка provider.")
	}
	if !toolrt.Equal(data.Value("schema_version"), toolrt.NewInt(1)) || !toolrt.Equal(data.Value("path_base"), "asset_directory") {
		return nil, lookup(shot + ": нужны schema_version=1 и path_base=asset_directory.")
	}
	if toolrt.Truthy(data.Value("elements")) || toolrt.Truthy(data.Value("audio_inputs")) {
		return nil, lookup(shot + ": дополнительные elements/audio_inputs не описаны в inputs; повтор невозможен.")
	}
	spec, err := func() (*toolrt.Dict, error) {
		prompt, err := toolrt.Item(data, "prompt")
		if err != nil {
			return nil, err
		}
		if !nonEmpty(prompt) {
			return nil, toolrt.New(toolrt.ValueError, "Промпт должен быть непустым именем файла.")
		}
		rawInputs, err := toolrt.Item(data, "inputs")
		if err != nil {
			return nil, err
		}
		list, ok := rawInputs.([]any)
		if !ok {
			return nil, toolrt.New(toolrt.ValueError, "inputs должен быть списком.")
		}
		inputs := []any{}
		for _, raw := range list {
			item := dict(raw)
			if item == nil || !nonEmpty(item.Value("path")) {
				return nil, toolrt.New(toolrt.ValueError, "У входа нет непустого path.")
			}
			// Именованный слот комплекта — вход input. Другие флаги должны быть сохранены явно.
			entry := entryFields(item)
			flag, _ := toolrt.DictGet(item, "flag", "input")
			entry.Set("flag", flag)
			path, err := assetpackage.DescriptorFile(asset, item, root)
			if err != nil {
				return nil, err
			}
			entry.Set("path", path)
			inputs = append(inputs, entry)
		}
		promptPath, err := assetpackage.DescriptorFile(asset, toolcli.Record("path", prompt), root)
		if err != nil {
			return nil, err
		}
		sha, err := toolrt.Item(data, "prompt_sha256")
		if err != nil {
			return nil, err
		}
		promptFile, err := checkedPrompt(promptPath, sha, shot)
		if err != nil {
			return nil, err
		}
		kind, _ := toolrt.DictGet(data, "kind", "video")
		return savedSpec(data, shot, kind, inputs, promptFile)
	}()
	if err != nil {
		return nil, damaged(shot+": повреждён снимок запроса: ", err)
	}
	return spec, nil
}

// validateSavedSpec — совместимость и сохранённые байты до создания нового пакета.
func validateSavedSpec(ctx context.Context, spec *toolrt.Dict, shot string) error {
	err := func() error {
		if err := requestsnapshot.ValidateSpec(spec); err != nil {
			return err
		}
		data, err := os.ReadFile(spec.Value("prompt_file").(string))
		if err != nil {
			return toolrt.OSErrorFrom(err, spec.Value("prompt_file").(string))
		}
		prompt, err := toolrt.DecodeUTF8(data)
		if err != nil {
			return err
		}
		if toolrt.Strip(prompt) == "" {
			return toolrt.New(toolrt.ValueError, "Промпт пуст.")
		}
		// Подготовка общая; ограничения сервиса проверяет только подключённый адаптер провайдера.
		if mediaadapters.Known(spec.Value("provider")) {
			service, err := mediaadapters.Lookup(spec.Value("provider"))
			if err != nil {
				return err
			}
			if normalizer, ok := service.(inputNormalizer); ok {
				if err := normalizer.NormalizeInputs(ctx, spec, 60*time.Second); err != nil {
					return err
				}
			}
			if validator, ok := service.(mediaapi.SpecValidator); ok {
				if err := validator.ValidateSpec(spec); err != nil {
					return err
				}
			}
			if validator, ok := service.(mediaapi.PromptValidator); ok {
				if _, err := validator.ValidatePrompt(prompt); err != nil {
					return err
				}
			}
		}
		for _, raw := range spec.Value("inputs").([]any) {
			item := dict(raw)
			path := toolrt.Str(item.Value("path"))
			if !toolrt.IsFile(path) {
				return toolrt.New(toolrt.ValueError, "Вход запроса отсутствует: "+path+".")
			}
			if expected, ok := item.Get("sha256"); ok {
				digest, err := requestsnapshot.FileSHA(path)
				if err != nil {
					return err
				}
				if !toolrt.Equal(digest, expected) {
					return toolrt.New(toolrt.ValueError, "Хеш входа "+toolrt.PathName(path)+" отличается от сохранённого.")
				}
			}
		}
		return nil
	}()
	if err != nil && toolrt.IsAny(err, toolrt.OSError, toolrt.ValueError, toolrt.TypeError) {
		return lookup(shot + ": сохранённый запрос нельзя повторить: " + err.Error())
	}
	return err
}

// nextAttemptDir — plan/batches/Mxx-attempt-NN со следующим свободным номером.
func nextAttemptDir(root, shot string) string {
	batches := toolrt.JoinPath(root, "plan", "batches")
	pattern := regexp.MustCompile(`^` + regexp.QuoteMeta(shot) + `-attempt-(\d+)$`)
	next := int64(1)
	found := false
	for _, path := range toolrt.Glob(batches, shot+"-attempt-*") {
		if match := pattern.FindStringSubmatch(toolrt.PathName(path)); match != nil {
			number, _ := strconv.ParseInt(match[1], 10, 64)
			if !found || number+1 > next {
				next, found = number+1, true
			}
		}
	}
	return toolrt.JoinPath(batches, shot+"-attempt-"+leftPad(next))
}

// leftPad — число не короче двух цифр (с ведущим нулём).
func leftPad(number int64) string {
	text := strconv.FormatInt(number, 10)
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// casefold — латинский id без крайних пробелов в нижнем регистре.
func casefold(text string) string { return strings.ToLower(toolrt.Strip(text)) }

// checkSettings — снимок должен соответствовать настройкам генерации проекта: иначе повтор
// молча сменит формат.
func checkSettings(spec, settings *toolrt.Dict) ([]string, error) {
	parameters := dict(spec.Value("parameters"))
	if parameters == nil {
		parameters = toolrt.NewDict()
	}
	provider, err := toolrt.Item(settings, "provider")
	if err != nil {
		return nil, err
	}
	problems := []string{}
	if casefold(toolrt.Str(spec.Value("provider"))) != casefold(toolrt.Str(provider)) {
		problems = append(problems, "провайдер запроса "+toolrt.Str(spec.Value("provider"))+" отличается от провайдера проекта "+toolrt.Str(provider))
	}
	if value, ok := parameters.Get("resolution"); ok && settings.Has("resolution") && !toolrt.Equal(toolrt.Str(value), settings.Value("resolution")) {
		problems = append(problems, "разрешение запроса "+toolrt.Str(value)+" отличается от настроек проекта "+toolrt.Str(settings.Value("resolution")))
	}
	if value, ok := parameters.Get("aspect_ratio"); ok && settings.Has("aspect_ratio") && !toolrt.Equal(toolrt.Str(value), settings.Value("aspect_ratio")) {
		problems = append(problems, "пропорции запроса "+toolrt.Str(value)+" отличаются от "+toolrt.Str(settings.Value("aspect_ratio")))
	}
	return problems, nil
}

// carrySpeech — речевой план: WAV липсинка и его рецепт переходят в новый пакет, если этот WAV уже
// входит в сохранённый запрос. Без них новую попытку нельзя принять, а после отправки WAV уже не
// подготовить заново. Источник — папка audio прежнего пакета или принятый комплект.
func carrySpeech(source, directory string, spec *toolrt.Dict) error {
	value, _ := toolrt.ReadJSON(toolrt.JoinPath(source, "audio-recipe.json"))
	recipe := dict(value)
	var output *toolrt.Dict
	if recipe != nil {
		output = dict(recipe.Value("output"))
	}
	if output == nil {
		return nil
	}
	name, ok := output.Value("path").(string)
	if !ok || toolrt.PathName(name) != name || !toolrt.IsFile(toolrt.JoinPath(source, name)) {
		return nil
	}
	digest, err := requestsnapshot.FileSHA(toolrt.JoinPath(source, name))
	if err != nil {
		return err
	}
	inside := false
	for _, raw := range spec.Value("inputs").([]any) {
		if item := dict(raw); item != nil && toolrt.Equal(item.Value("sha256"), digest) {
			inside = true
		}
	}
	if !toolrt.Equal(output.Value("sha256"), digest) || !inside {
		return nil
	}
	target := toolrt.JoinPath(directory, "audio")
	if err := os.MkdirAll(target, 0o755); err != nil {
		return toolrt.OSErrorFrom(err, target)
	}
	if err := requestsnapshot.CopyFile(toolrt.JoinPath(source, name), toolrt.JoinPath(target, name)); err != nil {
		return err
	}
	return requestsnapshot.CopyFile(toolrt.JoinPath(source, "audio-recipe.json"), toolrt.JoinPath(target, "audio-recipe.json"))
}

// workflow выполняет шаг shot_workflow в процессе; отказ — ValueError с текстом stderr (иначе
// stdout) инструмента.
func workflow(root string, args ...string) error {
	output := shotworkflow.Run(root, args)
	if output.Code == 0 {
		return nil
	}
	message := toolrt.Strip(output.Stderr)
	if message == "" {
		message = toolrt.Strip(output.Stdout)
	}
	return toolrt.New(toolrt.ValueError, message)
}

// Options — параметры Regenerate.
type Options struct {
	Source      string
	WorkDir     string
	UseAccount  bool
	PricingPath string
	// LocalDir — каталог состояния для наблюдений цен.
	LocalDir string
}

// Regenerate создаёт новый пакет и подготовленную попытку по сохранённому
// запросу; результат — сведения для таблицы и JSON.
func Regenerate(ctx context.Context, root, shot string, options Options) (*toolrt.Dict, error) {
	source := options.Source
	if source == "" {
		source = "auto"
	}
	var spec *toolrt.Dict
	packageDir := ""
	errorsList := []string{}
	if source == "auto" || source == "package" {
		found, request := findPackageRequest(root, shot)
		if request != "" {
			packageDir = found
			// Последний запрос задаёт источник повтора: его повреждение нельзя скрывать снимком assets.
			var err error
			if spec, err = specFromFrozen(request, shot); err != nil {
				return nil, err
			}
		} else if source == "package" {
			return nil, lookup("У плана " + shot + " нет пакета с подготовленной попыткой.")
		}
	}
	if spec == nil && (source == "auto" || source == "asset") {
		value, err := specFromAsset(root, shot)
		switch {
		case err == nil:
			spec, packageDir = value, ""
		case toolrt.Is(err, lookupError):
			errorsList = append(errorsList, err.Error())
		default:
			return nil, err
		}
	}
	if spec == nil {
		message := strings.Join(errorsList, " ")
		if message == "" {
			message = "У плана " + shot + " нет сохранённого запроса."
		}
		return nil, lookup(message)
	}
	if err := validateSavedSpec(ctx, spec, shot); err != nil {
		return nil, err
	}
	project, err := sceneregistry.LoadProject(root, true)
	if err != nil {
		return nil, err
	}
	settings, err := sceneregistry.GenerationSettings(project, toolrt.Str(spec.Value("kind")))
	if err != nil {
		return nil, err
	}
	mismatches, err := checkSettings(spec, settings)
	if err != nil {
		return nil, err
	}
	if len(mismatches) > 0 {
		return nil, lookup(shot + ": " + strings.Join(mismatches, "; ") + ". Повтор остановлен.")
	}
	directory := options.WorkDir
	if directory == "" {
		directory = nextAttemptDir(root, shot)
	} else if !filepath.IsAbs(directory) {
		directory = toolrt.JoinPath(root, directory)
	}
	init := []string{"init", shot, "--dir", directory}
	if packageDir != "" {
		init = append(init, "--retry-of", packageDir)
	}
	if err := workflow(root, init...); err != nil {
		return nil, err
	}
	speechSource := toolrt.JoinPath(root, "assets", "shots", shot)
	if packageDir != "" {
		speechSource = toolrt.JoinPath(packageDir, "audio")
	}
	if err := carrySpeech(speechSource, directory, spec); err != nil {
		return nil, err
	}
	connected := mediaadapters.Known(spec.Value("provider"))
	prepared, err := func() (*toolrt.Dict, error) {
		temporary, err := os.MkdirTemp("", "regenerate-")
		if err != nil {
			return nil, toolrt.OSErrorFrom(err, os.TempDir())
		}
		defer os.RemoveAll(temporary)
		specPath := toolrt.JoinPath(temporary, "request.json")
		text, err := toolrt.DumpsJSON(spec, toolrt.Indented)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(specPath, []byte(text), 0o644); err != nil {
			return nil, toolrt.OSErrorFrom(err, specPath)
		}
		if connected {
			return mediarequest.Prepare(root, specPath, toolrt.JoinPath(directory, "request"))
		}
		return requestsnapshot.Prepare(specPath, toolrt.JoinPath(directory, "request"), nil)
	}()
	if err != nil {
		return nil, err
	}
	// Опоры и промпт унаследованы от исходного запроса: этапы проходятся без согласований, по одному шагу.
	for _, stage := range []string{"keyframes_review", "prompt_review"} {
		if err := workflow(root, "set-stage", "--dir", directory, stage); err != nil {
			return nil, err
		}
	}
	if err := workflow(root, "set-stage", "--dir", directory, "request_choice", "--request-dir", "request"); err != nil {
		return nil, err
	}
	// Вопрос продолжают кнопки приложения; сам вопрос согласия на отправку не означает.
	if err := workflow(root, "ask", "--dir", directory, "--stage", "request_choice"); err != nil {
		return nil, err
	}
	frozenValue, _ := toolrt.ReadJSON(toolrt.JoinPath(directory, "request", "request.json"))
	frozen := dict(frozenValue)
	if frozen == nil {
		return nil, toolrt.Raise(toolrt.TypeError, "нельзя обратиться по индексу или ключу: %s", toolrt.TypeName(frozenValue))
	}
	var report *toolrt.Dict
	if connected {
		pricing, err := costcheck.PricingFor(frozen, options.PricingPath, options.LocalDir)
		if err != nil {
			return nil, err
		}
		if report, err = costcheck.Check(ctx, frozen, pricing, nil, options.UseAccount, 60); err != nil {
			return nil, err
		}
	} else {
		report = toolrt.NewDict()
		for _, key := range []string{"model", "kind", "command", "parameters", "outputs"} {
			value, err := toolrt.Item(frozen, key)
			if err != nil {
				return nil, err
			}
			report.Set(key, value)
		}
		report.Set("estimate_credits", nil)
		report.Set("estimate_source", nil)
		report.Set("balance_credits", nil)
		report.Set("balance_source", "для провайдера не подключена проверка стоимости и баланса")
		report.Set("verdict", "cost_or_balance_unknown")
		report.Set("verdict_label", costcheck.VerdictLabel("cost_or_balance_unknown"))
		report.Set("reasons", []any{"Для провайдера " + toolrt.Str(spec.Value("provider")) + " не подключена проверка стоимости и баланса."})
	}
	workflowValue, _ := toolrt.ReadJSON(toolrt.JoinPath(directory, "workflow.json"))
	var retryOf any
	if document := dict(workflowValue); document != nil {
		retryOf = document.Value("retry_of")
	}
	promptText := toolrt.Str(prepared.Value("prompt_text"))
	sourceName := "asset"
	if packageDir != "" {
		sourceName = "package"
	}
	return toolcli.Record(
		"shot", shot,
		"package", directory,
		"work_dir", toolrt.JoinPath(directory, "request"),
		"retry_of", retryOf,
		"request_sha256", prepared.Value("request_sha256"),
		"provider", prepared.Value("provider"),
		"model", prepared.Value("model"),
		"parameters", prepared.Value("parameters"),
		"inputs", prepared.Value("inputs"),
		"prompt_chars", toolrt.NewInt(int64(toolrt.Len(promptText))),
		"warnings", prepared.Value("warnings"),
		"cost", report,
		"source", sourceName,
	), nil
}

// Run — инструмент regenerate_shot на разрешённом корне проекта: LookupError — код 3, ValueError —
// код 1 с текстом, прочие исключения — необработанная ошибка (toolrt.Unhandled).
func Run(ctx context.Context, root string, args []string, localDir string) toolcli.Output {
	parsed, exit := toolcli.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	value := func(name string) string {
		if values := parsed.Values[name]; len(values) > 0 {
			return values[0]
		}
		return ""
	}
	printer := &toolcli.Printer{}
	info, err := Regenerate(ctx, root, value("shot"), Options{
		Source: value("--source"), WorkDir: value("--work-dir"), UseAccount: !parsed.Bools["--no-account"],
		PricingPath: value("--pricing"), LocalDir: localDir,
	})
	if err != nil {
		switch {
		case toolrt.Is(err, lookupError):
			return toolcli.Output{Code: noData, Stderr: toolrt.TextMode(err.Error() + "\n")}
		case toolrt.Is(err, toolrt.ValueError):
			return printer.Fail(err.Error())
		default:
			return printer.Crash(err)
		}
	}
	if parsed.Bools["--json"] {
		text, err := toolrt.DumpsJSON(info, toolrt.DumpOptions{})
		if err != nil {
			return printer.Crash(err)
		}
		if err := printer.Print(text); err != nil {
			return printer.Crash(err)
		}
		return printer.Exit(0)
	}
	retry := "принятого комплекта"
	if toolrt.Truthy(info.Value("retry_of")) {
		retry = toolrt.Str(info.Value("retry_of"))
	}
	parameters, err := toolrt.DumpsJSON(info.Value("parameters"), toolrt.DumpOptions{})
	if err != nil {
		return printer.Crash(err)
	}
	inputs, _ := info.Value("inputs").([]any)
	table, err := costcheck.Table(dict(info.Value("cost")))
	if err != nil {
		return printer.Crash(err)
	}
	lines := []string{
		"Пакет " + toolrt.Str(info.Value("package")) + " (повтор " + retry + "), запрос " + toolrt.Str(info.Value("request_sha256")),
		"Модель " + toolrt.Str(info.Value("model")) + ", параметры " + parameters + ", входов " + strconv.Itoa(len(inputs)) +
			", промпт " + toolrt.Str(info.Value("prompt_chars")) + " символов",
		table,
	}
	warnings, _ := info.Value("warnings").([]any)
	for _, warning := range warnings {
		lines = append(lines, "Предупреждение: "+toolrt.Str(warning))
	}
	for _, line := range lines {
		if err := printer.Print(line); err != nil {
			return printer.Crash(err)
		}
	}
	return printer.Exit(0)
}
