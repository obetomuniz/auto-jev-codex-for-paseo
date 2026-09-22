@echo off
setlocal
if defined PASEO_CLI goto run
for /f "delims=" %%I in ('where paseo.cmd 2^>nul') do if not defined PASEO_CLI set "PASEO_CLI=%%I"
if defined PASEO_CLI goto run
set "PASEO_CLI=%LOCALAPPDATA%\Programs\Paseo\resources\bin\paseo.cmd"
:run
if not exist "%PASEO_CLI%" (
  echo Paseo CLI not found. Install Paseo Desktop or set PASEO_CLI to its CLI path. 1>&2
  exit /b 1
)
call "%PASEO_CLI%" %*
exit /b %errorlevel%
