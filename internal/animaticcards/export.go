package animaticcards

// Примитивы карточек для других инструментов, которые рисуют в манере Pillow тем же
// шрифтом комплекса, что и карточки: contact_sheet собирает из них контактный лист
// и картинки сравнения с опорами. Экспорт — тонкие обёртки над уже проверенными эталоном
// animatic-cards функциями; поведение карточек от него не зависит.

// Filter — фильтр ресэмплинга Image.resize.
type Filter int

const (
	// Lanczos — Resampling.LANCZOS (вписывание референсов карточки).
	Lanczos Filter = iota
	// Bicubic — Resampling.BICUBIC, фильтр Image.resize и Image.thumbnail по умолчанию.
	Bicubic
)

// Picture — изображение режима «RGB» Pillow: холст, кадр или опора после convert("RGB").
// Значение разделяет пиксели с копиями (как ссылка на объект Image), поэтому Paste и DrawText
// меняют сам холст.
type Picture struct {
	img rgbImage
}

// NewPicture — Image.new("RGB", (width, height), fill) с цветом «#RRGGBB».
func NewPicture(width, height int, fill string) Picture {
	return Picture{newRGB(width, height, hexColor(fill))}
}

// OpenPicture — Image.open(path).convert("RGB") с текстами ошибок Pillow (FileNotFoundError,
// PIL.UnidentifiedImageError — подкласс OSError, OSError повреждённых данных).
func OpenPicture(path string) (Picture, error) {
	img, err := openRGB(path)
	return Picture{img}, err
}

// Size — (width, height).
func (p Picture) Size() (int, int) { return p.img.width, p.img.height }

// Paste — canvas.paste(source, (x, y)) без маски, с отсечением по холсту.
func (p Picture) Paste(source Picture, x, y int) { p.img.paste(source.img, x, y) }

// Resize — image.resize((width, height), filter) без reducing_gap: свёртка libImaging побайтно;
// тот же размер — копия; сторона меньше 1 — ValueError Pillow.
func (p Picture) Resize(width, height int, filter Filter) (Picture, error) {
	chosen := lanczos
	if filter == Bicubic {
		chosen = bicubic
	}
	img, err := resize(p.img, width, height, chosen)
	return Picture{img}, err
}

// DrawText — draw.text((x, y), text, font=ImageFont.truetype(FONT, size), fill=color) одной
// строкой с якорем «la»: та же раскладка (продвижения, лигатуры, кернинг) и растеризация, что у
// текста карточек. Перевод строки (multiline_text Pillow) не поддерживается: вызывающие рисуют
// однострочные подписи.
func (p Picture) DrawText(x, y int, text string, size int, color string) error {
	face, err := newFace(false, size)
	if err != nil {
		return err
	}
	canvas := card{img: p.img}
	canvas.drawText(face, x, y, text, hexColor(color))
	return nil
}

// PNG — image.save(target) в формате PNG (8-битный RGB; сжатие отличается от zlib Pillow).
func (p Picture) PNG() ([]byte, error) { return p.img.encodePNG() }
