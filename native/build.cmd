@echo off
setlocal
cd /d "%~dp0"
set "FLOAT_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%FLOAT_VSWHERE%" (
  echo Install Visual Studio 2022 Build Tools with Desktop development with C++.
  exit /b 1
)
for /f "usebackq tokens=*" %%i in (`"%FLOAT_VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "FLOAT_VS=%%i"
if not defined FLOAT_VS exit /b 1
call "%FLOAT_VS%\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 exit /b 1
if not exist "..\.build\native" mkdir "..\.build\native"
if /i "%~1"=="--test" (
  cl /nologo /O2 /EHsc /MT /std:c++17 ..\tests\native-envelopes.cpp /Fo:..\.build\native\NativeEnvelopes.obj /Fe:..\.build\native\NativeEnvelopes.exe
  if errorlevel 1 exit /b 1
  ..\.build\native\NativeEnvelopes.exe
  exit /b
)
cl /nologo /O2 /EHsc /MT /std:c++17 /DNTDDI_VERSION=0x0A00000A SpotifyAudio.cpp /Fo:..\.build\native\SpotifyAudio.obj /Fe:SpotifyAudio.exe /link mmdevapi.lib ole32.lib uuid.lib
exit /b %ERRORLEVEL%
