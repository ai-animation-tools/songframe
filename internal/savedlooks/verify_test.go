package savedlooks

import (
	"reflect"
	"testing"

	"songframe/internal/mediaapi"
)

// TestVerify — сверка образов замороженного запроса: ID нет в библиотеке — missing (даже если
// референс привязан к новому образу), у референса другой образ или привязки нет — changed, тот же
// образ при изменившихся снимках — stale; имя образа — из библиотеки.
func TestVerify(t *testing.T) {
	report := Report{
		Looks: []mediaapi.SavedLook{{ID: "l-1", Name: "Лодка"}, {ID: "l-2", Name: "Причал (новое имя)"}, {ID: "l-3", Name: "Маяк"}, {ID: "l-9", Name: "Новый"}},
		States: []State{
			{Reference: "boat", Status: StatusReady, Look: "l-1", Name: "Лодка"},
			{Reference: "pier", Status: StatusStale, Look: "l-2", Name: "Причал (новое имя)"},
			{Reference: "tower", Status: StatusReady, Look: "l-9", Name: "Новый"},
			{Reference: "gull", Status: StatusReady, Look: "l-9", Name: "Новый"},
			{Reference: "flag", Status: StatusNone},
		},
	}
	uses := []mediaapi.SavedLookUse{
		{Code: "boat", Entity: "Лодка", Look: "l-1", Name: "Лодка"},
		{Code: "pier", Entity: "Причал", Look: "l-2", Name: "Причал"},
		{Code: "tower", Entity: "Маяк", Look: "l-3", Name: "Маяк"},
		{Code: "gull", Entity: "Чайка", Look: "l-5", Name: "Чайка"},
		{Code: "flag", Entity: "Флаг", Look: "l-3", Name: "Маяк"},
	}
	got := Verify(report, uses)
	want := []UseCheck{
		{Code: "pier", Entity: "Причал", Name: "Причал (новое имя)", Status: UseStale},
		{Code: "tower", Entity: "Маяк", Name: "Маяк", Status: UseChanged},
		{Code: "gull", Entity: "Чайка", Name: "Чайка", Status: UseMissing},
		{Code: "flag", Entity: "Флаг", Name: "Маяк", Status: UseChanged},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Verify = %+v, want %+v", got, want)
	}
	if !Blocking(got) || Blocking(got[:2]) {
		t.Fatal("Blocking: отправку блокирует только образ, которого нет в аккаунте")
	}
	if checks := Verify(report, uses[:1]); len(checks) != 0 {
		t.Fatalf("готовый образ не требует внимания: %+v", checks)
	}
}
