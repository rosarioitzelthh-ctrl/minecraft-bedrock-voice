@echo off
title Minecraft Bedrock Proximity Voice - MODO ONLINE
echo ============================================================
echo   Minecraft Bedrock Proximity Voice - MODO ONLINE (Amigos)
echo ============================================================
echo.
echo 1. Iniciando servidor de voz en puerto 3000 y puente MC en 3001...
start "VoiceServer" /MIN cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:3000

echo 2. Creando enlace publico HTTPS para tus amigos...
echo    (Copia la URL https://... que aparece abajo y pasasela a tus amigos!)
echo    Tambien puedes ponerla en Minecraft con: !voz link https://...
echo.
ssh -o StrictHostKeyChecking=no -R 80:localhost:3000 nokey@localhost.run
echo.
echo Si SSH fallo, puedes usar: ngrok http 3000
pause
