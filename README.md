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
редактирования пароля второй запуск применяет PJSIP/dialplan и запускает службы.

Диагностика:

```bash
systemctl --no-pager --full status goip-ai-bridge asterisk
journalctl -u goip-ai-bridge -u asterisk -f
asterisk -rx "pjsip show contacts"
```

Записи находятся в `/var/lib/goip-ai-bridge/recordings`.

### Docker-вариант

Создайте конфигурацию:

```bash
cp .env.example .env
```

Обязательно измените:

```env
PUBLIC_IP=<публичный IPv4 виртуалки>
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

В `Configurations → VoIP`:

- `Config Mode`: `Single Server Mode`;
- `Phone Number`: `1001`;
- `Authentication ID`: `1001`;
- `Password`: значение `SIP_PASSWORD` из `.env`;
- `Display Name`: `goip4`;
- `SIP Proxy`: `<PUBLIC_IP>:5060`;
- `SIP Registrar Server`: `<PUBLIC_IP>:5060`;
- `Outbound Proxy`: оставить пустым;
- `Home Domain`: `<PUBLIC_IP>`;
- `Re-register Period`: `60`;
- preferred codec: сначала `G.711 A-law / PCMA`, затем `G.711 μ-law / PCMU`.

Сохраните настройки и перезагрузите VoIP-конфигурацию, если прошивка этого
требует. В статусе GoIP регистрация должна стать `Y`, `Registered` или
`LOGIN`, в зависимости от версии интерфейса.

В `Call Divert` / `Call Management`, для линии с SIM-картой:

- `CALL IN via GSM`: `Enable`;
- `Forwarding to VoIP Number`: `2000`;
- `CID Forward Mode`: `Use Remote Party ID` либо `Disabled`.

Для первого теста не выбирайте `Use CID as SIP Caller ID`: некоторые прошивки
тогда заменяют SIP username номером звонящего, и Asterisk не сможет сопоставить
первый `INVITE` с endpoint `1001`.

Если включены остальные линии без SIM, отключите для них `CALL IN via GSM`.
Номер `2000` ловится dialplan-ом Asterisk и отправляется в Node.js bridge.

Теперь позвоните на номер SIM. Asterisk ответит, в течение 10 секунд будет
тишина, затем bridge завершит звонок. Запись появится здесь:

```text
recordings/<call-uuid>.wav
```

Это WAV: PCM16, mono, 16 kHz — тот же входной аудиоформат, который ожидает
`ai-websocket-proxy`.

Полезная диагностика:

```bash
docker compose exec asterisk asterisk -rx "pjsip show contacts"
docker compose exec asterisk asterisk -rx "pjsip show endpoint 1001"
docker compose logs --tail=200 asterisk bridge
```

Если регистрация есть, но WAV содержит тишину, почти всегда не проходит RTP.
Проверьте UDP-порты `10000–10099`, правильность `PUBLIC_IP` и отсутствие
SIP ALG на роутере GoIP.

## 2. Подключение существующего ai-websocket-proxy

После успешного теста измените `.env`:

```env
BRIDGE_MODE=proxy
CALL_MAX_SECONDS=0
PROXY_WS_URL=wss://gemini-proxy.inoperate.com/v1/live
PROXY_SHARED_TOKEN=<тот же PROXY_SHARED_TOKEN, что на ai-websocket-proxy>
GEMINI_MODEL=gemini-2.5-flash-native-audio-preview-12-2025
SYSTEM_INSTRUCTION=Ты голосовой помощник. Отвечай кратко и естественно на русском языке.
INITIAL_TEXT=Начни разговор коротким приветствием на русском языке.
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

### Важная граница ответственности

`ai-websocket-proxy` из соседнего проекта является транспортным адаптером.
Раньше модель, system prompt, tools и выполнение tool calls находились в
сценарии Voximplant. Текущая первая версия Node.js bridge передаёт модель,
простой system prompt и начальную реплику, поэтому голосовой диалог работает
без изменения proxy.

Чтобы полностью повторить существующего бизнес-бота, его prompt, объявления
tools и обработчики tool calls нужно следующим шагом перенести из сценария
Voximplant в Node.js bridge. Сам media-протокол и `ai-websocket-proxy` при
этом менять не требуется.

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
