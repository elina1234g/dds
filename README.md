# ДДС — Финансы ИП

Веб-приложение для учёта движения денежных средств.  
Несколько пользователей → общая база данных → общая сводка.

---

## 🚀 Деплой на Render.com (бесплатно, 10 минут)

### Шаг 1: GitHub

1. Создайте аккаунт на [github.com](https://github.com) если нет
2. Нажмите **New repository** → назовите `dds-finance` → Create
3. Загрузите все файлы из этой папки в репозиторий:
   - Нажмите **uploading an existing file**
   - Перетащите все файлы (server.js, package.json, render.yaml, папку public/)
   - Commit changes

### Шаг 2: Render

1. Зайдите на [render.com](https://render.com) → Sign Up (можно через GitHub)
2. Нажмите **New +** → **Web Service**
3. Выберите ваш репозиторий `dds-finance`
4. Настройки:
   - **Name**: dds-finance
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
5. Нажмите **Create Web Service**
6. Подождите 2-3 минуты — сайт появится по адресу `https://dds-finance.onrender.com`

### Шаг 3: Постоянное хранилище (важно!)

По умолчанию на бесплатном тарифе данные сбрасываются при перезапуске.  
Чтобы данные сохранялись:

1. В Render → ваш сервис → **Disks**
2. **Add Disk**:
   - Name: `dds-data`
   - Mount Path: `/data`
   - Size: 1 GB
3. В **Environment** добавьте переменную:
   - Key: `DB_PATH`  
   - Value: `/data/dds.db`

---

## 💻 Запуск локально (для теста)

```bash
npm install
node server.js
```
Откройте http://localhost:3000

---

## 📁 Структура файлов

```
dds-finance/
├── server.js          — Node.js сервер + API + парсеры файлов
├── package.json       — зависимости
├── render.yaml        — конфиг для Render.com
├── db/                — база данных SQLite (создаётся автоматически)
└── public/
    └── index.html     — весь фронтенд
```

---

## 🔧 API эндпоинты

| Метод | URL | Описание |
|---|---|---|
| GET | /api/operations | Список операций с фильтрами |
| GET | /api/summary/:month | Сводка за месяц |
| GET | /api/months | Список доступных месяцев |
| POST | /api/import | Загрузить файл (CSV/ZIP) |
| POST | /api/operations/manual | Добавить вручную |
| GET | /api/counterparts | Справочник контрагентов |
| POST | /api/counterparts | Добавить контрагента |
| GET | /api/rules | Правила классификации |
| POST | /api/rules | Добавить правило |
| POST | /api/reclassify | Переклассифицировать всё |
| GET | /api/rates | Курсы валют |
| POST | /api/rates | Добавить/обновить курс |
| GET | /api/import-log | Лог импортов |
| GET | /api/stats | Статистика |

---

## 📋 Поддерживаемые форматы

| Источник | Формат | Как загружать |
|---|---|---|
| Payoneer | CSV | Через веб-интерфейс |
| ПСКБ | ZIP (XLS внутри) | Через веб-интерфейс |
| Ozon Bank | XLSX | Через Google Apps Script (см. Code.gs) |

---

## 👥 Несколько пользователей

- Каждый вводит своё имя в поле вверху справа
- Все загружают файлы в одну общую базу
- Сводка и графики — общие для всех
- В логе импорта видно кто что загрузил
