// Package toolregex — регулярные выражения с поиском с возвратом и классами Unicode для шаблонов
// инструментов (lint_registry, shot_status, check_workspace и др.).
//
// Результаты инструментов зафиксированы эталонами, а стандартный regexp Go (RE2) ведёт себя
// иначе: в нём нет просмотра назад и вперёд (`(?<![\w_-])`, `(?![\d.])`), `\b`, `\w`, `\d` и `\s`
// работают только с ASCII, а `$` не совпадает перед завершающим переводом строки. Здесь —
// небольшой поиск с возвратом по дереву шаблона для используемого подмножества: литералы, `.`
// (любой символ, кроме перевода строки), классы `[...]` с диапазонами и `\d\w\s` внутри, группы
// (захватывающие, `(?:…)`, просмотр `(?=…)`, `(?!…)`, `(?<=…)`, `(?<!…)` фиксированной ширины),
// альтернативы, квантификаторы `* + ? {m} {m,} {m,n}` (жадные и ленивые), якоря
// `^ $ \A \Z \b \B` и флаг IgnoreCase.
//
// `\w`, `\d`, `\s` и `\b` работают с Unicode, `$` совпадает в конце текста и перед завершающим
// «\n», `\Z` — только в конце текста. Позиции совпадений — индексы кодовых точек, строки читаются
// через toolrt.Runes, поэтому одиночные суррогаты сохраняются. Шаблоны известны заранее: ошибка
// разбора — паника MustCompile при инициализации пакета-потребителя.
package toolregex

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"songframe/internal/toolrt"
)

// Flags — флаги компиляции шаблона.
type Flags int

// IgnoreCase — сравнение символов без учёта регистра (простая свёртка Unicode).
const IgnoreCase Flags = 1

// Regexp — скомпилированный шаблон. Безопасен для параллельного использования: состояние
// поиска живёт в отдельном matcher.
type Regexp struct {
	pattern string
	root    node
	groups  int
	fold    bool
}

// Match — найденное совпадение: границы всего совпадения и групп в кодовых точках текста.
type Match struct {
	text  []rune
	spans []int // пары [start, end] для группы 0..n; -1 — группа не участвовала
}

// Start — начало совпадения в кодовых точках.
func (m Match) Start() int { return m.spans[0] }

// End — конец совпадения в кодовых точках (не включая).
func (m Match) End() int { return m.spans[1] }

// Group — текст группы n (0 — всё совпадение); группа, не участвовавшая в совпадении, — пустая
// строка и false.
func (m Match) Group(n int) (string, bool) {
	start, end := m.spans[2*n], m.spans[2*n+1]
	if start < 0 {
		return "", false
	}
	return toolrt.FromRunes(m.text[start:end]), true
}

// Groups — значения групп 1..n как значения модели toolrt; не участвовавшая группа — nil (None).
func (m Match) Groups() []any {
	result := make([]any, len(m.spans)/2-1)
	for index := range result {
		if text, ok := m.Group(index + 1); ok {
			result[index] = text
		}
	}
	return result
}

// MustCompile — компиляция шаблона с флагами; неверный шаблон — паника (ошибка программиста).
func MustCompile(pattern string, flags Flags) *Regexp {
	p := &parser{runes: []rune(pattern)}
	root := p.alternation()
	if p.pos != len(p.runes) {
		panic(fmt.Sprintf("toolregex: лишний символ в позиции %d шаблона %q", p.pos, pattern))
	}
	return &Regexp{pattern: pattern, root: root, groups: p.groups, fold: flags&IgnoreCase != 0}
}

// String — исходный шаблон.
func (r *Regexp) String() string { return r.pattern }

// Search — первое совпадение слева направо.
func (r *Regexp) Search(text string) (Match, bool) {
	return r.searchRunes(toolrt.Runes(text), 0)
}

// MatchString — совпадение, начинающееся с начала строки.
func (r *Regexp) MatchString(text string) (Match, bool) {
	runes := toolrt.Runes(text)
	return r.at(runes, 0, false)
}

// FullMatch — совпадение ровно на всю строку.
func (r *Regexp) FullMatch(text string) (Match, bool) {
	runes := toolrt.Runes(text)
	return r.at(runes, 0, true)
}

// FindAll — все непересекающиеся совпадения по порядку; после пустого совпадения поиск
// сдвигается на один символ.
func (r *Regexp) FindAll(text string) []Match {
	runes := toolrt.Runes(text)
	result := []Match{}
	for position := 0; position <= len(runes); {
		match, ok := r.searchRunes(runes, position)
		if !ok {
			break
		}
		result = append(result, match)
		if match.End() == match.Start() {
			position = match.End() + 1
		} else {
			position = match.End()
		}
	}
	return result
}

func (r *Regexp) searchRunes(runes []rune, from int) (Match, bool) {
	for start := from; start <= len(runes); start++ {
		if match, ok := r.at(runes, start, false); ok {
			return match, true
		}
	}
	return Match{}, false
}

// at пробует совпадение с позиции start; full — только до конца текста.
func (r *Regexp) at(runes []rune, start int, full bool) (Match, bool) {
	m := &matcher{text: runes, fold: r.fold, spans: make([]int, 2*(r.groups+1))}
	for index := range m.spans {
		m.spans[index] = -1
	}
	ok := r.root.match(m, start, func(end int) bool {
		if full && end != len(runes) {
			return false
		}
		m.spans[0], m.spans[1] = start, end
		return true
	})
	if !ok {
		return Match{}, false
	}
	return Match{text: runes, spans: m.spans}, true
}

// matcher — состояние одного поиска: текст, флаг регистра и границы групп (откатываются при возврате).
type matcher struct {
	text  []rune
	fold  bool
	spans []int
}

// node — узел шаблона. match пытается сопоставить узел с позиции i и для каждого варианта
// вызывает продолжение k с позицией конца; true — совпадение всего шаблона найдено.
type node interface {
	match(m *matcher, i int, k func(int) bool) bool
	// width — фиксированная ширина в символах (для просмотра назад) или -1.
	width() int
}

// ----- классы символов

// isWord — \w: буквы (L*), числа (N*: десятичные цифры, прочие цифры и числовые символы) и «_».
func isWord(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsNumber(r) }

// isDigit — \d: десятичные цифры Unicode (Nd).
func isDigit(r rune) bool { return unicode.Is(unicode.Nd, r) }

// isSpace — \s: пробельные символы toolrt.IsSpace.
func isSpace(r rune) bool { return toolrt.IsSpace(r) }

// classItem — элемент класса: диапазон или встроенный класс (с отрицанием).
type classItem struct {
	low, high rune
	builtin   func(rune) bool
	negate    bool
}

type charClass struct {
	items  []classItem
	negate bool
}

func (c *charClass) contains(r rune) bool {
	for _, item := range c.items {
		var hit bool
		if item.builtin != nil {
			hit = item.builtin(r) != item.negate
		} else {
			hit = r >= item.low && r <= item.high
		}
		if hit {
			return true
		}
	}
	return false
}

// test — принадлежность с учётом IGNORECASE: символ или любой из его вариантов свёртки.
func (c *charClass) test(r rune, fold bool) bool {
	hit := c.contains(r)
	if !hit && fold {
		for other := unicode.SimpleFold(r); other != r; other = unicode.SimpleFold(other) {
			if c.contains(other) {
				hit = true
				break
			}
		}
	}
	return hit != c.negate
}

// single — узел одного символа: литерал, `.` или класс.
type single struct {
	literal rune
	isLit   bool
	any     bool
	class   *charClass
}

func sameFold(a, b rune) bool {
	if a == b {
		return true
	}
	for other := unicode.SimpleFold(a); other != a; other = unicode.SimpleFold(other) {
		if other == b {
			return true
		}
	}
	return false
}

func (s *single) test(m *matcher, r rune) bool {
	switch {
	case s.any:
		return r != '\n'
	case s.isLit:
		if m.fold {
			return sameFold(r, s.literal)
		}
		return r == s.literal
	default:
		return s.class.test(r, m.fold)
	}
}

func (s *single) match(m *matcher, i int, k func(int) bool) bool {
	if i < len(m.text) && s.test(m, m.text[i]) {
		return k(i + 1)
	}
	return false
}

func (s *single) width() int { return 1 }

// ----- составные узлы

type sequence []node

func (s sequence) match(m *matcher, i int, k func(int) bool) bool {
	if len(s) == 0 {
		return k(i)
	}
	return s[0].match(m, i, func(j int) bool { return s[1:].match(m, j, k) })
}

func (s sequence) width() int {
	total := 0
	for _, item := range s {
		w := item.width()
		if w < 0 {
			return -1
		}
		total += w
	}
	return total
}

type alternation []node

func (a alternation) match(m *matcher, i int, k func(int) bool) bool {
	for _, option := range a {
		if option.match(m, i, k) {
			return true
		}
	}
	return false
}

func (a alternation) width() int {
	w := -2
	for _, option := range a {
		current := option.width()
		if current < 0 || (w != -2 && current != w) {
			return -1
		}
		w = current
	}
	if w == -2 {
		return 0
	}
	return w
}

// repeat — квантификатор: от min до max повторов (max < 0 — без предела), жадный или ленивый.
type repeat struct {
	child    node
	min, max int
	lazy     bool
}

func (r *repeat) match(m *matcher, i int, k func(int) bool) bool {
	var step func(count, at int) bool
	step = func(count, at int) bool {
		more := func() bool {
			if r.max >= 0 && count >= r.max {
				return false
			}
			return r.child.match(m, at, func(j int) bool {
				// Пустое повторение после минимума не продвигает поиск (защита от зацикливания).
				if j == at && count >= r.min {
					return false
				}
				return step(count+1, j)
			})
		}
		if count < r.min {
			return more()
		}
		if r.lazy {
			return k(at) || more()
		}
		return more() || k(at)
	}
	return step(0, i)
}

func (r *repeat) width() int {
	if r.min == r.max {
		if w := r.child.width(); w >= 0 {
			return w * r.min
		}
	}
	return -1
}

// group — захватывающая группа с номером index.
type group struct {
	index int
	child node
}

func (g *group) match(m *matcher, i int, k func(int) bool) bool {
	oldStart, oldEnd := m.spans[2*g.index], m.spans[2*g.index+1]
	if g.child.match(m, i, func(j int) bool {
		previousStart, previousEnd := m.spans[2*g.index], m.spans[2*g.index+1]
		m.spans[2*g.index], m.spans[2*g.index+1] = i, j
		if k(j) {
			return true
		}
		m.spans[2*g.index], m.spans[2*g.index+1] = previousStart, previousEnd
		return false
	}) {
		return true
	}
	m.spans[2*g.index], m.spans[2*g.index+1] = oldStart, oldEnd
	return false
}

func (g *group) width() int { return g.child.width() }

// look — просмотр вперёд или назад (behind), положительный или отрицательный.
type look struct {
	child    node
	behind   bool
	negative bool
}

func (l *look) match(m *matcher, i int, k func(int) bool) bool {
	saved := append([]int(nil), m.spans...)
	found := false
	if l.behind {
		w := l.child.width()
		if i-w >= 0 {
			found = l.child.match(m, i-w, func(j int) bool { return j == i })
		}
	} else {
		found = l.child.match(m, i, func(int) bool { return true })
	}
	if l.negative {
		copy(m.spans, saved)
		if found {
			return false
		}
		return k(i)
	}
	if !found {
		copy(m.spans, saved)
		return false
	}
	if k(i) {
		return true
	}
	copy(m.spans, saved)
	return false
}

func (l *look) width() int { return 0 }

// anchor — позиционное условие нулевой ширины.
type anchor func(m *matcher, i int) bool

func (a anchor) match(m *matcher, i int, k func(int) bool) bool {
	return a(m, i) && k(i)
}

func (a anchor) width() int { return 0 }

func wordAt(m *matcher, i int) bool { return i >= 0 && i < len(m.text) && isWord(m.text[i]) }

var (
	atStart       anchor = func(_ *matcher, i int) bool { return i == 0 }
	atEnd         anchor = func(m *matcher, i int) bool { return i == len(m.text) }
	atEndOrNL     anchor = func(m *matcher, i int) bool { return i == len(m.text) || (i == len(m.text)-1 && m.text[i] == '\n') }
	atBoundary    anchor = func(m *matcher, i int) bool { return wordAt(m, i-1) != wordAt(m, i) }
	notAtBoundary anchor = func(m *matcher, i int) bool { return wordAt(m, i-1) == wordAt(m, i) }
)

// ----- разбор шаблона

type parser struct {
	runes  []rune
	pos    int
	groups int
}

func (p *parser) peek() (rune, bool) {
	if p.pos < len(p.runes) {
		return p.runes[p.pos], true
	}
	return 0, false
}

func (p *parser) fail(message string) {
	panic(fmt.Sprintf("toolregex: %s в позиции %d шаблона %q", message, p.pos, string(p.runes)))
}

func (p *parser) alternation() node {
	options := []node{p.sequence()}
	for {
		r, ok := p.peek()
		if !ok || r != '|' {
			break
		}
		p.pos++
		options = append(options, p.sequence())
	}
	if len(options) == 1 {
		return options[0]
	}
	return alternation(options)
}

func (p *parser) sequence() node {
	items := sequence{}
	for {
		r, ok := p.peek()
		if !ok || r == '|' || r == ')' {
			return items
		}
		atom := p.atom()
		items = append(items, p.quantified(atom))
	}
}

// quantified разбирает квантификатор после атома; `{` без верной формы — литерал.
func (p *parser) quantified(atom node) node {
	r, ok := p.peek()
	if !ok {
		return atom
	}
	low, high := -1, -1
	switch r {
	case '*':
		low, high = 0, -1
		p.pos++
	case '+':
		low, high = 1, -1
		p.pos++
	case '?':
		low, high = 0, 1
		p.pos++
	case '{':
		end := p.pos + 1
		for end < len(p.runes) && p.runes[end] != '}' {
			end++
		}
		if end >= len(p.runes) {
			return atom
		}
		body := string(p.runes[p.pos+1 : end])
		first, second, hasComma := strings.Cut(body, ",")
		parse := func(text string, fallback int) (int, bool) {
			if text == "" {
				return fallback, true
			}
			value, err := strconv.Atoi(text)
			return value, err == nil && value >= 0
		}
		lowValue, okLow := parse(first, 0)
		highValue, okHigh := lowValue, true
		if hasComma {
			highValue, okHigh = parse(second, -1)
		}
		if !okLow || !okHigh || (first == "" && !hasComma) {
			return atom
		}
		low, high = lowValue, highValue
		p.pos = end + 1
	default:
		return atom
	}
	lazy := false
	if next, ok := p.peek(); ok && next == '?' {
		lazy = true
		p.pos++
	}
	return &repeat{child: atom, min: low, max: high, lazy: lazy}
}

func (p *parser) atom() node {
	r := p.runes[p.pos]
	p.pos++
	switch r {
	case '.':
		return &single{any: true}
	case '^':
		return atStart
	case '$':
		return atEndOrNL
	case '[':
		return &single{class: p.class()}
	case '(':
		return p.group()
	case '\\':
		return p.escape()
	case '*', '+', '?':
		p.fail("квантификатор без атома")
	}
	return &single{literal: r, isLit: true}
}

func (p *parser) group() node {
	if r, ok := p.peek(); ok && r == '?' {
		p.pos++
		kind := p.runes[p.pos]
		p.pos++
		var result node
		switch kind {
		case ':':
			result = p.alternation()
		case '=', '!':
			result = &look{child: p.alternation(), negative: kind == '!'}
		case '<':
			direction := p.runes[p.pos]
			p.pos++
			if direction != '=' && direction != '!' {
				p.fail("именованные группы не поддерживаются")
			}
			child := p.alternation()
			if child.width() < 0 {
				p.fail("просмотр назад требует фиксированной ширины")
			}
			result = &look{child: child, behind: true, negative: direction == '!'}
		default:
			p.fail("неподдерживаемая группа")
		}
		p.closeGroup()
		return result
	}
	p.groups++
	index := p.groups
	child := p.alternation()
	p.closeGroup()
	return &group{index: index, child: child}
}

func (p *parser) closeGroup() {
	if r, ok := p.peek(); !ok || r != ')' {
		p.fail("нет закрывающей скобки")
	}
	p.pos++
}

// escapeClass — встроенный класс по букве экранирования.
func escapeClass(r rune) (classItem, bool) {
	switch r {
	case 'd':
		return classItem{builtin: isDigit}, true
	case 'D':
		return classItem{builtin: isDigit, negate: true}, true
	case 'w':
		return classItem{builtin: isWord}, true
	case 'W':
		return classItem{builtin: isWord, negate: true}, true
	case 's':
		return classItem{builtin: isSpace}, true
	case 'S':
		return classItem{builtin: isSpace, negate: true}, true
	}
	return classItem{}, false
}

// escapedRune — символ экранирования \n, \t, \xhh, \uXXXX или экранированный знак.
func (p *parser) escapedRune(r rune) rune {
	switch r {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	case 'f':
		return '\f'
	case 'v':
		return '\v'
	case 'a':
		return '\a'
	case 'x', 'u', 'U':
		size := map[rune]int{'x': 2, 'u': 4, 'U': 8}[r]
		if p.pos+size > len(p.runes) {
			p.fail("неполное экранирование")
		}
		value, err := strconv.ParseUint(string(p.runes[p.pos:p.pos+size]), 16, 32)
		if err != nil {
			p.fail("неверное экранирование")
		}
		p.pos += size
		return rune(value)
	}
	if unicode.IsLetter(r) || unicode.IsDigit(r) {
		p.fail("неподдерживаемое экранирование \\" + string(r))
	}
	return r
}

func (p *parser) escape() node {
	r := p.runes[p.pos]
	p.pos++
	if item, ok := escapeClass(r); ok {
		return &single{class: &charClass{items: []classItem{item}}}
	}
	switch r {
	case 'b':
		return atBoundary
	case 'B':
		return notAtBoundary
	case 'A':
		return atStart
	case 'Z':
		return atEnd
	}
	return &single{literal: p.escapedRune(r), isLit: true}
}

// class разбирает `[...]` после открывающей скобки: `]` первым символом — литерал, `-` по краям —
// литерал.
func (p *parser) class() *charClass {
	c := &charClass{}
	if r, ok := p.peek(); ok && r == '^' {
		c.negate = true
		p.pos++
	}
	first := true
	for {
		if p.pos >= len(p.runes) {
			p.fail("незакрытый класс")
		}
		r := p.runes[p.pos]
		if r == ']' && !first {
			p.pos++
			return c
		}
		first = false
		p.pos++
		var low rune
		if r == '\\' {
			escaped := p.runes[p.pos]
			p.pos++
			if item, ok := escapeClass(escaped); ok {
				c.items = append(c.items, item)
				continue
			}
			low = p.escapedRune(escaped)
		} else {
			low = r
		}
		high := low
		if p.pos+1 < len(p.runes) && p.runes[p.pos] == '-' && p.runes[p.pos+1] != ']' {
			p.pos++
			next := p.runes[p.pos]
			p.pos++
			if next == '\\' {
				escaped := p.runes[p.pos]
				p.pos++
				high = p.escapedRune(escaped)
			} else {
				high = next
			}
			if high < low {
				p.fail("неверный диапазон")
			}
		}
		c.items = append(c.items, classItem{low: low, high: high})
	}
}
