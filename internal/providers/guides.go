package providers

import (
	"regexp"
	"strings"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
	"songframe-go/resources"
)

// GuideHeading — заголовок раздела документа провайдера, который входит в промпт агента.
const GuideHeading = "## Указания агенту"

var nextSection = regexp.MustCompile(`\n## `)

// Guide — раздел «Указания агенту» документа выбранного провайдера вида
// медиа kind (image, video) с заголовком для промпта задания. Особенности конкретного сервиса
// агент получает только для провайдера, выбранного в проекте. false — провайдер не выбран, не
// поддерживает вид медиа или у его документа нет раздела. Документы встроены в бинарник
// (resources.ProviderDoc).
func Guide(kind string, provider any) (string, bool) {
	id, ok := mediaproviders.Normalize(provider)
	if !ok || !mediaproviders.Supports(id, kind) {
		return "", false
	}
	info, _ := mediaproviders.Lookup(id)
	data, err := resources.ProviderDoc(kind, id)
	if err != nil {
		return "", false
	}
	document := strings.ReplaceAll(string(data), "\r\n", "\n")
	start := strings.Index(document, "\n"+GuideHeading+"\n")
	if start < 0 {
		return "", false
	}
	body := document[start+len(GuideHeading)+2:]
	if end := nextSection.FindStringIndex(body); end != nil {
		body = body[:end[0]]
	}
	section := jscompat.Trim(body)
	if section == "" {
		return "", false
	}
	label := "изображений"
	if kind == mediaproviders.Video {
		label = "видео"
	}
	return "## Указания провайдера " + label + ": " + info.Title + "\n\n" + section, true
}
