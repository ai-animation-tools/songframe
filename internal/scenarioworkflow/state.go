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
// утверждение сцен (scenesApproval), признак needsScenesReview с видами изменившихся входов
// reviewInputs и ожидающее предложение (pending: proposal, expectedHashes, scaffold, duration).
// Пути в отпечатках отсчитываются от проекта, поэтому запись переезжает вместе с клипом: копия
// папки, `git pull` на другом компьютере и откат через Git видят те же утверждения, что и файлы.
// Сама запись в отпечатки и снимки предложений не входит.
//
// Запись держится деревом dynvalue и меняется на месте: порядок ключей (в том числе message,
// добавленного после status) и форма JSON зафиксированы эталоном testdata/golden/scenario-workflow.
// Повреждённая или чужая по форме запись не даёт утверждения: читается как пустая
// {schemaVersion: 1}, проект при этом не меняется.

var sha256Text = regexp.MustCompile(`^[a-f0-9]{64}$`)

// proposalStatuses — допустимые status предложения.
var proposalStatuses = []string{"running", "ready", "invalid", "failed", "cancelled", "interrupted", "applied"}

// passes — сценарные проходы.
var passes = []string{"treatment", "scenes", "revise"}

// StatePath — запись сценарного прохода относительно папки проекта.
const StatePath = "plan/scenario-workflow.json"

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

// readState — проверенная запись или пустая при любой ошибке чтения и формы.
func readState(project string) *dynvalue.Object {
	data, err := os.ReadFile(statePath(project))
	if err != nil {
		return emptyState()
	}
	value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	if err != nil {
		return emptyState()
	}
	if checkStoredState(value) != nil {
		return emptyState()
	}
	state, _ := dynvalue.AsObject(value)
	return state
}

// writeState — JSON с отступом в два пробела и переводом строки, атомарная замена; папка plan/
// у проекта уже есть. Запись лежит в проекте, поэтому проходит шлюз записи projectfs.CheckWrite,
// как и остальные файлы: поверх незавершённой многофайловой операции она не пишется.
func writeState(project string, state *dynvalue.Object) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return projectfs.WriteFile(statePath(project), []byte(dynvalue.StringifyIndent(state, "  ")+"\n"), 0o666)
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
// нормализаторы, что и чтение проекта (трактовка — черновиком, см. readDocuments).
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
