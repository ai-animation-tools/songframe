package productionworkflow

import (
	"os"
	"path/filepath"
	"slices"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// Statuses — допустимые статусы записанного предложения (ProductionProposal.status):
// cancelled — пользователь остановил задание, interrupted — задание оборвалось или предложение
// отклонено, applied — предложение применено к пакету.
var Statuses = []string{"running", "ready", "invalid", "failed", "cancelled", "interrupted", "applied"}

// StoreFolder — каталог записей предложений внутри каталога состояния приложения.
const StoreFolder = "production-workflow"

// Stored — локальная запись предложения одного плана в представлении
// jscompat: { proposal, packageDir, target, hashes, rules, capabilities?, imageJob?, imageHashes? }.
// Дерево сохраняет порядок ключей, поэтому запись после изменения статуса пишется тем же
// JSON, что зафиксирован эталоном. Владелец — Workflow; Apply, восстановление после перезапуска
// и опоры читают и дополняют её через эти методы.
type Stored struct {
	Tree *jscompat.Object
}

// Proposal — объект proposal записи (ProductionProposal): id, jobId, stage, status, stale,
// before, after и необязательные message, agentText, refused.
func (s *Stored) Proposal() *jscompat.Object {
	proposal, _ := s.Tree.Value("proposal").(*jscompat.Object)
	return proposal
}

// ID — proposal.id.
func (s *Stored) ID() string { value, _ := s.Proposal().Value("id").(string); return value }

// JobID — proposal.jobId: задание агента ("" — предложение без задания, импорт опор).
func (s *Stored) JobID() string { value, _ := s.Proposal().Value("jobId").(string); return value }

// Stage — proposal.stage: description, frames, prompt или request.
func (s *Stored) Stage() string { value, _ := s.Proposal().Value("stage").(string); return value }

// Status — proposal.status.
func (s *Stored) Status() string { return jscompat.ToString(s.Proposal().Value("status")) }

// PackageDir — packageDir записи: пакет, из которого готовилось предложение; "" — null, новая
// подготовка без пакета.
func (s *Stored) PackageDir() string { value, _ := s.Tree.Value("packageDir").(string); return value }

// Target — target записи: пакет, в который Apply запишет результат (новый attempt-NN или тот же).
func (s *Stored) Target() string { value, _ := s.Tree.Value("target").(string); return value }

// Hashes — снимок входов на момент подготовки (см. Snapshot).
func (s *Stored) Hashes() *jscompat.Object {
	hashes, _ := s.Tree.Value("hashes").(*jscompat.Object)
	return hashes
}

// Rules — правила проверки ответа (ProposalRules), записанные при подготовке.
func (s *Stored) Rules() Rules { return RulesFromTree(s.Tree.Value("rules")) }

// Capabilities — объявления моделей провайдера видео на момент подготовки (Undefined — нет).
func (s *Stored) Capabilities() any { return s.Tree.Value("capabilities") }

// ImageJob — предложение опор, созданных заданием провайдера-агента.
func (s *Stored) ImageJob() bool { return s.Tree.Value("imageJob") == true }

// ImageHashes — SHA-256 изображений готового предложения опор по абсолютным путям; nil — нет.
func (s *Stored) ImageHashes() *jscompat.Object {
	hashes, _ := s.Tree.Value("imageHashes").(*jscompat.Object)
	return hashes
}

// active — предложение ещё ждёт решения: готовится или готово к применению.
func (s *Stored) active() bool {
	return s != nil && (s.Status() == "running" || s.Status() == "ready")
}

// CheckStored проверяет запись проекта project: известный статус и пути
// пакетов внутри проекта. nil — форма записи не та (её не показывают); ошибка — пакет записи вне
// plan/batches|awaiting. project — реальный путь проекта.
func CheckStored(project string, value any) (*Stored, error) {
	tree, ok := value.(*jscompat.Object)
	if !ok {
		return nil, nil
	}
	proposal, proposalOK := tree.Value("proposal").(*jscompat.Object)
	_, hashesOK := tree.Value("hashes").(*jscompat.Object)
	rules, rulesOK := tree.Value("rules").(*jscompat.Object)
	target, targetOK := tree.Value("target").(string)
	packageDir := tree.Value("packageDir")
	_, packageOK := packageDir.(string)
	if !proposalOK || !hashesOK || !rulesOK || !targetOK || (packageDir != nil && !packageOK) ||
		rules.Value("project") != project {
		return nil, nil
	}
	if _, isString := proposal.Value("id").(string); !isString || !slices.Contains(Statuses, jscompat.ToString(proposal.Value("status"))) {
		return nil, nil
	}
	if _, err := PackagePath(project, target); err != nil {
		return nil, err
	}
	if packageOK {
		if _, err := PackagePath(project, packageDir.(string)); err != nil {
			return nil, err
		}
	}
	return &Stored{Tree: tree}, nil
}

// Store — записи предложений в каталоге состояния: <LocalDir>/production-workflow/<SHA-256
// «проект\0план»>.json. Запись принадлежит паре проект/план, поэтому один план держит не больше
// одного непринятого предложения. Методы не синхронизированы: их вызывает Workflow под своим
// мьютексом.
type Store struct {
	LocalDir string
}

// Folder — каталог записей.
func (s Store) Folder() string { return filepath.Join(s.LocalDir, StoreFolder) }

// FileName — имя записи плана shot проекта project (реальный путь).
func FileName(project, shot string) string {
	return digestHex([]byte(project+"\x00"+shot)) + ".json"
}

// Path — путь записи плана.
func (s Store) Path(project, shot string) string {
	return filepath.Join(s.Folder(), FileName(project, shot))
}

// Read возвращает проверенную запись плана или nil (нет файла, повреждена, чужая,
// отклонена, пакет вне проекта).
func (s Store) Read(project, shot string) *Stored {
	value, err := readJSON(s.Path(project, shot))
	if err != nil {
		return nil
	}
	stored, err := CheckStored(project, value)
	if err != nil {
		return nil
	}
	return stored
}

// Write — writeProductionJson: атомарная запись `JSON.stringify(value, null, 2) + '\n'`.
func (s Store) Write(project, shot string, stored *Stored) error {
	return writeJSON(s.Path(project, shot), stored.Tree)
}

// WriteDiscarded заменяет запись отметкой { schemaVersion: 1, discarded: id }: отклонённое
// предложение больше не читается, а история самого задания агента сохраняется.
func (s Store) WriteDiscarded(project, shot, id string) error {
	marker := jscompat.NewObject()
	marker.Set("schemaVersion", float64(1))
	marker.Set("discarded", id)
	return writeJSON(s.Path(project, shot), marker)
}

// writeJSON — writeProjectJSON для любого дерева jscompat.
func writeJSON(path string, value any) error {
	return projectfs.WriteFile(path, []byte(jscompat.StringifyIndent(value, "  ")+"\n"), 0)
}

// readJSON — null (nil) при отсутствии файла; ошибка чтения или разбора возвращается.
func readJSON(path string) (any, error) {
	if !jscompat.Exists(path) {
		return nil, nil
	}
	if err := jscompat.ReadFileCheck(path); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, jscompat.FsError("open", path, err)
	}
	return jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
}
