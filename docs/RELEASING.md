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

1. В draft загружаются проверенные ZIP, module.json и SHA256SUMS.txt.
2. После завершения загрузки публикуется готовый release.
3. `scripts/publish-manifest.mjs` получает manifest из опубликованного asset
   и проверяет версию, адреса и готовность всех файлов.
4. Он создаёт/обновляет raw main/module.json через Contents API с SHA прежней
   версии. Этот файл поддерживает прежние установки с raw-main URL.

Новый основной канал — [manifest последнего выпуска](https://github.com/Mishokkka/nfs/releases/latest/download/module.json).
Manifest конкретного выпуска указывает на ZIP конкретного тега. До первого
релиза оба публичных manifest отсутствуют: это не предложение скачать ещё
не созданный архив. Для текущей предрелизной версии используется локальный ZIP.

CI вызывает `node scripts/publish-manifest.mjs --check`: отсутствие bootstrap
manifest допускается; существующий должен совпадать с asset готового release.
Проверочные jobs имеют read-only доступ. Запись в main выполняет только release
job с contents: write после публикации assets. Если политика ветки запрещает
запись, готовый release и основной канал остаются доступны, а legacy raw-main
канал не продвигается. Не заменяйте его manifest до проверки опубликованного asset.

## Перед тегом

Обязательны `npm run test:all`, `npm run build` и полноценный сетевой заезд в
целевом Foundry с питом, финишем и F5 ведущего. Тесты планирования публикации
не выполняют запись в GitHub. Для prerelease нужен отдельный явно настроенный
канал; стабильный workflow их отклоняет до создания draft.
