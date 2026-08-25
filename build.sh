#!/usr/bin/env bash
# Збирає standalone-сторінку з тіла документа.
#
# src/document.html написаний як ТІЛО сторінки — так його вимагає обгортка
# артефакта claude.ai, яка сама додає doctype і head. Для звичайного хостингу
# ці теги потрібні свої, інакше браузер іде в quirks mode, а кодування
# залежить від заголовків сервера. Тут вони й додаються.
set -euo pipefail

out=dist
mkdir -p "$out"

# <title> у тілі дублював би той, що в head, — прибираємо його з тіла.
sed '0,\#<title>.*</title>#{\#<title>.*</title>#d}' src/document.html > "$out/.body.tmp"

cat wrapper/head.html "$out/.body.tmp" wrapper/tail.html > "$out/index.html"
rm -f "$out/.body.tmp"

cp static/robots.txt static/_headers "$out/"

printf 'Зібрано %s (%s байт)\n' "$out/index.html" "$(wc -c < "$out/index.html")"
