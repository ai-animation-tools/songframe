package animaticcards

// Примитивы карточек для других инструментов, которые рисуют теми же средствами и тем же
// шрифтом комплекса, что и карточки: contact_sheet собирает из них контактный лист
// и картинки сравнения с опорами. Экспорт — тонкие обёртки над уже проверенными эталоном
// animatic-cards функциями; поведение карточек от него не зависит.

// Filter — фильтр ресэмплинга Resize.
type Filter int

const (
	// Lanczos — фильтр Ланцоша с опорой 3 (вписывание референсов карточки).
	Lanczos Filter = iota
	// Bicubic — бикубический фильтр (a = -0.5, опора 2) для миниатюр и уменьшения кадров.
	Bicubic
)

// Picture — 8-битное RGB-изображение без альфы: холст, кадр или опора после приведения к RGB.
// Значение разделяет пиксели с копиями (как ссылка), поэтому Paste и DrawText меняют сам холст.
type Picture struct {
	img rgbImage
}

// NewPicture — холст width×height, залитый цветом «#RRGGBB».
func NewPicture(width, height int, fill string) Picture {
	return Picture{newRGB(width, height, hexColor(fill))}
}

// OpenPicture открывает изображение и приводит его к RGB (openRGB) с теми же ошибками, что у
// карточек: FileNotFoundError, нераспознанный формат (подкласс OSError) и OSError повреждённых
// данных.
func OpenPicture(path string) (Picture, error) {
	img, err := openRGB(path)
	return Picture{img}, err
}

// Size — (width, height).
func (p Picture) Size() (int, int) { return p.img.width, p.img.height }

// Paste вставляет source в точку (x, y) без маски, с отсечением по холсту.
func (p Picture) Paste(source Picture, x, y int) { p.img.paste(source.img, x, y) }

// Resize меняет размер двухпроходной свёрткой выбранного фильтра (побайтно как у вписывания
// референсов карточки); тот же размер — копия; сторона меньше 1 — ValueError.
func (p Picture) Resize(width, height int, filter Filter) (Picture, error) {
	chosen := lanczos
	if filter == Bicubic {
		chosen = bicubic
	}
	img, err := resize(p.img, width, height, chosen)
	return Picture{img}, err
}

// DrawText рисует text шрифтом комплекса кегля size цветом color одной строкой, левый верхний
// угол строки (по восходящей линии шрифта) — в (x, y): та же раскладка (продвижения, лигатуры,
// кернинг) и растеризация, что у текста карточек. Многострочный текст не поддерживается:
// вызывающие рисуют однострочные подписи.
func (p Picture) DrawText(x, y int, text string, size int, color string) error {
	face, err := newFace(false, size)
	if err != nil {
		return err
	}
	canvas := card{img: p.img}
	canvas.drawText(face, x, y, text, hexColor(color))
	return nil
}

// PNG кодирует изображение в PNG (8-битный RGB; сжатие эталоном не фиксируется).
func (p Picture) PNG() ([]byte, error) { return p.img.encodePNG() }
