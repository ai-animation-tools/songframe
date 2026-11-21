package productionworkflow

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
)

// TestAgentContextFrame — план с точкой съёмки получает в контексте агента факты кадра по схеме своей
// локации; план без точки съёмки ключа frame не получает, его контекст прежний.
func TestAgentContextFrame(t *testing.T) {
	run := ownRun(t)
	scenesPath := filepath.Join(run.project, "plan", "scenes.json")
	data, err := os.ReadFile(scenesPath)
	if err != nil {
		t.Fatal(err)
	}
	scenes, err := dynvalue.Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	list, _ := dynvalue.AsArray(dynvalue.Get(scenes, "scenes"))
	viewpoint, err := dynvalue.Parse([]byte(`{"location":"pier","side":"south","size":"wide","camera":{"start":[0,0]},"subjects":[{"entity":"boat","start":[0,10]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	list[0].(*dynvalue.Object).Set("viewpoint", viewpoint)
	if err := os.WriteFile(scenesPath, []byte(dynvalue.Stringify(scenes)), 0o644); err != nil {
		t.Fatal(err)
	}
	schemesFile := `{"schemes":[{"id":"s1","location":"pier","title":"Причал","objects":[` +
		`{"id":"o1","name":"Настил","shape":{"type":"rect","center":[0,15],"size":[20,4]},"height":1,"color":"#795548"}]}]}`
	if err := os.WriteFile(filepath.Join(run.project, "plan", "schemes.json"), []byte(schemesFile), 0o644); err != nil {
		t.Fatal(err)
	}

	type facts struct {
		Frame *struct {
			Camera struct {
				Side string  `json:"side"`
				Fov  float64 `json:"fov"`
			} `json:"camera"`
			Start struct {
				Looks    string `json:"looks"`
				Subjects []struct {
					Entity   string  `json:"entity"`
					InFrame  bool    `json:"in_frame"`
					Place    string  `json:"place"`
					Distance float64 `json:"distance"`
				} `json:"subjects"`
				Objects []map[string]any `json:"objects"`
			} `json:"start"`
		} `json:"frame"`
	}
	read := func(shot string) facts {
		t.Helper()
		c, err := ReadContext(run.project, shot, "")
		if err != nil {
			t.Fatal(err)
		}
		var got facts
		if err := json.Unmarshal([]byte(agentContext(c, contextInput{stage: "description", briefs: dynvalue.NewObject(), capabilities: &dynvalue.Array{Items: []any{}}})), &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	shot, _ := dynvalue.Get(list[0], "id").(string)
	got := read(shot)
	if got.Frame == nil {
		t.Fatal("нет фактов кадра")
	}
	start := got.Frame.Start
	if got.Frame.Camera.Side != "south" || got.Frame.Camera.Fov != 60 || start.Looks != "на север" {
		t.Fatalf("камера %+v, взгляд %q", got.Frame.Camera, start.Looks)
	}
	if len(start.Subjects) != 1 || start.Subjects[0].Entity != "boat" || !start.Subjects[0].InFrame || start.Subjects[0].Place != "центр" || start.Subjects[0].Distance != 10 {
		t.Fatalf("герои %+v", start.Subjects)
	}
	if len(start.Objects) != 1 || start.Objects[0]["name"] != "Настил" || start.Objects[0]["in_frame"] != true {
		t.Fatalf("объекты %+v", start.Objects)
	}
	// Цвет — только для холста: агенту он не передаётся.
	if _, ok := start.Objects[0]["color"]; ok {
		t.Fatalf("цвет в фактах: %+v", start.Objects[0])
	}
	if other, _ := dynvalue.Get(list[1], "id").(string); read(other).Frame != nil {
		t.Fatalf("%s без точки съёмки получил факты кадра", other)
	}
}
