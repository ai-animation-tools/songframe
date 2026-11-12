package production

import (
	"fmt"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/spend"
)

// SpendFor — расход плана shot по журналу plan/spend.json и живым попыткам. Принятый результат —
// по комплекту assets/shots/Mxx: номер генерации и SHA запроса из снимка generation-request.json,
// длина материала — кадры accepted_edit на его fps. Только чтение.
func SpendFor(project, shot string) (spend.Summary, error) {
	if !acceptedShotID.MatchString(shot) {
		return spend.Summary{}, fmt.Errorf("неверный код плана: %q", shot)
	}
	entries, err := spend.Entries(project)
	if err != nil {
		return spend.Summary{}, err
	}
	return spend.Summarize(entries, shot, acceptedResult(project, shot)), nil
}

// acceptedResult — принятый результат плана для сводки расхода; nil без комплекта или его длины.
func acceptedResult(project, shot string) *spend.Accepted {
	dir := filepath.Join(project, "assets", "shots", shot)
	manifest := readJSON(filepath.Join(dir, "manifest.json"))
	edit := dynvalue.Get(manifest, "accepted_edit")
	frames, fps := dynvalue.Get(edit, "frames"), dynvalue.Get(edit, "fps")
	if !dynvalue.IsFinite(frames) || !dynvalue.IsFinite(fps) || dynvalue.ToNumber(fps) <= 0 {
		return nil
	}
	accepted := &spend.Accepted{Seconds: dynvalue.ToNumber(frames) / dynvalue.ToNumber(fps)}
	generation := dynvalue.Get(manifest, "generation")
	if path, err := existingAssetFile(dir, dynvalue.GetPath(generation, "request", "path")); err == nil && path != nil {
		request := readJSON(*path)
		if id, ok := dynvalue.Get(request, "generation_id").(string); ok && id != "" {
			accepted.GenerationID = &id
		}
		if sha, ok := dynvalue.Get(request, "request_sha256").(string); ok {
			accepted.RequestSHA256 = sha
		}
	}
	return accepted
}
