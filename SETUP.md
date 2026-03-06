# Zenvest — Инструкция по локальному развёртыванию

## Что нужно установить

| Программа | Зачем | Ссылка |
|-----------|-------|--------|
| Docker Desktop | Запуск PostgreSQL и Redis в контейнерах | https://www.docker.com/products/docker-desktop/ |
| Node.js 20+ | Запуск самого приложения | https://nodejs.org/ (LTS версия) |
| Git | Уже есть, раз залил на GitHub | — |
| ffmpeg | Конвертация голосовых сообщений | https://www.gyan.dev/ffmpeg/builds/ |

> **whisper.cpp** — нужен для распознавания голосовых. Можно пропустить на первом этапе — бот будет работать, просто голосовые не будут транскрибироваться.

---

## Шаг 1: Установка Docker Desktop

1. Скачай **Docker Desktop** с https://www.docker.com/products/docker-desktop/
2. Запусти установщик, следуй инструкциям (все галочки по умолчанию)
3. После установки может потребоваться **перезагрузка компьютера**
4. Docker попросит включить **WSL 2** (Windows Subsystem for Linux) — соглашайся
   - Если появится ошибка про WSL, открой PowerShell от администратора и выполни:
     ```
     wsl --install
     ```
   - После этого перезагрузи компьютер
5. Запусти Docker Desktop — в трее появится иконка кита
6. Подожди пока статус станет **"Docker Desktop is running"** (зелёный индикатор внизу слева)

### Как проверить что Docker работает

Открой терминал (cmd, PowerShell или Git Bash) и выполни:

```bash
docker --version
# Должно вывести что-то вроде: Docker version 27.x.x

docker compose version
# Должно вывести: Docker Compose version v2.x.x
```

---

## Шаг 2: Установка Node.js

1. Скачай **Node.js LTS** с https://nodejs.org/ (кнопка LTS — зелёная)
2. Установи, всё по умолчанию
3. Проверь:

```bash
node --version
# v20.x.x или выше

npm --version
# 10.x.x или выше
```

---

## Шаг 3: Установка ffmpeg

1. Скачай **ffmpeg** с https://www.gyan.dev/ffmpeg/builds/
   - Нужна версия **"ffmpeg-release-essentials.zip"** (или .7z)
2. Распакуй архив, например в `C:\ffmpeg\`
3. Внутри будет папка вроде `ffmpeg-7.1-essentials_build\bin\` — там лежит `ffmpeg.exe`
4. **Добавь путь к ffmpeg в PATH**:
   - Нажми Win + S, найди **"Переменные среды"** (или "Environment Variables")
   - В блоке **"Системные переменные"** найди `Path`, нажми "Изменить"
   - Нажми "Создать" и добавь путь к папке bin, например: `C:\ffmpeg\ffmpeg-7.1-essentials_build\bin`
   - Нажми OK везде
5. **Перезапусти терминал** и проверь:

```bash
ffmpeg -version
# Должно вывести версию
```

---

## Шаг 4: Запуск PostgreSQL и Redis через Docker

Открой терминал в папке проекта (`zenvest/`) и выполни:

```bash
docker compose up -d
```

**Что происходит:**
- Docker скачивает образы PostgreSQL и Redis (только первый раз, ~150 МБ)
- Создаёт и запускает 2 контейнера: `zenvest-postgres` и `zenvest-redis`
- Флаг `-d` значит "в фоне" (detached) — терминал не блокируется

### Как проверить что контейнеры работают

```bash
docker compose ps
```

Должно показать оба сервиса со статусом **"Up"** и **(healthy)**:

```
NAME               STATUS          PORTS
zenvest-postgres   Up (healthy)    0.0.0.0:5432->5432/tcp
zenvest-redis      Up (healthy)    0.0.0.0:6379->6379/tcp
```

### Полезные команды Docker

```bash
# Посмотреть логи PostgreSQL
docker compose logs postgres

# Посмотреть логи Redis
docker compose logs redis

# Остановить всё
docker compose down

# Остановить и УДАЛИТЬ данные (база будет пустая)
docker compose down -v

# Перезапустить
docker compose restart
```

---

## Шаг 5: Настройка .env файла

```bash
# Скопируй шаблон (в Git Bash или вручную)
cp .env.example .env
```

Открой `.env` в любом редакторе и заполни:

```env
# === ОБЯЗАТЕЛЬНО заполнить ===

# Telegram — получи у @BotFather в Telegram
TELEGRAM_BOT_TOKEN=123456789:ABCdef...

# Gemini API — получи на https://aistudio.google.com/apikey
GEMINI_API_KEY=AIzaSy...

# PostgreSQL — оставь как есть, совпадает с docker-compose
POSTGRES_PASSWORD=changeme
DATABASE_URL=postgresql://zenvest:changeme@localhost:5432/zenvest

# Redis — оставь как есть
REDIS_URL=redis://localhost:6379

# === ОПЦИОНАЛЬНО (можно пропустить) ===

# Google Sheets — если хочешь синхронизацию
# GOOGLE_SERVICE_ACCOUNT_JSON=./credentials/service-account.json
# GOOGLE_SHEET_ID=your_sheet_id_here

# whisper.cpp — если установил (см. раздел ниже)
# WHISPER_MODEL_PATH=./models/ggml-medium.bin
# WHISPER_BINARY_PATH=/path/to/whisper.cpp/main

# Приложение
PORT=3000
NODE_ENV=development
DAILY_REPORT_TIME=20:00
TIMEZONE=Europe/Prague
```

### Как получить Telegram Bot Token

1. Открой Telegram, найди **@BotFather**
2. Отправь `/newbot`
3. Введи имя бота (например: Zenvest Test Bot)
4. Введи username бота (например: zenvest_test_bot)
5. BotFather пришлёт токен — скопируй его в `.env`

### Как получить Gemini API Key

1. Открой https://aistudio.google.com/apikey
2. Войди с Google-аккаунтом
3. Нажми "Create API Key"
4. Скопируй ключ в `.env`

---

## Шаг 6: Установка зависимостей и запуск

```bash
# Установить npm-пакеты
npm install

# Запустить приложение в режиме разработки
npm run dev
```

**Что происходит при запуске:**
1. Подключается к PostgreSQL → создаёт таблицы (миграции)
2. Проверяет подключение к Redis
3. Запускает HTTP-сервер на порту 3000
4. Запускает Telegram-бота (начинает слушать сообщения)
5. Запускает планировщик (суточный отчёт в 20:00)

### Как проверить что всё работает

1. **Health check** — открой в браузере http://localhost:3000/health
   - Должен вернуть: `{"status":"ok","db":true,"redis":true,"sheets":false}`
   - `sheets: false` — это нормально, если не настроил Google Sheets

2. **Логи** — в терминале увидишь:
   ```
   Starting Zenvest...
   Database initialized, migrations up to date
   HTTP server on port 3000
   Telegram bot started
   ```

3. **Telegram** — добавь бота в тестовую группу и попробуй:
   - `/register Тест` — зарегистрировать объект
   - Отправить текстовое сообщение — должно записаться в буфер
   - Отправить фото чека — бот должен ответить результатом распознавания
   - `/hours 8` — записать рабочие часы

---

## Типичные проблемы

### "Database connection failed" / "ECONNREFUSED 5432"

PostgreSQL не запущен. Проверь:
```bash
docker compose ps
# Если не запущен:
docker compose up -d
```

### "Redis connection failed" / "ECONNREFUSED 6379"

Аналогично — Redis не запущен:
```bash
docker compose up -d
```

### "409: Conflict: terminated by other getUpdates request"

Бот уже запущен где-то ещё (другой терминал, сервер). Telegram разрешает только одно активное подключение. Останови другой экземпляр.

### "TELEGRAM_BOT_TOKEN is required"

Не заполнен `.env` файл. Проверь что файл `.env` существует и токен указан.

### Docker Desktop не запускается / ошибка WSL

1. Открой PowerShell от администратора
2. Выполни: `wsl --install`
3. Перезагрузи компьютер
4. Запусти Docker Desktop снова

### Порт 5432 или 6379 уже занят

Если у тебя уже установлен PostgreSQL или Redis локально:
```bash
# Проверь что занимает порт (в PowerShell от администратора)
netstat -ano | findstr :5432
```
Вариант: останови локальный сервис или измени порты в `docker-compose.yml`.

---

## Полный порядок запуска (чеклист)

Каждый раз когда садишься работать:

```bash
# 1. Убедись что Docker Desktop запущен (иконка кита в трее)

# 2. Запусти базы данных (если не запущены)
docker compose up -d

# 3. Запусти приложение
npm run dev

# 4. Проверь здоровье
# Открой http://localhost:3000/health
```

Для остановки:
```bash
# Ctrl+C в терминале — остановит приложение
# Docker-контейнеры продолжат работать (это нормально)

# Если хочешь остановить и контейнеры:
docker compose down
```

---

## Опционально: whisper.cpp (голосовые сообщения)

> Без whisper.cpp бот работает, но голосовые сообщения не будут транскрибироваться. Можно настроить позже.

На Windows whisper.cpp проще всего собрать через WSL (Ubuntu):

```bash
# В WSL (Ubuntu)
git clone https://github.com/ggerganov/whisper.cpp.git
cd whisper.cpp
make

# Скачать модель (1.5 ГБ)
bash models/download-ggml-model.sh medium
```

Потом в `.env` укажи пути (через WSL):
```env
WHISPER_MODEL_PATH=/path/to/whisper.cpp/models/ggml-medium.bin
WHISPER_BINARY_PATH=/path/to/whisper.cpp/main
```

---

## Опционально: Google Sheets

1. Создай проект в Google Cloud Console: https://console.cloud.google.com/
2. Включи Google Sheets API
3. Создай Service Account → скачай JSON-ключ
4. Положи файл ключа в `zenvest/credentials/service-account.json`
5. Создай Google Таблицу, расшарь её для email сервис-аккаунта (из JSON, поле `client_email`)
6. Скопируй ID таблицы из URL (длинная строка между `/d/` и `/edit`)
7. Заполни в `.env`:
```env
GOOGLE_SERVICE_ACCOUNT_JSON=./credentials/service-account.json
GOOGLE_SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms
```

---

## Структура Docker

```
┌─────────────────────────────────────────────┐
│  Твой компьютер (Windows 10)                │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  Docker Desktop                       │  │
│  │                                       │  │
│  │  ┌─────────────┐  ┌─────────────┐    │  │
│  │  │ PostgreSQL   │  │   Redis     │    │  │
│  │  │ порт 5432    │  │  порт 6379  │    │  │
│  │  │ (база данных)│  │  (очередь)  │    │  │
│  │  └─────────────┘  └─────────────┘    │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  Node.js (npm run dev)                │  │
│  │  Zenvest Bot — порт 3000             │  │
│  │  подключается к postgres и redis      │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

Docker здесь используется **только для баз данных** (PostgreSQL и Redis). Само приложение запускается напрямую через Node.js — так удобнее при разработке (быстрее перезапуск, видишь логи в реальном времени).
