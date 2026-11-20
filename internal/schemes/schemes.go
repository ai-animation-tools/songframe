// Package schemes читает, проверяет и сохраняет схемы локаций plan/schemes.json: вид сверху
// и виды с четырёх сторон, нарисованные именованными фигурами в метрах. Схемы дают агентам
// однозначное расположение объектов вместо словесных «правее» и «сзади»; по ним же вычисляются
// факты кадра для точки камеры плана.
//
// Документ целиком принадлежит приложению: его пишет только страница «Схемы», поэтому он
// читается в типизированные структуры, а не переносится как произвольное дерево. Отсутствие файла
// означает, что схем ещё нет; чтение ничего не пишет, запись атомарна и не трогает файл при отказе
// проверки.
package schemes

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"songframe/internal/projectfs"
)

// Виды схем: сверху и с четырёх сторон. «Вид с запада» — то, что видит камера, стоящая на западе
// и смотрящая на восток.
const (
	ViewTop   = "top"
	ViewNorth = "north"
	ViewEast  = "east"
	ViewSouth = "south"
	ViewWest  = "west"
)

// Views — допустимые виды в порядке показа.
var Views = []string{ViewTop, ViewNorth, ViewEast, ViewSouth, ViewWest}

// Типы фигур.
const (
	ShapeRect    = "rect"
	ShapeEllipse = "ellipse"
	ShapePolygon = "polygon"
	ShapeLine    = "line"
	ShapePoint   = "point"
)

// Point — координаты в метрах. На виде сверху [восток, север]; на видах сбоку [координата мира
// по горизонтали, высота]: X мира для видов с севера и юга, Y мира для видов с востока и запада.
type Point [2]float64

// Shape — геометрия объекта. Набор полей зависит от Type:
//   - rect: Center, Size (ширина и высота вдоль осей до поворота), Rotation (градусы против часовой);
//   - ellipse: Center, Radii, Rotation; круг — равные радиусы;
//   - polygon: Points, не меньше трёх, замкнут всегда;
//   - line: Points, не меньше двух; Smooth — гладкая кривая через точки, Closed — замкнутая,
//     Width — ширина полосы в метрах (дорога, трасса), без неё линия без толщины;
//   - point: At.
type Shape struct {
	Type     string   `json:"type"`
	Center   *Point   `json:"center,omitempty"`
	Size     *Point   `json:"size,omitempty"`
	Radii    *Point   `json:"radii,omitempty"`
	Rotation *float64 `json:"rotation,omitempty"`
	Points   []Point  `json:"points,omitempty"`
	Smooth   bool     `json:"smooth,omitempty"`
	Closed   bool     `json:"closed,omitempty"`
	Width    *float64 `json:"width,omitempty"`
	At       *Point   `json:"at,omitempty"`
}

// Формы верха объёма.
const (
	TopRidge = "ridge"
	TopSlope = "slope"
	TopTent  = "tent"
)

// TopForms — допустимые формы верха.
var TopForms = []string{TopRidge, TopSlope, TopTent}

// BodyEllipsoid — тело-эллипсоид, вписанное в фигуру и высоту, вместо призмы.
const BodyEllipsoid = "ellipsoid"

// Top — верх объёма над телом: поднимается от высоты тела на Rise метров.
//   - ridge — гребень посередине фигуры вдоль её оси Axis («x» — вдоль первого размера, «y» — второго);
//   - slope — одна плоскость, опускающаяся в сторону Down («+x», «-x», «+y», «-y»);
//   - tent — к центру фигуры (шатёр, конус над эллипсом).
//
// Оси — собственные оси фигуры до поворота: у фигуры без поворота «x» — восток, «y» — север.
// Названия форм геометрические: из них собираются дом, палатка, навес, беседка.
type Top struct {
	Form string  `json:"form"`
	Rise float64 `json:"rise"`
	Axis string  `json:"axis,omitempty"`
	Down string  `json:"down,omitempty"`
}

// Object — именованная фигура схемы. Смысл объекта агент берёт из названия. Color нужен только
// редактору; Entity связывает объект с сущностью кастинга: строением, предметом или другой локацией
// (дверь соседней улицы). Такой референс плана точка съёмки не ставит точкой — его место и размер
// берутся из объекта.
//
// Объём (только на виде сверху): тело — фигура, поднятая на Height метров от низа (нет или 0 —
// плоская поверхность, линия без высоты — разметка, точка — отметка); низ поднят над землёй на
// Elevation (навес, крона, мост); Top — верх над телом; Body «ellipsoid» — округлое тело вместо призмы.
type Object struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Shape     Shape    `json:"shape"`
	Height    *float64 `json:"height,omitempty"`
	Elevation *float64 `json:"elevation,omitempty"`
	Top       *Top     `json:"top,omitempty"`
	Body      string   `json:"body,omitempty"`
	Color     string   `json:"color,omitempty"`
	Entity    string   `json:"entity,omitempty"`
}

// Scheme — одна схема локации кастинга (Location — ID сущности типа location).
type Scheme struct {
	ID       string   `json:"id"`
	Location string   `json:"location"`
	Title    string   `json:"title"`
	View     string   `json:"view"`
	Objects  []Object `json:"objects"`
}

// Document — plan/schemes.json.
type Document struct {
	SchemaVersion int      `json:"schema_version"`
	Schemes       []Scheme `json:"schemes"`
}

// Path — путь схем внутри проекта.
func Path(project string) string {
	return filepath.Join(project, "plan", "schemes.json")
}

// Empty — документ без схем: так выглядит проект, где файла ещё нет.
func Empty() Document {
	return Document{SchemaVersion: 1, Schemes: []Scheme{}}
}

// errDamaged — файл есть, но не разбирается как документ схем.
var errDamaged = errors.New(textFileDamaged)

// Read читает схемы. Нет файла — пустой документ и missing=true; файл не разбирается или
// содержит поля вне контракта — ошибка повреждения (страница показывает её, файл не трогается).
func Read(project string) (Document, bool, error) {
	data, err := os.ReadFile(Path(project))
	if errors.Is(err, os.ErrNotExist) {
		return Empty(), true, nil
	}
	if err != nil {
		return Empty(), false, err
	}
	document, err := Decode(data)
	if err != nil {
		return Empty(), false, errDamaged
	}
	return document, false, nil
}

// Decode разбирает документ строго: неизвестные поля — ошибка, чтобы опечатка в ключе не
// потеряла данные молча при следующей записи.
func Decode(data []byte) (Document, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, err
	}
	if document.Schemes == nil {
		document.Schemes = []Scheme{}
	}
	for index := range document.Schemes {
		if document.Schemes[index].Objects == nil {
			document.Schemes[index].Objects = []Object{}
		}
	}
	return document, nil
}

// encode — байты файла: JSON с отступом в два пробела и перевод строки, без экранирования HTML.
func encode(document Document) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// writeFile — атомарная замена файла проекта; точка подмены для тестов сбоя записи.
var writeFile = func(path string, data []byte) error { return projectfs.WriteFile(path, data, 0) }

// Save проверяет документ по локациям кастинга и атомарно записывает его. Повреждённый прежний
// файл не перезаписывается. Ошибка проверки
// перечисляет все проблемы по строке и оставляет прежний файл нетронутым.
func Save(project string, document Document) (Document, error) {
	if document.Schemes == nil {
		document.Schemes = []Scheme{}
	}
	// Повреждённый файл не перезаписывается: его разбирает пользователь, иначе схемы пропали бы молча.
	if _, _, err := Read(project); errors.Is(err, errDamaged) {
		return Document{}, err
	}
	problems := Validate(document, LoadCatalog(project))
	if len(problems) > 0 {
		return Document{}, errors.New(joinLines(problems))
	}
	data, err := encode(document)
	if err != nil {
		return Document{}, err
	}
	if err := writeFile(Path(project), data); err != nil {
		return Document{}, err
	}
	return document, nil
}

// joinLines — проблемы одной ошибкой, по строке на проблему: интерфейс показывает их списком.
func joinLines(lines []string) string {
	var buffer bytes.Buffer
	for index, line := range lines {
		if index > 0 {
			buffer.WriteByte('\n')
		}
		buffer.WriteString(line)
	}
	return buffer.String()
}
