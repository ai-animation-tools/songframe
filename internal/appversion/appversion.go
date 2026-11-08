// Package appversion хранит версию собранного приложения. Сборочные сценарии передают её
// из packaging/VERSION через -ldflags "-X songframe/internal/appversion.Version=…";
// запуск из исходников без них получает версию разработки 1.0.0-dev: по SemVer она младше
// выпуска 1.0.0.
package appversion

// Version — версия этой сборки в SemVer: X.Y.Z у выпуска, X.Y.Z-суффикс у ранних сборок.
var Version = "1.0.0-dev"
