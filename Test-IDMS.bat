@echo off
setlocal
cd /d "%~dp0"

set "APP=%~dp0IDMS.exe"
set "LOG=%~dp0idms-test.log"

(
  echo IDMS test baslatildi: %DATE% %TIME%
  echo Uygulama: "%APP%"
) > "%LOG%" 2>&1

if not exist "%APP%" (
  (
    echo HATA: IDMS.exe bulunamadi.
    echo Once proje klasorunde npm run dist komutuyla paketi olusturun.
  ) >> "%LOG%" 2>&1
  type "%LOG%"
  pause
  exit /b 1
)

echo IDMS baslatiliyor. Kayit: "%LOG%"
echo.
(
  echo.
  echo --- IDMS baslatma ciktisi ---
) >> "%LOG%"
"%APP%" --enable-logging --v=1 >> "%LOG%" 2>&1
set "RESULT=%ERRORLEVEL%"

(
  echo.
  echo IDMS kapandi. Cikis kodu: %RESULT%
  echo Test tamamlandi: %DATE% %TIME%
) >> "%LOG%" 2>&1
type "%LOG%"
pause
exit /b %RESULT%
