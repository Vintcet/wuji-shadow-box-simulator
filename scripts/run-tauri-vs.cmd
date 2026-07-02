@echo off
setlocal

set "MODE=%~1"
if "%MODE%"=="" goto usage
if /I not "%MODE%"=="dev" if /I not "%MODE%"=="build" goto usage

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSINSTALL="

if exist "%VSWHERE%" (
  for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
)

if "%VSINSTALL%"=="" set "VSINSTALL=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools"
if not exist "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" goto missing

call "%VSINSTALL%\Common7\Tools\VsDevCmd.bat" -arch=x64
if errorlevel 1 exit /b %errorlevel%

if /I "%MODE%"=="dev" (
  pnpm tauri dev
) else (
  pnpm tauri build
)
exit /b %errorlevel%

:usage
echo Usage: scripts\run-tauri-vs.cmd ^<dev^|build^>
exit /b 1

:missing
echo Missing Visual Studio Build Tools with C++ workload. Install Microsoft.VisualStudio.2022.BuildTools first.
exit /b 1
