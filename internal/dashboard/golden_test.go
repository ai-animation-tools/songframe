package dashboard_test

import (
	"encoding/json"
	"testing"

	"songframe-go/internal/dashboard"
	"songframe-go/internal/golden"
	"songframe-go/internal/production"
)

// TestGolden — домен production-view: viewProduction и viewDashboard оригинала на образце с
// правками случаев. Наличие Python и платных клиентов (tools) относится к машине и не сравнивается.
func TestGolden(t *testing.T) {
	for _, c := range golden.Load(t, "production-view") {
		t.Run(c.Name, func(t *testing.T) {
			project := c.BuildProject(t)
			view, err := production.ViewProduction(project)
			if err != nil {
				t.Fatal(err)
			}
			data, err := json.Marshal(view)
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(data, &document); err != nil {
				t.Fatal(err)
			}
			delete(document, "tools")
			golden.AssertValue(t, c.Read(t, "expected-production.json"), document, project)
			board, err := dashboard.ViewDashboard(project)
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, c.Read(t, "expected-dashboard.json"), board, project)
		})
	}
}
