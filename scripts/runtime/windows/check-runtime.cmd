@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 1
set "SONGFRAME_RUNTIME_SMOKE=%CD%\result.json"
set "SONGFRAME_LOCAL_DIR=%CD%\check-state\local"
>"check.log" echo %DATE% %TIME%
>>"check.log" echo %CD%
>"result.json" echo {"ok":false,"stage":"launcher"}
start "" /wait "%~dp0SongFrame.exe" "--user-data-dir=%CD%\check-state\userdata" >>"check.log" 2>&1
set "SONGFRAME_CHECK_EXIT=%ERRORLEVEL%"
>>"check.log" echo {"exitCode":%SONGFRAME_CHECK_EXIT%}
echo %CD%
echo check.log
echo result.json
if exist "result.json" type "result.json"
popd
pause
exit /b %SONGFRAME_CHECK_EXIT%
