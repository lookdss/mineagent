# MineAgent — автономный AI-компаньон для Minecraft Java

Бот на [Mineflayer](https://github.com/PrismarineJS/mineflayer), который заходит на сервер как обычный игрок,
понимает команды в чате на русском/английском, видит мир и инвентарь, выполняет задачи (добыча, крафт, ферма,
стройка, бой), сам следит за голодом и опасностью и **учится новым навыкам**, генерируя и проверяя
Mineflayer-код локально (идея из NVIDIA Voyager). Весь интеллект — локальная LLM через **LM Studio**
(любой OpenAI-совместимый сервер подойдёт: Ollama, vLLM, llama.cpp server).

## Требования

| Компонент | Версия |
|---|---|
| Node.js | 18+ (проверено на 22) |
| Minecraft Java | до **26.1** включительно (столько поддерживает Mineflayer 4.39 / minecraft-protocol 1.68; при обновлении Mineflayer появятся новые версии) |
| Java для сервера 26.1 | 25 |
| LM Studio | любая с включённым Local Server (OpenAI API, порт 1234) |

## Быстрый старт

```bash
git clone <repo> mineagent && cd mineagent
npm install
cp config.example.json config.json   # отредактируйте под себя
npm run test-llm                      # проверка связи с LM Studio: модели, tool-calling, эмбеддинги
npm start                             # запуск бота
```

### LM Studio

1. Скачайте модель с поддержкой tool-calling, например `Qwen2.5-7B-Instruct` (Q4_K_M, ~4.5 ГБ VRAM).
   Для Dual Loop дополнительно — кодовую модель (`Devstral-Small`, `Qwen2.5-Coder-14B`).
2. Для эмбеддингов (библиотека навыков и отбор инструментов) загрузите `text-embedding-nomic-embed-text-v1.5` (или любую embedding-модель).
   Если embedding-модели нет — бот автоматически перейдёт на локальные хеш-эмбеддинги (работает, но поиск похожих навыков хуже).
   `nomic-embed-text` плохо различает русские фразы, поэтому описания навыков перед индексацией переводятся на английский;
   для русскоязычного отбора инструментов лучше взять многоязычную модель (`bge-m3`, `multilingual-e5-small`).
3. Вкладка **Developer → Local Server → Start**. Включите *Serve on Local Network*, если бот и LM Studio на разных ПК.
4. В `config.json` укажите точные имена моделей, как они показаны в LM Studio (`llm.models.chat`, `llm.models.coder`, `embeddings.model`).

### Сервер Minecraft

Любой ванильный/Paper-сервер ≤ 26.1. Для бота в оффлайн-режиме (`online-mode=false`) ничего больше не нужно;
для лицензионных серверов поставьте `"auth": "microsoft"` — при первом запуске Mineflayer попросит войти через код устройства.

Пример запуска тестового сервера 26.1 (нужна Java 25):

```bash
mkdir mc-server && cd mc-server
# скачайте server.jar версии 26.1 с minecraft.net
echo "eula=true" > eula.txt
java -Xmx2G -jar server.jar nogui   # после первого запуска: online-mode=false в server.properties
```

## Конфигурация (`config.json`)

```jsonc
{
  "minecraft": { "host": "127.0.0.1", "port": 25565, "username": "Bob", "auth": "offline", "version": false },
  "bot": {
    "triggerNames": ["Боб", "Bob"],          // на какие обращения реагировать
    "language": "ru",
    "ownerPlayers": [],                      // если не пусто — слушаться только этих игроков
    "cancelTaskOnNewCommand": true           // новая команда прерывает текущую длинную задачу
  },
  "llm": {
    "baseUrl": "http://localhost:1234/v1",
    "apiKey": "lm-studio",
    "mode": "single",                        // "single" — одна модель на всё; "dual" — chat + coder
    "models": { "chat": "qwen2.5-7b-instruct", "coder": "devstral-small-2-24b" },
    "temperature": 0.3, "maxTokens": 1024, "historyTurns": 12, "maxToolRounds": 4,
    "maxToolsPerRequest": 12,                // сколько инструментов показывать модели (отбор по смыслу запроса, 0 = все)
    "routerFallback": true                   // модель ответила текстом вместо tool-call → спросить JSON-роутер
  },
  "embeddings": { "model": "text-embedding-nomic-embed-text-v1.5", "fallbackToLocal": true },
  "skillLibrary": { "dir": "./data/skills", "learnedCodeDir": "./data/learned",
                    "minSimilarity": 0.68, "maxFixIterations": 4, "sandboxTimeoutMs": 30000 },
  "autonomy": {
    "enabled": true, "tickMs": 5000,
    "eatBelowFood": 14, "fleeBelowHealth": 8, "fightHostilesWithin": 6,
    "depositWhenInventoryAbove": 0.8,        // доля занятых слотов, после которой бот идёт разгружаться на базу
    "travelKit": ["pickaxe", "axe", "sword", "torch", "bread"],  // подстроки имён предметов, которые не сдаёт в сундук
    "idleThinkEveryMs": 0                    // >0 — раз в N мс спрашивать LLM «чем заняться», когда нет задач
  },
  "safety": {
    "forbiddenPlaceBlocks": ["tnt", "lava_bucket", "fire", "flint_and_steel"],
    "forbiddenDigBlocks": ["bedrock", "spawner", "chest", "barrel", "beacon", "ender_chest"],
    "maxTerrainVariance": 3                  // максимальный перепад высот площадки без flatten=true
  },
  "logging": { "level": "info" }
}
```

Полный список полей и значения по умолчанию — в `src/config.js` (zod-схема), шаблон — `config.example.json`.

### Single vs Dual Loop

* **single** — одна модель принимает команды и пишет код навыков. Подходит для 7–14B на 8 ГБ VRAM.
* **dual** — `models.chat` (быстрая, tool-calling) обрабатывает чат, `models.coder` (большая кодовая) вызывается
  только при обучении новому навыку. LM Studio умеет держать несколько моделей загруженными (или подгружать по
  запросу, если включён JIT loading) — учитывайте, что при нехватке VRAM первая генерация кода займёт 10–30 с на загрузку.

## Как общаться с ботом

Бот реагирует на сообщения с обращением по имени (`Боб, …` / `Bob …`) и на личные сообщения (`/msg Bob …`).
`bot.triggerNames` задаёт имена-обращения; `bot.ownerPlayers` ограничивает круг игроков, которых бот слушается.

Примеры естественных команд:

```
Боб, подойди ко мне
Боб, иди за мной
Боб, наруби 20 брёвен
Боб, добудь 30 булыжника
Боб, скрафти каменную кирку
Боб, построй дом 7x7
Боб, сделай ферму пшеницы
Боб, сложи всё лишнее в сундук
Боб, дай мне 10 хлеба
Боб, что у тебя в инвентаре?
Боб, стоп
```

Прямые команды (не нужна LLM, удобно для слабых моделей и отладки):

```
Боб, !help                         список инструментов
Боб, !collect_block block=iron_ore count=5
Боб, !build_structure type=house width=7 depth=7 height=4 material=oak_planks
Боб, !place_block item=chest
Боб, !learn_skill task="построить мост через реку из булыжника"
```

### Встроенные навыки

| Группа | Инструменты |
|---|---|
| Движение | `come_here`, `follow_player`, `goto_position`, `stop`, `get_status` |
| Добыча | `collect_block`, `dig_block_at`, `chop_tree` (рубит всё дерево, пересаживает саплинг) |
| Инвентарь/база | `list_inventory`, `give_item`, `equip_item`, `deposit_items`, `withdraw_item`, `set_base_here`, `go_to_base` |
| Крафт | `craft_item` (ищет/ставит верстак), `smelt_item` |
| Ферма | `make_farm` (параметры размера, вода, посев), `harvest_crops` (сбор + пересев) |
| Бой | `attack_entity`, `hunt_for_food` |
| Стройка | `place_block`, `build_structure` — чертежи `house`, `pen`, `wall`, `platform`, `storage`, `pillar` с проверкой рельефа и материалов |
| Обучение | `learn_skill`, `list_learned_skills`, `forget_skill` |

### Автономия (без LLM, каждые 2 с)

* автоеда (`mineflayer-auto-eat`), при голоде — поиск еды: готовка сырого мяса → сбор урожая → охота;
* враждебный моб рядом: атака при достаточном HP, побег к игроку/базе при низком;
* инвентарь заполнен выше порога — поход к базовым сундукам и выгрузка всего, кроме «походного набора»;
* опционально `autonomy.idleThinkEveryMs` — редкие размышления LLM «чем заняться полезным».

## Самообучение (Skill Library)

Когда ни один инструмент не подходит, модель вызывает `learn_skill(task)`:

1. Поиск похожего навыка в LanceDB по эмбеддингу задачи → если похожесть ≥ `minSimilarity`, выполняется он.
2. Иначе coder-модель пишет `async function name(bot, args) { … return 'результат' }` в ограниченном API
   (`bot`, `Vec3`, `goals`, `helpers.*`, `sleep`, `say`, `log`).
3. Статическая проверка (запрет `require`, `process`, `eval`, сети, бесконечных циклов и т. п.) → запуск в `node:vm`
   с таймаутом и отменой (`!stop` останавливает любой навык).
4. Ошибка/стек → возвращается модели, до `maxFixIterations` попыток.
5. Успешный навык сохраняется в `data/skills/*.json` + `data/learned/*.js`, индексируется в LanceDB и сразу доступен как инструмент.

> Безопасность: `node:vm` + статический анализ + whitelist — защита от случайных ошибок модели, но **не** полноценная
> песочница. Не давайте боту оператора и не запускайте на чужих серверах без проверки сгенерированного кода в `data/skills/`.

## Структура проекта

```
src/
  index.js            точка входа, сборка всех подсистем
  config.js           zod-схема конфига
  llm/client.js       OpenAI-совместимый клиент (LM Studio/Ollama), нормализация tool-calls
  llm/prompts.js      системные промпты (бот, coder, правила безопасности)
  bot/createBot.js    Mineflayer + плагины (pathfinder, collectblock, tool, pvp, auto-eat)
  bot/sensors.js      структурированный снапшот мира для LLM
  bot/taskManager.js  одна длинная задача за раз, отмена через AbortSignal
  bot/autonomy.js     рефлексы без LLM
  agent/agent.js      чат-цикл: отбор инструментов → LLM → валидация → выполнение → ответ
  agent/toolSelector.js  семантический отбор инструментов по эмбеддингам
  agent/memory.js     постоянная память (база, сундуки)
  skills/registry.js  реестр навыков, zod → JSON Schema для tool-calling
  skills/helpers.js   высокоуровневые операции над Mineflayer
  skills/builtin/     встроенные навыки по группам
  skills/library/     sandbox, эмбеддинги, LanceDB, learn_skill
scripts/
  test-llm.js   проверка LLM-эндпоинта
  check.js      синтаксис + загрузка модулей (npm test)
  player.js     тестовый игрок: node scripts/player.js 127.0.0.1 25565 Steve "Боб, подойди; wait 10"
  e2e.js        e2e-прогон прямых команд против работающего бота (npm run test-e2e)
```

## Советы по моделям

* 7B+ с tool-calling (Qwen2.5-7B-Instruct, Llama-3.1-8B, Mistral-Nemo) уверенно вызывают инструменты.
* Модели 1.5–3B часто отвечают текстом — для них работают семантический отбор инструментов (`maxToolsPerRequest`)
  и JSON-роутер (`routerFallback`), но лучше использовать прямые `!команды`.
* Для `learn_skill` нужна модель, умеющая писать JS: Qwen2.5-Coder-7B/14B, Devstral.

## Лицензия

MIT
