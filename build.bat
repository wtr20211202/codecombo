@echo off
setlocal enabledelayedexpansion

REM Version = nearest reachable v* tag (strip "v" prefix); falls back to dev when no tag
REM (CI shallow clones need git fetch --tags first).
REM NOTE: keep this file ASCII-only. cmd parses batch files with the OEM codepage
REM (e.g. CP936 on zh-CN Windows); UTF-8 comments here get mis-tokenized and cmd
REM tries to execute the mojibake as a command (observed: em-dash+for bytes swallowed
REM the following ASCII, breaking parsing on line 5).
REM describe must run as a direct redirected command into a temp file - a for /f
REM inline backquoted run mangles --abbrev=0 (the "0" ends up a positional arg).
set VERSION=dev
git describe --tags --match "v[0-9]*" --abbrev=0 >"%TEMP%\sc_ver.tmp" 2>nul
for /f "usebackq delims=" %%i in ("%TEMP%\sc_ver.tmp") do set VERSION=%%i
if not "%VERSION%"=="dev" set VERSION=%VERSION:~1%
del "%TEMP%\sc_ver.tmp" 2>nul

for /f "delims=" %%i in ('git rev-parse HEAD 2^>nul') do set COMMIT=%%i
if "%COMMIT%"=="" set COMMIT=unknown

for /f "delims=" %%i in ('powershell -command "[DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')"') do set BUILD_TIME=%%i
if "%BUILD_TIME%"=="" set BUILD_TIME=unknown

set LDFLAGS=-s -w -X main.version=%VERSION% -X main.commit=%COMMIT% -X main.buildTime=%BUILD_TIME%

REM parity with build.sh: inject self-update verification pubkey (ed25519) via ldflags
if defined CC_UPDATE_PUBKEY (
    set "LDFLAGS=%LDFLAGS% -X codecombo/server/update.updatePubKey=%CC_UPDATE_PUBKEY%"
    echo ==^> Update verification pubkey: INJECTED (ed25519^)
) else (
    echo ==^> Update verification pubkey: NOT SET (dev build; updates will require CC_UPDATE_ALLOW_UNVERIFIED=1^)
)

echo ==^> Version: %VERSION% (%COMMIT%, %BUILD_TIME%)
echo ==^> Building frontend...
cd web
call npm install
call npm run build
cd ..

if exist dist rmdir /s /q dist
mkdir dist

set TARGET=%1

REM parity with build.sh: convenience entry for update signing keypair
if "%TARGET%"=="keygen" (
    go run ./tools/updatekey keygen
    goto :end
)

if "%TARGET%"=="all" (
    echo ==^> Building all platforms...

    echo     Building windows/amd64...
    set CGO_ENABLED=0
    set GOOS=windows
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-windows-amd64.exe .
    call :sign_artifact dist\codecombo-windows-amd64.exe

    echo     Building windows/arm64...
    set GOARCH=arm64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-windows-arm64.exe .
    call :sign_artifact dist\codecombo-windows-arm64.exe

    echo     Building linux/amd64...
    set GOOS=linux
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-linux-amd64 .
    call :sign_artifact dist\codecombo-linux-amd64

    echo     Building linux/arm64...
    set GOARCH=arm64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-linux-arm64 .
    call :sign_artifact dist\codecombo-linux-arm64

    echo     Building darwin/amd64...
    set GOOS=darwin
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-darwin-amd64 .
    call :sign_artifact dist\codecombo-darwin-amd64

    echo     Building darwin/arm64...
    set GOARCH=arm64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-darwin-arm64 .
    call :sign_artifact dist\codecombo-darwin-arm64
) else if "%TARGET%"=="windows" (
    echo ==^> Building windows/amd64...
    set CGO_ENABLED=0
    set GOOS=windows
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-windows-amd64.exe .
    call :sign_artifact dist\codecombo-windows-amd64.exe
) else if "%TARGET%"=="linux" (
    echo ==^> Building linux/amd64...
    set CGO_ENABLED=0
    set GOOS=linux
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-linux-amd64 .
    call :sign_artifact dist\codecombo-linux-amd64
) else if "%TARGET%"=="darwin" (
    echo ==^> Building darwin/amd64...
    set CGO_ENABLED=0
    set GOOS=darwin
    set GOARCH=amd64
    go build -ldflags "%LDFLAGS%" -o dist\codecombo-darwin-amd64 .
    call :sign_artifact dist\codecombo-darwin-amd64
) else (
    echo ==^> Building current platform...
    REM parity with build.sh build_target: disable cgo (native build stays static, no dynamic libc)
    set CGO_ENABLED=0
    go build -ldflags "%LDFLAGS%" -o dist\simple-coding.exe .
    call :sign_artifact dist\simple-coding.exe
)

echo ==^> Output:
dir /b dist
echo ==^> Done!
goto :end

REM parity with build.sh sign_artifact: emit companion verification assets
REM   .sha256 = lowercase hex digest (consumed by verifyChecksum)
REM   .sig    = ed25519 signature (base64) of the hex digest (consumed by verifySignature)
:sign_artifact
if "%CC_UPDATE_PRIVATE_KEY%"=="" goto :eof
powershell -command "(Get-FileHash -Algorithm SHA256 '%~1').Hash.ToLower()" > "%~1.sha256"
go run ./tools/updatekey sign %CC_UPDATE_PRIVATE_KEY% < "%~1" > "%~1.sig"
echo     Signed: %~nx1 (+.sha256 +.sig)
goto :eof

:end
endlocal
