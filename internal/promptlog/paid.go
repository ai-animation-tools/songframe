package promptlog

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"

	"songframe/internal/spend"
)

// PaidSubmit отправляет платный запрос папки requestDir через submit и записывает отправку в журнал:
// до вызова — замороженный промпт, параметры и входы запроса, после — итог по attempt.json
// (номер генерации, списание, отказ) или причину сбоя. Отмена — cancelled. Сбой записи журнала
// не мешает отправке: он пишется в лог процесса.
func PaidSubmit(ctx context.Context, project, requestDir string, place *Place, submit func() error) error {
	id := NewID("paid")
	record, ok := paidRecord(project, requestDir)
	if ok {
		record.ID, record.Place = id, place
		if err := Begin(project, record); err != nil {
			log.Printf("Не удалось записать платную отправку в журнал проекта: %v", err)
			ok = false
		}
	}
	err := submit()
	if !ok {
		return err
	}
	status, failure := StatusCompleted, ""
	switch {
	case ctx.Err() != nil:
		status, failure = StatusCancelled, ctx.Err().Error()
	case err != nil:
		status, failure = StatusFailed, err.Error()
	}
	response, paid := paidOutcome(requestDir, record.Executor)
	if endErr := End(project, id, status, response, failure, paid); endErr != nil {
		log.Printf("Не удалось записать итог платной отправки в журнал проекта: %v", endErr)
	}
	return err
}

// paidRecord — запись по замороженному запросу: вид, провайдер, модель, промпт и входы.
func paidRecord(project, requestDir string) (Record, bool) {
	var request struct {
		Shot       string          `json:"shot"`
		Kind       string          `json:"kind"`
		Provider   string          `json:"provider"`
		Model      string          `json:"model"`
		Parameters json.RawMessage `json:"parameters"`
		Prompt     struct {
			Path string `json:"path"`
		} `json:"prompt"`
		Inputs []struct {
			Path string `json:"path"`
		} `json:"inputs"`
	}
	data, err := os.ReadFile(filepath.Join(requestDir, "request.json"))
	if err != nil || json.Unmarshal(data, &request) != nil {
		return Record{}, false
	}
	kind := KindVideo
	if request.Kind == "image" {
		kind = KindImage
	}
	prompt := ""
	if request.Prompt.Path != "" {
		if text, err := os.ReadFile(filepath.Join(requestDir, filepath.FromSlash(request.Prompt.Path))); err == nil {
			prompt = string(text)
		}
	}
	inputs := []string{}
	for _, input := range request.Inputs {
		if input.Path != "" {
			inputs = append(inputs, filepath.Join(requestDir, filepath.FromSlash(input.Path)))
		}
	}
	title := "Запрос видео"
	if kind == KindImage {
		title = "Запрос изображения"
	}
	if request.Shot != "" {
		title = request.Shot + " · " + title
	}
	context := ""
	if len(request.Parameters) > 0 {
		context = string(request.Parameters)
	}
	return Record{
		Kind: kind, Title: title, Executor: request.Provider, Model: request.Model, Prompt: prompt, Context: context,
		Attachments: Attach(project, inputs), Paid: &Paid{RequestSHA256: attemptSHA(requestDir), Parameters: request.Parameters},
	}, true
}

// attemptSHA — SHA-256 замороженного запроса из attempt.json.
func attemptSHA(requestDir string) string {
	var state struct {
		RequestSHA256 string `json:"request_sha256"`
	}
	data, _ := os.ReadFile(filepath.Join(requestDir, "attempt.json"))
	_ = json.Unmarshal(data, &state)
	return state.RequestSHA256
}

// paidOutcome — ответ сервиса по attempt.json: состояние попытки как JSON и сведения генерации.
func paidOutcome(requestDir, provider string) (string, *Paid) {
	data, err := os.ReadFile(filepath.Join(requestDir, "attempt.json"))
	if err != nil {
		return "", nil
	}
	var state struct {
		Status          string   `json:"status"`
		RequestSHA256   string   `json:"request_sha256"`
		GenerationID    *string  `json:"generation_id"`
		CreditsConsumed *float64 `json:"credits_consumed"`
		ServiceStatus   *string  `json:"service_status"`
		LastRejection   *string  `json:"last_rejection"`
	}
	if json.Unmarshal(data, &state) != nil {
		return "", nil
	}
	shown := map[string]any{"status": state.Status, "generation_id": state.GenerationID, "credits_consumed": state.CreditsConsumed}
	if state.ServiceStatus != nil {
		shown["service_status"] = *state.ServiceStatus
	}
	if state.LastRejection != nil {
		shown["last_rejection"] = *state.LastRejection
	}
	response, _ := json.MarshalIndent(shown, "", "  ")
	paid := &Paid{RequestSHA256: state.RequestSHA256, GenerationID: state.GenerationID, Amount: state.CreditsConsumed}
	if state.CreditsConsumed != nil {
		paid.Unit = spend.UnitOf(provider)
	}
	return string(response), paid
}
