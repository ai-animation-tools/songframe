package animaticcards

import (
	"encoding/binary"
	"math/bits"
	"sort"
	"sync"
	"unicode"

	"golang.org/x/image/font"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"

	"songframe-go/resources"
)

// Раскладка строки повторяет то, что делает Pillow 10.2 с движком Raqm 0.10 и HarfBuzz поверх
// FreeType: от суммы продвижений глифов зависят переносы и выбор кегля карточки, поэтому
// ширина строки должна совпадать с draw.textlength эталона с точностью до 1/64 пикселя.
//
// Что воспроизводится (проверено эталоном testdata/golden/animatic-cards/textlength.json):
//   - продвижения глифов без хинтинга (hb-ft по умолчанию грузит их с FT_LOAD_NO_HINTING),
//     округлённые до 26.6 — это GlyphAdvance пакета sfnt с font.HintingNone;
//   - деление текста на прогоны по письменности, как _raqm_resolve_scripts (общие символы и
//     знаки наследуют письменность соседей, парные скобки — письменность открывающей);
//   - лигатуры GSUB (тип 4) включённых по умолчанию функций ccmp/locl/rlig/liga/clig/calt/rclt
//     системы языка по умолчанию для письменности прогона (в DejaVu это fi/fl/ff у латиницы);
//   - кернинг GPOS PairPos (тип 2) функции kern для письменности прогона с масштабированием
//     HarfBuzz (v·mult+32768)>>16 и правилами применения подтаблиц формата 1 и 2;
//   - нулевая ширина нераскрываемых символов (default ignorables) и меток GDEF класса 3.
//
// Чего нет (в карточках клипов не встречается, расхождение — только в ширине таких строк):
// контекстные подстановки GSUB (тип 6: в DejaVu они переставляют точки над i/j перед
// комбинируемыми знаками и обслуживают арабское письмо), нормализация составных символов
// HarfBuzz, справа-налево и сложные шейперы (арабский, иврит), системы языка из локали
// процесса (Raqm берёт язык из LC_CTYPE; в DejaVu особые формы есть только у сербского и
// македонского), таблицы Device и фильтры классов меток в флагах lookup.

// fontFile — разобранный встроенный шрифт: sfnt даёт cmap, продвижения, метрики и контуры, а
// таблицы GSUB/GPOS/GDEF разбираются здесь, потому что sfnt читает кернинг только латиницы и
// не знает лигатур. Значение неизменяемо после loadFonts и используется из любых горутин; кэши
// прогонов по письменности защищены mutex.
type fontFile struct {
	font *sfnt.Font
	upem int
	gsub []byte
	gpos []byte
	// glyphClass — GlyphClassDef таблицы GDEF (nil, если таблицы нет).
	glyphClass *classDef

	mu        sync.Mutex
	ligatures map[string][]ligatureLookup
	kerning   map[string][]pairLookup
}

var (
	fontsOnce sync.Once
	fontsErr  error
	regular   *fontFile
	bold      *fontFile
)

// loadFonts разбирает оба встроенных шрифта один раз за процесс.
func loadFonts() error {
	fontsOnce.Do(func() {
		regular, fontsErr = parseFontFile(resources.FontDejaVuSans)
		if fontsErr == nil {
			bold, fontsErr = parseFontFile(resources.FontDejaVuSansBold)
		}
	})
	return fontsErr
}

// fontFor — обычный или полужирный шрифт карточки.
func fontFor(isBold bool) (*fontFile, error) {
	if err := loadFonts(); err != nil {
		return nil, err
	}
	if isBold {
		return bold, nil
	}
	return regular, nil
}

// parseFontFile читает шрифт из resources и его таблицы OpenType Layout.
func parseFontFile(name string) (*fontFile, error) {
	data, err := resources.Font(name)
	if err != nil {
		return nil, err
	}
	parsed, err := sfnt.Parse(data)
	if err != nil {
		return nil, err
	}
	result := &fontFile{
		font:      parsed,
		upem:      int(parsed.UnitsPerEm()),
		gsub:      sfntTable(data, "GSUB"),
		gpos:      sfntTable(data, "GPOS"),
		ligatures: map[string][]ligatureLookup{},
		kerning:   map[string][]pairLookup{},
	}
	if gdef := sfntTable(data, "GDEF"); len(gdef) >= 6 {
		if offset := u16(gdef, 4); offset != 0 {
			result.glyphClass = parseClassDef(gdef, offset)
		}
	}
	return result, nil
}

// u16 и u32 — чтение big-endian без паники: за пределами таблицы — 0. Разбор встроенного шрифта
// проверен тестом, а нули на чужих данных лишь отключают лигатуру или пару кернинга.
func u16(data []byte, offset int) int {
	if offset < 0 || offset+2 > len(data) {
		return 0
	}
	return int(binary.BigEndian.Uint16(data[offset:]))
}

func u32(data []byte, offset int) int {
	if offset < 0 || offset+4 > len(data) {
		return 0
	}
	return int(binary.BigEndian.Uint32(data[offset:]))
}

func s16(data []byte, offset int) int { return int(int16(u16(data, offset))) }

// sfntTable — содержимое таблицы tag из каталога шрифта (nil, если её нет).
func sfntTable(data []byte, tag string) []byte {
	count := u16(data, 4)
	for index := 0; index < count; index++ {
		record := 12 + 16*index
		if record+16 > len(data) || string(data[record:record+4]) != tag {
			continue
		}
		start, length := u32(data, record+8), u32(data, record+12)
		if start+length > len(data) {
			return nil
		}
		return data[start : start+length]
	}
	return nil
}

// coverage — таблица Coverage: индекс глифа в покрытии или -1.
type coverage struct {
	glyphs []uint16 // формат 1
	ranges [][3]int // формат 2: start, end, startCoverageIndex
	format int
}

func parseCoverage(data []byte, offset int) coverage {
	result := coverage{format: u16(data, offset)}
	count := u16(data, offset+2)
	switch result.format {
	case 1:
		for index := 0; index < count; index++ {
			result.glyphs = append(result.glyphs, uint16(u16(data, offset+4+2*index)))
		}
	case 2:
		for index := 0; index < count; index++ {
			record := offset + 4 + 6*index
			result.ranges = append(result.ranges, [3]int{u16(data, record), u16(data, record+2), u16(data, record+4)})
		}
	}
	return result
}

func (c coverage) index(glyph sfnt.GlyphIndex) int {
	g := int(glyph)
	switch c.format {
	case 1:
		position := sort.Search(len(c.glyphs), func(i int) bool { return int(c.glyphs[i]) >= g })
		if position < len(c.glyphs) && int(c.glyphs[position]) == g {
			return position
		}
	case 2:
		position := sort.Search(len(c.ranges), func(i int) bool { return c.ranges[i][1] >= g })
		if position < len(c.ranges) && c.ranges[position][0] <= g {
			return c.ranges[position][2] + g - c.ranges[position][0]
		}
	}
	return -1
}

// classDef — таблица ClassDef: класс глифа, по умолчанию 0.
type classDef struct {
	start   int
	classes []uint16 // формат 1
	ranges  [][3]int // формат 2: start, end, class
	format  int
}

func parseClassDef(data []byte, offset int) *classDef {
	result := &classDef{format: u16(data, offset)}
	switch result.format {
	case 1:
		result.start = u16(data, offset+2)
		count := u16(data, offset+4)
		for index := 0; index < count; index++ {
			result.classes = append(result.classes, uint16(u16(data, offset+6+2*index)))
		}
	case 2:
		count := u16(data, offset+2)
		for index := 0; index < count; index++ {
			record := offset + 4 + 6*index
			result.ranges = append(result.ranges, [3]int{u16(data, record), u16(data, record+2), u16(data, record+4)})
		}
	}
	return result
}

func (c *classDef) class(glyph sfnt.GlyphIndex) int {
	if c == nil {
		return 0
	}
	g := int(glyph)
	switch c.format {
	case 1:
		if g >= c.start && g-c.start < len(c.classes) {
			return int(c.classes[g-c.start])
		}
	case 2:
		position := sort.Search(len(c.ranges), func(i int) bool { return c.ranges[i][1] >= g })
		if position < len(c.ranges) && c.ranges[position][0] <= g {
			return c.ranges[position][2]
		}
	}
	return 0
}

// Флаги lookup, которые учитываются при сопоставлении: пропуск базовых глифов, лигатур и меток
// по классам GDEF. MarkAttachmentType и UseMarkFilteringSet не поддерживаются (в DejaVu их нет у
// лигатур латиницы и кернинга).
const (
	ignoreBaseGlyphs = 0x2
	ignoreLigatures  = 0x4
	ignoreMarks      = 0x8
)

// skipped — глиф пропускается сопоставлением lookup с флагом flag.
func (f *fontFile) skipped(glyph sfnt.GlyphIndex, flag int) bool {
	if flag&(ignoreBaseGlyphs|ignoreLigatures|ignoreMarks) == 0 {
		return false
	}
	switch f.glyphClass.class(glyph) {
	case 1:
		return flag&ignoreBaseGlyphs != 0
	case 2:
		return flag&ignoreLigatures != 0
	case 3:
		return flag&ignoreMarks != 0
	}
	return false
}

// defaultGSUBFeatures — функции GSUB, которые HarfBuzz включает по умолчанию для
// горизонтального текста (кроме rvrn и ltra/ltrm, которых в DejaVu нет).
var defaultGSUBFeatures = map[string]bool{"ccmp": true, "locl": true, "rlig": true, "liga": true, "clig": true, "calt": true, "rclt": true}

// lookupIndices — индексы lookup, которые HarfBuzz применит к прогону письменности tag: система
// языка по умолчанию (при отсутствии письменности — DFLT, затем latn, как hb_ot_layout), её
// обязательная функция и функции из features. Возвращаются по возрастанию: так HarfBuzz
// обходит lookup внутри стадии.
func lookupIndices(table []byte, tag string, features map[string]bool) []int {
	if len(table) < 10 {
		return nil
	}
	scriptList, featureList := u16(table, 4), u16(table, 6)
	langSys := -1
	for _, candidate := range []string{tag, "DFLT", "dflt", "latn"} {
		count := u16(table, scriptList)
		for index := 0; index < count; index++ {
			record := scriptList + 2 + 6*index
			if record+6 > len(table) || string(table[record:record+4]) != candidate {
				continue
			}
			script := scriptList + u16(table, record+4)
			if offset := u16(table, script); offset != 0 {
				langSys = script + offset
			}
			break
		}
		if langSys >= 0 {
			break
		}
	}
	if langSys < 0 {
		return nil
	}
	seen := map[int]bool{}
	addFeature := func(index int) {
		record := featureList + 2 + 6*index
		if index >= u16(table, featureList) {
			return
		}
		feature := featureList + u16(table, record+4)
		for position := 0; position < u16(table, feature+2); position++ {
			seen[u16(table, feature+4+2*position)] = true
		}
	}
	if required := u16(table, langSys+2); required != 0xFFFF {
		addFeature(required)
	}
	for position := 0; position < u16(table, langSys+4); position++ {
		index := u16(table, langSys+6+2*position)
		record := featureList + 2 + 6*index
		if record+4 <= len(table) && features[string(table[record:record+4])] {
			addFeature(index)
		}
	}
	result := make([]int, 0, len(seen))
	for index := range seen {
		result = append(result, index)
	}
	sort.Ints(result)
	return result
}

// lookupSubtables — тип lookup, флаг и смещения подтаблиц от начала table; расширение (тип
// extension) разворачивается в реальный тип и смещение.
func lookupSubtables(table []byte, index, extension int) (kind, flag int, offsets []int) {
	lookupList := u16(table, 8)
	if index >= u16(table, lookupList) {
		return 0, 0, nil
	}
	lookup := lookupList + u16(table, lookupList+2+2*index)
	kind, flag = u16(table, lookup), u16(table, lookup+2)
	for position := 0; position < u16(table, lookup+4); position++ {
		offset := lookup + u16(table, lookup+6+2*position)
		if kind == extension {
			kind = u16(table, offset+2)
			offset += u32(table, offset+4)
		}
		offsets = append(offsets, offset)
	}
	return kind, flag, offsets
}

// ligature — замена последовательности first+components на glyph.
type ligature struct {
	glyph      sfnt.GlyphIndex
	components []sfnt.GlyphIndex
}

// ligatureLookup — lookup типа 4: подтаблицы по порядку, у каждой покрытие первого глифа и
// наборы лигатур по индексу покрытия (внутри набора — в порядке шрифта, первая совпавшая).
type ligatureLookup struct {
	flag      int
	subtables []ligatureSubtable
}

type ligatureSubtable struct {
	coverage coverage
	sets     [][]ligature
}

// ligatureLookups — lookup лигатур для письменности tag (кэшируются).
func (f *fontFile) ligatureLookups(tag string) []ligatureLookup {
	f.mu.Lock()
	defer f.mu.Unlock()
	if cached, ok := f.ligatures[tag]; ok {
		return cached
	}
	result := []ligatureLookup{}
	for _, index := range lookupIndices(f.gsub, tag, defaultGSUBFeatures) {
		kind, flag, offsets := lookupSubtables(f.gsub, index, 7)
		if kind != 4 {
			continue
		}
		lookup := ligatureLookup{flag: flag}
		for _, offset := range offsets {
			if u16(f.gsub, offset) != 1 {
				continue
			}
			subtable := ligatureSubtable{coverage: parseCoverage(f.gsub, offset+u16(f.gsub, offset+2))}
			for set := 0; set < u16(f.gsub, offset+4); set++ {
				setOffset := offset + u16(f.gsub, offset+6+2*set)
				items := []ligature{}
				for item := 0; item < u16(f.gsub, setOffset); item++ {
					ligOffset := setOffset + u16(f.gsub, setOffset+2+2*item)
					entry := ligature{glyph: sfnt.GlyphIndex(u16(f.gsub, ligOffset))}
					for component := 1; component < u16(f.gsub, ligOffset+2); component++ {
						entry.components = append(entry.components, sfnt.GlyphIndex(u16(f.gsub, ligOffset+2+2*component)))
					}
					items = append(items, entry)
				}
				subtable.sets = append(subtable.sets, items)
			}
			lookup.subtables = append(lookup.subtables, subtable)
		}
		result = append(result, lookup)
	}
	f.ligatures[tag] = result
	return result
}

// pairLookup — lookup PairPos (тип 2) функции kern.
type pairLookup struct {
	flag      int
	subtables []pairSubtable
}

// pairSubtable — подтаблица PairPos. Хранятся только XAdvance первого и второго глифа (x_offset
// на ширину строки не влияет) и длина второй записи: при непустой второй записи HarfBuzz
// пропускает второй глиф как начало следующей пары.
type pairSubtable struct {
	format   int
	coverage coverage
	len1     int
	len2     int
	xadv1    int // смещение XAdvance в записи значения 1 или -1
	xadv2    int
	data     []byte
	offset   int
	// Формат 1: наборы пар по индексу покрытия.
	pairSets []int
	// Формат 2: классы и матрица записей.
	class1, class2 *classDef
	class1Count    int
	class2Count    int
	records        int
}

// valueLayout — длина записи ValueRecord в байтах и смещение XAdvance в ней (-1 — поля нет).
func valueLayout(format int) (length, xadvance int) {
	length = 2 * bits.OnesCount16(uint16(format))
	xadvance = -1
	if format&0x4 != 0 {
		xadvance = 2 * bits.OnesCount16(uint16(format&0x3))
	}
	return length, xadvance
}

// kernLookups — lookup кернинга для письменности tag (кэшируются).
func (f *fontFile) kernLookups(tag string) []pairLookup {
	f.mu.Lock()
	defer f.mu.Unlock()
	if cached, ok := f.kerning[tag]; ok {
		return cached
	}
	result := []pairLookup{}
	for _, index := range lookupIndices(f.gpos, tag, map[string]bool{"kern": true}) {
		kind, flag, offsets := lookupSubtables(f.gpos, index, 9)
		if kind != 2 {
			continue
		}
		lookup := pairLookup{flag: flag}
		for _, offset := range offsets {
			subtable := pairSubtable{format: u16(f.gpos, offset), data: f.gpos, offset: offset}
			subtable.coverage = parseCoverage(f.gpos, offset+u16(f.gpos, offset+2))
			format1, format2 := u16(f.gpos, offset+4), u16(f.gpos, offset+6)
			subtable.len1, subtable.xadv1 = valueLayout(format1)
			subtable.len2, subtable.xadv2 = valueLayout(format2)
			switch subtable.format {
			case 1:
				for set := 0; set < u16(f.gpos, offset+8); set++ {
					subtable.pairSets = append(subtable.pairSets, offset+u16(f.gpos, offset+10+2*set))
				}
			case 2:
				subtable.class1 = parseClassDef(f.gpos, offset+u16(f.gpos, offset+8))
				subtable.class2 = parseClassDef(f.gpos, offset+u16(f.gpos, offset+10))
				subtable.class1Count, subtable.class2Count = u16(f.gpos, offset+12), u16(f.gpos, offset+14)
				subtable.records = offset + 16
			default:
				continue
			}
			lookup.subtables = append(lookup.subtables, subtable)
		}
		result = append(result, lookup)
	}
	f.kerning[tag] = result
	return result
}

// apply — PairPos для пары (first, second). applied — подтаблица сработала (HarfBuzz больше не
// пробует следующие подтаблицы этого lookup), adv1/adv2 — XAdvance в единицах шрифта.
func (p pairSubtable) apply(first, second sfnt.GlyphIndex) (applied bool, adv1, adv2 int) {
	index := p.coverage.index(first)
	if index < 0 {
		return false, 0, 0
	}
	value := func(record, at int) int {
		if at < 0 {
			return 0
		}
		return s16(p.data, record+at)
	}
	switch p.format {
	case 1:
		if index >= len(p.pairSets) {
			return false, 0, 0
		}
		set := p.pairSets[index]
		size := 2 + p.len1 + p.len2
		count := u16(p.data, set)
		// Пары набора отсортированы по второму глифу.
		position := sort.Search(count, func(i int) bool { return u16(p.data, set+2+size*i) >= int(second) })
		if position >= count || u16(p.data, set+2+size*position) != int(second) {
			return false, 0, 0
		}
		record := set + 2 + size*position + 2
		return true, value(record, p.xadv1), value(record+p.len1, p.xadv2)
	case 2:
		class1, class2 := p.class1.class(first), p.class2.class(second)
		if class1 >= p.class1Count || class2 >= p.class2Count {
			return false, 0, 0
		}
		record := p.records + (p.len1+p.len2)*(class1*p.class2Count+class2)
		return true, value(record, p.xadv1), value(record+p.len1, p.xadv2)
	}
	return false, 0, 0
}

// scriptTags — теги OpenType письменностей, которые есть в DejaVu Sans; остальные письменности
// HarfBuzz искал бы под своим тегом, не нашёл бы и взял DFLT — тот же итог даёт пустой тег.
var scriptTags = map[string]string{
	"Latin": "latn", "Cyrillic": "cyrl", "Greek": "grek", "Arabic": "arab", "Hebrew": "hebr",
	"Armenian": "armn", "Georgian": "geor", "Thai": "thai", "Lao": "lao ", "Braille": "brai",
	"Canadian_Aboriginal": "cans", "Cherokee": "cher", "Han": "hani", "Hiragana": "kana",
	"Katakana": "kana", "Nko": "nko ", "Ogham": "ogam", "Runic": "runr", "Tifinagh": "tfng",
}

// script — свойство Script символа по таблицам unicode (Unknown для неназначенных), как
// hb_unicode_script. Кириллица, латиница и общие символы проверяются первыми.
var scriptCache sync.Map

func script(r rune) string {
	if cached, ok := scriptCache.Load(r); ok {
		return cached.(string)
	}
	result := "Unknown"
	for _, name := range []string{"Common", "Latin", "Cyrillic", "Inherited"} {
		if unicode.Is(unicode.Scripts[name], r) {
			result = name
			break
		}
	}
	if result == "Unknown" {
		for name, table := range unicode.Scripts {
			if unicode.Is(table, r) {
				result = name
				break
			}
		}
	}
	scriptCache.Store(r, result)
	return result
}

// pairedChars — парные знаки Raqm (paired_chars в raqm.c): чётный индекс — открывающий.
var pairedChars = []rune{
	0x0028, 0x0029, 0x003c, 0x003e, 0x005b, 0x005d, 0x007b, 0x007d, 0x00ab, 0x00bb,
	0x2018, 0x2019, 0x201c, 0x201d, 0x2039, 0x203a, 0x3008, 0x3009, 0x300a, 0x300b,
	0x300c, 0x300d, 0x300e, 0x300f, 0x3010, 0x3011, 0x3014, 0x3015, 0x3016, 0x3017,
	0x3018, 0x3019, 0x301a, 0x301b,
}

func pairIndex(r rune) int {
	position := sort.Search(len(pairedChars), func(i int) bool { return pairedChars[i] >= r })
	if position < len(pairedChars) && pairedChars[position] == r {
		return position
	}
	return -1
}

// resolveScripts — письменность каждого символа после разрешения Common/Inherited, как
// _raqm_resolve_scripts: общие и наследуемые символы берут письменность последнего сильного
// символа, закрывающая парная скобка — письменность своей открывающей, ведущие общие символы —
// письменность следующего символа (обратный проход).
func resolveScripts(runes []rune) []string {
	scripts := make([]string, len(runes))
	for index, r := range runes {
		scripts[index] = script(r)
	}
	type entry struct {
		pair   int
		script string
	}
	stack := []entry{}
	lastScriptIndex, lastSetIndex := -1, -1
	lastScript := ""
	for index, r := range runes {
		switch {
		case scripts[index] == "Common" && lastScriptIndex != -1:
			pair := pairIndex(r)
			switch {
			case pair >= 0 && pair%2 == 0:
				scripts[index] = lastScript
				lastSetIndex = index
				stack = append(stack, entry{pair, scripts[index]})
			case pair >= 0:
				open := pair - 1
				for len(stack) > 0 && stack[len(stack)-1].pair != open {
					stack = stack[:len(stack)-1]
				}
				if len(stack) > 0 {
					scripts[index] = stack[len(stack)-1].script
					lastScript = scripts[index]
					stack = stack[:len(stack)-1]
				} else {
					scripts[index] = lastScript
				}
				lastSetIndex = index
			default:
				scripts[index] = lastScript
				lastSetIndex = index
			}
		case scripts[index] == "Inherited" && lastScriptIndex != -1:
			scripts[index] = lastScript
			lastSetIndex = index
		default:
			for previous := lastSetIndex + 1; previous < index; previous++ {
				scripts[previous] = scripts[index]
			}
			lastScript = scripts[index]
			lastScriptIndex = index
			lastSetIndex = index
		}
	}
	for index := len(runes) - 2; index >= 0; index-- {
		if scripts[index] == "Inherited" || scripts[index] == "Common" {
			scripts[index] = scripts[index+1]
		}
	}
	return scripts
}

// defaultIgnorable — hb_unicode_funcs_t::is_default_ignorable: такие символы HarfBuzz скрывает
// (нулевая ширина) и пропускает при сопоставлении пар кернинга.
func defaultIgnorable(r rune) bool {
	switch {
	case r == 0x00AD, r == 0x034F, r == 0x061C, r == 0x115F, r == 0x1160, r == 0x17B4, r == 0x17B5,
		r >= 0x180B && r <= 0x180F, r >= 0x200B && r <= 0x200F, r >= 0x202A && r <= 0x202E,
		r >= 0x2060 && r <= 0x206F, r == 0x3164, r >= 0xFE00 && r <= 0xFE0F, r == 0xFEFF, r == 0xFFA0,
		r >= 0xFFF0 && r <= 0xFFF8, r >= 0x1BCA0 && r <= 0x1BCA3, r >= 0x1D173 && r <= 0x1D17A,
		r >= 0xE0000 && r <= 0xE0FFF:
		return true
	}
	return false
}

// shapedGlyph — глиф после раскладки: индекс в шрифте и продвижение в 1/64 пикселя.
type shapedGlyph struct {
	index   sfnt.GlyphIndex
	advance int
	hidden  bool
}

// face — шрифт заданного кегля в пикселях (как ImageFont.truetype(path, point)).
type face struct {
	file *fontFile
	size int
	buf  sfnt.Buffer
}

// newFace — шрифт кегля size: обычный или полужирный.
func newFace(isBold bool, size int) (*face, error) {
	file, err := fontFor(isBold)
	if err != nil {
		return nil, err
	}
	return &face{file: file, size: size}, nil
}

// emScale — масштаб значения GPOS в 1/64 пикселя, как hb_font_t::em_scale: x_scale = size·64
// (hb-ft берёт его из метрик FreeType), mult = (x_scale<<16)/upem, результат
// (v·mult+32768)>>16 с арифметическим сдвигом.
func (f *face) emScale(value int) int {
	mult := (int64(f.size*64) << 16) / int64(f.file.upem)
	return int((int64(value)*mult + 32768) >> 16)
}

// ascent — font.getmetrics()[0] FreeType: восходящая hhea, округлённая вверх до пикселя. Якорь
// «la» draw.text ставит базовую линию на это расстояние ниже верхней координаты строки.
func (f *face) ascent() int {
	metrics, err := f.file.font.Metrics(&f.buf, fixed.I(f.size), font.HintingNone)
	if err != nil {
		return f.size
	}
	return metrics.Ascent.Ceil()
}

// shape раскладывает строку: прогоны по письменности, лигатуры и кернинг внутри прогона.
func (f *face) shape(text string) []shapedGlyph {
	runes := []rune(text)
	if len(runes) == 0 {
		return nil
	}
	scripts := resolveScripts(runes)
	result := make([]shapedGlyph, 0, len(runes))
	for start := 0; start < len(runes); {
		end := start + 1
		for end < len(runes) && scripts[end] == scripts[start] {
			end++
		}
		result = append(result, f.shapeRun(runes[start:end], scriptTags[scripts[start]])...)
		start = end
	}
	return result
}

// shapeRun — раскладка одного прогона письменности tag.
func (f *face) shapeRun(runes []rune, tag string) []shapedGlyph {
	glyphs := make([]shapedGlyph, len(runes))
	for index, r := range runes {
		glyph, err := f.file.font.GlyphIndex(&f.buf, r)
		if err != nil {
			glyph = 0
		}
		glyphs[index] = shapedGlyph{index: glyph, hidden: defaultIgnorable(r)}
	}
	for _, lookup := range f.file.ligatureLookups(tag) {
		glyphs = applyLigatures(f.file, lookup, glyphs)
	}
	for index := range glyphs {
		advance, err := f.file.font.GlyphAdvance(&f.buf, glyphs[index].index, fixed.I(f.size), font.HintingNone)
		if err == nil {
			glyphs[index].advance = int(advance)
		}
	}
	for _, lookup := range f.file.kernLookups(tag) {
		f.applyKerning(lookup, glyphs)
	}
	for index := range glyphs {
		// Скрытые символы и метки GDEF обнуляются после позиционирования (zero width marks late).
		if glyphs[index].hidden || f.file.glyphClass.class(glyphs[index].index) == 3 {
			glyphs[index].advance = 0
		}
	}
	return glyphs
}

// applyLigatures — один lookup лигатур слева направо: в позиции пробуются подтаблицы по порядку,
// в наборе — лигатуры по порядку; после замены обход продолжается за лигатурой. Компоненты
// сопоставляются подряд: пропуск меток между ними (флаг IgnoreMarks) не поддерживается.
func applyLigatures(file *fontFile, lookup ligatureLookup, glyphs []shapedGlyph) []shapedGlyph {
	result := make([]shapedGlyph, 0, len(glyphs))
	for index := 0; index < len(glyphs); {
		current := glyphs[index]
		consumed := 1
		if !current.hidden && !file.skipped(current.index, lookup.flag) {
		subtables:
			for _, subtable := range lookup.subtables {
				coverageIndex := subtable.coverage.index(current.index)
				if coverageIndex < 0 || coverageIndex >= len(subtable.sets) {
					continue
				}
				for _, candidate := range subtable.sets[coverageIndex] {
					if index+len(candidate.components) >= len(glyphs) && len(candidate.components) > 0 {
						continue
					}
					matched := true
					for offset, component := range candidate.components {
						next := glyphs[index+1+offset]
						if next.hidden || next.index != component {
							matched = false
							break
						}
					}
					if matched {
						current = shapedGlyph{index: candidate.glyph}
						consumed = 1 + len(candidate.components)
						break subtables
					}
				}
				// Покрытый первый глиф без совпавшей лигатуры: следующие подтаблицы пробуются.
			}
		}
		result = append(result, current)
		index += consumed
	}
	return result
}

// applyKerning — один lookup PairPos слева направо по правилам HarfBuzz: вторым глифом пары
// становится следующий непропускаемый глиф; после срабатывания обход продолжается со второго
// глифа (или за ним, если у подтаблицы есть вторая запись значения).
func (f *face) applyKerning(lookup pairLookup, glyphs []shapedGlyph) {
	skip := func(glyph shapedGlyph) bool { return glyph.hidden || f.file.skipped(glyph.index, lookup.flag) }
	for index := 0; index < len(glyphs); {
		if skip(glyphs[index]) {
			index++
			continue
		}
		next := index + 1
		for next < len(glyphs) && skip(glyphs[next]) {
			next++
		}
		if next >= len(glyphs) {
			break
		}
		applied := false
		for _, subtable := range lookup.subtables {
			ok, adv1, adv2 := subtable.apply(glyphs[index].index, glyphs[next].index)
			if !ok {
				continue
			}
			glyphs[index].advance += f.emScale(adv1)
			glyphs[next].advance += f.emScale(adv2)
			applied = true
			if subtable.len2 > 0 {
				next++
			}
			break
		}
		if applied {
			index = next
		} else {
			index++
		}
	}
}

// length — draw.textlength(text, font) в 1/64 пикселя: сумма продвижений после раскладки.
func (f *face) length(text string) int {
	total := 0
	for _, glyph := range f.shape(text) {
		total += glyph.advance
	}
	return total
}
