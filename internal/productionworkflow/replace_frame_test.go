package productionworkflow

import (
	"testing"

	"songframe/internal/dynvalue"
)

// Предложение заменяет кандидата только той опоры, о которой открыт вопрос, и только одним файлом:
// вопрос о другой опоре и пакетная подстановка по-прежнему ждут решения пользователя.
func TestReplacesAskedFrame(t *testing.T) {
	workflow := dynvalue.NewObject()
	question := dynvalue.NewObject()
	question.Set("frame", "K01")
	workflow.Set("pending_decision", question)
	context := &Context{Workflow: workflow}
	after := func(ids ...string) *dynvalue.Object {
		images := &dynvalue.Array{}
		for _, id := range ids {
			image := dynvalue.NewObject()
			image.Set("id", id)
			images.Items = append(images.Items, image)
		}
		tree := dynvalue.NewObject()
		tree.Set("stage", "frames")
		tree.Set("images", images)
		return tree
	}
	if !replacesAskedFrame(context, after("K01")) {
		t.Fatal("замена кандидата опоры вопроса отклонена")
	}
	if replacesAskedFrame(context, after("K02")) {
		t.Fatal("вопрос об опоре K01 не должен пропускать K02")
	}
	if replacesAskedFrame(context, after("K01", "K02")) {
		t.Fatal("вопрос не должен пропускать несколько опор")
	}
	question.Delete("frame")
	if replacesAskedFrame(context, after("K01")) {
		t.Fatal("общий вопрос пакета не заменяется файлом")
	}
}
