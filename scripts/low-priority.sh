#!/bin/sh
# Запускает команду с пониженным приоритетом процессора и диска и на половине физических ядер:
# полный прогон проверок не отнимает отзывчивость у остальной работы машины. Одного nice мало:
# при загрузке всех ядер интерфейс открытого приложения (WebKit) всё равно подтормаживает, потому что
# делит с проверками кэши и потоки SMT. Поэтому команде достаются оба потока первой половины ядер, а
# вторая половина остаётся свободной. Привязку и приоритет наследуют все дочерние процессы (go test,
# Chromium Playwright, Vite); Go и Playwright берут число потоков из доступных ядер. Где нужной
# программы нет (lscpu и taskset — Linux), соответствующий шаг пропускается.
set -eu
if command -v lscpu >/dev/null 2>&1 && command -v taskset >/dev/null 2>&1; then
	# CPU,CORE по строке на логический процессор; ядра нумеруются подряд с нуля.
	cpus=$(lscpu -p=CPU,CORE | awk -F, '
		/^#/ { next }
		{ cpu[NR] = $1; core[NR] = $2; if ($2 + 1 > cores) cores = $2 + 1 }
		END {
			for (i in cpu) if (core[i] < cores / 2 || cores < 2) list = list (list == "" ? "" : ",") cpu[i]
			print list
		}')
	if [ -n "$cpus" ]; then set -- taskset -c "$cpus" "$@"; fi
fi
if command -v ionice >/dev/null 2>&1; then set -- ionice -c3 "$@"; fi
if command -v nice >/dev/null 2>&1; then set -- nice -n 19 "$@"; fi
exec "$@"
