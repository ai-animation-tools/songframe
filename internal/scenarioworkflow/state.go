package scenarioworkflow

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe/internal/cast"
	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/scenario"
)

// Запись сценарного прохода — файл проекта StatePath. В ней утверждение пары (approval),
// утверждение сцен (scenesApproval) и признак needsScenesReview с видами изменившихся входов
// reviewInputs. Пути в отпечатках отсчитываются от проекта, поэтому запись переезжает вместе с
// клипом: копия папки, `git pull` на другом компьютере и откат через Git видят те же утверждения,
// что и файлы. Сама запись в отпечатки и снимки предложений не входит.
//
// Ожидающее предложение (pending: proposal, expectedHashes, scaffold, duration и необязательный
// checkIssue — проблема проверки, из которой запущена доработка) — временное состояние до
// «Применить» или «Отклонить» с полными снимками сценария и кастинга. Оно лежит отдельно, в
// PendingPath среди записей предложений производства, вне Git (plan/batches/* в .gitignore
// шаблона): непринятый ответ агента не меняет отслеживаемых файлов и не попадает в коммиты. В
// памяти обе части держатся одним деревом с ключом pending; разделяют их readState и writeState.
//
// Запись держится деревом dynvalue и меняется на месте: порядок ключей (в том числе message,
// добавленного после status) и форма JSON зафиксированы эталоном testdata/golden/scenario-workflow.
// Повреждённая или чужая по форме запись не даёт утверждения: читается как пустая
// {schemaVersion: 1}, проект при этом не меняется. Повреждённое предложение читается как его
// отсутствие и утверждений не снимает.

var sha256Text = regexp.MustCompile(`^[a-f0-9]{64}$`)

// proposalStatuses — допустимые status предложения.
var proposalStatuses = []string{"running", "ready", "invalid", "failed", "cancelled", "interrupted", "applied"}

// passes — сценарные проходы.
var passes = []string{"treatment", "scenes", "revise"}

// StatePath — запись сценарного прохода относительно папки проекта.
const StatePath = "plan/scenario-workflow.json"

// PendingPath — ожидающее предложение сценарного прохода относительно папки проекта: рядом с
// записями предложений производства (sceneregistry.ProposalsDir), вне Git.
const PendingPath = "plan/batches/proposals/scenario.json"

// pendingPath — путь ожидающего предложения проекта (project — реальный путь).
func pendingPath(project string) string {
	return filepath.Join(project, filepath.FromSlash(PendingPath))
}

// statePath — путь записи проекта (project — реальный путь).
func statePath(project string) string {
	return filepath.Join(project, filepath.FromSlash(StatePath))
}

// emptyState — {schemaVersion: 1}.
func emptyState() *dynvalue.Object {
	state := dynvalue.NewObject()
	state.Set("schemaVersion", 1.0)
	return state
}

// readState — проверенная запись с ожидающим предложением под ключом pending. Ошибка чтения или
// формы записи даёт пустую запись, ошибка предложения — запись без него.
func readState(project string) *dynvalue.Object {
	state := emptyState()
	if value, ok := readJSONFile(statePath(project)); ok {
		if record, isRecord := dynvalue.AsObject(value); isRecord {
			record.Delete("pending")
			if checkStoredState(record) == nil {
				state = record
			}
		}
	}
	if pending, ok := readJSONFile(pendingPath(project)); ok {
		state.Set("pending", pending)
		if checkStoredState(state) != nil {
			state.Delete("pending")
		}
	}
	return state
}

// readJSONFile — разобранный JSON файла; false — нет файла или он не JSON.
func readJSONFile(path string) (any, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	return value, err == nil
}

// writeState — запись без pending в StatePath и предложение в PendingPath (без предложения файл
// удаляется). JSON с отступом в два пробела и переводом строки, атомарная замена; папка plan/ у
// проекта уже есть, папку предложений создаёт projectfs.WriteFile. Оба файла лежат в проекте, поэтому запись проходит
// шлюз projectfs.CheckWrite, как и остальные файлы: поверх незавершённой многофайловой операции она
// не пишется. Предложение пишется первым: запись утверждений меняется последней.
func writeState(project string, state *dynvalue.Object) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	record := dynvalue.NewObject()
	for _, key := range state.Keys() {
		if key != "pending" {
			record.Set(key, state.Value(key))
		}
	}
	if pending := state.Value("pending"); pending != dynvalue.Undefined {
		if err := projectfs.WriteFile(pendingPath(project), []byte(dynvalue.StringifyIndent(pending, "  ")+"\n"), 0o666); err != nil {
			return err
		}
	} else if err := os.Remove(pendingPath(project)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return projectfs.WriteFile(statePath(project), []byte(dynvalue.StringifyIndent(record, "  ")+"\n"), 0o666)
}

// validHashes — hashes() из checkStoredState: объект путь → SHA-256 или null; путь непустой,
// не абсолютный и без сегмента «..».
func validHashes(value any) bool {
	record, ok := dynvalue.AsObject(value)
	if !ok {
		return false
	}
	for _, path := range record.Keys() {
		if path == "" || strings.HasPrefix(path, "/") || slices.Contains(strings.Split(path, "/"), "..") {
			return false
		}
		hash := record.Value(path)
		if text, isText := hash.(string); hash != nil && (!isText || !sha256Text.MatchString(text)) {
			return false
		}
	}
	return true
}

// checkDocuments — documents() из checkStoredState: снимок документов проходит те же
// нормализаторы, что и чтение проекта (части — черновиком, см. readDocuments).
func checkDocuments(value any) error {
	record, ok := dynvalue.AsObject(value)
	if !ok {
		return errors.New(textSnapshotInvalidDocuments)
	}
	if document := record.Value("cast"); document != nil {
		if _, err := cast.Normalize(document, cast.LoadDefaults()); err != nil {
			return err
		}
	}
	if document := record.Value("treatment"); document != nil {
		if _, err := scenario.NormalizeTreatmentDraft(document); err != nil {
			return err
		}
	}
	if document := record.Value("scenes"); document != nil {
		if err := checkScenesShape(document); err != nil {
			return err
		}
	}
	return nil
}

// stringsArray — массив строк.
func stringsArray(value any) bool {
	items, ok := dynvalue.AsArray(value)
	if !ok {
		return false
	}
	for _, item := range items {
		if !isString(item) {
			return false
		}
	}
	return true
}

// checkStoredState — проверка формы записи прохода и снимков документов.
func checkStoredState(value any) error {
	state, ok := dynvalue.AsObject(value)
	invalid := !ok || !dynvalue.StrictEqual(state.Value("schemaVersion"), 1.0)
	if !invalid {
		if approval := state.Value("approval"); approval != dynvalue.Undefined && !validHashes(approval) {
			invalid = true
		}
		if scenes := state.Value("scenesApproval"); scenes != dynvalue.Undefined {
			record, isRecord := dynvalue.AsObject(scenes)
			if !isRecord || !validHashes(record.Value("hashes")) {
				invalid = true
			} else if hash := record.Value("sceneHash"); hash != dynvalue.Undefined && hash != nil {
				if text, isText := hash.(string); !isText || !sha256Text.MatchString(text) {
					invalid = true
				}
			}
		}
		if review := state.Value("needsScenesReview"); review != dynvalue.Undefined {
			if _, isBool := review.(bool); !isBool {
				invalid = true
			}
		}
		if reasons := state.Value("reviewInputs"); reasons != dynvalue.Undefined && !stringsArray(reasons) {
			invalid = true
		}
	}
	if invalid {
		return errors.New(textWorkflowInvalidState)
	}
	pendingValue := state.Value("pending")
	if pendingValue == dynvalue.Undefined {
		return nil
	}
	stored, ok := dynvalue.AsObject(pendingValue)
	if !ok || !validHashes(stored.Value("expectedHashes")) {
		return errors.New(textWorkflowInvalidProposal)
	}
	duration, isNumber := stored.Value("duration").(float64)
	if !isNumber || !dynvalue.IsFinite(duration) || duration <= 0 || !dynvalue.IsRecord(stored.Value("proposal")) {
		return errors.New(textWorkflowInvalidProposal)
	}
	if scaffold := stored.Value("scaffold"); scaffold != nil {
		if err := checkScenesShape(scaffold); err != nil {
			return err
		}
	}
	proposal, _ := dynvalue.AsObject(stored.Value("proposal"))
	text := func(key string) (string, bool) {
		value, ok := proposal.Value(key).(string)
		return value, ok
	}
	id, idOK := text("id")
	jobID, jobOK := text("jobId")
	pass, passOK := text("pass")
	status, statusOK := text("status")
	_, staleOK := proposal.Value("stale").(bool)
	message := proposal.Value("message")
	_, messageOK := message.(string)
	if !idOK || id == "" || !jobOK || jobID == "" || !passOK || !slices.Contains(passes, pass) || !statusOK ||
		!slices.Contains(proposalStatuses, status) || !stringsArray(proposal.Value("selectedIds")) ||
		!stringsArray(proposal.Value("warnings")) || !stringsArray(proposal.Value("changedIds")) || !staleOK ||
		(message != dynvalue.Undefined && !messageOK) {
		return errors.New(textWorkflowInvalidMetadata)
	}
	if err := checkDocuments(proposal.Value("before")); err != nil {
		return err
	}
	return checkDocuments(proposal.Value("after"))
}
