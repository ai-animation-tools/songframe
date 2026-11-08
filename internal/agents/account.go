package agents

import (
	"context"
	"math"
	"regexp"
	"strings"
	"time"

	"songframe-go/internal/jscompat"
)

// AccountLimit — AgentAccountLimit: окно лимита из штатной диагностики CLI. usedPercent — в
// процентах, windowMinutes — длина окна в минутах, resetsAt — Unix-время сброса в секундах.
type AccountLimit struct {
	Label         string   `json:"label"`
	UsedPercent   float64  `json:"usedPercent"`
	WindowMinutes *float64 `json:"windowMinutes"`
	ResetsAt      *float64 `json:"resetsAt"`
}

// AccountResult — AgentAccountResult: снимок подтверждённых полей аккаунта. null означает, что CLI
// не подтвердил показатель: отсутствие ответа не означает нулевой лимит или оплаченную подписку.
type AccountResult struct {
	Provider              string          `json:"provider"`
	CheckedAt             string          `json:"checkedAt"`
	Diagnostic            CheckResult     `json:"diagnostic"`
	Email                 *string         `json:"email"`
	Organization          *string         `json:"organization"`
	AuthenticationMethod  *string         `json:"authenticationMethod"`
	Plan                  *string         `json:"plan"`
	SubscriptionStatus    *string         `json:"subscriptionStatus"`
	SubscriptionExpiresAt *string         `json:"subscriptionExpiresAt"`
	Limits                *[]AccountLimit `json:"limits"`
	UsageAllowed          *bool           `json:"usageAllowed"`
	Credits               *string         `json:"credits"`
	Message               string          `json:"message,omitempty"`
}

// timestamp — new Date().toISOString(): UTC с миллисекундами.
func timestamp(now time.Time) string { return now.UTC().Format("2006-01-02T15:04:05.000Z") }

var controlCharacters = regexp.MustCompile(`\p{Cc}`)

// accountText — подтверждённое текстовое поле: непустая строка без управляющих символов, не
// длиннее 512 кодовых единиц; иначе nil.
func accountText(value any) *string {
	raw, ok := value.(string)
	if !ok || jscompat.Trim(raw) == "" {
		return nil
	}
	cleaned := utf16Slice(jscompat.Trim(controlCharacters.ReplaceAllString(raw, "")), 512)
	if cleaned == "" {
		return nil
	}
	return &cleaned
}

// accountNumber — конечное неотрицательное число или nil.
func accountNumber(value any) *float64 {
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) || number < 0 {
		return nil
	}
	return &number
}

// supportedMinor — версия X.Y.Z с тем же major и minor не ниже требуемого (аккаунт).
func supportedMinor(version string, major, minor float64) bool {
	a, b, _, ok := numbers(version)
	return ok && a == major && b >= minor
}

// prepareAccount — пустой снимок с диагностикой; поля заполняются только подтверждёнными данными.
func prepareAccount(ctx context.Context, config Settings, options CheckOptions) (AccountResult, ProcessOptions, error) {
	diagnostic, err := CheckAgent(ctx, config, options)
	if err != nil {
		return AccountResult{}, ProcessOptions{}, err
	}
	options = options.resolve()
	process := options.process()
	return AccountResult{Provider: config.Provider, CheckedAt: timestamp(time.Now()), Diagnostic: diagnostic}, process, nil
}

// claudeAccount читает auth status --json и, для подписки claude.ai без рабочих ключей API,
// лимиты через изолированный control protocol (get_usage). Отсутствие входа не перепроверяется.
func claudeAccount(ctx context.Context, config Settings, options CheckOptions) (AccountResult, error) {
	result, process, err := prepareAccount(ctx, config, options)
	if err != nil || result.Diagnostic.ExecutablePath == "" || result.Diagnostic.Availability != Available {
		return result, err
	}
	path := result.Diagnostic.ExecutablePath
	if !supportedMinor(result.Diagnostic.Version, 2, 1) {
		result.Message = textAccountVersionUnsupported(Title(Claude))
		return result, nil
	}
	if result.Diagnostic.Authorization == Unauthenticated {
		return result, nil
	}
	canReadUsage := false
	response, err := readAccountCommand(ctx, path, []string{"auth", "status", "--json"}, process)
	if err != nil {
		result.Message = textPartialAccount
	} else {
		data := object(response)
		switch data.Value("loggedIn") {
		case true:
			result.Email = accountText(data.Value("email"))
			result.Organization = accountText(data.Value("orgName"))
			if result.Organization == nil {
				result.Organization = accountText(data.Value("orgId"))
			}
			result.AuthenticationMethod = accountText(data.Value("authMethod"))
			result.Plan = accountText(data.Value("subscriptionType"))
			// Изолированный control CLI не загружает apiKeyHelper: его личные лимиты нельзя
			// приписывать рабочему API-аккаунту.
			method := data.Value("authMethod")
			source := data.Value("apiKeySource")
			canReadUsage = (method == "claude.ai" || method == "oauth_token") && data.Value("apiProvider") == "firstParty" &&
				(source == jscompat.Undefined || source == "none")
		case false:
		default:
			result.Message = textPartialAccount
		}
	}
	// get_usage — экспериментальный метод SDK, появился в 2.1.273.
	_, minor, patch, _ := numbers(result.Diagnostic.Version)
	if canReadUsage && (minor > 1 || patch >= 273) {
		if usage := readClaudeUsage(ctx, path, process); usage != nil {
			result.Limits = claudeLimits(usage)
		} else {
			result.Message = textPartialAccount
		}
	}
	return result, nil
}

// claudeUsage — узкий снимок get_usage: аккаунт, произвольный текст CLI и история наружу не выходят.
type claudeUsage struct {
	available *bool
	// rates — nil, если rate_limits не объект.
	rates *claudeRates
}

type claudeWindow struct {
	utilization *float64
	resetsAt    *string
}

type claudeRow struct {
	kind, group string
	percent     *float64
	resetsAt    *string
}

type claudeRates struct {
	windows map[string]claudeWindow
	// limits — динамический список; nil, если поля нет (старый формат).
	limits []claudeRow
	hasRow bool
}

// claudeWindows — фиксированные окна старого формата в порядке показа.
var claudeWindows = []string{"five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"}

var identifierPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

func usagePercent(value any) *float64 {
	number, ok := value.(float64)
	if !ok || math.IsInf(number, 0) || math.IsNaN(number) || number < 0 || number > 100 {
		return nil
	}
	return &number
}

var resetPrefix = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T`)

func resetTime(value any) *string {
	raw, ok := value.(string)
	if !ok || !resetPrefix.MatchString(raw) || utf16Len(raw) > 40 {
		return nil
	}
	if _, ok := parseDate(raw); !ok {
		return nil
	}
	return &raw
}

// readClaudeUsage выполняет initialize и get_usage (skip_behaviors исключает чтение истории за семь
// дней); любой сбой — nil.
func readClaudeUsage(ctx context.Context, executable string, options ProcessOptions) *claudeUsage {
	usageRequest := jscompat.NewObject()
	usageRequest.Set("subtype", "get_usage")
	usageRequest.Set("skip_behaviors", true)
	initialize := jscompat.NewObject()
	initialize.Set("subtype", "initialize")
	responses, err := claudeControl(ctx, executable, options, []*jscompat.Object{initialize, usageRequest})
	if err != nil {
		return nil
	}
	data, ok := responses[1].(*jscompat.Object)
	if !ok || (!data.Has("rate_limits_available") && !data.Has("rate_limits")) {
		return nil
	}
	usage := &claudeUsage{}
	if available, ok := data.Value("rate_limits_available").(bool); ok {
		usage.available = &available
	}
	rateLimits, ok := data.Value("rate_limits").(*jscompat.Object)
	if !ok {
		return usage
	}
	rates := &claudeRates{windows: map[string]claudeWindow{}}
	for _, key := range claudeWindows {
		if window, ok := rateLimits.Value(key).(*jscompat.Object); ok {
			rates.windows[key] = claudeWindow{utilization: usagePercent(window.Value("utilization")), resetsAt: resetTime(window.Value("resets_at"))}
		}
	}
	if rows, ok := jscompat.AsArray(rateLimits.Value("limits")); ok {
		rates.hasRow = true
		rates.limits = []claudeRow{}
		if len(rows) > 32 {
			rows = rows[:32]
		}
		for _, raw := range rows {
			row, ok := raw.(*jscompat.Object)
			if !ok {
				continue
			}
			kind, group := text(row.Value("kind")), text(row.Value("group"))
			if !identifierPattern.MatchString(kind) || !identifierPattern.MatchString(group) {
				continue
			}
			rates.limits = append(rates.limits, claudeRow{kind: kind, group: group, percent: usagePercent(row.Value("percent")), resetsAt: resetTime(row.Value("resets_at"))})
		}
	}
	usage.rates = rates
	return usage
}

// resetSeconds — Math.floor(Date.parse(value) / 1000) или nil без времени.
func resetSeconds(value *string) *float64 {
	if value == nil {
		return nil
	}
	milliseconds, ok := parseDate(*value)
	if !ok {
		return nil
	}
	seconds := math.Floor(milliseconds / 1000)
	return &seconds
}

// claudeLimits — окна лимитов Claude. Динамический список учитывает отдельные модели и группы;
// фиксированные окна служат только старому формату.
func claudeLimits(usage *claudeUsage) *[]AccountLimit {
	if (usage.available != nil && !*usage.available) || usage.rates == nil {
		return nil
	}
	limits := []AccountLimit{}
	if usage.rates.hasRow {
		for _, row := range usage.rates.limits {
			if row.percent == nil {
				continue
			}
			var window *float64
			if row.kind == "five_hour" {
				window = floatPointer(300)
			} else if strings.HasPrefix(row.kind, "seven_day") {
				window = floatPointer(10080)
			}
			limits = append(limits, AccountLimit{Label: textLimitLabel(row.group, row.kind, nil), UsedPercent: *row.percent, WindowMinutes: window, ResetsAt: resetSeconds(row.resetsAt)})
		}
	} else {
		for _, key := range claudeWindows {
			window, ok := usage.rates.windows[key]
			if !ok || window.utilization == nil {
				continue
			}
			minutes := 10080
			if key == "five_hour" {
				minutes = 300
			}
			limits = append(limits, AccountLimit{Label: textLimitWithWindow(key, minutes), UsedPercent: *window.utilization, WindowMinutes: floatPointer(float64(minutes)), ResetsAt: resetSeconds(window.resetsAt)})
		}
	}
	if len(limits) == 0 {
		return nil
	}
	return &limits
}

func floatPointer(value float64) *float64 { return &value }

// codexSnapshot — ответы app-server: nil (Undefined) — запрос не выполнен.
type codexSnapshot struct {
	account    any
	rateLimits any
	partial    bool
}

// readCodexAccount — только штатные операции чтения: account/read без обновления токена и
// account/rateLimits/read; сбой одного запроса не отменяет другой.
func readCodexAccount(ctx context.Context, executable string, options ProcessOptions) codexSnapshot {
	snapshot := codexSnapshot{account: jscompat.Undefined, rateLimits: jscompat.Undefined}
	_, err := codexRPC(ctx, executable, options, func(request func(string, *jscompat.Object) (any, error)) (struct{}, error) {
		params := jscompat.NewObject()
		params.Set("refreshToken", false)
		if value, err := request("account/read", params); err != nil {
			snapshot.partial = true
		} else {
			snapshot.account = value
		}
		if value, err := request("account/rateLimits/read", jscompat.NewObject()); err != nil {
			snapshot.partial = true
		} else {
			snapshot.rateLimits = value
		}
		return struct{}{}, nil
	})
	if err != nil {
		snapshot.partial = true
	}
	return snapshot
}

// codexLimits — окна и кредиты Codex. Многокорзинный ответ авторитетен даже при пустой карте:
// legacy-корзина не подменяет его старыми числами.
func codexLimits(response *jscompat.Object) (*[]AccountLimit, *string) {
	type bucket struct {
		id    string
		value any
	}
	buckets := []bucket{}
	if byID, ok := response.Value("rateLimitsByLimitId").(*jscompat.Object); ok {
		for _, key := range byID.Keys() {
			buckets = append(buckets, bucket{key, byID.Value(key)})
		}
	} else if legacy, ok := response.Value("rateLimits").(*jscompat.Object); ok {
		id := "codex"
		if limitID := accountText(legacy.Value("limitId")); limitID != nil {
			id = *limitID
		}
		buckets = append(buckets, bucket{id, legacy})
	}
	limits := []AccountLimit{}
	credits := []string{}
	addCredit := func(value string) {
		for _, existing := range credits {
			if existing == value {
				return
			}
		}
		credits = append(credits, value)
	}
	for _, item := range buckets {
		data := object(item.value)
		name := "codex"
		for _, candidate := range []*string{accountText(data.Value("limitName")), accountText(data.Value("limitId")), accountText(item.id)} {
			if candidate != nil {
				name = *candidate
				break
			}
		}
		for _, key := range []string{"primary", "secondary"} {
			window := object(data.Value(key))
			used := accountNumber(window.Value("usedPercent"))
			if used == nil || *used > 100 {
				continue
			}
			minutes := accountNumber(window.Value("windowDurationMins"))
			limits = append(limits, AccountLimit{Label: textLimitLabel(name, key, minutes), UsedPercent: *used, WindowMinutes: minutes, ResetsAt: accountNumber(window.Value("resetsAt"))})
		}
		credit := object(data.Value("credits"))
		balance := accountText(credit.Value("balance"))
		switch {
		case credit.Value("unlimited") == true:
			addCredit(textUnlimitedCredits)
		case balance != nil:
			addCredit(*balance)
		case credit.Value("hasCredits") == false:
			addCredit(textNoCredits)
		case credit.Value("hasCredits") == true:
			addCredit(textAvailableCredits)
		}
	}
	var joined *string
	if len(credits) > 0 {
		value := strings.Join(credits, "; ")
		joined = &value
	}
	if len(limits) == 0 {
		return nil, joined
	}
	return &limits, joined
}

// codexAccount читает аккаунт и лимиты через app-server. login status подтверждает локальные
// учётные данные; явный ответ сервера об отсутствии аккаунта важнее этого кэша.
func codexAccount(ctx context.Context, config Settings, options CheckOptions) (AccountResult, error) {
	result, process, err := prepareAccount(ctx, config, options)
	if err != nil || result.Diagnostic.ExecutablePath == "" || result.Diagnostic.Availability != Available {
		return result, err
	}
	if !supportedMinor(result.Diagnostic.Version, 0, 159) {
		result.Message = textAccountVersionUnsupported(Title(Codex))
		return result, nil
	}
	if result.Diagnostic.Authorization == Unauthenticated {
		return result, nil
	}
	snapshot := readCodexAccount(ctx, result.Diagnostic.ExecutablePath, process)
	response := object(snapshot.account)
	if response.Value("account") == nil && response.Value("requiresOpenaiAuth") == true {
		result.Diagnostic.Authorization = Unauthenticated
		result.Diagnostic.Message = textCodexLoggedOut
		result.Message = textCodexLoggedOut
		return result, nil
	}
	account := object(response.Value("account"))
	switch account.Value("type") {
	case "chatgpt":
		result.AuthenticationMethod = stringPointer("ChatGPT")
		result.Email = accountText(account.Value("email"))
		if account.Value("planType") != "unknown" {
			result.Plan = accountText(account.Value("planType"))
		}
	case "apiKey":
		result.AuthenticationMethod = stringPointer("API key")
	case "amazonBedrock":
		result.AuthenticationMethod = stringPointer("Amazon Bedrock")
	default:
		result.Diagnostic.Authorization = AuthUnknown
		result.Diagnostic.Message = textAccountAuthorizationUnknown(Title(Codex))
		result.Message = textPartialAccount
	}
	rates := object(snapshot.rateLimits)
	result.Limits, result.Credits = codexLimits(rates)
	if allowed, ok := rates.Value("ordinaryUsageAllowed").(bool); ok {
		result.UsageAllowed = &allowed
		if !allowed {
			result.Message = textUsageRestricted(Title(Codex))
		}
	}
	if snapshot.partial || !jscompat.Truthy(snapshot.rateLimits) || !jscompat.Truthy(snapshot.account) {
		result.Message = textPartialAccount
	}
	return result, nil
}

func stringPointer(value string) *string { return &value }
