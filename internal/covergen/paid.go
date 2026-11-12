package covergen

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/promptlog"
	"songframe/internal/providers"
	"songframe/internal/providers/agentexec"
	"songframe/internal/tools"
)

// watchTimeout — предел ожидания результата отправленной попытки (media_request watch).
const watchTimeout = 15 * time.Minute

// Runner — запуск инструмента платной попытки (media_request, cost_check) с отменой.
type Runner func(ctx context.Context, project, name string, args []string) (tools.Result, error)

// PaidOptions — зависимости платной обложки.
type PaidOptions struct {
	// Media — общий платный адаптер провайдера для изображений (возможности, подготовка,
	// отправка через владельца согласования, сбор оригиналов).
	Media *providers.PaidMedia
	// Run — запуск инструментов; nil — tools.RunContext.
	Run Runner
	// PricingArgs — аргументы таблицы цен cost_check; nil — PricingArgs.
	PricingArgs func() []string
}

// PricingArgs — аргументы цены: SONGFRAME_PRICING_FILE подменяет базовую таблицу цен в
// тестовых прогонах; наблюдения расхода cost_check learn пишет в каталог состояния.
func PricingArgs() []string {
	if file := os.Getenv("SONGFRAME_PRICING_FILE"); file != "" {
		return []string{"--pricing", file}
	}
	return []string{}
}

// paidAttempt — состояние подготовленной платной попытки: зафиксированный запрос, цена подготовки
// и признак единственного запуска.
type paidAttempt struct {
	options  PaidOptions
	texts    texts
	title    string
	project  string
	prepared providers.PreparedRequest
	quote    Quote
	used     bool
	// place — страница проекта для журнала отправок: обложка — «Проект», референс — «Кастинг».
	place *promptlog.Place
}

// stopped — отказ после отмены: до отправки — «отправка не выполнялась», после начала отправки —
// предупреждение, что запрос мог быть оплачен.
func (p *paidAttempt) stopped(ctx context.Context, submitted bool) error {
	if ctx.Err() == nil {
		return nil
	}
	if submitted {
		return errors.New(p.texts.stoppedAfterSubmit(p.title))
	}
	return errors.New(p.texts.stoppedBeforeSubmit)
}

// aliasNames — синонимы имени из правил запроса изображений; без записи — само имя.
func aliasNames(rules mediaapi.RequestRules, name string) []string {
	for _, alias := range rules.Aliases[mediaproviders.Image] {
		if alias.Name == name {
			return alias.Names
		}
	}
	return []string{name}
}

// parametersForModel — параметры обложки для модели. Пропорции и число результатов сцены к ней не
// относятся: обложка — одно квадратное изображение, референс — одно изображение с пропорциями
// проекта (1:1, если проект их не задал). Явное generation.image.resolution заменяет синонимы с
// тем же значением (иное значение — конфликт), без явного разрешения подставляется разрешение
// провайдера по умолчанию, если модель объявляет параметр. Включённая серия изображений —
// отказ, объявленная серия выключается.
func parametersForModel(rules mediaapi.RequestRules, defaultResolution string, model mediaapi.Model, options *dynvalue.Object, resolution any, t texts, reference bool) (*dynvalue.Object, error) {
	parameters := dynvalue.NewObject()
	if options != nil {
		parameters = options.Clone()
	}
	arguments, _ := dynvalue.Parse(model.Arguments)
	declared := func(name string) bool {
		object, ok := arguments.(*dynvalue.Object)
		return ok && object.Has(name)
	}
	for _, key := range rules.OutputCount {
		parameters.Delete(key)
	}
	aspect := aliasNames(rules, "aspect_ratio")
	if !reference {
		for _, key := range aspect {
			parameters.Delete(key)
		}
		parameters.Set("aspect_ratio", "1:1")
	} else if !anyKey(parameters, aspect) {
		parameters.Set("aspect_ratio", "1:1")
	}
	resolutionKeys := aliasNames(rules, "resolution")
	supplied := []string{}
	for _, key := range resolutionKeys {
		if parameters.Has(key) {
			supplied = append(supplied, key)
		}
	}
	if resolution != dynvalue.Undefined {
		for _, key := range supplied {
			if !dynvalue.StrictEqual(parameters.Value(key), resolution) {
				return nil, errors.New(t.resolutionConflict)
			}
			parameters.Delete(key)
		}
		parameters.Set("resolution", resolution)
	} else if len(supplied) == 0 && anyDeclared(declared, resolutionKeys) {
		var value any = dynvalue.Undefined
		if defaultResolution != "" {
			value = defaultResolution
		}
		parameters.Set("resolution", value)
	}
	if series := rules.Image.Series; series != nil {
		for _, name := range series.Names {
			if value := parameters.Value(name); value == true || value == "true" {
				return nil, errors.New(t.seriesUnsupported(series.Names[0]))
			}
		}
		for _, key := range series.Names {
			if declared(key) {
				if !anyKey(parameters, series.Names) {
					parameters.Set(key, series.Off)
				}
				break
			}
		}
	}
	return parameters, nil
}

// anyKey — хотя бы один из ключей есть в объекте (key in parameters).
func anyKey(object *dynvalue.Object, keys []string) bool {
	for _, key := range keys {
		if object.Has(key) {
			return true
		}
	}
	return false
}

// anyDeclared — хотя бы один из ключей объявлен моделью.
func anyDeclared(declared func(string) bool, keys []string) bool {
	for _, key := range keys {
		if declared(key) {
			return true
		}
	}
	return false
}

// PreparePaid готовит отдельную попытку платного провайдера в
// <WorkDir>/request и показывает цену, ничего не отправляя. Проект должен выбрать этого же
// провайдера; модель выбирает общий селектор (предпочтение проекта не ограничивает совместимый
// выбор), опоры передаются именованными слотами с нейтральными подписями. Сбой проверки цены
// становится неизвестной ценой: он сам по себе отправку не разрешает.
func PreparePaid(ctx context.Context, input CandidateInput, options PaidOptions) (*Candidate, error) {
	if options.Run == nil {
		options.Run = tools.RunContext
	}
	if options.PricingArgs == nil {
		options.PricingArgs = PricingArgs
	}
	reference := input.Purpose == agentexec.PurposeReference
	paid := options.Media.Paid
	info, _ := mediaproviders.Lookup(paid.ID)
	attempt := &paidAttempt{options: options, texts: textsFor(reference), title: info.Title, project: input.Project, place: &promptlog.Place{Page: "project"}}
	if reference {
		attempt.place = &promptlog.Place{Page: "cast"}
	}
	t := attempt.texts
	if err := attempt.stopped(ctx, false); err != nil {
		return nil, err
	}
	settings, err := imageSettings(input.Project)
	if err != nil {
		return nil, err
	}
	object, isObject := settings.(*dynvalue.Object)
	provider, _ := dynvalue.Get(settings, "provider").(string)
	if !isObject || !sameMediaProvider(provider, paid.ID) {
		return nil, errors.New(t.providerRequired(info.Title))
	}
	caps := options.Media.Capabilities(ctx, input.Project)
	if err := attempt.stopped(ctx, false); err != nil {
		return nil, err
	}
	references, err := mediafile.CheckedReferences(input.References)
	if err != nil {
		return nil, err
	}
	model, err := trimmedModel(object)
	if err != nil {
		return nil, err
	}
	preferred := model
	inputs := make([]providers.PaidInputItem, len(references))
	for index, image := range references {
		inputs[index] = providers.PaidInputItem{Flag: "input", Slot: paid.Rules.Image.ReferenceSlot(index), Role: image.Label, Path: image.Path}
	}
	request := providers.PaidInput{
		Project: input.Project, WorkDir: filepath.Join(input.WorkDir, "request"), Shot: "M00", Kind: mediaproviders.Image,
		Command: paid.Rules.Image.Command(len(references)), Model: model, PreferredModel: &preferred, Prompt: input.Prompt,
		Parameters: dynvalue.NewObject(), Inputs: inputs, Outputs: 1,
	}
	projectOptions, _ := object.Value("options").(*dynvalue.Object)
	resolution := object.Value("resolution")
	selected, err := providers.SelectCheckedPaidRequest(paid, request, caps, func(item mediaapi.Model) (*dynvalue.Object, error) {
		return parametersForModel(paid.Rules, info.DefaultImageResolution, item, projectOptions, resolution, t, reference)
	})
	if err != nil {
		return nil, err
	}
	prepared, err := options.Media.Prepare(ctx, selected, caps)
	if err != nil {
		return nil, err
	}
	if err := attempt.stopped(ctx, false); err != nil {
		return nil, err
	}
	attempt.prepared = prepared
	quote, err := attempt.price(ctx)
	if err != nil {
		return nil, err
	}
	attempt.quote = quote
	selectedModel := selected.Model
	frozen := quote
	return &Candidate{Provider: paid.ID, Model: &selectedModel, RequestSha: prepared.RequestSha, Quote: &frozen, Generate: attempt.generate}, nil
}

// finiteNumber — значение, если это конечное число JSON; иначе nil.
func finiteNumber(value any) *float64 {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return nil
	}
	return &number
}

// price — cost_check check: стоимость и остаток подготовленной попытки. Непонятный или
// противоречивый ответ и сбой запуска — неизвестная цена с текстом сбоя; отмена — отказ.
func (p *paidAttempt) price(ctx context.Context) (Quote, error) {
	if err := p.stopped(ctx, false); err != nil {
		return Quote{}, err
	}
	quote, ok := func() (Quote, bool) {
		args := append([]string{"check", "--work-dir", p.prepared.RequestDir, "--json"}, p.options.PricingArgs()...)
		result, err := p.options.Run(ctx, p.project, "cost_check", args)
		if err != nil || ctx.Err() != nil {
			return Quote{}, false
		}
		parsed, err := dynvalue.Parse([]byte(result.Stdout))
		value, isObject := parsed.(*dynvalue.Object)
		if err != nil || !isObject {
			return Quote{}, false
		}
		code := -1
		if result.Code != nil {
			code = *result.Code
		}
		verdict := dynvalue.ToString(value.Value("verdict"))
		if (code != 0 && code != 2) || (verdict != VerdictOK && verdict != VerdictInsufficientBalance && verdict != VerdictCostOrBalanceUnknown) {
			return Quote{}, false
		}
		credits, balance := finiteNumber(value.Value("estimate_credits")), finiteNumber(value.Value("balance_credits"))
		if (credits != nil && *credits < 0) || (balance != nil && *balance < 0) {
			return Quote{}, false
		}
		if verdict == VerdictOK && (code != 0 || credits == nil || balance == nil || *balance < *credits) {
			return Quote{}, false
		}
		reasons := []string{}
		if list, ok := value.Value("reasons").(*dynvalue.Array); ok {
			for _, item := range list.Items {
				if text, ok := item.(string); ok {
					reasons = append(reasons, text)
				}
			}
		}
		return Quote{Credits: credits, Balance: balance, Verdict: verdict, Message: strings.Join(reasons, " ")}, true
	}()
	if err := p.stopped(ctx, false); err != nil {
		return Quote{}, err
	}
	if !ok {
		// Сбой проверки цены оставляет пользователю явный выбор; сам по себе он не разрешает отправку.
		return Quote{Verdict: VerdictCostOrBalanceUnknown, Message: p.texts.priceFailed(p.title)}, nil
	}
	return quote, nil
}

// sameNumber — равенство необязательных чисел: два отсутствующих равны, отсутствующее и число — нет.
func sameNumber(left, right *float64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// generate — единственная попытка: повторная проверка цены, одна отправка того же SHA через
// владельца согласования, ожидание результата, запоминание фактического списания и сбор одного
// изображения. После начала отправки отмена не разрешает повтор и не обещает возврат кредитов.
func (p *paidAttempt) generate(ctx context.Context, allowUnknownCost bool) (string, error) {
	t := p.texts
	if err := p.stopped(ctx, false); err != nil {
		return "", err
	}
	if p.used {
		return "", errors.New(t.attemptUsed)
	}
	p.used = true
	if !priceAllowsGeneration(&p.quote, allowUnknownCost) {
		return "", errors.New(t.priceUnconfirmed)
	}
	current, err := p.price(ctx)
	if err != nil {
		return "", err
	}
	// Согласие на неизвестную цену допускает появление цены перед отправкой, но не нехватку средств.
	approvedUnknownCost := canAgreeToUnknownCost(&p.quote) && allowUnknownCost
	var approved bool
	if approvedUnknownCost {
		approved = priceAllowsGeneration(&current, true)
	} else {
		approved = current.Verdict == VerdictOK && sameNumber(current.Credits, p.quote.Credits) && sameNumber(current.Balance, p.quote.Balance)
	}
	if !approved {
		return "", errors.New(t.priceChanged)
	}
	if err := p.stopped(ctx, false); err != nil {
		return "", err
	}
	submitted := false
	path, err := func() (string, error) {
		_, err := p.options.Media.Submit(ctx, p.prepared, func(ctx context.Context, action string, reference providers.PreparedRequest) error {
			if action != "submit" {
				return errors.New(t.submitActionRequired)
			}
			if err := p.stopped(ctx, false); err != nil {
				return err
			}
			// После старта submit исход может быть неизвестен: отмена не разрешает повторный платный запрос.
			submitted = true
			var result tools.Result
			err := promptlog.PaidSubmit(ctx, p.project, reference.RequestDir, p.place, func() error {
				var runErr error
				result, runErr = p.options.Run(ctx, p.project, "media_request", []string{"submit", "--work-dir", reference.RequestDir, "--confirm", reference.RequestSha})
				if runErr == nil && (result.Code == nil || *result.Code != 0) {
					return failure(result.Stderr, t.submitFailed)
				}
				return runErr
			})
			if err != nil {
				return err
			}
			if err := p.stopped(ctx, submitted); err != nil {
				return err
			}
			if result.Code == nil || *result.Code != 0 {
				return failure(result.Stderr, t.submitFailed)
			}
			return nil
		})
		if err != nil {
			return "", err
		}
		if err := p.stopped(ctx, submitted); err != nil {
			return "", err
		}
		watchCtx, cancel := context.WithTimeout(ctx, watchTimeout)
		result, err := p.options.Run(watchCtx, p.project, "media_request", []string{"watch", "--work-dir", p.prepared.RequestDir, "--max-minutes", "15"})
		cancel()
		if err != nil {
			return "", err
		}
		if err := p.stopped(ctx, submitted); err != nil {
			return "", err
		}
		if result.Code == nil || *result.Code != 0 {
			return "", failure(result.Stderr, t.watchFailed)
		}
		// Фактическое списание запоминается: если сервис не сообщает цену заранее, такой же запрос в следующий раз покажет цену.
		_, _ = p.options.Run(ctx, p.project, "cost_check", append([]string{"learn", "--work-dir", p.prepared.RequestDir}, p.options.PricingArgs()...))
		artifacts, err := p.options.Media.Collect(p.prepared)
		if err != nil {
			return "", err
		}
		if len(artifacts) != 1 || artifacts[0].Kind != mediaproviders.Image {
			return "", errors.New(t.singleImageRequired(p.title))
		}
		return artifacts[0].Path, nil
	}()
	if err != nil {
		if stopped := p.stopped(ctx, submitted); stopped != nil {
			return "", stopped
		}
		return "", err
	}
	return path, nil
}

// sameMediaProvider — непустые id совпадают без учёта регистра и
// пробелов по краям.
func sameMediaProvider(left, right string) bool {
	left, right = dynvalue.Trim(left), dynvalue.Trim(right)
	return left != "" && right != "" && strings.ToLower(left) == strings.ToLower(right)
}

// failure — stderr без пробелов по краям, а если он пуст — fallback.
func failure(stderr, fallback string) error {
	if text := dynvalue.Trim(stderr); text != "" {
		return errors.New(text)
	}
	return errors.New(fallback)
}
