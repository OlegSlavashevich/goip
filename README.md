# GoIP → Voximplant WebSocket bridge

Минимальный голосовой шлюз для цепочки:

```text
GSM caller
  ↕ mobile network
GoIP-4
  ↕ SIP signalling + RTP/G.711
Asterisk
  ↕ AudioSocket, PCM16 mono 8 kHz
Node.js bridge
  ↕ JSON start/media/stop, PCM16 mono 16 kHz
existing ai-websocket-proxy
  ↕ Gemini Live
```

Asterisk здесь не является полноценной АТС. Он выполняет только ту часть,
которую нельзя заменить обычным WebSocket-сервером: SIP, SDP, RTP, G.711 и NAT.
Node.js принимает простой двунаправленный PCM-поток, записывает его и при
необходимости эмулирует media-протокол Voximplant.

## Требования к виртуалке

Для теста и нескольких одновременных звонков достаточно:

- 1 vCPU;
- 1 GB RAM;
- 5–10 GB диска;
- публичный IPv4 либо VPN-маршрут между GoIP и виртуалкой;
- Docker Engine и Docker Compose.

2 GB RAM удобнее, если Docker-образы будут собираться прямо на этой же
виртуалке. После сборки рабочая связка заметно легче этого лимита.

## 1. Первый тест: запись 10 секунд

### Маленькая Debian-виртуалка без Docker

Если диск меньше 5 GB, используйте нативную установку. Скопируйте проект в
`/opt/goip-ai-bridge`, затем выполните:

```bash
sh /opt/goip-ai-bridge/deploy/native/install.sh
nano /etc/goip-ai-bridge.env
sh /opt/goip-ai-bridge/deploy/native/install.sh
```

Первый запуск устанавливает Asterisk, Node.js и создаёт конфигурацию. После
редактирования адресов и пароля второй запуск применяет PJSIP/dialplan и
запускает службы. Для trunk-режима укажите:

```env
PUBLIC_IP=<публичный IPv4 виртуалки>
GOIP_PUBLIC_IP=<публичный IPv4, с которого GoIP приходит на виртуалку>
SIP_USERNAME=1001
SIP_PASSWORD=<длинный случайный пароль из букв и цифр>
```

Диагностика:

```bash
systemctl --no-pager --full status goip-ai-bridge asterisk
journalctl -u goip-ai-bridge -u asterisk -f
asterisk -rx "pjsip show endpoint goip-trunk"
```

При `RECORD_CALLS=true` записи находятся в
`/var/lib/goip-ai-bridge/recordings`:

- `<call-uuid>.wav` — входящий голос абонента, записанный Node.js bridge;
- `<YYYY-MM-DD_HH-MM-SS>_<call-uuid>-full.wav` — полный смешанный разговор:
  абонент и бот.

Полная запись создаётся Asterisk через `MixMonitor`, поэтому в ней слышны оба
направления звонка. Дата и время берутся в момент поступления звонка из
локального времени виртуалки; UUID позволяет найти тот же звонок в логах.

### Docker-вариант

Создайте конфигурацию:

```bash
cp .env.example .env
```

Обязательно измените:

```env
PUBLIC_IP=<публичный IPv4 виртуалки>
GOIP_PUBLIC_IP=<публичный IPv4, с которого GoIP приходит на виртуалку>
SIP_USERNAME=1001
SIP_PASSWORD=<длинный случайный пароль из букв и цифр>
BRIDGE_MODE=record
CALL_MAX_SECONDS=10
RECORD_CALLS=true
```

Если GoIP и виртуалка находятся в одной VPN или локальной сети, в `PUBLIC_IP`
укажите адрес виртуалки, достижимый с GoIP.

Запуск:

```bash
docker compose build
docker compose up -d
docker compose logs -f asterisk bridge
```

### Настройка веб-консоли GoIP-4

Названия пунктов немного отличаются между прошивками, но в официальном
руководстве используются следующие поля.

В `Configurations → Basic VoIP`:

- `Config Mode`: `Trunk Gateway Mode`;
- `SIP Trunk Gateway1`: `<PUBLIC_IP>:5060`;
- `SIP Trunk Gateway2` и `SIP Trunk Gateway3`: оставить пустыми;
- `Phone Number`: `1001`;
- `Authentication ID` и `Password`: оставить пустыми;
- `Re-register Period`: `0`;
- `Prefix Match Mode`: `Match Callee`;
- `Delete Callee Prefix while Dialing`: `Disable`;
- `Line 1 Routing Prefix`: оставить пустым;
- preferred codec: сначала `G.711 A-law / PCMA`, затем `G.711 μ-law / PCMU`.

Сохраните настройки. В trunk-режиме SIP-регистрация не используется. Asterisk
принимает вызовы от endpoint `goip-trunk` только с `GOIP_PUBLIC_IP`.

В `Call Divert` / `Call Management`, для линии с SIM-картой:

- `CALL IN via GSM`: `Enable`;
- `Forwarding to VoIP Number`: `2000`;
- `CID Forward Mode`: `Use Remote Party ID` либо `Disabled`.

Для первого теста оставьте `CID Forward Mode` выключенным.

Если включены остальные линии без SIM, отключите для них `CALL IN via GSM`.
Номер `2000` ловится dialplan-ом Asterisk и отправляется в Node.js bridge.

Теперь позвоните на номер SIM. Asterisk ответит, в течение 10 секунд будет
тишина, затем bridge завершит звонок. Запись появится здесь:

```text
recordings/<call-uuid>.wav
```

Это WAV: PCM16, mono, 16 kHz — тот же входной аудиоформат, который ожидает
`ai-websocket-proxy`.

Кроме неё Asterisk сохраняет полную смешанную запись разговора в
`recordings/full/<YYYY-MM-DD_HH-MM-SS>_<call-uuid>-full.wav`. При нативной
установке оба файла находятся непосредственно в
`/var/lib/goip-ai-bridge/recordings`.

Полезная диагностика:

```bash
docker compose exec asterisk asterisk -rx "pjsip show endpoint goip-trunk"
docker compose logs --tail=200 asterisk bridge
```

Если WAV содержит тишину, почти всегда не проходит RTP. Проверьте UDP-порты
`10000–10099`, правильность `PUBLIC_IP` и отсутствие SIP ALG на роутере GoIP.

## 2. Подключение существующего ai-websocket-proxy

После успешного теста измените `.env`:

```env
BRIDGE_MODE=proxy
CALL_MAX_SECONDS=0
PROXY_WS_URL=wss://gemini-proxy.inoperate.com/v1/live
PROXY_SHARED_TOKEN=<тот же PROXY_SHARED_TOKEN, что на ai-websocket-proxy>
GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
BOT_PROFILE=real-estate
BOT_PAGE_URL=https://kakdoma-sutochno.ru/assist/
BOT_DATE_UTC_OFFSET=+03:00
BOT_VOICE_NAME=Erinome
BOT_MAX_CALL_DURATION_MS=1200000
BOT_PRELOAD_CACHE_MS=300000
ALLOW_CONFIRM_BOOKING=false
```

`CALL_MAX_SECONDS=0` отключает тестовый автоотбой. Для ограниченного
продакшен-звонка можно поставить, например, `300`.

Перезапустите:

```bash
docker compose up -d --build bridge
docker compose logs -f bridge
```

Node.js bridge подключается к `/v1/live` с `Authorization: Bearer ...` и
передаёт:

```json
{
  "event": "start",
  "streamId": "<call-uuid>",
  "start": {
    "streamId": "<call-uuid>",
    "mediaFormat": {
      "encoding": "audio/L16",
      "sampleRate": 16000,
      "channels": 1
    }
  }
}
```

Каждый аудиокадр выглядит так:

```json
{
  "event": "media",
  "streamId": "<call-uuid>",
  "media": {
    "chunk": 1,
    "timestamp": 0,
    "payload": "<base64 PCM16/16 kHz>"
  }
}
```

Обратные `media`-пакеты декодируются, преобразуются в 8 kHz PCM и
возвращаются через Asterisk в RTP/GoIP. При отбое отправляется `stop`.

### Перенесённый сценарий «Как Дома»

При `BOT_PROFILE=real-estate` bridge запускает для каждого звонка отдельный
экземпляр сценария из `examples/scenario_proxy.js`: полный system prompt,
транскрипты, метрики и инструменты `search_apartments`,
`check_apartment_availability`, `get_apartment_detail` и
`create_booking_request`. `ai-websocket-proxy` остаётся без изменений и
используется только как транспорт к Gemini Live.

По умолчанию `ALLOW_CONFIRM_BOOKING=false`: диалог и заявка проходят в
dry-run, реальный `/confirm` не вызывается. Включайте `true` только после
проверки логов, данных брони и правовых оснований.

Перед ответом на GSM-вызов Asterisk генерирует `CALL_UUID` и вызывает
`http://127.0.0.1:9093/prepare?callId=<CALL_UUID>`. Пока bridge загружает
страницу, правила и каталог, открывает Gemini-сессию и заранее генерирует
первые аудиокадры приветствия, абонент продолжает слышать обычные гудки.
Только после появления первого звука bridge отвечает `ready`, Asterisk
выполняет `Answer()` и подключает к той же сессии AudioSocket. Поэтому после
поднятия трубки приветствие должно начаться почти сразу; если абонент начнёт
говорить первым, его речь не отбрасывается и может прервать приветствие.

Подготовка ограничена `PREPARE_AI_TIMEOUT_MS` (по умолчанию 12 секунд).
Готовая, но не подключённая к AudioSocket сессия закрывается через
`PREPARED_CALL_TTL_MS` (по умолчанию 30 секунд). Начальные данные кешируются
на `BOT_PRELOAD_CACHE_MS` (по умолчанию пять минут), а поиски по конкретным
датам никогда не кешируются.

Логи разговора и инструментов:

```bash
journalctl -u goip-ai-bridge -f
```

Для проверки подготовки ищите одну цепочку с одинаковым `callId`:
`Prepared greeting audio is ready` → `AI call prepared before answer` →
`Prepared call claimed` → `Call started` → `Bot audio sent to AudioSocket`.
В последнем событии поле `answerToFirstBotAudioMs` показывает задержку от
подключения звонка до первого отправленного кадра приветствия.

### Диагностика задержек

При `LATENCY_MONITORING=true` bridge измеряет WebSocket ping/pong до
`ai-websocket-proxy`, равномерность входных AudioSocket-кадров и локальную
очередь звука бота перед Asterisk. Интервал измерения RTT задаётся
`PROXY_PING_INTERVAL_MS` (по умолчанию 5000 мс).

На белорусской виртуалке:

```bash
journalctl -u goip-ai-bridge -f -o cat \
  | grep --line-buffered -E \
  'Proxy WebSocket RTT|Bot audio arrived|Bot audio sent|Bot audio playback summary|Call latency summary'
```

На сервере `ai-websocket-proxy`:

```bash
journalctl -u ai-websocket-proxy -f -o cat \
  | grep --line-buffered -E \
  'manual vad activity ended|gemini first audio|turn complete'
```

События связываются по `callId`/`metadata.callId` и номеру `turn`.

- `silence_wall_ms` — сколько Silero ждал тишину после последнего голоса;
- интервал между `manual vad activity ended` и `gemini first audio` — обработка
  Gemini вместе с его исходящим CONNECT-маршрутом;
- `gemini_audio_to_vox_media_ms` — ресемплинг и упаковка внутри proxy;
- `proxyRttMs / 2` — приблизительная задержка одного направления между
  Беларусью и proxy;
- `proxyMediaToAudioSocketMs` — локальная очередь между получением звука и
  первой отправкой в Asterisk;
- `audioSocketInputGapsOver40Ms` — провалы входного медиапотока со стороны
  Asterisk/GoIP.

Последний участок `Asterisk → RTP → GoIP → динамик телефона` программно
напрямую не наблюдается. Если все перечисленные интервалы низкие, но человек
слышит поздний ответ, проверять нужно RTP/jitter buffer и сеть GoIP.

Записи нативной установки:

```bash
ls -lht /var/lib/goip-ai-bridge/recordings
```

Файл с суффиксом `-full.wav` содержит и голос абонента, и ответы бота. Файл без
суффикса содержит только звук, поступивший от GoIP. Чтобы отключить обе записи,
задайте `RECORD_CALLS=false` в `/etc/goip-ai-bridge.env` и повторно запустите
установщик.

Обновление нативной установки:

```bash
cd /opt/goip-ai-bridge
git pull --ff-only
nano /etc/goip-ai-bridge.env
sh deploy/native/install.sh /opt/goip-ai-bridge
journalctl -u goip-ai-bridge -f
```

После изменения исходного Voximplant-сценария синхронизировать перенос можно
командой (из этого репозитория, когда соседний проект доступен локально):

```bash
node scripts/import-real-estate-scenario.mjs
```

### Персональные данные и трансграничная передача

WSS шифрует канал, но не отменяет факт трансграничной передачи. В этой схеме
за пределы Беларуси могут уходить голос, расшифровка, номер телефона, имя,
даты и данные заявки. До продакшена определите страны размещения
`ai-websocket-proxy` и AI-провайдера, правовое основание передачи, текст
информирования/согласия, сроки хранения и удаления, а также договоры с
обработчиками.

Если основанием является согласие, его нужно получить до отправки первого
аудиокадра за границу. Одного приветствия, которое уже генерирует внешний AI,
для этого недостаточно: нужен локальный IVR/запись перед `AudioSocket` либо
другое подтверждённое юристом основание. Тестовые WAV и подробные транскрипты
в продакшене лучше отключить (`RECORD_CALLS=false`) или хранить строго
ограниченный срок.

Для юридической проверки:

- [Закон Республики Беларусь № 99-З — перевод на сайте НЦЗПД](https://cpd.by/en/national-regulation/the-belarusian-data-protection-act/)
- [Официальный список доступных регионов Gemini API](https://ai.google.dev/gemini-api/docs/available-regions)
- [Условия обработки данных Gemini API](https://ai.google.dev/gemini-api/terms)
- [Zero data retention в Gemini Developer API](https://ai.google.dev/gemini-api/docs/zdr)

На момент последней проверки Беларусь отсутствует в опубликованном Google
списке доступных регионов Gemini Developer API. Это не исправляется
размещением proxy в другой стране: перед продакшеном нужен продукт/договор
провайдера, который прямо допускает обслуживание пользователей из Беларуси.

Отдельно проверьте регулирование электросвязи: Закон Республики Беларусь
№ 45-З определяет международный трафик широко, включая сетевые пакеты
независимо от протокола. Поэтому замена внешнего SIP на внешний WSS сама по
себе не доказывает соответствие требованиям. Для коммерческого запуска
получите письменное заключение белорусского специалиста по электросвязи либо
разъяснение регулятора именно для схемы GSM → локальный Asterisk → внешний
AI-процессинг.

## Сеть и безопасность

На виртуалке нужны входящие UDP:

- `5060` — SIP;
- `10000–10099` — RTP.

TCP `9092` наружу публиковать не нужно: AudioSocket доступен только внутри
Docker-сети. WebSocket к `ai-websocket-proxy` является исходящим соединением.

Если у GoIP постоянный публичный IP, ограничьте SIP/RTP этим IP в firewall или
security group. Не публикуйте стандартный SIP-порт с коротким паролем.

Запись содержит речь абонента. Используйте её только для согласованного теста,
защитите каталог `recordings/` и удалите файлы после диагностики.

## Проверки проекта

```bash
cd bridge
npm ci
npm test
node --check src/index.js
```

Документация протоколов:

- [GoIP User Manual](https://www.voip-systems.ru/assets/files/voip/voip-gsm/User_Manual_1_4_8_16.pdf)
- [Asterisk AudioSocket protocol](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/)
- [Asterisk PJSIP NAT configuration](https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Configuring-res_pjsip-to-work-through-NAT/)
