package scenarioworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe-go/internal/cast"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/scenario"
)

// Локальная запись сценарного прохода (WorkflowState оригинала) хранится вне проекта, в каталоге
// состояния приложения: scenario-workflow/<sha256 пути проекта>.json. В ней утверждение пары
// (approval), утверждение сцен (scenesApproval), признак needsScenesReview и ожидающее
// предложение (pending: proposal, expectedHashes, scaffold, duration).
//
// Запись держится деревом jscompat и меняется на месте, как объект оригинала: порядок ключей
// (в том числе message, добавленного после status) и форма JSON совпадают с Electron-версией.
// Повреждённая или чужая по форме запись не даёт утверждения: читается как пустая
// {schemaVersion: 1}, проект при этом не меняется.

var sha256Text = regexp.MustCompile(`^[a-f0-9]{64}$`)

// proposalStatuses — допустимые status предложения.
var proposalStatuses = []string{"running", "ready", "invalid", "failed", "cancelled", "interrupted", "applied"}

// passes — сценарные проходы.
var passes = []string{"treatment", "scenes", "revise"}

// statePath — путь локальной записи проекта (project — реальный путь).
func statePath(localDir, project string) string {
	sum := sha256.Sum256([]byte(project))
	return filepath.Join(localDir, "scenario-workflow", hex.EncodeToString(sum[:])+".json")
}

// emptyState — {schemaVersion: 1}.
func emptyState() *jscompat.Object {
	state := jscompat.NewObject()
	state.Set("schemaVersion", 1.0)
	return state
}

// readState — read оригинала: проверенная запись или пустая при любой ошибке чтения и формы.
func readState(localDir, project string) *jscompat.Object {
	data, err := os.ReadFile(statePath(localDir, project))
	if err != nil {
		return emptyState()
	}
	value, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
	if err != nil {
		return emptyState()
	}
	if checkStoredState(value) != nil {
		return emptyState()
	}
	state, _ := jscompat.AsObject(value)
	return state
}

// writeState — write оригинала: JSON с отступом в два пробела и переводом строки, атомарная замена.
func writeState(localDir, project string, state *jscompat.Object) error {
	path := statePath(localDir, project)
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return err
	}
	return projectfs.WriteFile(path, []byte(jscompat.StringifyIndent(state, "  ")+"\n"), 0o666)
}

// validHashes — hashes() из checkStoredState: объект путь → SHA-256 или null; путь непустой,
// не абсолютный и без сегмента «..».
func validHashes(value any) bool {
	record, ok := jscompat.AsObject(value)
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
	record, ok := jscompat.AsObject(value)
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
	items, ok := jscompat.AsArray(value)
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

// checkStoredState — checkStoredState оригинала: форма локальной записи и снимков документов.
func checkStoredState(value any) error {
	state, ok := jscompat.AsObject(value)
	invalid := !ok || !jscompat.StrictEqual(state.Value("schemaVersion"), 1.0)
	if !invalid {
		if approval := state.Value("approval"); approval != jscompat.Undefined && !validHashes(approval) {
			invalid = true
		}
		if scenes := state.Value("scenesApproval"); scenes != jscompat.Undefined {
			record, isRecord := jscompat.AsObject(scenes)
			if !isRecord || !validHashes(record.Value("hashes")) {
				invalid = true
			} else if hash := record.Value("sceneHash"); hash != jscompat.Undefined && hash != nil {
				if text, isText := hash.(string); !isText || !sha256Text.MatchString(text) {
					invalid = true
				}
			}
		}
		if review := state.Value("needsScenesReview"); review != jscompat.Undefined {
			if _, isBool := review.(bool); !isBool {
				invalid = true
			}
		}
	}
	if invalid {
		return errors.New(textWorkflowInvalidState)
	}
	pendingValue := state.Value("pending")
	if pendingValue == jscompat.Undefined {
		return nil
	}
	stored, ok := jscompat.AsObject(pendingValue)
	if !ok || !validHashes(stored.Value("expectedHashes")) {
		return errors.New(textWorkflowInvalidProposal)
	}
	duration, isNumber := stored.Value("duration").(float64)
	if !isNumber || !jscompat.IsFinite(duration) || duration <= 0 || !jscompat.IsRecord(stored.Value("proposal")) {
		return errors.New(textWorkflowInvalidProposal)
	}
	if scaffold := stored.Value("scaffold"); scaffold != nil {
		if err := checkScenesShape(scaffold); err != nil {
			return err
		}
	}
	proposal, _ := jscompat.AsObject(stored.Value("proposal"))
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
		(message != jscompat.Undefined && !messageOK) {
		return errors.New(textWorkflowInvalidMetadata)
	}
	if err := checkDocuments(proposal.Value("before")); err != nil {
		return err
	}
	return checkDocuments(proposal.Value("after"))
}
