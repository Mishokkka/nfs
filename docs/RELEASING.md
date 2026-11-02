# Сборка и публичный канал обновления

`module-source.json` описывает разрабатываемую версию. Вместе с package.json,
runtime VERSION и текущей строкой README его обновляет `npm run sync-version`.
Скрипт не изменяет публичный корневой module.json.

`npm run build` создаёт:

- `dist/fbl-need-for-speed-<version>.zip` со штатным Foundry
  `fbl-need-for-speed/module.json` из исходного manifest;
- `dist/module.json` с теми же байтами;
- `dist/SHA256SUMS.txt` для ZIP и отдельного manifest.

Локальная установка выполняется из ZIP. Исходный checkout целиком не является
установкой: публичный manifest может отсутствовать либо относиться к прошлому выпуску.

## Последовательность выпуска

Release workflow работает только для push стабильного тега vX.Y.Z, совпадающего
с package version, после проверок Windows/Linux. Создание тега — отдельное решение
о выпуске; текущая проверка PR этого не делает.

Все stable release jobs используют одну группу `nfs-stable-release` с
`cancel-in-progress: false` и `queue: max`. Группа общая для разных тегов:
их продвижение сериализовано, ожидание нового тега не отменяет предыдущий.
Порядок завершения проверок может отличаться от порядка версий.

1. В draft загружаются проверенные ZIP, module.json и SHA256SUMS.txt.
2. `scripts/publish-manifest.mjs` проверяет manifest draft, все три asset,
   текущий опубликованный Latest и legacy main/module.json до любых изменений.
3. Готовый release публикуется с `make_latest: "false"`. Скрипт повторно читает
   опубликованные assets и оба канала. При более новой версии в любом канале
   этот выпуск остаётся только в истории, оба канала сохраняются.
4. Для подходящей версии создаётся/обновляется raw main/module.json через
   Contents API с SHA прежней версии. Он поддерживает прежние установки.
5. После успешной записи legacy и повторной проверки каналов переключается
   Latest. Повторный запуск самого publisher допускается после частичного
   успеха; существующий опубликованный release не требуется публиковать заново.

Новый основной канал — [manifest последнего выпуска](https://github.com/Mishokkka/nfs/releases/latest/download/module.json).
Manifest конкретного выпуска указывает на ZIP конкретного тега. До первого
релиза оба публичных manifest отсутствуют: это не предложение скачать ещё
не созданный архив. Для текущей предрелизной версии используется локальный ZIP.

CI вызывает `node scripts/publish-manifest.mjs --check`: отсутствие bootstrap
manifest допускается; существующий должен совпадать с asset готового release.
Проверочные jobs имеют read-only доступ. Запись в main выполняет только release
job с contents: write после публикации assets. Если политика ветки запрещает
запись legacy, скрипт завершится ошибкой и не переключит Latest. Версионные
assets уже опубликованы; прежние каналы сохраняются. Если отказало последнее
переключение Latest, legacy уже может содержать новую готовую версию, Latest —
старую. Повторный запуск publisher завершает продвижение без отката каналов.

GitHub не предоставляет транзакцию между Contents API и Latest. Общая очередь
защищает от конкурирующих tag jobs этого workflow; ручные публикации должны
использовать ту же очередь. Повторные чтения обнаруживают внешнее продвижение,
но не заменяют атомарную блокировку произвольных внешних записей. Workflow не
перезагружает assets существующего release при полном повторе job: для уже
созданного выпуска повторяют только publisher, сохраняя исходные assets.

Семантика очереди и явного `make_latest` проверена по
[GitHub Actions concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) и
[Release API](https://docs.github.com/en/rest/releases/releases#update-a-release).

## Перед тегом

Обязательны `npm run test:all`, `npm run build` и полноценный сетевой заезд в
целевом Foundry с питом, финишем и F5 ведущего. Тесты планирования публикации
не выполняют запись в GitHub. Для prerelease нужен отдельный явно настроенный
канал; стабильный workflow их отклоняет до создания draft.
