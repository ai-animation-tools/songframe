// Package animaticcards рисует условные PNG-карточки аниматика для планов без видео.
//
// Карточка — кадр-заглушка плана без видео: название проекта, интервал, заголовок, камера,
// действие и непрерывность текстом, основной референс и миниатюры остальных; у плана с
// принятыми опорами — первая опора на весь холст, остальные полоской. Полный текст плана
// остаётся в монтажном списке и раскадровке, поэтому не поместившийся текст сокращается
// многоточием, а не роняет сборку. Пакет вызывается из обновления представлений сцены
// internal/sceneviews (expected_cards); записью файлов и манифестом владеет оно, здесь только
// байты PNG.
//
// Эталон testdata/golden/animatic-cards фиксирует макет 1280×720, цвета, координаты, выбор
// кегля, переносы, многоточие, размеры и положение вписанных изображений, пиксели фона, полос и
// вписанных PNG/WebP/GIF (ресэмплинг Lanczos и преобразования libwebp считаются целочисленно), а
// также тексты исключений для неверных данных (вызывающий инструмент печатает их строкой
// «Ошибка: текст»). Не фиксируются сглаживание глифов (растеризатор x/image без хинтинга),
// пиксели JPEG (±3 уровня из-за обратного DCT декодера Go) и сжатие PNG, поэтому SHA-256 файла
// карточки с эталоном не сравнивается.
package animaticcards

import "songframe/internal/toolrt"

// Макет карточки; значения зафиксированы эталоном.
const (
	cardWidth  = 1280
	cardHeight = 720
	accent     = "#E8B975"
	background = "#171E24"
	foreground = "#EDF0F2"
	muted      = "#ACB7C0"
)

// trace — запись вызовов для эталона: поля text_box и вставки изображений (card.paste) в
// порядке рисования. Рабочий вызов трассировку не ведёт.
type trace struct {
	Texts  []textCall
	Pastes []pasteCall
}

// pasteCall — вставленное изображение: размер после вписывания, позиция и SHA-256 пикселей.
type pasteCall struct {
	Width, Height, X, Y int
	SHA256              string
}

// card — холст карточки и необязательная трассировка.
type card struct {
	img   rgbImage
	trace *trace
}

func (c *card) paste(source rgbImage, x, y int) {
	c.img.paste(source, x, y)
	if c.trace != nil {
		c.trace.Pastes = append(c.trace.Pastes, pasteCall{source.width, source.height, x, y, source.digest()})
	}
}

// cardResult — сведения о нарисованной карточке (вызывающий их не использует, эталон сверяет).
type cardResult struct {
	ActionFont       int
	StateFont        int
	PrimaryReference any
	PrimaryImage     any
}

// RenderCard рисует PNG текстовой карточки плана в target.
// shot — элемент sceneregistry.Shots(data, nil) (*toolrt.Dict: id, title, interval, duration, camera,
// action, state, refs, card.primary_reference, derived_from, lipsync); project — результат
// sceneregistry.ValidateProject(..., false); references — data["references"] реестра (*toolrt.Dict);
// root — корень проекта, пути изображений относительно него.
//
// Ошибки — исключения toolrt с типом и текстом, зафиксированными эталоном: KeyError
// отсутствующего поля, TypeError/AttributeError неверного типа, FileNotFoundError и
// нераспознанный формат референса (unidentifiedImage), AssertionError слова шире поля.
func RenderCard(shot, project, references *toolrt.Dict, root string) ([]byte, error) {
	c, _, err := renderCard(shot, project, references, root, nil)
	if err != nil {
		return nil, err
	}
	return c.img.encodePNG()
}

// RenderKeyframeCard рисует PNG карточки опор; last — PNG последней опоры на весь холст
// (fitCanvas), если withLast и опор >= 2, иначе nil.
// keyframes — словари {id, role, time_seconds, path, sha256}, path относительно root.
// Пустой список опор — ValueError «Нет принятых опор для карточки.».
func RenderKeyframeCard(shot, project *toolrt.Dict, keyframes []*toolrt.Dict, root string, withLast bool) (card, last []byte, err error) {
	rendered, lastImage, err := renderKeyframeCard(shot, project, keyframes, root, withLast, nil)
	if err != nil {
		return nil, nil, err
	}
	if card, err = rendered.img.encodePNG(); err != nil {
		return nil, nil, err
	}
	if lastImage != nil {
		if last, err = lastImage.encodePNG(); err != nil {
			return nil, nil, err
		}
	}
	return card, last, nil
}

// joinRoot склеивает root и путь из данных; нестроковый путь — TypeError «операция «/»
// неприменима: путь и <вид>».
func joinRoot(root string, path any) (string, error) {
	text, ok := path.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(path))
	}
	return toolrt.JoinPath(root, text), nil
}

// item — значение container по ключу любого типа; отсутствие ключа и неверный тип контейнера —
// исключения toolrt.GetItem.
func item(container, key any) (any, error) { return toolrt.GetItem(container, key) }

// concat — левоассоциативное сложение a + b + … значений toolrt.Add: операнды вычисляются по
// одному, поэтому ошибка первого сложения возникает раньше KeyError следующего операнда.
func concat(first any, rest ...func() (any, error)) (any, error) {
	result := first
	for _, next := range rest {
		value, err := next()
		if err != nil {
			return nil, err
		}
		if result, err = toolrt.Add(result, value); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// literal — операнд concat, который не может упасть.
func literal(text string) func() (any, error) {
	return func() (any, error) { return text, nil }
}

// field — операнд concat: значение container по ключу key.
func field(container any, key string) func() (any, error) {
	return func() (any, error) { return item(container, key) }
}

// upperName — имя проекта прописными (toUpper); нестроковое имя — AttributeError.
func upperName(project *toolrt.Dict) (any, error) {
	name, err := item(project, "name")
	if err != nil {
		return nil, err
	}
	text, ok := name.(string)
	if !ok {
		return nil, toolrt.Raise(toolrt.AttributeError, "ожидается строка, получено: %s", toolrt.TypeName(name))
	}
	return toUpper(text), nil
}

// placeReference вписывает референс в рамку и центрирует его (смещения — деление с округлением
// вниз; они неотрицательны).
func (c *card) placeReference(path any, x, y, width, height int, root string) error {
	full, err := joinRoot(root, path)
	if err != nil {
		return err
	}
	source, err := openRGB(full)
	if err != nil {
		return err
	}
	fitted, err := contain(source, width, height)
	if err != nil {
		return err
	}
	c.paste(fitted, x+floorDiv(width-fitted.width, 2), y+floorDiv(height-fitted.height, 2))
	return nil
}

// floorDiv — целочисленное деление с округлением вниз (к минус бесконечности) для b > 0.
func floorDiv(a, b int) int {
	quotient := a / b
	if (a%b != 0) && (a < 0) {
		quotient--
	}
	return quotient
}

// fitCanvas — изображение целиком на холсте 1280×720 цвета фона.
func fitCanvas(path string, c *card) (rgbImage, error) {
	canvas := &card{img: newRGB(cardWidth, cardHeight, hexColor(background))}
	if c != nil {
		canvas.trace = c.trace
	}
	source, err := openRGB(path)
	if err != nil {
		return rgbImage{}, err
	}
	fitted, err := contain(source, cardWidth, cardHeight)
	if err != nil {
		return rgbImage{}, err
	}
	canvas.paste(fitted, floorDiv(cardWidth-fitted.width, 2), floorDiv(cardHeight-fitted.height, 2))
	return canvas.img, nil
}

// renderCard — тело RenderCard с необязательной трассировкой; порядок вычислений и рисования
// зафиксирован эталоном, поэтому при неверных данных первой возникает одна и та же ошибка.
func renderCard(shot, project, references *toolrt.Dict, root string, tr *trace) (*card, cardResult, error) {
	c := &card{img: newRGB(cardWidth, cardHeight, hexColor(background)), trace: tr}
	c.img.fillRect(0, 0, 1280, 7, hexColor(accent))
	fail := func(err error) (*card, cardResult, error) { return nil, cardResult{}, err }

	name, err := upperName(project)
	if err != nil {
		return fail(err)
	}
	header, err := concat(name, literal("  /  ЧЕРНОВОЙ МОНТАЖ"))
	if err != nil {
		return fail(err)
	}
	if _, err := c.textBox(header, 32, 22, 760, 32, 20, accent, true); err != nil {
		return fail(err)
	}
	interval, err := item(shot, "interval")
	if err != nil {
		return fail(err)
	}
	timing, err := concat(interval, literal("  •  "), field(shot, "duration"), literal(" с"))
	if err != nil {
		return fail(err)
	}
	if _, err := c.textBox(timing, 865, 24, 385, 30, 18, foreground, false); err != nil {
		return fail(err)
	}
	title, err := item(shot, "title")
	if err != nil {
		return fail(err)
	}
	// План из материала другого плана помечается источником; у обычного плана заголовок прежний.
	if derived := shot.Value("derived_from"); toolrt.Truthy(derived) {
		source, err := item(derived, "shot")
		if err != nil {
			return fail(err)
		}
		suffix, err := concat("  •  из ", func() (any, error) { return source, nil })
		if err != nil {
			return fail(err)
		}
		if title, err = toolrt.Add(title, suffix); err != nil {
			return fail(err)
		}
	}
	id, err := item(shot, "id")
	if err != nil {
		return fail(err)
	}
	heading, err := concat(id, literal("  /  "), func() (any, error) { return title, nil })
	if err != nil {
		return fail(err)
	}
	if _, err := c.textBox(heading, 32, 63, 1216, 51, 32, foreground, true); err != nil {
		return fail(err)
	}
	if _, err := c.textBox("РЕФЕРЕНСЫ • УСЛОВНЫЙ КАДР, НЕ ГОТОВАЯ СЦЕНА", 32, 128, 660, 26, 17, muted, false); err != nil {
		return fail(err)
	}
	camera, err := item(shot, "camera")
	if err != nil {
		return fail(err)
	}
	if _, err := c.textBox(camera, 720, 128, 528, 83, 21, accent, false); err != nil {
		return fail(err)
	}
	c.img.fillRoundedRect9(32, 166, 692, 540, hexColor("#101519"))
	cardField, err := item(shot, "card")
	if err != nil {
		return fail(err)
	}
	key, err := item(cardField, "primary_reference")
	if err != nil {
		return fail(err)
	}
	primary, err := item(references, key)
	if err != nil {
		return fail(err)
	}
	sourcePath, err := item(primary, "path")
	if err != nil {
		return fail(err)
	}
	if err := c.placeReference(sourcePath, 32, 166, 660, 374, root); err != nil {
		return fail(err)
	}
	primaryName, err := item(primary, "name")
	if err != nil {
		return fail(err)
	}
	label, err := concat(primaryName, literal(" • исходный референс"))
	if err != nil {
		return fail(err)
	}
	if _, err := c.textBox(label, 42, 545, 640, 25, 16, muted, false); err != nil {
		return fail(err)
	}
	if _, err := c.textBox("ДЕЙСТВИЕ", 720, 218, 528, 27, 17, accent, true); err != nil {
		return fail(err)
	}
	action, err := item(shot, "action")
	if err != nil {
		return fail(err)
	}
	actionFont, err := c.textBox(action, 720, 250, 528, 263, 24, foreground, false)
	if err != nil {
		return fail(err)
	}
	if _, err := c.textBox("НЕПРЕРЫВНОСТЬ", 720, 518, 528, 26, 17, accent, true); err != nil {
		return fail(err)
	}
	state, err := item(shot, "state")
	if err != nil {
		return fail(err)
	}
	stateFont, err := c.textBox(state, 720, 549, 528, 108, 18, muted, false)
	if err != nil {
		return fail(err)
	}
	refsValue, err := item(shot, "refs")
	if err != nil {
		return fail(err)
	}
	refs, err := toolrt.Iter(refsValue)
	if err != nil {
		return fail(err)
	}
	others := []any{}
	for _, ref := range refs {
		if !toolrt.Equal(ref, key) {
			others = append(others, ref)
		}
	}
	cellWidth := min(106, 660/max(1, len(others)))
	for index, ref := range others {
		x := 32 + index*cellWidth
		reference, err := item(references, ref)
		if err != nil {
			return fail(err)
		}
		path, err := item(reference, "path")
		if err != nil {
			return fail(err)
		}
		if err := c.placeReference(path, x, 582, cellWidth-6, 62, root); err != nil {
			return fail(err)
		}
		// Подпись — short_name референса, иначе его name. Тип референса проверяется до запасного
		// имени, а запасное name обязательно даже при заданном short_name: порядок ошибок
		// зафиксирован эталоном.
		reference, err = item(references, ref)
		if err != nil {
			return fail(err)
		}
		if _, ok := reference.(*toolrt.Dict); !ok {
			return fail(toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(reference)))
		}
		fallback, err := item(reference, "name")
		if err != nil {
			return fail(err)
		}
		short, _ := toolrt.DictGet(reference, "short_name", fallback)
		if _, err := c.textBox(short, x, 647, cellWidth-6, 23, 16, muted, false); err != nil {
			return fail(err)
		}
	}
	c.img.fillRect(0, 679, 1280, 720, hexColor("#0D1216"))
	notice, color := "Референсы не показывают текущую позу, ракурс и состояние", muted
	if toolrt.Truthy(shot.Value("lipsync")) {
		notice, color = "РЕЧЕВОЙ ПЛАН • губы не анимированы, границы слов не проверены", accent
	}
	if _, err := c.textBox(notice, 32, 689, 974, 26, 17, color, false); err != nil {
		return fail(err)
	}
	return c, cardResult{ActionFont: actionFont, StateFont: stateFont, PrimaryReference: key, PrimaryImage: sourcePath}, nil
}

// keyframePath — путь опоры keyframe["path"] относительно root.
func keyframePath(keyframe *toolrt.Dict, root string) (string, error) {
	path, err := item(keyframe, "path")
	if err != nil {
		return "", err
	}
	return joinRoot(root, path)
}

// renderKeyframeCard — тело RenderKeyframeCard с необязательной трассировкой. Вторым
// значением возвращается холст последней опоры (nil, если он не нужен).
func renderKeyframeCard(shot, project *toolrt.Dict, keyframes []*toolrt.Dict, root string, withLast bool, tr *trace) (*card, *rgbImage, error) {
	if len(keyframes) == 0 {
		return nil, nil, toolrt.New(toolrt.ValueError, "Нет принятых опор для карточки.")
	}
	c := &card{trace: tr}
	firstPath, err := keyframePath(keyframes[0], root)
	if err != nil {
		return nil, nil, err
	}
	if c.img, err = fitCanvas(firstPath, c); err != nil {
		return nil, nil, err
	}
	c.img.shadeBand(0, 58)
	c.img.shadeBand(cardHeight-112, cardHeight)
	c.img.fillRect(0, 0, cardWidth, 7, hexColor(accent))
	name, err := upperName(project)
	if err != nil {
		return nil, nil, err
	}
	header, err := concat(name, literal("  /  ОПОРЫ ПРИНЯТЫ, ВИДЕО НЕ СГЕНЕРИРОВАНО"))
	if err != nil {
		return nil, nil, err
	}
	if _, err := c.textBox(header, 32, 20, 860, 28, 18, accent, true); err != nil {
		return nil, nil, err
	}
	interval, err := item(shot, "interval")
	if err != nil {
		return nil, nil, err
	}
	timing, err := concat(interval, literal("  •  "), field(shot, "duration"), literal(" с"))
	if err != nil {
		return nil, nil, err
	}
	if _, err := c.textBox(timing, 900, 22, 350, 28, 18, foreground, false); err != nil {
		return nil, nil, err
	}
	id, err := item(shot, "id")
	if err != nil {
		return nil, nil, err
	}
	heading, err := concat(id, literal("  /  "), field(shot, "title"))
	if err != nil {
		return nil, nil, err
	}
	if _, err := c.textBox(heading, 32, cardHeight-100, 760, 40, 24, foreground, true); err != nil {
		return nil, nil, err
	}
	// План опор: «id время с» каждой опоры через « → »; время — formatG.
	plan := ""
	for index, keyframe := range keyframes {
		keyID, err := item(keyframe, "id")
		if err != nil {
			return nil, nil, err
		}
		seconds, err := item(keyframe, "time_seconds")
		if err != nil {
			return nil, nil, err
		}
		formatted, err := formatG(seconds)
		if err != nil {
			return nil, nil, err
		}
		if index > 0 {
			plan += " → "
		}
		plan += toolrt.Str(keyID) + " " + formatted + " с"
	}
	if _, err := c.textBox("План опор: "+plan, 32, cardHeight-58, 760, 24, 16, muted, false); err != nil {
		return nil, nil, err
	}
	camera, err := item(shot, "camera")
	if err != nil {
		return nil, nil, err
	}
	if _, err := c.textBox(camera, 32, cardHeight-32, 760, 24, 16, accent, false); err != nil {
		return nil, nil, err
	}
	others := keyframes[1:]
	if len(others) > 0 {
		width := min(176, (cardWidth-820-32)/max(1, len(others)))
		for index, keyframe := range others {
			x := cardWidth - 32 - width*(len(others)-index) + 6
			path, err := item(keyframe, "path")
			if err != nil {
				return nil, nil, err
			}
			if err := c.placeReference(path, x, cardHeight-104, width-6, 76, root); err != nil {
				return nil, nil, err
			}
			keyID, err := item(keyframe, "id")
			if err != nil {
				return nil, nil, err
			}
			if _, err := c.textBox(keyID, x, cardHeight-26, width-6, 24, 16, muted, false); err != nil {
				return nil, nil, err
			}
		}
	}
	if !withLast || len(keyframes) < 2 {
		return c, nil, nil
	}
	lastPath, err := keyframePath(keyframes[len(keyframes)-1], root)
	if err != nil {
		return nil, nil, err
	}
	last, err := fitCanvas(lastPath, c)
	if err != nil {
		return nil, nil, err
	}
	return c, &last, nil
}
