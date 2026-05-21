@echo off
setlocal
if "%1"=="devices" (
  if "%IPTV_HUB_TEST_SDB_MODE%"=="no-devices" (
    echo List of devices attached
    exit /b 0
  )
  echo List of devices attached
  echo 0123456789ABCDEF	device
  exit /b 0
)
if "%1"=="install" (
  if "%IPTV_HUB_TEST_SDB_MODE%"=="install-fail" (
    echo install failed: corrupted ipk 1>&2
    exit /b 1
  )
  echo Installed %2
  exit /b 0
)
if "%1"=="-s" (
  if "%3"=="devices" (
    if "%IPTV_HUB_TEST_SDB_MODE%"=="no-devices" (
      echo List of devices attached
      exit /b 0
    )
    echo List of devices attached
    echo %2	device
    exit /b 0
  )
  if "%3"=="install" (
    if "%IPTV_HUB_TEST_SDB_MODE%"=="install-fail" (
      echo install failed: corrupted ipk 1>&2
      exit /b 1
    )
    echo Installed %4 on %2
    exit /b 0
  )
)
echo unknown subcommand: %1 1>&2
exit /b 2
