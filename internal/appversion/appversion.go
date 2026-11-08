// Package appversion хранит версию собранного приложения. Сборочные сценарии передают её
// из packaging/VERSION через -ldflags "-X songframe-go/internal/appversion.Version=…";
// запуск из исходников без них получает версию разработки 1.0.0-dev: она младше выпуска
// 1.0.0, но старше выпусков Electron 0.x, которые лежат в том же репозитории.
package appversion

// Version — версия этой сборки в SemVer: X.Y.Z у выпуска, X.Y.Z-суффикс у ранних сборок.
var Version = "1.0.0-dev"
