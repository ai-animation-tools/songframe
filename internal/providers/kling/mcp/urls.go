package mcp

import (
	"net/url"
	"strconv"
	"strings"

	"songframe-go/internal/pycompat"
)

// Разбор адресов и форм urllib.parse CPython 3.12 в том объёме, в котором им пользуется клиент:
// схема результата (поле urlparse(...).scheme решает, скачивать ли оригинал без логотипа), хост
// и путь issuer при discovery, кодирование форм OAuth и разбор строки колбэка. net/url Go
// отличается в краевых случаях (регистр схемы, пробелы, порядок полей формы, пустые значения),
// поэтому правила реализованы отдельно.

// URLParts — urlparse(url): части адреса. Path — без параметров «;…» последнего сегмента, как у
// urlparse (не urlsplit).
type URLParts struct {
	Scheme   string
	Netloc   string
	Path     string
	Query    string
	Fragment string
}

// schemeChars — urllib.parse.scheme_chars.
const schemeChars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-."

// ParseURL — urlparse(url) для строки. Ошибка — ValueError("Invalid IPv6 URL") при непарной
// квадратной скобке в netloc, как у Python.
func ParseURL(raw string) (URLParts, error) {
	// WHATWG: ведущие управляющие символы и пробел отбрасываются, \t \r \n удаляются везде.
	raw = strings.TrimLeftFunc(raw, func(r rune) bool { return r <= ' ' })
	for _, unsafe := range []string{"\t", "\r", "\n"} {
		raw = strings.ReplaceAll(raw, unsafe, "")
	}
	parts := URLParts{}
	if index := strings.IndexByte(raw, ':'); index > 0 {
		first := raw[0]
		if (first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') {
			valid := true
			for _, r := range raw[:index] {
				if !strings.ContainsRune(schemeChars, r) {
					valid = false
					break
				}
			}
			if valid {
				parts.Scheme, raw = strings.ToLower(raw[:index]), raw[index+1:]
			}
		}
	}
	if strings.HasPrefix(raw, "//") {
		end := len(raw)
		for _, delimiter := range []string{"/", "?", "#"} {
			if found := strings.Index(raw[2:], delimiter); found >= 0 && found+2 < end {
				end = found + 2
			}
		}
		parts.Netloc, raw = raw[2:end], raw[end:]
		open, closed := strings.Contains(parts.Netloc, "["), strings.Contains(parts.Netloc, "]")
		if open != closed {
			return URLParts{}, pycompat.New(pycompat.ValueError, "Invalid IPv6 URL")
		}
	}
	if index := strings.IndexByte(raw, '#'); index >= 0 {
		raw, parts.Fragment = raw[:index], raw[index+1:]
	}
	if index := strings.IndexByte(raw, '?'); index >= 0 {
		raw, parts.Query = raw[:index], raw[index+1:]
	}
	parts.Path = withoutParams(parts.Scheme, raw)
	return parts, nil
}

// usesParams — urllib.parse.uses_params: схемы, у которых urlparse отделяет «;params».
var usesParams = map[string]bool{
	"": true, "ftp": true, "hdl": true, "prospero": true, "http": true, "imap": true, "https": true,
	"shttp": true, "rtsp": true, "rtsps": true, "rtspu": true, "sip": true, "sips": true, "mms": true,
	"sftp": true, "tel": true,
}

// withoutParams — путь без «;params» (_splitparams): точка с запятой ищется в последнем сегменте.
func withoutParams(scheme, path string) string {
	if !usesParams[scheme] || !strings.Contains(path, ";") {
		return path
	}
	var index int
	if slash := strings.LastIndexByte(path, '/'); slash >= 0 {
		index = strings.IndexByte(path[slash:], ';')
		if index < 0 {
			return path
		}
		index += slash
	} else {
		index = strings.IndexByte(path, ';')
	}
	return path[:index]
}

// URLScheme — urlparse(value).scheme; ошибка разбора — ValueError Python.
func URLScheme(value string) (string, error) {
	parts, err := ParseURL(value)
	return parts.Scheme, err
}

// Hostname — urlparse(...).hostname: хост без учётных данных и порта в нижнем регистре; пусто —
// None. IPv6 возвращается без скобок.
func (p URLParts) Hostname() string {
	host := p.Netloc
	if index := strings.LastIndexByte(host, '@'); index >= 0 {
		host = host[index+1:]
	}
	if strings.Contains(host, "[") {
		start := strings.IndexByte(host, '[')
		end := strings.IndexByte(host[start:], ']')
		if end < 0 {
			return ""
		}
		host = host[start+1 : start+end]
	} else if index := strings.IndexByte(host, ':'); index >= 0 {
		host = host[:index]
	}
	return strings.ToLower(host)
}

// Port — urlparse(...).port: (порт, задан ли). Нечисловой порт или вне 0–65535 — ValueError
// с текстом Python.
func (p URLParts) Port() (int, bool, error) {
	host := p.Netloc
	if index := strings.LastIndexByte(host, '@'); index >= 0 {
		host = host[index+1:]
	}
	var text string
	if strings.Contains(host, "[") {
		if index := strings.IndexByte(host, ']'); index >= 0 {
			rest := host[index+1:]
			if strings.HasPrefix(rest, ":") {
				text = rest[1:]
			}
		}
	} else if index := strings.IndexByte(host, ':'); index >= 0 {
		text = host[index+1:]
	}
	if text == "" {
		return 0, false, nil
	}
	valid := true
	for _, r := range text {
		if r < '0' || r > '9' {
			valid = false
		}
	}
	if !valid {
		return 0, false, pycompat.Raise(pycompat.ValueError, "Port could not be cast to integer value as %s", pycompat.Repr(text))
	}
	value, err := strconv.Atoi(text)
	if err != nil || value > 65535 {
		return 0, false, pycompat.New(pycompat.ValueError, "Port out of range 0-65535")
	}
	return value, true, nil
}

// Field — пара формы в порядке передачи: urlencode сохраняет порядок полей, а
// url.Values.Encode Go сортирует ключи.
type Field struct{ Name, Value string }

// URLEncode — urllib.parse.urlencode(fields) для строковых значений (quote_plus: безопасны буквы,
// цифры и «_.-~», пробел — «+»). url.QueryEscape кодирует по тому же правилу.
func URLEncode(fields []Field) string {
	parts := make([]string, len(fields))
	for index, field := range fields {
		parts[index] = url.QueryEscape(field.Name) + "=" + url.QueryEscape(field.Value)
	}
	return strings.Join(parts, "&")
}

// ParseQueryFirst — {key: values[0] for key, values in parse_qs(query).items()}: пары по «&»,
// пустые значения отбрасываются (keep_blank_values=False), пара без «=» пропускается, неверные
// %-последовательности остаются как есть (errors="replace"). Ключи — в порядке первого появления,
// значения — строки.
func ParseQueryFirst(query string) *pycompat.Dict {
	result := pycompat.NewDict()
	if query == "" {
		return result
	}
	for _, pair := range strings.Split(query, "&") {
		name, value, found := strings.Cut(pair, "=")
		if !found || value == "" {
			continue
		}
		name, value = unquotePlus(name), unquotePlus(value)
		if !result.Has(name) {
			result.Set(name, value)
		}
	}
	return result
}

// unquotePlus — urllib.parse.unquote_plus: «+» — пробел, %XX — байт; неполные и неверные
// последовательности сохраняются, невалидный UTF-8 заменяется U+FFFD.
func unquotePlus(text string) string {
	text = strings.ReplaceAll(text, "+", " ")
	if !strings.Contains(text, "%") {
		return text
	}
	data := make([]byte, 0, len(text))
	for index := 0; index < len(text); index++ {
		if text[index] == '%' && index+2 < len(text) && isHex(text[index+1]) && isHex(text[index+2]) {
			value, _ := strconv.ParseUint(text[index+1:index+3], 16, 8)
			data = append(data, byte(value))
			index += 2
			continue
		}
		data = append(data, text[index])
	}
	return DecodeReplace(data)
}

func isHex(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
}

// DecodeReplace — bytes.decode("utf-8", "replace"): каждая максимальная неверная
// подпоследовательность заменяется одним U+FFFD по правилам декодера CPython (strings.ToValidUTF8
// Go сворачивает серию ошибок в одну замену).
func DecodeReplace(data []byte) string {
	var builder strings.Builder
	for index := 0; index < len(data); {
		start := data[index]
		if start < 0x80 {
			builder.WriteByte(start)
			index++
			continue
		}
		need, low, high := 0, byte(0x80), byte(0xBF)
		switch {
		case start >= 0xC2 && start <= 0xDF:
			need = 1
		case start >= 0xE0 && start <= 0xEF:
			need = 2
			if start == 0xE0 {
				low = 0xA0
			} else if start == 0xED {
				high = 0x9F
			}
		case start >= 0xF0 && start <= 0xF4:
			need = 3
			if start == 0xF0 {
				low = 0x90
			} else if start == 0xF4 {
				high = 0x8F
			}
		default:
			builder.WriteRune('�')
			index++
			continue
		}
		valid := 0
		for offset := 1; offset <= need && index+offset < len(data); offset++ {
			value := data[index+offset]
			minimum, maximum := byte(0x80), byte(0xBF)
			if offset == 1 {
				minimum, maximum = low, high
			}
			if value < minimum || value > maximum {
				break
			}
			valid++
		}
		if valid == need {
			builder.Write(data[index : index+need+1])
		} else {
			builder.WriteRune('�')
		}
		index += valid + 1
	}
	return builder.String()
}
