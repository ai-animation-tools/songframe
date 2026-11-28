package productionworkflow

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/filedigest"
	"songframe/internal/mediaapi"
	"songframe/internal/mediafile"
	"songframe/internal/mediaproviders"
	"songframe/internal/projectfs"
	"songframe/internal/providers"
)

// Видео по референсам — второй способ генерации попытки рядом с опорами (generation_method
// "references" в workflow.json). Опор Codex нет: запрос видео получает готовые картинки — кадр
// принятого предшественника для стыка, картинку места и изображения сущностей кастинга без
// сохранённого образа (герой, предмет), — а герои с образом идут образами, как в запросе по
// опорам. Картинка места обязательна: без неё модель придумает место сама и план выпадет из
// клипа; её роль несёт кадр «Начало» или картинка с ролью place. Режим
// провайдера объявляет адаптер (mediaapi.ReferenceRules); без него способ не предлагается.
//
// Способ выбирается у попытки до описания (StartInput.Method): описание без опор отличается от
// описания с опорами. Агент описания предлагает картинки с ролями, приложение копирует их в
// папку references/ попытки, пользователь утверждает, убирает или заменяет их своим файлом на
// шаге «Референсы». Видеопромпт ссылается на картинку меткой [#R01]: при сборке запроса метка
// становится обозначением провайдера (Mention) по месту картинки в запросе.

// methodReferences — значение generation_method попытки по референсам.
const methodReferences = "references"

// Роли референса: start — кадр принятого предшественника, с которого начинается план; place —
// картинка места: изображение сущности кастинга (с entity) или кадр принятого плана того же места
// (без entity), кадрирование которого план не повторяет; entity — изображение героя или предмета.
// Вид сущности кастинга — свободная строка, поэтому место отмечает роль, а не вид.
const (
	referenceStart  = "start"
	referencePlace  = "place"
	referenceEntity = "entity"
)

// referencesDir — папка копий референсов в попытке.
const referencesDir = "references"

// defaultReferenceLimit — предел картинок, если модель режима не объявила слотов.
const defaultReferenceLimit = 10

// referenceMark — метка картинки в видеопромпте: [#R01]; referenceMarkBroken — начало метки,
// записанной с ошибкой.
var (
	referenceMark       = regexp.MustCompile(`\[#(R\d{2})\]`)
	referenceMarkBroken = regexp.MustCompile(`\[\s*#`)
	referenceID         = regexp.MustCompile(`^R\d{2}$`)
)

// Тексты способа по референсам.
const (
	textReferencesUnavailable    = "Способ «По референсам» недоступен: провайдер видео проекта не делает видео по референсам."
	textReferencesPlanKind       = "Способ «По референсам» не подходит речевому плану, плану из опор и производному плану."
	textReferencesMethodFixed    = "Способ генерации выбирается до описания: в этой попытке его не сменить, начните новую попытку."
	textReferencesMethodInvalid  = "Неизвестный способ генерации попытки."
	textReferencesInvalid        = "Референсы описания: R01, R02… подряд, роль start, place или entity, путь изображения из allowedPaths; start — только первый, кадр принятого плана из continuityFrames, без entity; place — изображение сущности кастинга плана с её кодом или кадр принятого плана без entity; entity — код сущности кастинга плана."
	textReferencesPlace          = "Среди картинок нет места: нужен кадр «Начало» или картинка места (изображение локации из кастинга или кадр принятого плана того же места)."
	textReferencePlaceLast       = "Это единственная картинка места: без неё модель придумает место сама. Замените её своим файлом или кадром, а не убирайте."
	textReferencesCount          = "Описание по референсам должно предложить от одной картинки до предела модели."
	textReferencesDuplicate      = "Одна картинка предложена дважды."
	textReferencesNotMethod      = "Эта попытка делается по опорам: референсов у неё нет."
	textReferencesNotEditable    = "Референсы меняются после утверждения описания и до видеопромпта; дальше — доработка описания или новая попытка."
	textReferenceMissing         = "Референса нет в попытке."
	textReferenceLast            = "Последний референс не убрать: запросу нужна хотя бы одна картинка."
	textReferenceImageRequired   = "Референс — изображение PNG, JPEG или WebP."
	textReferencesNotApproved    = "Сначала утвердите референсы."
	textReferenceFileChanged     = "Файл референса изменён или удалён: замените его или доработайте описание."
	textReferencesManualNotAllow = "Попытка по референсам делается провайдером проекта: ручного пакета у неё нет."
	textReferencesKeyframes      = "У попытки по референсам нет опор: число опор не выбирается."
	textApproveReferencesFirst   = "сначала утвердите референсы"
	textReferencesOwnDescription = "Своё описание пишется с планом опор: картинки попытки по референсам предлагает агент описания."
)

func textReferenceMarkUnknown(code string, known []string) string {
	return "Метка [#" + code + "] в видеопромпте не называет референс попытки (есть: " + strings.Join(known, ", ") + ")."
}

func textReferenceMarkBroken(fragment string) string {
	return "Метка картинки в видеопромпте записана с ошибкой: «" + fragment + "». Пишите [#R01]."
}

// referenceItems — workflow.references как массив (нет или не массив — пусто).
func referenceItems(workflow *dynvalue.Object) []any {
	if workflow == nil {
		return nil
	}
	items, _ := dynvalue.AsArray(workflow.Value("references"))
	return items
}

// referencesApproved — у попытки есть референсы, все утверждены и их файлы совпадают с
// утверждёнными SHA-256.
func (c *Context) referencesApproved() (bool, error) {
	items := referenceItems(c.Workflow)
	if len(items) == 0 {
		return false, nil
	}
	for _, item := range items {
		if !dynvalue.Truthy(dynvalue.Get(item, "approved")) || !dynvalue.Truthy(dynvalue.Get(item, "path")) {
			return false, nil
		}
		full, err := packageFile(c, dynvalue.Get(item, "path"))
		if err != nil {
			return false, err
		}
		if !matchesDigest(full, dynvalue.Get(item, "sha256")) {
			return false, nil
		}
	}
	return true, nil
}

// referenceRules — режим по референсам провайдера видео проекта; nil — режима нет.
func (w *Workflow) referenceRules(c *Context) *mediaapi.ReferenceRules {
	provider, _ := c.Settings.Value("provider").(string)
	if !mediaproviders.Supports(provider, mediaproviders.Video) || w.options.VideoMedia == nil {
		return nil
	}
	media, ok := w.options.VideoMedia(provider)
	if !ok || media == nil || media.Paid.Rules.Video == nil {
		return nil
	}
	return media.Paid.Rules.Video.References
}

// referencesReason — почему плану c нельзя выбрать способ «По референсам»; "" — можно.
func (w *Workflow) referencesReason(c *Context) string {
	switch {
	case c.DerivedFrom != "" || c.StaticShot || c.Scene.Value("lipsync") == true:
		return textReferencesPlanKind
	case c.Manual && c.workflowValue("generation_method") != "manual" || w.referenceRules(c) == nil:
		return textReferencesUnavailable
	}
	return ""
}

// methodChoice — способ попытки, которую готовит запуск: новая попытка с описания берёт выбор
// запуска (method), остальные — способ своей попытки; явный другой выбор у них — ошибка.
// Повтор оплаченной попытки (новая папка по revise) наследует её способ.
func (w *Workflow) methodChoice(c *Context, input StartInput) (bool, error) {
	if input.Method != "" && input.Method != methodReferences && input.Method != "keyframes" {
		return false, errors.New(textReferencesMethodInvalid)
	}
	current := c.ReferencesMethod
	if input.Action == "prepare" {
		current = input.Method == methodReferences
	} else if input.Method != "" && (input.Method == methodReferences) != current {
		return false, errors.New(textReferencesMethodFixed)
	}
	if current {
		if reason := w.referencesReason(c); reason != "" {
			return false, errors.New(reason)
		}
	}
	return current, nil
}

// referenceLimit — сколько картинок принимает первая модель режима по её слотам в объявлениях
// команды режима (reports); без объявления — defaultReferenceLimit.
func referenceLimit(rules *mediaapi.ReferenceRules, reports []providers.CatalogReport) int {
	if rules == nil {
		return 0
	}
	for _, report := range reports {
		if report.Command != rules.Command || report.Models == nil {
			continue
		}
		for _, id := range rules.Models {
			slots, _ := dynvalue.Get(report.Models.Value(id), "slots").(*dynvalue.Object)
			count := 0
			for slots != nil && slots.Has(rules.ImageSlot(count)) {
				count++
			}
			if count > 0 {
				return count
			}
		}
	}
	return defaultReferenceLimit
}

// parseReferences — описание по референсам: description, requestSeconds по правилу длительности и
// список картинок R01… подряд. Картинка — путь изображения из allowedPaths; роль start — первая
// картинка, кадр принятого плана из continuityFrames, без сущности; роль place — изображение
// сущности кастинга плана с её кодом или кадр принятого плана без кода; роль entity — изображение
// сущности кастинга плана (код из rules.ReferenceEntities). Одна картинка не повторяется; среди
// картинок есть место (start или place).
func parseReferences(value *dynvalue.Object, rules Rules) error {
	if err := keys(value, "schemaVersion", "stage", "description", "requestSeconds", "references"); err != nil {
		return err
	}
	seconds, isNumber := value.Value("requestSeconds").(float64)
	items, isArray := dynvalue.AsArray(value.Value("references"))
	if !isText(value.Value("description")) || !isNumber || !isArray {
		return errors.New(textDescriptionInvalid)
	}
	limit := rules.MaxReferences
	if limit <= 0 {
		limit = defaultReferenceLimit
	}
	if len(items) < 1 || len(items) > limit {
		return errors.New(textReferencesCount)
	}
	if err := CheckDuration(seconds, rules.WindowSeconds, rules.DurationRule); err != nil {
		return err
	}
	seen := map[string]bool{}
	place := false
	for index, item := range items {
		reference, isObject := item.(*dynvalue.Object)
		if !isObject {
			return errors.New(textReferencesInvalid)
		}
		if err := keys(reference, "id", "role", "entity", "path"); err != nil {
			return err
		}
		path, _ := reference.Value("path").(string)
		entity, hasEntity := reference.Value("entity").(string)
		valid := reference.Value("id") == "R"+twoDigits(index+1) && isText(path) && imagePath.MatchString(path) && slices.Contains(rules.AllowedPaths, path)
		switch reference.Value("role") {
		case referenceStart:
			valid = valid && index == 0 && !reference.Has("entity") && isShotFramePath(path)
		case referencePlace:
			valid = valid && (hasEntity && slices.Contains(rules.ReferenceEntities, entity) || !reference.Has("entity") && isShotFramePath(path))
		case referenceEntity:
			valid = valid && hasEntity && slices.Contains(rules.ReferenceEntities, entity)
		default:
			valid = false
		}
		if !valid {
			return errors.New(textReferencesInvalid)
		}
		if seen[path] {
			return errors.New(textReferencesDuplicate)
		}
		seen[path] = true
		place = place || isPlaceReference(reference)
	}
	if !place {
		return errors.New(textReferencesPlace)
	}
	return nil
}

// isPlaceReference — картинка задаёт место плана: кадр «Начало» или роль place.
func isPlaceReference(item any) bool {
	role := dynvalue.Get(item, "role")
	return role == referenceStart || role == referencePlace
}

// imageExtension — расширение по содержимому изображения: png, jpg или webp; "" — не изображение.
func imageExtension(data []byte) string {
	switch {
	case bytes.HasPrefix(data, pngSignature):
		return "png"
	case len(data) >= 3 && data[0] == 255 && data[1] == 216 && data[2] == 255:
		return "jpg"
	case len(data) >= 12 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		return "webp"
	}
	return ""
}

// placeReference — копия картинки source (полный путь) в references/<id>.<расширение> попытки
// target: прежние копии того же ID с другим расширением убираются. Возвращает путь от попытки и
// SHA-256 копии.
func placeReference(target, id, source string) (string, string, error) {
	data, err := os.ReadFile(source)
	if err != nil {
		return "", "", dynvalue.FsError("open", source, err)
	}
	extension := imageExtension(data)
	if extension == "" {
		return "", "", errors.New(textReferenceImageRequired)
	}
	name := id + "." + extension
	for _, other := range []string{"png", "jpg", "webp"} {
		if other != extension {
			if err := removePackageFile(filepath.Join(target, referencesDir, id+"."+other)); err != nil {
				return "", "", err
			}
		}
	}
	full := filepath.Join(target, referencesDir, name)
	if current, err := os.ReadFile(full); err != nil || !bytes.Equal(current, data) {
		if err := projectfs.WriteFile(full, data, 0); err != nil {
			return "", "", err
		}
	}
	digest, ok := filedigest.File(full)
	if !ok {
		return "", "", errors.New(textReferenceImageRequired)
	}
	return referencesDir + "/" + name, digest, nil
}

// referencesTree — workflow.references по предложенным картинкам: копии в попытке target, роль,
// сущность и исходный путь от проекта. Картинка с тем же ID, ролью, сущностью и байтами, что
// утверждённая прежде, остаётся утверждённой (доработка описания той же попытки).
func referencesTree(project, target string, proposed []any, previous []any) (*dynvalue.Array, error) {
	result := &dynvalue.Array{Items: []any{}}
	for _, item := range proposed {
		id := dynvalue.ToString(dynvalue.Get(item, "id"))
		source := dynvalue.ToString(dynvalue.Get(item, "path"))
		full, err := ProductionPath(project, filepath.Join(project, filepath.FromSlash(source)))
		if err != nil {
			return nil, err
		}
		path, digest, err := placeReference(target, id, full)
		if err != nil {
			return nil, err
		}
		entry := dynvalue.NewObject()
		entry.Set("id", id)
		entry.Set("role", dynvalue.Get(item, "role"))
		if entity, ok := dynvalue.Get(item, "entity").(string); ok {
			entry.Set("entity", entity)
		} else {
			entry.Set("entity", nil)
		}
		entry.Set("source", source)
		entry.Set("path", path)
		entry.Set("sha256", digest)
		old := findByID(previous, id)
		entry.Set("approved", dynvalue.Truthy(dynvalue.Get(old, "approved")) && dynvalue.Get(old, "sha256") == digest &&
			dynvalue.Get(old, "role") == entry.Value("role") && dynvalue.StrictEqual(dynvalue.Get(old, "entity"), entry.Value("entity")))
		result.Items = append(result.Items, entry)
	}
	return result, nil
}

// referenceShotFrames — пути кадров других планов среди предложенных картинок: их нужно
// извлечь в continuity/ попытки до копирования.
func referenceShotFrames(proposed []any) []any {
	frames := []any{}
	for _, item := range proposed {
		if path, _ := dynvalue.Get(item, "path").(string); isShotFramePath(path) {
			frame := dynvalue.NewObject()
			frame.Set("referencePaths", &dynvalue.Array{Items: []any{dynvalue.Get(item, "path")}})
			frames = append(frames, frame)
		}
	}
	return frames
}

// referencesEditReason — почему референсы попытки c сейчас не меняются; "" — можно: способ по
// референсам, описание утверждено, вопроса и предложения нет, видеопромпт ещё не предложен и
// попытка не отправлялась.
func referencesEditReason(c *Context, busy, proposalPending bool) string {
	stage, _ := c.workflowValue("stage").(string)
	switch {
	case !c.ReferencesMethod:
		return textReferencesNotMethod
	case c.DerivedFrom != "":
		return derivedshot.Reason(c.DerivedFrom)
	case busy:
		return textOperationBusy
	case proposalPending:
		return textResolveProposalFirst
	case dynvalue.Truthy(c.workflowValue("pending_decision")):
		return textResolvePackageQuestionFirst
	case c.Paid || c.SceneChanged || c.workflowValue("description_approved") != true || stage != "description_review" ||
		dynvalue.Truthy(c.workflowValue("request_dir")) || dynvalue.Truthy(dynvalue.Get(c.workflowValue("prompt"), "approved")):
		return textReferencesNotEditable
	}
	return ""
}

// editReferences — общий порядок действий с референсами: проверка под мьютексом, правка списка
// change и запись workflow.json. Утверждения промпта нет (правка до видеопромпта), поэтому
// сбрасывать нечего.
func (w *Workflow) editReferences(project, shot, packageDir string, change func(c *Context, items []any) ([]any, error)) (View, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	view, err := w.view(project, shot, packageDir)
	if err != nil {
		return View{}, err
	}
	if view.PackageDir == nil {
		return View{}, errors.New(textPackageUnavailable)
	}
	c, err := ReadContext(view.Project, shot, *view.PackageDir)
	if err != nil {
		return View{}, err
	}
	if reason := referencesEditReason(c, view.Busy, w.store.Read(c.Project, shot).active()); reason != "" {
		return View{}, errors.New(reason)
	}
	items, err := change(c, slices.Clone(referenceItems(c.Workflow)))
	if err != nil {
		return View{}, err
	}
	workflow, err := packageDocument(c.PackageDir, textWorkflowMissing)
	if err != nil {
		return View{}, err
	}
	workflow.Set("references", &dynvalue.Array{Items: items})
	if err := writeProjectJSON(filepath.Join(c.PackageDir, "workflow.json"), workflow); err != nil {
		return View{}, err
	}
	return w.view(c.Project, shot, c.PackageDir)
}

// ApproveReferences — productionWorkflow.approveReferences: утвердить все референсы попытки. Файл
// каждого должен быть на месте; SHA-256 утверждения — текущий файл.
func (w *Workflow) ApproveReferences(project, shot, packageDir string) (View, error) {
	return w.editReferences(project, shot, packageDir, func(c *Context, items []any) ([]any, error) {
		for _, item := range items {
			entry, ok := item.(*dynvalue.Object)
			if !ok {
				return nil, errors.New(textReferencesInvalid)
			}
			full, err := packageFile(c, entry.Value("path"))
			if err != nil {
				return nil, err
			}
			digest, found := filedigest.File(full)
			if !found {
				return nil, errors.New(textReferenceFileChanged)
			}
			entry.Set("sha256", digest)
			entry.Set("approved", true)
		}
		return items, nil
	})
}

// RemoveReference — productionWorkflow.removeReference: убрать референс id из запроса попытки.
// Файл копии остаётся в папке попытки; ID остальных не меняются. Последний и единственная
// картинка места не убираются.
func (w *Workflow) RemoveReference(project, shot, packageDir, id string) (View, error) {
	return w.editReferences(project, shot, packageDir, func(_ *Context, items []any) ([]any, error) {
		index := slices.IndexFunc(items, func(item any) bool { return dynvalue.Get(item, "id") == id })
		if index < 0 {
			return nil, errors.New(textReferenceMissing)
		}
		if len(items) == 1 {
			return nil, errors.New(textReferenceLast)
		}
		rest := slices.Delete(slices.Clone(items), index, index+1)
		if isPlaceReference(items[index]) && !slices.ContainsFunc(rest, isPlaceReference) {
			return nil, errors.New(textReferencePlaceLast)
		}
		return rest, nil
	})
}

// ReplaceReference — productionWorkflow.replaceReference: картинка референса id — свой файл path
// (абсолютный путь: файл пользователя или взятый кадр принятого плана). Выбранный пользователем
// файл сразу утверждён; исходный путь сохраняется, только если файл внутри проекта.
func (w *Workflow) ReplaceReference(project, shot, packageDir, id, path string) (View, error) {
	return w.editReferences(project, shot, packageDir, func(c *Context, items []any) ([]any, error) {
		index := slices.IndexFunc(items, func(item any) bool { return dynvalue.Get(item, "id") == id })
		if index < 0 {
			return nil, errors.New(textReferenceMissing)
		}
		entry, ok := items[index].(*dynvalue.Object)
		if !ok || !referenceID.MatchString(id) || !dynvalue.IsAbs(path) {
			return nil, errors.New(textReferenceImageRequired)
		}
		real, err := dynvalue.Realpath(path)
		if err != nil {
			return nil, err
		}
		if info, err := os.Stat(real); err != nil || !info.Mode().IsRegular() {
			return nil, errors.New(textReferenceImageRequired)
		}
		file, digest, err := placeReference(c.PackageDir, id, real)
		if err != nil {
			return nil, err
		}
		entry.Set("path", file)
		entry.Set("sha256", digest)
		entry.Set("approved", true)
		if inside, err := filepath.Rel(c.Project, real); err == nil && !strings.HasPrefix(inside, "..") && !filepath.IsAbs(inside) {
			entry.Set("source", filepath.ToSlash(inside))
		} else {
			entry.Delete("source")
		}
		return items, nil
	})
}

// referenceMarks — ID картинок, на которые ссылается видеопромпт, по порядку первого упоминания.
func referenceMarks(prompt string) []string {
	codes := []string{}
	for _, match := range referenceMark.FindAllStringSubmatch(prompt, -1) {
		if !slices.Contains(codes, match[1]) {
			codes = append(codes, match[1])
		}
	}
	return codes
}

// brokenReferenceMark — фрагмент метки картинки, записанной с ошибкой; "" — ошибок нет.
func brokenReferenceMark(prompt string) string {
	stripped := referenceMark.ReplaceAllString(prompt, "")
	location := referenceMarkBroken.FindStringIndex(stripped)
	if location == nil {
		return ""
	}
	end := min(len(stripped), location[0]+12)
	if close := strings.IndexByte(stripped[location[0]:], ']'); close >= 0 && location[0]+close+1 < end {
		end = location[0] + close + 1
	}
	return stripped[location[0]:end]
}

// checkReferenceMarks — метки картинок видеопромпта называют референсы попытки: опечатка и
// чужой ID — ошибка с перечнем ID.
func checkReferenceMarks(c *Context, prompt string) error {
	if fragment := brokenReferenceMark(prompt); fragment != "" {
		return errors.New(textReferenceMarkBroken(fragment))
	}
	known := []string{}
	for _, item := range referenceItems(c.Workflow) {
		known = append(known, dynvalue.ToString(dynvalue.Get(item, "id")))
	}
	for _, code := range referenceMarks(prompt) {
		if !slices.Contains(known, code) {
			return errors.New(textReferenceMarkUnknown(code, known))
		}
	}
	return nil
}

// replaceReferenceMarks — метки картинок становятся обозначением провайдера по месту картинки в
// запросе (order — ID картинок по порядку слотов).
func replaceReferenceMarks(prompt string, order []string, mention func(index int) string) string {
	return referenceMark.ReplaceAllStringFunc(prompt, func(mark string) string {
		id := referenceMark.FindStringSubmatch(mark)[1]
		if index := slices.Index(order, id); index >= 0 {
			return mention(index)
		}
		return mark
	})
}

// referenceLabel — подпись референса во входах запроса: «Начало», «Место» (у изображения
// сущности — «Место: имя») или имя сущности кастинга.
func referenceLabel(c *Context, item any) string {
	role := dynvalue.Get(item, "role")
	if role == referenceStart {
		return roleStartReference
	}
	code := dynvalue.ToString(dynvalue.Get(item, "entity"))
	name := code
	for _, entity := range shotEntities(c) {
		if entity.Code == code {
			name = entity.Name
		}
	}
	if role == referencePlace {
		if code == "" {
			return rolePlaceReference
		}
		return rolePlaceReference + ": " + name
	}
	return name
}

// referenceEntityCodes — коды сущностей кастинга плана, чьи изображения могут стать референсами.
func referenceEntityCodes(c *Context) []string {
	codes := []string{}
	for _, entity := range shotEntities(c) {
		codes = append(codes, entity.Code)
	}
	return codes
}

// referenceAttachments — утверждённые референсы для задания видеопромпта: вложения (уменьшенные
// JPEG, как опоры) и ключ attachedReferences {id, role, entity, name, path, attached}. Папку
// вложений directory готовит promptAttachments (dirErr — её ошибка): attachmentsDir очищает
// папку, поэтому второй её вызов удалил бы уже записанные кадры задания.
func referenceAttachments(c *Context, directory string, dirErr error) ([]string, *dynvalue.Array) {
	images := []string{}
	attached := &dynvalue.Array{Items: []any{}}
	for _, item := range referenceItems(c.Workflow) {
		if !dynvalue.Truthy(dynvalue.Get(item, "approved")) {
			continue
		}
		source, err := packageFile(c, dynvalue.Get(item, "path"))
		if err != nil {
			continue
		}
		entry := dynvalue.NewObject()
		entry.Set("id", dynvalue.Get(item, "id"))
		entry.Set("role", dynvalue.Get(item, "role"))
		entry.Set("entity", orNull(dynvalue.Get(item, "entity")))
		entry.Set("name", referenceLabel(c, item))
		entry.Set("path", rel(c.Project, source))
		ok := false
		if dirErr == nil {
			target := filepath.Join(directory, "reference-"+dynvalue.ToString(dynvalue.Get(item, "id"))+".jpg")
			data, err := mediafile.ShrinkJPEG(source, promptFrameSide, promptFrameQuality)
			if err == nil {
				err = os.WriteFile(target, data, 0o666)
			}
			if err == nil {
				images = append(images, target)
				ok = true
			}
		}
		entry.Set("attached", ok)
		attached.Items = append(attached.Items, entry)
	}
	return images, attached
}
