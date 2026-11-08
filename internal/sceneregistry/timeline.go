package sceneregistry

import (
	"math/big"
	"strings"

	"songframe-go/internal/pycompat"
)

// Seconds — seconds(number, fps): кадр в секундах Decimal с шестью знаками после запятой без
// хвостовых нулей («12.5», «0»). number — значение Python (обычно int), fps — делитель (int).
func Seconds(number any, fps any) (string, error) {
	value, err := pycompat.NewDecimal(number)
	if err != nil {
		return "", err
	}
	divisor, err := pycompat.DecimalOperand(fps, "/")
	if err != nil {
		return "", err
	}
	quotient, err := value.Div(divisor)
	if err != nil {
		return "", err
	}
	rounded, err := quotient.Quantize(-6)
	if err != nil {
		return "", err
	}
	text := strings.TrimRight(strings.TrimRight(rounded.FormatF(), "0"), ".")
	if text == "" {
		return "0", nil
	}
	return text, nil
}

// Clock — clock(value): «ММ:СС.d» для секунд (строка, int или float Python): минуты — int(value)
// // 60 с дополнением до двух знаков, секунды — остаток Decimal со всеми его цифрами.
func Clock(value any) (string, error) {
	number, err := pycompat.NewDecimal(value)
	if err != nil {
		return "", err
	}
	remainder, err := number.Mod(pycompat.DecimalInt(60))
	if err != nil {
		return "", err
	}
	text := remainder.FormatF()
	if !strings.Contains(text, ".") {
		text += ".0"
	}
	whole, err := number.ToInt()
	if err != nil {
		return "", err
	}
	minutes := new(big.Int).Div(whole.Big(), big.NewInt(60)) // деление с округлением вниз, как //
	padded := minutes.String()
	if minutes.Sign() < 0 {
		padded = "-" + leftPad(padded[1:], 1)
	} else {
		padded = leftPad(padded, 2)
	}
	less, err := remainder.Cmp(pycompat.DecimalInt(10))
	if err != nil {
		return "", err
	}
	zero := ""
	if less < 0 {
		zero = "0"
	}
	return padded + ":" + zero + text, nil
}

// leftPad — дополнение нулями слева до ширины width (f"{n:02}").
func leftPad(text string, width int) string {
	if len(text) >= width {
		return text
	}
	return strings.Repeat("0", width-len(text)) + text
}

// Shots — shots(data, initial): планы реестра с монтажным временем для карточек, раскадровки и
// сборки. Каждый план — копия полей реестра плюс title (свой или части), sequence_title, start/end
// (секунды строкой; у последнего end — end_seconds реестра как есть), duration, interval
// («ММ:СС.d–ММ:СС.d»), frames, state (continuity) и refs (references без заглушки «—»).
func Shots(data any, initial *pycompat.Dict) ([]*pycompat.Dict, error) {
	document, err := Validate(data, initial)
	if err != nil {
		return nil, err
	}
	sequences, err := pycompat.Iter(document.Value("sequences"))
	if err != nil {
		return nil, err
	}
	titleKeys := newKeyed()
	for _, item := range sequences {
		id, err := pycompat.GetItem(item, "id")
		if err != nil {
			return nil, err
		}
		title, err := pycompat.GetItem(item, "title")
		if err != nil {
			return nil, err
		}
		if err := titleKeys.set(id, title); err != nil {
			return nil, err
		}
	}
	scenes, _ := pycompat.Iter(document.Value("scenes"))
	fps := document.Value("fps")
	result := make([]*pycompat.Dict, 0, len(scenes))
	for index, item := range scenes {
		scene := item.(*pycompat.Dict)
		start, err := Seconds(scene.Value("start_frame"), fps)
		if err != nil {
			return nil, err
		}
		var end any
		if index == len(scenes)-1 {
			audio, err := pycompat.GetItem(document, "audio")
			if err != nil {
				return nil, err
			}
			if end, err = pycompat.GetItem(audio, "end_seconds"); err != nil {
				return nil, err
			}
		} else if end, err = Seconds(scene.Value("end_frame_exclusive"), fps); err != nil {
			return nil, err
		}
		finish, err := pycompat.NewDecimal(end)
		if err != nil {
			return nil, err
		}
		begin, _ := pycompat.NewDecimal(start)
		length, err := finish.Sub(begin)
		if err != nil {
			return nil, err
		}
		sequenceTitle, found, err := titleKeys.get(scene.Value("sequence"))
		if err != nil {
			return nil, err
		}
		if !found {
			return nil, pycompat.NewKeyError(scene.Value("sequence"))
		}
		title, _ := pycompat.DictGet(scene, "title", sequenceTitle)
		from, err := Clock(start)
		if err != nil {
			return nil, err
		}
		to, err := Clock(end)
		if err != nil {
			return nil, err
		}
		frames, err := pycompat.Sub(scene.Value("end_frame_exclusive"), scene.Value("start_frame"))
		if err != nil {
			return nil, err
		}
		continuity, err := pycompat.GetItem(scene, "continuity")
		if err != nil {
			return nil, err
		}
		references, _ := pycompat.Iter(scene.Value("references"))
		refs := []any{}
		for _, reference := range references {
			if !pycompat.Equal(reference, "—") {
				refs = append(refs, reference)
			}
		}
		shot := scene.Clone()
		shot.Set("title", title)
		shot.Set("sequence_title", sequenceTitle)
		shot.Set("start", start)
		shot.Set("end", end)
		shot.Set("duration", length.FormatF())
		shot.Set("interval", from+"–"+to)
		shot.Set("frames", frames)
		shot.Set("state", continuity)
		shot.Set("refs", refs)
		result = append(result, shot)
	}
	return result, nil
}
