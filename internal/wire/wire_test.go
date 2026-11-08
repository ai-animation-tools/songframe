package wire

import (
	"encoding/json"
	"testing"
)

type inner struct {
	Tags []string          `json:"tags"`
	Meta map[string]string `json:"meta"`
}

type outer struct {
	Items    []inner          `json:"items"`
	Optional *inner           `json:"optional"`
	Present  *inner           `json:"present"`
	Nested   inner            `json:"nested"`
	ByID     map[string][]int `json:"byId"`
	Any      any              `json:"any"`
	private  []string
}

func TestFillReplacesNilCollections(t *testing.T) {
	value := Fill(outer{Items: []inner{{}}, Present: &inner{}, ByID: map[string][]int{"a": nil}, Any: inner{}})
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"items":[{"tags":[],"meta":{}}],"optional":null,"present":{"tags":[],"meta":{}},"nested":{"tags":[],"meta":{}},"byId":{"a":[]},"any":{"tags":[],"meta":{}}}`
	if string(data) != want {
		t.Fatalf("\n%s\n%s", data, want)
	}
	if list := Fill([]string(nil)); list == nil {
		t.Fatal("верхний срез остался nil")
	}
}
