# TrayBin v2.0.0 Stable — Tauri 2 / Windows 11 x64

**Стабильный релиз** на базе полностью проверенного пользователем Release Candidate 1.
После RC1 функциональность TrayBin, интерфейс и работа трея не менялись.

## Что входит

- Портативное приложение без установщика: один `TrayBin.exe` (сам EXE требует WebView2 Runtime, встроенный в Windows 11 либо установленный отдельно).
- Компактная панель **376×528**, тёмно-фиолетовая тема и шрифт **Inter**, без белой системной рамки.
- **Пять оригинальных Classic-иконок** состояния корзины, одинарный/двойной/правый клики по трею.
- Подтверждение Windows перед очисткой корзины, автозапуск, single-instance, экономичный фоновый опрос.
- Контроль исходников SHA-256 и автоматические проверки перед сборкой.

## Сборка

Закрой TrayBin через «Выход из TrayBin», открой PowerShell в постоянной папке проекта и выполни:

```powershell
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\BUILD-RELEASE.ps1
if ($LASTEXITCODE -ne 0) { throw 'Stable Release build failed' }
```

Скрипт сначала запускает `VERIFY-RELEASE.ps1` (22 теста Node.js, Cargo check и Rust unit tests), затем `npm run build:release`, создаёт:

- `Artifacts\TrayBin_v2.0.0_Stable\Portable\TrayBin.exe`
- `Artifacts\TrayBin_v2.0.0_Stable\TrayBin_v2.0.0_Stable_Portable.zip`
- `Artifacts\TrayBin_v2.0.0_Stable\TrayBin_v2.0.0_Stable_Source.zip` — полный исходный проект с lock-файлами для будущих сборок
- `Artifacts\TrayBin_v2.0.0_Stable\RELEASE_ARTIFACTS_SHA256.txt` — SHA-256 всех трёх релизных артефактов

Ранее созданные RC1-файлы в `Artifacts\TrayBin_v2.0.0_RC1` не удаляются.

## Запуск и автозапуск

Открой `TrayBin.exe` из папки `Portable` либо распакуй ZIP в постоянный каталог.
**Сначала закрой предыдущий TrayBin:** один экземпляр на сеанс Windows.
Если используешь автозапуск, установи окончательное расположение EXE *перед* включением автозапуска: в записи хранится абсолютный путь.
Inter должен быть установлен в Windows; дополнительных файлов шрифта в архиве нет.
Исполняемый файл без цифровой подписи: Windows SmartScreen может предупреждать; сверяй SHA-256.

## Приёмка

Перед финальной фиксацией бинарного Stable убедись, что итоговая Release-сборка запускается без консоли и работает так же, как проверенный RC1.
Проверки RC1: 9/9 действий в Windows 11, 16/16 Node.js и 3/3 Rust — успешно.
Ссылки на внешние библиотеки не требуются после сборки, кроме системного WebView2 Runtime.

## Резервная копия исходников и восстановление

`TrayBin_v2.0.0_Stable_Source.zip` содержит одну папку `TrayBin_v2.0.0_Stable_Source` с каноническими исходниками (Rust/HTML/CSS/JS, иконки, скрипты и тесты), `package-lock.json`, `src-tauri/Cargo.lock`, `FILE_MANIFEST_SHA256.txt` и `SOURCE_ARCHIVE_SHA256.txt`. Содержимое дополнительно проверяется распаковкой и SHA-256 в процессе сборки.

В исходный архив **не входят** `node_modules`, `src-tauri/target`, `Artifacts`, старые `patches`, резервные копии, диагностические отчёты и временные файлы.

Для восстановления распакуй архив в отдельную папку, открой в ней PowerShell и выполни:

```powershell
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\BUILD-RELEASE.ps1
if ($LASTEXITCODE -ne 0) { throw 'Release rebuild failed' }
```

Нужны Node.js/npm, Rust toolchain для `x86_64-pc-windows-msvc`, Windows C++ Build Tools и WebView2 Runtime для запуска. Зависимости скачиваются при первой установке; архив не содержит готовые бинарные кэши.

**Исправление упаковщика исходников:** проверка `package-lock.json` выполняется отдельным `scripts/VERIFY-NPM-LOCK.cjs` вместо `node -e` (совместимость с Windows PowerShell 5.1).
