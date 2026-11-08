// Package agents ведёт внешних текстовых агентов SongFrame (Codex и Claude Code):
// реестр исполнителей, глобальный выбор агента в settings.json, диагностику программы (поиск,
// версия, вход), сведения аккаунта и каталог моделей, аргументы и потоковые протоколы обоих CLI,
// задания с историей, отменой дерева процессов и вложениями изображений, а также явный выбор
// исполнителей ИИ (ai.access).
//
// Аргументы CLI и stdin, тексты ошибок, формат settings.json и файлов истории
// jobs/agent-<uuid>.json зафиксированы эталонами testdata/golden/agents-*.
// Внешние программы запускаются только общим internal/process: без shell и консоли, с
// завершением дерева при отмене или тайм-ауте.
package agents

// Идентификаторы исполнителей. Общий код и интерфейс не сравнивают их с текстом: всё, что нужно
// знать о провайдере, берётся из Providers, особенности протокола — из его адаптера.
const (
	Claude = "claude"
	Codex  = "codex"
)

// ProviderInfo — запись реестра текстового агента. Поля и значения совпадают с AGENT_PROVIDERS
// из frontend/src/shared/agent-providers.ts (единственный источник названий для интерфейса);
// тест TestRegistryMatchesFrontend сверяет их, чтобы Go не разошёлся с TS-реестром.
type ProviderInfo struct {
	// Title — название в интерфейсе и сообщениях диагностики.
	Title string
	// Executable — имя исполняемого файла для автоматического поиска в PATH.
	Executable string
	// LoginCommand и StatusCommand — команды для пользователя в терминале.
	LoginCommand  string
	StatusCommand string
	// InstallURL, LoginURL и AccountURL — официальные инструкции и личный кабинет.
	InstallURL string
	LoginURL   string
	AccountURL string
	// ReviewImageBudgetBytes — бюджет копий изображений проверки в SongFrame, а не лимит CLI.
	ReviewImageBudgetBytes int
}

// ProviderIDs — порядок исполнителей в настройках (порядок ключей AGENT_PROVIDERS).
var ProviderIDs = []string{Claude, Codex}

// Providers — реестр текстовых агентов. Не изменяется во время работы.
var Providers = map[string]ProviderInfo{
	Claude: {
		Title:                  "Claude Code",
		Executable:             "claude",
		LoginCommand:           "claude auth login",
		StatusCommand:          "claude auth status",
		InstallURL:             "https://code.claude.com/docs/en/setup",
		LoginURL:               "https://code.claude.com/docs/en/cli-reference",
		AccountURL:             "https://claude.ai/settings/usage",
		ReviewImageBudgetBytes: 6 * 1024 * 1024,
	},
	Codex: {
		Title:                  "Codex",
		Executable:             "codex",
		LoginCommand:           "codex login",
		StatusCommand:          "codex login status",
		InstallURL:             "https://learn.chatgpt.com/docs/codex/cli",
		LoginURL:               "https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login",
		AccountURL:             "https://chatgpt.com/codex/settings/usage",
		ReviewImageBudgetBytes: 16 * 1024 * 1024,
	},
}

// IsProvider — isAgentProvider: только собственные ключи реестра (toString и т. п. не подходят).
func IsProvider(value string) bool {
	_, ok := Providers[value]
	return ok
}

// Title — agentTitle: название выбранного исполнителя или общая сущность «Агент» без выбора.
func Title(provider string) string {
	if info, ok := Providers[provider]; ok {
		return info.Title
	}
	return textAgentLabel
}
