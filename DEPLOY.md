# Деплой Zenvest на Ubuntu-сервер

## Требования к серверу

- Ubuntu 22.04+ (или Debian 12+)
- Минимум 1 GB RAM, 10 GB диск
- Доступ по SSH
- Открытый порт 3000 (опционально, для health check)

---

## 1. Подготовка сервера

### 1.1. Подключись к серверу

```bash
ssh root@YOUR_SERVER_IP
```

### 1.2. Обнови систему

```bash
apt update && apt upgrade -y
```

### 1.3. Установи Docker и Docker Compose

```bash
# Установка Docker
curl -fsSL https://get.docker.com | sh

# Проверка
docker --version
docker compose version
```

---

## 2. Копирование проекта на сервер

### Вариант A: через Git (рекомендуется)

На локальной машине (Windows) — если проект в git-репозитории:

```bash
# На сервере
git clone https://github.com/YOUR_USER/zenvest.git /opt/zenvest
cd /opt/zenvest
```

### Вариант B: через SCP (без Git)

На локальной машине (Windows, из PowerShell):

```powershell
# Запаковать проект (без node_modules и .env)
cd C:\Users\Administrator\Desktop\WORK\zenvestarch\zenvest

# Создать архив (PowerShell)
tar -czf zenvest.tar.gz --exclude=node_modules --exclude=dist --exclude=.env --exclude=.git src/ credentials/ package.json package-lock.json tsconfig.json knexfile.ts docker-compose.yml Dockerfile .dockerignore .env.example

# Скопировать на сервер
scp zenvest.tar.gz root@YOUR_SERVER_IP:/opt/
```

На сервере:

```bash
mkdir -p /opt/zenvest
cd /opt/zenvest
tar -xzf /opt/zenvest.tar.gz
rm /opt/zenvest.tar.gz
```

---

## 3. Настройка конфигурации

### 3.1. Создай .env файл

```bash
cd /opt/zenvest
cp .env.example .env
nano .env
```

Заполни все значения:

```env
# Telegram — токен из @BotFather
TELEGRAM_BOT_TOKEN=123456:ABC-...

# Gemini API — https://aistudio.google.com/apikey
GEMINI_API_KEY=AIza...

# Groq — https://console.groq.com/keys
GROQ_API_KEY=gsk_...

# PostgreSQL — пароль (тот же что в POSTGRES_PASSWORD)
POSTGRES_PASSWORD=СГЕНЕРИРУЙ_НАДЁЖНЫЙ_ПАРОЛЬ
DATABASE_URL=postgresql://zenvest:СГЕНЕРИРУЙ_НАДЁЖНЫЙ_ПАРОЛЬ@postgres:5432/zenvest

# Redis — внутри Docker-сети обращаемся по имени сервиса
REDIS_URL=redis://redis:6379

# Google Sheets
GOOGLE_SERVICE_ACCOUNT_JSON=./credentials/service-account.json
GOOGLE_SHEET_ID=ID_ТАБЛИЦЫ_ИЗ_URL

# Google Drive (Shared Drive)
GOOGLE_DRIVE_FOLDER_ID=ID_ПАПКИ

# Приложение
PORT=3000
NODE_ENV=production
DAILY_REPORT_TIME=20:00
TIMEZONE=Europe/Prague
```

**Важно:**
- `DATABASE_URL` и `REDIS_URL` используют имена Docker-сервисов (`postgres`, `redis`), а не `localhost`
- Пароль в `POSTGRES_PASSWORD` и в `DATABASE_URL` должен совпадать

### 3.2. Скопируй Google credentials

На локальной машине (PowerShell):

```powershell
scp C:\Users\Administrator\Desktop\WORK\zenvestarch\zenvest\credentials\service-account.json root@YOUR_SERVER_IP:/opt/zenvest/credentials/
```

Или на сервере создай директорию и файл:

```bash
mkdir -p /opt/zenvest/credentials
nano /opt/zenvest/credentials/service-account.json
# Вставь содержимое JSON файла
```

---

## 4. Запуск

```bash
cd /opt/zenvest

# Собрать и запустить все контейнеры
docker compose up -d --build
```

Первый запуск займёт 1-2 минуты (скачивание образов + сборка).

### Проверка

```bash
# Статус контейнеров
docker compose ps

# Логи приложения
docker compose logs -f app

# Логи всех сервисов
docker compose logs -f
```

Должно быть:
```
zenvest-app       | Bot started: @your_bot_name (123456)
zenvest-app       | Long polling started
zenvest-app       | Database connected
zenvest-app       | Migrations applied
zenvest-app       | Google Sheets sync enabled
zenvest-app       | Google Drive upload enabled
```

### Health check

```bash
curl http://localhost:3000/health
# {"status":"ok","db":true,"redis":true,"sheets":true}
```

---

## 5. Управление

### Перезапуск

```bash
cd /opt/zenvest
docker compose restart app
```

### Обновление кода

```bash
cd /opt/zenvest

# Вариант A: через Git
git pull

# Вариант B: скопируй новые файлы через SCP (src/, package.json, etc.)

# Пересобрать и перезапустить
docker compose up -d --build
```

### Остановка

```bash
docker compose down        # Остановить контейнеры (данные сохраняются)
docker compose down -v     # Остановить + УДАЛИТЬ данные БД (осторожно!)
```

### Логи

```bash
docker compose logs -f app           # Только приложение
docker compose logs -f app --tail 50 # Последние 50 строк
docker compose logs -f postgres      # Только БД
```

### Зайти в БД

```bash
docker compose exec postgres psql -U zenvest
```

---

## 6. Автозапуск при перезагрузке сервера

Docker с `restart: unless-stopped` автоматически перезапускает контейнеры. Убедись что Docker включён в systemd:

```bash
systemctl enable docker
```

---

## 7. Обновление .env

После изменения `.env`:

```bash
cd /opt/zenvest
docker compose up -d   # Пересоздаст контейнер app с новыми переменными
```

---

## 8. Бэкап БД

```bash
# Создать бэкап
docker compose exec postgres pg_dump -U zenvest zenvest > backup_$(date +%Y%m%d).sql

# Восстановить
cat backup_20260306.sql | docker compose exec -T postgres psql -U zenvest zenvest
```

### Автобэкап (cron)

```bash
crontab -e
```

Добавь строку (бэкап каждый день в 3:00):

```
0 3 * * * cd /opt/zenvest && docker compose exec -T postgres pg_dump -U zenvest zenvest | gzip > /opt/backups/zenvest_$(date +\%Y\%m\%d).sql.gz
```

```bash
mkdir -p /opt/backups
```

---

## Структура на сервере

```
/opt/zenvest/
├── .env                    ← Твои секреты (не коммитить!)
├── credentials/
│   └── service-account.json ← Google Service Account
├── docker-compose.yml
├── Dockerfile
├── package.json
├── package-lock.json
├── tsconfig.json
├── knexfile.ts
├── src/                    ← Исходный код
└── .dockerignore
```

---

## Решение проблем

### Контейнер app не запускается

```bash
docker compose logs app
```

Частые причины:
- Неправильный `DATABASE_URL` (проверь пароль и хост `postgres`)
- Нет `credentials/service-account.json`
- Неправильный `TELEGRAM_BOT_TOKEN`

### Бот не отвечает

```bash
# Проверь что polling запущен
docker compose logs app | grep "polling"

# Проверь что нет другого инстанса бота с тем же токеном
# (на Windows должен быть остановлен!)
```

**Важно:** Telegram позволяет только один long-polling инстанс на токен. Останови бота на Windows перед запуском на сервере.

### Нет подключения к БД

```bash
docker compose ps   # postgres должен быть healthy
docker compose logs postgres
```

### Redis ошибка

```bash
docker compose ps   # redis должен быть healthy
docker compose exec redis redis-cli ping  # Должно вернуть PONG
```
