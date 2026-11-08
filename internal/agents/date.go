package agents

import (
	"regexp"
	"strconv"
	"time"
)

// isoDate — формат даты-времени ECMAScript (Date Time String Format), который проверяют и
// переводят во время сброса лимиты Claude: дата, время до минут, необязательные секунды с долями
// и смещение. Значения других форм (устаревший разбор V8) считаются отсутствующими.
var isoDate = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$`)

// parseDate — Date.parse для формата ISO: миллисекунды Unix-времени и ok=false для неверной даты.
// Без смещения время местное, как требует спецификация для даты со временем.
func parseDate(value string) (float64, bool) {
	match := isoDate.FindStringSubmatch(value)
	if match == nil {
		return 0, false
	}
	number := func(index int) int {
		result, _ := strconv.Atoi(match[index])
		return result
	}
	year, month, day, hour, minute := number(1), number(2), number(3), number(4), number(5)
	second := 0
	if match[6] != "" {
		second = number(6)
	}
	milliseconds := 0
	if fraction := match[7]; fraction != "" {
		for len(fraction) < 3 {
			fraction += "0"
		}
		milliseconds, _ = strconv.Atoi(fraction[:3])
	}
	if month < 1 || month > 12 || day < 1 || day > time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC).Day() ||
		hour > 24 || minute > 59 || second > 59 || (hour == 24 && (minute != 0 || second != 0 || milliseconds != 0)) {
		return 0, false
	}
	location := time.Local
	switch zone := match[8]; {
	case zone == "Z":
		location = time.UTC
	case zone != "":
		hours, _ := strconv.Atoi(zone[1:3])
		minutes, _ := strconv.Atoi(zone[4:6])
		if hours > 23 || minutes > 59 {
			return 0, false
		}
		offset := hours*3600 + minutes*60
		if zone[0] == '-' {
			offset = -offset
		}
		location = time.FixedZone("", offset)
	}
	moment := time.Date(year, time.Month(month), day, hour, minute, second, milliseconds*int(time.Millisecond), location)
	return float64(moment.UnixMilli()), true
}
