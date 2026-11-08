# -*- coding: utf-8 -*-
# Минимальная поставка Go/Wails: программа, DLL Visual C++ для ORT рядом с ней и лицензии.
# Профиль, проекты и компоненты принадлежат пользователю и не удаляются этим установщиком.
Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "WinVer.nsh"
!include "x64.nsh"
!include "WordFunc.nsh"
!include "FileFunc.nsh"

# Все входы определяет сборочный сценарий; случайных fallback в чужой checkout нет.
!ifndef VERSION
  !error "Не передан VERSION"
!endif
!ifndef NUMERIC_VERSION
  !error "Не передан NUMERIC_VERSION из четырёх чисел"
!endif
!ifndef BINARY
  !error "Не передан BINARY"
!endif
!ifndef WEBVIEW_BOOTSTRAPPER
  !error "Не передан WEBVIEW_BOOTSTRAPPER"
!endif
!ifndef VCRUNTIME
  !error "Не передан VCRUNTIME (папка DLL Visual C++)"
!endif
!ifndef OUTPUT
  !error "Не передан OUTPUT"
!endif
!ifndef ICON
  !error "Не передан ICON"
!endif
!ifndef LICENSES
  !error "Не передан LICENSES"
!endif

!define PRODUCT "SongFrame"
; Папка установки и ключ удаления отличаются от Electron SongFrame (D-038): его папка
; %LOCALAPPDATA%\Programs\SongFrame и профиль не затрагиваются.
!define INSTALL_NAME "SongFrame Desktop"
!define EXE "songframe.exe"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SongFrameDesktop"
!define WEBVIEW_KEY "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${PRODUCT} ${VERSION}"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\${INSTALL_NAME}"
RequestExecutionLevel user
ManifestDPIAware true
ManifestSupportedOS all
SetCompressor /SOLID lzma
SetCompressorDictSize 16
SetOverwrite on
AllowSkipFiles off
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${NUMERIC_VERSION}"
VIFileVersion "${NUMERIC_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "${PRODUCT}"
VIAddVersionKey /LANG=1033 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1033 "FileDescription" "Установщик ${PRODUCT}"
VIAddVersionKey /LANG=1033 "CompanyName" "Yarkov Aleksey"
VIAddVersionKey /LANG=1033 "LegalCopyright" "© 2026 Yarkov Aleksey"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "Будет установлен SongFrame для текущего пользователя.$\r$\n$\r$\nПеред установкой закройте SongFrame. Проекты, профиль и внешние компоненты сохраняются.$\r$\n$\r$\nЕсли Microsoft WebView2 отсутствует, установщик загрузит его через официальный bootstrapper. Для этого может потребоваться интернет."
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Запустить ${PRODUCT}"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!define MUI_FINISHPAGE_TEXT "SongFrame установлен.$\r$\n$\r$\nFFmpeg, ONNX Runtime и модели устанавливаются в приложении, в разделе «Компоненты»."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Var WebViewPresent
Var BootstrapExit

# Все контролируемые отказы получают ненулевой код и сообщение также в silent-режиме.
# /SD предотвращает зависание автоматической проверки на окне сообщения.
!macro Fail CODE MESSAGE
  DetailPrint "${MESSAGE}"
  MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}" /SD IDOK
  SetErrorLevel ${CODE}
  Quit
!macroend

# Проверка сохраняет байты старого exe: OPEN_EXISTING без truncate и без принудительной остановки.
# Повторена для uninstall; запущенный процесс или иной lock требует закрыть приложение и повторить.
!macro CheckExecutableUnlocked PREFIX
Function ${PREFIX}CheckExecutableUnlocked
  IfFileExists "$INSTDIR\${EXE}" 0 unlocked
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${EXE}", i 0x40000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  ${If} $0 == -1
    !insertmacro Fail 73 "Не удалось открыть файл SongFrame для замены или удаления. Закройте приложение и повторите. Если оно уже закрыто, проверьте права доступа к папке приложения."
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
unlocked:
FunctionEnd
!macroend
!insertmacro CheckExecutableUnlocked ""
!insertmacro CheckExecutableUnlocked "un."

# UI и silent-установка используют одну архитектурную границу. Путь фиксирован в профиле пользователя,
# поэтому /D не превращает ранний uninstaller в очистку произвольной выбранной папки.
Function .onInit
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${INSTALL_NAME}"
  ${IfNot} ${AtLeastWin10}
    !insertmacro Fail 64 "SongFrame поддерживает только Windows 10 и Windows 11 (x64)."
  ${EndIf}
  ${If} ${IsServerOS}
    !insertmacro Fail 64 "Эта ранняя поставка предназначена для Windows 10 и Windows 11; Windows Server не поддерживается."
  ${EndIf}
  ${IfNot} ${IsNativeAMD64}
    !insertmacro Fail 65 "Для этой поставки SongFrame требуется Windows x64 на процессоре AMD64/Intel 64."
  ${EndIf}
  SetRegView 64
  Call CheckExecutableUnlocked
FunctionEnd

# WebView2 обнаруживается по Microsoft pv: машинная 32-битная ветка и пользовательская установка.
# Непустой ключ с 0.0.0.0 не означает готовый runtime. Источник контракта:
# https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
Function DetectWebView2
  StrCpy $WebViewPresent 0
  SetRegView 32
  ReadRegStr $0 HKLM "${WEBVIEW_KEY}" "pv"
  ${If} $0 != ""
    ${VersionCompare} "$0" "0.0.0.0" $1
    ${If} $1 == 1
      StrCpy $WebViewPresent 1
    ${EndIf}
  ${EndIf}
  ReadRegStr $0 HKCU "${WEBVIEW_KEY}" "pv"
  ${If} $0 != ""
    ${VersionCompare} "$0" "0.0.0.0" $1
    ${If} $1 == 1
      StrCpy $WebViewPresent 1
    ${EndIf}
  ${EndIf}
  SetRegView 64
FunctionEnd

# Bootstrapper запускается без повышения прав. Его exit code не подменяет повторную проверку pv:
# даже код 0 без установленного runtime завершает установку до изменения файлов приложения.
Function EnsureWebView2
  Call DetectWebView2
  ${If} $WebViewPresent == 1
    DetailPrint "Microsoft WebView2 Runtime уже установлен."
    Return
  ${EndIf}
  DetailPrint "Установка Microsoft WebView2 Runtime для текущего пользователя…"
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  ClearErrors
  File /oname=MicrosoftEdgeWebview2Setup.exe "${WEBVIEW_BOOTSTRAPPER}"
  ${If} ${Errors}
    !insertmacro Fail 70 "Не удалось извлечь установщик Microsoft WebView2. Проверьте свободное место и повторите установку."
  ${EndIf}
  StrCpy $BootstrapExit -1
  ClearErrors
  ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $BootstrapExit
  ${If} ${Errors}
    StrCpy $BootstrapExit -1
  ${EndIf}
  Call DetectWebView2
  ${If} $WebViewPresent != 1
    !insertmacro Fail 71 "Microsoft WebView2 Runtime не установлен (код bootstrapper: $BootstrapExit). Проверьте интернет или установите WebView2 Runtime отдельно с сайта Microsoft, затем повторите установку SongFrame."
  ${EndIf}
  DetailPrint "Microsoft WebView2 Runtime подтверждён после установки (код: $BootstrapExit)."
FunctionEnd

Section "SongFrame" InstallApplication
  SectionIn RO
  SetShellVarContext current
  SetRegView 64
  Call EnsureWebView2
  # За время установки WebView2 пользователь мог снова запустить старую программу.
  Call CheckExecutableUnlocked
  SetOutPath "$INSTDIR"
  ClearErrors
  File /oname=songframe.exe "${BINARY}"
  ${If} ${Errors}
    !insertmacro Fail 74 "Не удалось записать SongFrame. Закройте приложение, проверьте свободное место и права доступа, затем повторите установку."
  ${EndIf}
  SetOutPath "$INSTDIR\licenses"
  ClearErrors
  File /r "${LICENSES}/*"
  ${If} ${Errors}
    !insertmacro Fail 74 "Не удалось установить лицензионные материалы. Проверьте свободное место и повторите установку."
  ${EndIf}
  # DLL Visual C++ нужны отдельно скачиваемому ONNX Runtime: Windows ищет их в папке программы.
  SetOutPath "$INSTDIR"
  ClearErrors
  File "${VCRUNTIME}\msvcp140.dll"
  File "${VCRUNTIME}\msvcp140_1.dll"
  File "${VCRUNTIME}\vcruntime140.dll"
  File "${VCRUNTIME}\vcruntime140_1.dll"
  ${If} ${Errors}
    !insertmacro Fail 74 "Не удалось записать библиотеки Microsoft Visual C++. Закройте приложение, проверьте свободное место и повторите установку."
  ${EndIf}
  # Ранние сборки клали отдельный vc_redist в prerequisites; он больше не нужен.
  Delete "$INSTDIR\prerequisites\vc_redist.x64.exe"
  Delete "$INSTDIR\prerequisites\README.txt"
  RMDir "$INSTDIR\prerequisites"
  SetOutPath "$INSTDIR"
  ClearErrors
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortcut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Yarkov Aleksey"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '$\"$INSTDIR\uninstall.exe$\"'
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" '$\"$INSTDIR\uninstall.exe$\" /S'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  ${If} ${Errors}
    !insertmacro Fail 74 "Не удалось зарегистрировать установку или создать ярлыки. Проверьте права доступа и повторите установку."
  ${EndIf}
  # GetSize использует собственный error flag, поэтому вызывается только после проверки записи metadata.
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  ${IfNot} ${Errors}
    WriteRegDWORD HKCU "${UNINSTALL_KEY}" "EstimatedSize" $0
  ${EndIf}
  SetErrorLevel 0
SectionEnd

# Путь uninstall также фиксирован: не доверяем перемещению uninstall.exe или произвольному /D.
# Удаляются только файлы комплекта. UserData, папки компонентов и проекты не затрагиваются.
Function un.onInit
  SetShellVarContext current
  SetRegView 64
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${INSTALL_NAME}"
  Call un.CheckExecutableUnlocked
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  SetRegView 64
  Call un.CheckExecutableUnlocked
  ClearErrors
  Delete "$INSTDIR\${EXE}"
  ${If} ${Errors}
    !insertmacro Fail 74 "Не удалось удалить SongFrame. Закройте приложение и повторите удаление; профиль и проекты сохранены."
  ${EndIf}
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  Delete "$INSTDIR\msvcp140.dll"
  Delete "$INSTDIR\msvcp140_1.dll"
  Delete "$INSTDIR\vcruntime140.dll"
  Delete "$INSTDIR\vcruntime140_1.dll"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\uninstall.exe"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  # Нерекурсивный RMDir сохраняет любые прочие файлы и выбранные пользователем каталоги.
  RMDir "$INSTDIR"
  SetErrorLevel 0
SectionEnd
