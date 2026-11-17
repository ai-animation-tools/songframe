package productionworkflow

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/dynvalue"
	"songframe/internal/mediaapi"
	"songframe/internal/mediaproviders"
	"songframe/internal/mediatest"
	"songframe/internal/providers"
)

// Платный запрос опоры получает утверждённые опоры пакета входами после референсов описания, а
// промпт называет их слоты. Если модель объявляет меньше слотов, опоры отбрасываются с последней.
func TestFrameImageRequestApprovedFrames(t *testing.T) {
	t.Cleanup(mediaproviders.Register("test", mediaproviders.Info{Title: "Тестовый сервис", Kinds: []string{mediaproviders.Image}, Paid: true, DefaultImageOutputs: 1}))
	project := t.TempDir()
	write := func(rel string) string {
		path := filepath.Join(project, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, mediatest.BuiltinPNG, 0o666); err != nil {
			t.Fatal(err)
		}
		return path
	}
	write("source/heroes/boat.png")
	k01 := write("plan/batches/M01-attempt-01/frames/K01.png")
	k02 := write("plan/batches/M01-attempt-01/frames/K02.png")
	paid := providers.Paid{ID: "test", Rules: mediaapi.RequestRules{Image: mediaapi.ImageRules{
		Command: func(references int) string {
			if references == 0 {
				return "text_to_image"
			}
			return "image_to_image"
		},
		ReferenceSlot: func(index int) string { return fmt.Sprintf("image_%d", index+1) },
	}}}
	model := func(command, slots string) mediaapi.Model {
		return mediaapi.Model{ID: "test-image", Command: command, Arguments: json.RawMessage(`{}`), Slots: json.RawMessage(slots), Limits: json.RawMessage(`{}`)}
	}
	// Модель принимает не больше двух входов изображений.
	caps := mediaapi.Capabilities{Provider: "test", Kind: mediaproviders.Image, Available: true, Models: []mediaapi.Model{
		model("text_to_image", `{}`),
		model("image_to_image", `{"image_1":{"required":true},"image_2":{"required":false}}`),
	}}
	settings, _ := dynvalue.Parse([]byte(`{"provider":"test"}`))
	request := func(references []string, approved ...string) providers.PaidInput {
		frames := []mediaapi.ApprovedFrame{}
		for index, path := range approved {
			frames = append(frames, mediaapi.ApprovedFrame{ID: fmt.Sprintf("K%02d", index+1), Role: "first", Path: path})
		}
		input := mediaapi.ImagesInput{Project: project, Shot: "M01", PackageDir: filepath.Join(project, "plan", "batches", "M01-attempt-01"),
			Frames: []mediaapi.FramePrompt{{ID: "K03", Role: "last", Prompt: "Лодка у пристани", ReferencePaths: references}}, ApprovedFrames: &frames}
		result, err := frameImageRequest(paid, input, settings, caps, func(string) bool { return true })
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	slots := func(input providers.PaidInput) string {
		items := []string{}
		for _, item := range input.Inputs {
			items = append(items, item.Slot+"="+filepath.Base(item.Path))
		}
		return strings.Join(items, " ")
	}

	both := request(nil, k01, k02)
	if got := slots(both); got != "image_1=K01.png image_2=K02.png" || both.Command != "image_to_image" {
		t.Fatalf("две опоры без референсов: %s %s", both.Command, got)
	}
	if !strings.HasSuffix(both.Prompt, "\n\nСогласованность: image_1, image_2 — уже утверждённые опоры этого плана; сохрани с них внешность героев, одежду, свет и расстановку.") {
		t.Fatalf("промпт: %q", both.Prompt)
	}
	// Референс описания и две опоры не помещаются в два слота: последняя опора отброшена.
	trimmed := request([]string{"source/heroes/boat.png"}, k01, k02)
	if got := slots(trimmed); got != "image_1=boat.png image_2=K01.png" {
		t.Fatalf("лишняя опора не отброшена: %s", got)
	}
	if !strings.HasSuffix(trimmed.Prompt, "\n\nСогласованность: image_2 — уже утверждённая опора этого плана; сохрани с неё внешность героев, одежду, свет и расстановку.") {
		t.Fatalf("промпт: %q", trimmed.Prompt)
	}
	// Без утверждённых опор запрос прежний.
	plain := request(nil)
	if plain.Command != "text_to_image" || len(plain.Inputs) != 0 || plain.Prompt != "Лодка у пристани" {
		t.Fatalf("первая опора: %s %s %q", plain.Command, slots(plain), plain.Prompt)
	}
}
