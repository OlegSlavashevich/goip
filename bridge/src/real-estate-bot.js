// Generated from ai-websocket-proxy/examples/scenario_proxy.js.
// Re-run scripts/import-real-estate-scenario.mjs after changing the source scenario.

export function createRealEstateBot(options = {}) {
  const Logger = {
    write(line) {
      if (typeof options.log === "function") options.log("info", "Real-estate bot", { line });
    },
  };
  const Net = {
    httpRequestAsync: createHttpRequestAdapter(options.fetchImpl || globalThis.fetch),
  };

  const GEMINI_MODEL = options.geminiModel || "gemini-2.5-flash-native-audio-preview-12-2025";
  const VOICE_NAME = options.voiceName || "Erinome";
  
  const PAGE_URL = options.pageUrl || "https://kakdoma-sutochno.ru/assist/";
  const DATE_UTC_OFFSET = options.dateUtcOffset || "+03:00";
  const ALLOW_CONFIRM_BOOKING = options.allowConfirmBooking === true;
  const PRELOAD_MAX_WAIT_MS = 10000;
  const SEARCH_OPTIONS_LIMIT = 3;
  const MAX_CALL_DURATION_MS = 20 * 60 * 1000;
  const GEMINI_FAILURE_PHRASE = "Извините, связь прервалась по технической причине. Пожалуйста, перезвоните нам.";
  
  let ACTIVE_CALL_METRICS = null;
  let SESSION_SHUTTING_DOWN = false;
  
  function createCallMetrics() {
    return {
      id: String(Date.now()) + "-" + Math.floor(Math.random() * 1000000),
      startedAt: Date.now(),
      stage: "starting",
      apiCalls: 0,
      apiErrors: 0,
      apiLatencyTotalMs: 0,
      apiLatencyMaxMs: 0,
      toolCalls: 0,
      toolErrors: 0,
      latestUsage: null,
      usageSum: {
        input: 0,
        output: 0,
        total: 0,
        inputText: 0,
        inputAudio: 0,
        outputText: 0,
        outputAudio: 0,
      },
    };
  }
  
  function setStage(stage) {
    if (ACTIVE_CALL_METRICS) ACTIVE_CALL_METRICS.stage = stage;
  }
  
  function recordApiMetric(status, latencyMs) {
    if (!ACTIVE_CALL_METRICS) return;
    ACTIVE_CALL_METRICS.apiCalls += 1;
    if (status < 200 || status >= 300) ACTIVE_CALL_METRICS.apiErrors += 1;
    ACTIVE_CALL_METRICS.apiLatencyTotalMs += latencyMs;
    ACTIVE_CALL_METRICS.apiLatencyMaxMs = Math.max(ACTIVE_CALL_METRICS.apiLatencyMaxMs, latencyMs);
  }
  
  function recordToolMetric(ok) {
    if (!ACTIVE_CALL_METRICS) return;
    ACTIVE_CALL_METRICS.toolCalls += 1;
    if (!ok) ACTIVE_CALL_METRICS.toolErrors += 1;
  }
  
  function recordUsageMetric(usage) {
    if (!ACTIVE_CALL_METRICS || !usage) return;
    ACTIVE_CALL_METRICS.latestUsage = usage;
    ACTIVE_CALL_METRICS.usageSum.input += usage.promptTokenCount || 0;
    ACTIVE_CALL_METRICS.usageSum.output += usage.responseTokenCount || 0;
    ACTIVE_CALL_METRICS.usageSum.total += usage.totalTokenCount || 0;
  
    asArray(usage.promptTokensDetails).forEach(function (detail) {
      if (detail.modality === "TEXT") ACTIVE_CALL_METRICS.usageSum.inputText += detail.tokenCount || 0;
      if (detail.modality === "AUDIO") ACTIVE_CALL_METRICS.usageSum.inputAudio += detail.tokenCount || 0;
    });
    asArray(usage.responseTokensDetails).forEach(function (detail) {
      if (detail.modality === "TEXT") ACTIVE_CALL_METRICS.usageSum.outputText += detail.tokenCount || 0;
      if (detail.modality === "AUDIO") ACTIVE_CALL_METRICS.usageSum.outputAudio += detail.tokenCount || 0;
    });
  }
  
  function logCallSummary(reason) {
    if (!ACTIVE_CALL_METRICS) return;
    const m = ACTIVE_CALL_METRICS;
    const avgApiLatency = m.apiCalls ? Math.round(m.apiLatencyTotalMs / m.apiCalls) : 0;
    log("summary", "call ended", {
      call_id: m.id,
      reason: reason || "ended",
      duration_sec: Math.round((Date.now() - m.startedAt) / 1000),
      stage: m.stage,
      api_calls: m.apiCalls,
      api_errors: m.apiErrors,
      api_latency_avg_ms: avgApiLatency,
      api_latency_max_ms: m.apiLatencyMaxMs,
      tool_calls: m.toolCalls,
      tool_errors: m.toolErrors,
      latest_tokens: m.latestUsage ? {
        input: m.latestUsage.promptTokenCount || 0,
        output: m.latestUsage.responseTokenCount || 0,
        total: m.latestUsage.totalTokenCount || 0,
      } : null,
      session_token_sum: m.usageSum,
    });
  }
  
  function handleUsagePayload(payload) {
    if (!payload || payload.promptTokenCount === undefined) return false;
    recordUsageMetric(payload);
    log("tokens", "latest", {
      input: payload.promptTokenCount || 0,
      output: payload.responseTokenCount || 0,
      total: payload.totalTokenCount || 0,
    });
    return true;
  }
  
  function uniq(items) {
    const out = [];
    for (let i = 0; i < items.length; i++) if (out.indexOf(items[i]) === -1) out.push(items[i]);
    return out;
  }
  
  function asRecord(value) {
    return value && typeof value === "object" ? value : {};
  }
  
  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }
  
  function firstNumber(value) {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string") {
      // "1 550,50" → 1550.5: пробелы — разделители тысяч, запятая — десятичная
      const parsed = Number(value.replace(/\s+/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
      if (isFinite(parsed)) return parsed;
    }
    return undefined;
  }
  
  function cleanText(value) {
    return String(value || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#\d+;/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }
  
  function normalizeSearchText(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(COMBINING_ACUTE_RE, "")
      .replace(/ё/g, "е")
      .replace(/[^0-9a-zа-я]+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  
  function searchTokens(value) {
    // Стоп-лист: генерики короче обычного фильтра («ул», «тест») дают ложные
    // матчи чужих адресов, а слова про животных матчатся на «…с животными
    // запрещено» в описаниях — питомцев матчит amenity-буст в chooseBest.
    const stop = {
      "рядом": true,
      "около": true,
      "возле": true,
      "ул": true,
      "пр": true,
      "пер": true,
      "дом": true,
      "корп": true,
      "стр": true,
      "тест": true,
      "москва": true,
      "можно": true,
      "нельзя": true,
      "животными": true,
      "животных": true,
      "животные": true,
      "животным": true,
      "собака": true,
      "собаки": true,
      "собакой": true,
      "собачка": true,
      "собачкой": true,
      "кошка": true,
      "кошкой": true,
      "питомец": true,
      "питомцем": true,
      "какая": true,
      "какой": true,
      "какие": true,
      "квартира": true,
      "квартиру": true,
      "квартиры": true,
      "квартир": true,
      "вариант": true,
      "варианты": true,
      "краснодар": true,
      "минск": true,
      "минске": true,
      "есть": true,
      "сайт": true,
      "сайте": true,
      "метро": true,
      "станция": true,
      "станции": true,
      "станцию": true,
      "район": true,
      "районе": true,
      "улица": true,
      "улице": true,
      "проспект": true,
      "проспекте": true,
    };
    return normalizeSearchText(value)
      .split(" ")
      .filter(function (token) { return token.length >= 2 && !stop[token]; });
  }
  
  function daysBetween(beginDate, endDate) {
    const begin = new Date(beginDate + "T00:00:00Z").getTime();
    const end = new Date(endDate + "T00:00:00Z").getTime();
    return Math.max(0, Math.round((end - begin) / 86400000));
  }
  
  function safeNights(beginDate, endDate) {
    return Math.max(1, daysBetween(beginDate, endDate));
  }
  
  function roundPerNight(total, nights) {
    const amount = firstNumber(total);
    if (amount === undefined) return undefined;
    const perNight = amount / Math.max(1, Number(nights) || 1);
    const step = perNight >= 2000 ? 100 : 10;
    return Math.round(perNight / step) * step;
  }
  
  function nightsWord(n) {
    const d10 = n % 10;
    const d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return "ночь";
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "ночи";
    return "ночей";
  }
  
  function rublesWord(n) {
    const d10 = n % 10;
    const d100 = n % 100;
    if (d10 === 1 && d100 !== 11) return "рубль";
    if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return "рубля";
    return "рублей";
  }
  
  function parseUtcOffsetMinutes(offset) {
    const m = String(offset).match(/^([+-])(\d{2}):(\d{2})$/);
    if (!m) return 180;
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3]));
  }
  
  function todayInUtcOffset(offset) {
    const shifted = new Date(Date.now() + parseUtcOffsetMinutes(offset) * 60000);
    return shifted.toISOString().slice(0, 10);
  }
  
  function formatRuList(items) {
    const clean = items.filter(Boolean);
    if (!clean.length) return "";
    if (clean.length === 1) return clean[0];
    return clean.slice(0, -1).join(", ") + " и " + clean[clean.length - 1];
  }
  
  // Gemini native audio не поддерживает SSML: ударение подсказываем знаком
  // U+0301 в тексте, который модель читает (talk_track, user_message, промпт).
  // Только display-строки; в поисковые/матчинговые тексты не попадает
  // (normalizeSearchText вычищает U+0301).
  const PRONUNCIATION_HINTS = {
    "Кальварийская": "Кальвари́йская",
    "Кальварийской": "Кальвари́йской",
    "Хоружей": "Хору́жей",
    "Якуба Коласа": "Яку́ба Ко́ласа",
    "Петровщина": "Петро́вщина",
    "Петровщине": "Петро́вщине",
    "Победителей": "Победи́телей",
    "Дзержинского": "Дзержи́нского",
    "Немига": "Неми́га",
    "Немиге": "Неми́ге",
    "Алхимовская": "Алхи́мовская",
    "Бунинская": "Бу́нинская",
    "Потапово": "Пота́пово",
    "Сокольники": "Соко́льники",
    "Жлобы": "Жло́бы",
  };
  
  function accentuate(text) {
    let out = String(text || "");
    Object.keys(PRONUNCIATION_HINTS).forEach(function (word) {
      if (out.indexOf(word) !== -1) out = out.split(word).join(PRONUNCIATION_HINTS[word]);
    });
    return out;
  }
  
  const COMBINING_ACUTE_RE = new RegExp(String.fromCharCode(0x0301), "g");
  
  const RU_MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  
  function ruDate(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(iso || "");
    return Number(m[3]) + " " + RU_MONTHS_GEN[Number(m[2]) - 1];
  }
  
  function log(scope, message, data) {
    let line = "[" + scope + "] " + message;
    if (data !== undefined) {
      let text = "";
      try { text = JSON.stringify(data); } catch (e) { text = String(data); }
      if (text.length > 900) text = text.slice(0, 900) + "...";
      line += " " + text;
    }
    Logger.write(line);
  }
  
  function extractInitWidget(html, widgetName) {
    const re = new RegExp("initWidget" + widgetName + "\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)", "m");
    const match = html.match(re);
    const body = match && match[1] ? match[1] : "";
    const tokenMatch = body.match(/token\s*:\s*["']([^"']+)["']/);
    const token = tokenMatch ? tokenMatch[1] : "";
    const apartmentsMatch = body.match(/apartments\s*:\s*\[([\s\S]*?)\]/);
    const apartmentsText = apartmentsMatch && apartmentsMatch[1] ? apartmentsMatch[1] : "";
    const rawIds = apartmentsText.match(/\d+/g) || [];
    const apartmentIds = uniq(rawIds.map(function (x) { return Number(x); }).filter(function (x) { return x > 0; }));
    return { token: token, apartmentIds: apartmentIds };
  }
  
  function extractPageFacts(html) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const telegramMatch = html.match(/@[\w_]{4,}/);
    const phoneMatch = html.match(/(?:\+7|8)\s?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/);
    return {
      title: cleanText(titleMatch && titleMatch[1]),
      description: cleanText(descMatch && descMatch[1]),
      telegram: telegramMatch ? telegramMatch[0] : undefined,
      phone: phoneMatch ? phoneMatch[0] : undefined,
    };
  }
  
  function inferCityOrArea(pageUrl, html, info) {
    const slug = pageUrl.split("/").filter(Boolean).pop() || "";
    const h1 = cleanText((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    if (/krasnodar/i.test(slug)) return "Краснодар";
    if (/alchimovo/i.test(slug)) return "Алхимово";
    if (/moskva|moscow/i.test(pageUrl)) return "Москва";
    return cleanText(asRecord(info).title) || h1 || slug || "город";
  }
  
  function normalizeRules(info, detail) {
    info = asRecord(info);
    detail = asRecord(detail);
    const checkInRules = asRecord(detail.check_in_rule || detail.check_in_rules || info.check_in_rules);
    const arrival = asRecord(checkInRules.arrival_time);
    const departure = asRecord(checkInRules.departure_time);
    const text = cleanText([
      info.description,
      info.important_notes,
      asRecord(info.check_in_rules).description,
      asRecord(info.check_in_rules).booking_description,
      asRecord(asRecord(info.check_in_rules).refund_rule_text).booking_refund_text,
      detail.desc,
    ].filter(Boolean).join("\n"));
  
    const lower = text.toLowerCase();
    const minAgeMatch = lower.match(/(?:старше|от)\s*(\d{2})\s*(?:года|лет)/);
    const minAge = minAgeMatch ? Number(minAgeMatch[1]) : undefined;
    const petsForbidden = /животн\w+\s+запрещ|содержание животных|проживание с животными запрещ/i.test(text);
    const petsByApproval = /животн\w+[^.]{0,80}согласован/i.test(text);
    const smokingForbidden = /курение[^.]{0,80}запрещ|курить[^.]{0,80}запрещ|воздержаться от курения/i.test(text);
    const partiesForbidden = /вечерин|мероприят|шумн/i.test(text);
  
    return {
      checkInFrom: arrival.from || checkInRules.check_in_time_start,
      checkInTo: arrival.to || checkInRules.check_in_time_end,
      checkOutFrom: departure.from || checkInRules.check_out_time_start,
      checkOutTo: departure.to || checkInRules.check_out_time_end,
      minAge: minAge,
      passportRequired: /паспорт|скан/i.test(text),
      smokingAllowed: !smokingForbidden,
      partiesAllowed: !partiesForbidden,
      petsPolicy: petsForbidden ? "forbidden" : petsByApproval ? "by_approval" : "unknown",
      depositRequired: /залог|депозит/i.test(text),
      prepaymentRequired: /предоплат|аванс|бронируем при наличии залога/i.test(text),
      bookingPrepaymentRefundable: /предоплат\w+[^.]{0,80}невозврат/i.test(text) ? false : undefined,
      shortSummary: [
        arrival.from ? "заезд с " + arrival.from : undefined,
        departure.to ? "выезд до " + departure.to : undefined,
        minAge ? "гость от " + minAge + " лет" : undefined,
        /паспорт|скан/i.test(text) ? "нужен паспорт" : undefined,
        smokingForbidden ? "курение запрещено" : undefined,
        partiesForbidden ? "вечеринки запрещены" : undefined,
        petsForbidden ? "с животными нельзя" : petsByApproval ? "с животными только через согласование администратора" : undefined,
      ].filter(Boolean).join("; "),
    };
  }
  
  const SERVICE_LABELS = {
    wi_fi: "Wi-Fi",
    washing_machine: "стиральная машина",
    tv: "ТВ",
    cabletv: "кабельное ТВ",
    refrigerator: "холодильник",
    stove: "плита",
    microwave: "микроволновка",
    dishwasher: "посудомоечная машина",
    iron: "утюг",
    air_conditioning: "кондиционер",
    waterheater: "водонагреватель",
    parking: "парковка",
    elevator: "лифт",
    balcony: "балкон",
    kids: "можно с детьми",
    playground: "детская площадка",
    bathroom: "ванная комната",
    mountainview: "вид на горы",
  };
  
  function normalizeAmenities(servicesValue) {
    const services = asArray(servicesValue);
    function has(key) { return services.indexOf(key) !== -1; }
    return {
      wi_fi: has("wi_fi"),
      washing_machine: has("washing_machine"),
      tv: has("tv"),
      cabletv: has("cabletv"),
      refrigerator: has("refrigerator"),
      stove: has("stove"),
      microwave: has("microwave"),
      dishwasher: has("dishwasher"),
      iron: has("iron"),
      air_conditioning: has("air_conditioning"),
      waterheater: has("waterheater"),
      parking: has("parking"),
      elevator: has("elevator"),
      balcony: has("balcony"),
      kids: has("kids"),
      playground: has("playground"),
      bathroom: has("bathroom"),
      mountainview: has("mountainview"),
      animals: has("animals"),
      smoke: has("smoke"),
      romantic: has("romantic"),
    };
  }
  
  function summarizeAmenities(amenities) {
    const labels = [];
    Object.keys(SERVICE_LABELS).forEach(function (key) {
      if (amenities[key]) labels.push(SERVICE_LABELS[key]);
    });
    return labels.length ? "Есть " + formatRuList(labels) + "." : "Удобства в карточке не указаны.";
  }
  
  function getPriceHint(apartment) {
    const price = asRecord(apartment.price);
    const details = asRecord(price.details);
    const common = asRecord(price.common);
    return firstNumber(details.amount) || firstNumber(common.with_discount) || firstNumber(common.without_discount);
  }
  
  function normalizeApartmentSummary(apartment, rules) {
    apartment = asRecord(apartment);
    const amenities = normalizeAmenities(apartment.services);
    const rooms = firstNumber(apartment.rooms);
    const capacity = firstNumber(apartment.capacity);
    const priceHint = getPriceHint(apartment);
    const metro = asArray(apartment.metro_stations)
      .map(function (station) { return cleanText(asRecord(station).title); })
      .filter(Boolean);
    const summary = {
      apartment_id: Number(apartment.id),
      title: apartment.title,
      address: apartment.address,
      rooms: rooms,
      area: firstNumber(apartment.area),
      floor: apartment.floor,
      capacity: capacity,
      sleeps: apartment.sleeps,
      max_children_count: firstNumber(apartment.max_children_count),
      availability: apartment.availability,
      min_stay: firstNumber(apartment.min_stay),
      price_hint: priceHint,
      metro: metro,
      amenities: amenities,
      amenities_summary: summarizeAmenities(amenities),
      restriction_hints: {
        pets: amenities.animals && rules.petsPolicy === "forbidden" ? "by_approval" : rules.petsPolicy,
        smoking: rules.smokingAllowed ? (amenities.smoke ? "allowed_signal" : "unknown") : "forbidden_by_global_rules",
        children: capacity ? "до " + capacity + " гостей всего" : undefined,
      },
      short_facts: [
        rooms ? rooms + "-комнатная" : undefined,
        capacity ? "до " + capacity + " гостей" : undefined,
        apartment.sleeps ? "спальные места: " + apartment.sleeps : undefined,
        metro.length ? "метро: " + formatRuList(metro) : undefined,
        priceHint ? "ориентир цены: " + priceHint + " рублей" : undefined,
      ].filter(Boolean),
    };
  
    Object.defineProperty(summary, "_searchText", {
      value: normalizeSearchText([
        apartment.id,
        apartment.title,
        apartment.address,
        metro.join(" "),
        apartment.sleeps,
        apartment.desc,
        asArray(apartment.services).join(" "),
      ].filter(Boolean).join(" ")),
      enumerable: false,
    });
    return summary;
  }
  
  function extractDescFacts(desc) {
    const text = cleanText(desc);
    const minAgeMatch = text.match(/(?:старше|от)\s*(\d{2})\s*(?:года|лет)/i);
    return {
      check_in_hint: (text.match(/заезд[^.]{0,60}/i) || [])[0],
      check_out_hint: (text.match(/выезд[^.]{0,60}/i) || [])[0],
      passport_required_hint: /паспорт|скан/i.test(text),
      min_age_hint: minAgeMatch ? Number(minAgeMatch[1]) : undefined,
      smoking_forbidden_hint: /курить|курение/i.test(text) && /запрещ/i.test(text),
      parties_forbidden_hint: /вечерин|мероприят/i.test(text),
      prepayment_hint: /предоплат|аванс/i.test(text),
      location_hint: (text.match(/(?:рядом|находится|ходьбы)[^.]{0,120}/i) || [])[0],
    };
  }
  
  function normalizeApartmentDetail(apartment, globalRules) {
    const summary = normalizeApartmentSummary(apartment, globalRules);
    const rules = normalizeRules({}, apartment);
    const mergedRules = Object.assign({}, globalRules, rules);
    if (rules.petsPolicy === "unknown") mergedRules.petsPolicy = globalRules.petsPolicy;
    if (globalRules.petsPolicy === "forbidden" && summary.amenities.animals) mergedRules.petsPolicy = "by_approval";
    mergedRules.smokingAllowed = Boolean(globalRules.smokingAllowed && rules.smokingAllowed);
    mergedRules.partiesAllowed = Boolean(globalRules.partiesAllowed && rules.partiesAllowed);
    mergedRules.passportRequired = Boolean(globalRules.passportRequired || rules.passportRequired);
    mergedRules.depositRequired = Boolean(globalRules.depositRequired || rules.depositRequired);
    mergedRules.prepaymentRequired = Boolean(globalRules.prepaymentRequired || rules.prepaymentRequired);
  
    const descFacts = extractDescFacts(apartment.desc);
    const photos = asArray(apartment.photos)
      .map(function (p) { return { url: String(asRecord(p).url || "") }; })
      .filter(function (p) { return p.url; });
  
    return Object.assign({}, summary, {
      can_be_booked: Boolean(apartment.can_be_booked),
      coordinates: apartment.coordinates,
      photos: photos.slice(0, 8),
      rules: mergedRules,
      description: cleanText(apartment.desc).slice(0, 1500),
      desc_facts: descFacts,
      short_description: accentuate([
        summary.rooms ? summary.rooms + "-комнатная квартира" : "Квартира",
        summary.capacity ? "до " + summary.capacity + " гостей" : undefined,
        summary.address ? "адрес: " + summary.address : undefined,
        summary.metro && summary.metro.length ? "рядом метро " + formatRuList(summary.metro) : undefined,
        summary.amenities_summary,
        descFacts.location_hint,
      ].filter(Boolean).join(". ")),
    });
  }
  
  function normalizeChildren(value) {
    return asArray(value)
      .map(function (child) {
        if (child && typeof child === "object") return asRecord(child).age;
        return child;
      })
      .filter(function (age) { return age !== undefined && age !== null && String(age).trim(); })
      .map(function (age) { return { age: String(age) }; });
  }
  
  function makeGuests(args) {
    args = asRecord(args);
    return {
      adults: Math.max(1, Number(args.adults || 1)),
      children: normalizeChildren(args.children),
    };
  }
  
  function validateStayDates(beginDate, endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(beginDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return "Нужны даты заезда и выезда в формате YYYY-MM-DD.";
    }
    if (endDate <= beginDate) {
      return "Дата выезда должна быть позже даты заезда. Переспроси у клиента даты заезда и выезда.";
    }
    const today = todayInUtcOffset(DATE_UTC_OFFSET);
    if (beginDate < today) {
      return "Дата заезда " + beginDate + " уже в прошлом, сегодня " + today + ". Переспроси у клиента актуальные даты.";
    }
    return null;
  }
  
  function widgetUrl(runtime, path) {
    return "https://realtycalendar.ru/v2/widget/" + runtime.token + path;
  }
  
  function extractBookingToken(url, widgetToken) {
    const text = String(url || "");
    const queryMatch = text.match(/[?&]token=([^&#]+)/);
    if (queryMatch) return queryMatch[1];
    // Наблюдаемый формат: https://homereserve.ru/{widgetToken}/{eventCalendarToken}
    const path = text.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0];
    const segments = path.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last !== String(widgetToken || "")) return last;
    return undefined;
  }
  
  async function fetchText(url, headers) {
    const startedAt = Date.now();
    const r = await Net.httpRequestAsync(url, { method: "GET", headers: headers || [] });
    const latency = Date.now() - startedAt;
    recordApiMetric(r.code, latency);
    log("api", url + " status=" + r.code + " " + latency + "ms");
    if (r.code < 200 || r.code >= 300) throw new Error("HTTP " + r.code + ": " + String(r.text || "").slice(0, 300));
    return String(r.text || "");
  }
  
  async function fetchJson(runtime, url, body) {
    const startedAt = Date.now();
    const headers = [
      "Accept: application/json",
      "Origin: " + runtime.pageOrigin,
      "Referer: " + runtime.pageUrl,
      "User-Agent: Mozilla/5.0",
    ];
    const options = body
      ? { method: "POST", headers: headers.concat(["Content-Type: application/json"]), postData: JSON.stringify(body) }
      : { method: "GET", headers: headers };
  
    const r = await Net.httpRequestAsync(url, options);
    const latency = Date.now() - startedAt;
    const text = String(r.text || "");
    recordApiMetric(r.code, latency);
    log("api", url + " status=" + r.code + " " + latency + "ms", {
      payload: body ? {
        apartment_id: body.apartment_id,
        apartment_ids: Array.isArray(body.apartment_ids) ? body.apartment_ids.length + " ids" : undefined,
        begin_date: body.begin_date,
        end_date: body.end_date,
        guests: body.guests,
        page: body.page,
      } : undefined,
      bytes: text.length,
    });
    if (r.code < 200 || r.code >= 300) throw new Error("HTTP " + r.code + ": " + text.slice(0, 500));
    return JSON.parse(text);
  }
  
  async function fetchApartments(runtime, payload) {
    const result = await fetchJson(runtime, widgetUrl(runtime, "/apartments"), payload);
    return asArray(result.apartments);
  }
  
  async function fetchCalendar(runtime, apartmentId, beginDate, endDate, guests) {
    const result = await fetchJson(runtime, widgetUrl(runtime, "/calendar"), {
      apartment_id: String(apartmentId),
      begin_date: beginDate,
      end_date: endDate,
      guests: guests,
    });
  
    const nights = daysBetween(beginDate, endDate);
    const calendar = asArray(result.calendar);
    const days = calendar.filter(function (day) {
      const date = String(day.date || "");
      return date >= beginDate && date < endDate;
    });
    const arrivalDay = calendar.filter(function (day) { return day.date === beginDate; })[0];
    const departureDay = calendar.filter(function (day) { return day.date === endDate; })[0];
    const minStay = Math.max.apply(null, [0].concat(days.map(function (day) { return firstNumber(day.min_stay) || 0; })));
    const nightlyPrices = days.map(function (day) { return firstNumber(day.price); }).filter(function (x) { return x !== undefined; });
    const calendarPriceSum = nightlyPrices.length === days.length
      ? nightlyPrices.reduce(function (sum, price) { return sum + price; }, 0)
      : undefined;
    const allAvailable = days.length >= nights && days.every(function (day) { return day.available === true; });
    const arrivalAllowed = !(arrivalDay && arrivalDay.closed_on_arrival);
    const departureAllowed = !(departureDay && departureDay.closed_on_departure);
    const minStayOk = !minStay || nights >= minStay;
    const blockingReason = !allAvailable
      ? "not_available"
      : !minStayOk
        ? "min_stay_" + minStay
        : !arrivalAllowed
          ? "closed_on_arrival"
          : !departureAllowed
            ? "closed_on_departure"
            : null;
  
    return {
      apartment_id: apartmentId,
      period_available: allAvailable && minStayOk && arrivalAllowed && departureAllowed,
      min_stay_ok: minStayOk,
      min_stay: minStay || undefined,
      begin_date: beginDate,
      end_date: endDate,
      nights: nights,
      calendar_price_sum: calendarPriceSum,
      calendar_price_min: nightlyPrices.length ? Math.min.apply(null, nightlyPrices) : undefined,
      calendar_price_max: nightlyPrices.length ? Math.max.apply(null, nightlyPrices) : undefined,
      calendar_price_avg: nightlyPrices.length ? Math.round(nightlyPrices.reduce(function (s, p) { return s + p; }, 0) / nightlyPrices.length) : undefined,
      calendar_priced_nights: nightlyPrices.length,
      arrival_allowed: arrivalAllowed,
      departure_allowed: departureAllowed,
      blocking_reason: blockingReason,
    };
  }
  
  async function fetchPrice(runtime, apartmentId, beginDate, endDate, guests, promoCode) {
    const result = await fetchJson(runtime, widgetUrl(runtime, "/price"), {
      apartment_id: String(apartmentId),
      arrival_time: null,
      departure_time: null,
      begin_date: beginDate,
      end_date: endDate,
      guests: guests,
      promo_code: promoCode || undefined,
    });
    return asRecord(result.price);
  }
  
  async function fetchApartmentDetail(runtime, apartmentId) {
    const result = await fetchJson(runtime, widgetUrl(runtime, "/apartment/" + apartmentId), {});
    const detail = normalizeApartmentDetail(result, runtime.rules);
    log("normalize", "apartment_detail", {
      id: detail.apartment_id,
      can_be_booked: detail.can_be_booked,
      photos: detail.photos.length,
      pets_policy: detail.rules.petsPolicy,
    });
    return detail;
  }
  
  async function loadInitialCatalogSnapshot(runtime) {
    const startedAt = Date.now();
    const rawApartments = await fetchApartments(runtime, {
      apartment_ids: runtime.catalogApartmentIds,
      begin_date: null,
      end_date: null,
      guests: { adults: 1, children: [] },
      page: 1,
    });
  
    const summaries = rawApartments.map(function (a) {
      return normalizeApartmentSummary(a, runtime.rules);
    });
    runtime.catalogSnapshot = summaries;
    runtime.knownApartments = summaries;
    log("normalize", "catalog_snapshot", {
      raw: rawApartments.length,
      normalized: summaries.length,
      latency_ms: Date.now() - startedAt,
      sample: summaries.slice(0, 5).map(function (a) {
        return { id: a.apartment_id, price: a.price_hint, capacity: a.capacity, address: a.address };
      }),
    });
    return summaries;
  }
  
  async function ensureKnownApartments(runtime) {
    if (asArray(runtime.knownApartments).length) return runtime.knownApartments;
    if (asArray(runtime.catalogSnapshot).length) {
      runtime.knownApartments = runtime.catalogSnapshot;
      return runtime.knownApartments;
    }
  
    return loadInitialCatalogSnapshot(runtime);
  }
  
  async function resolveApartmentId(runtime, args) {
    args = asRecord(args);
    const requestedId = Number(args.apartment_id);
    const query = String(args.query || args.requirements || args.address || "").trim();
    const known = await ensureKnownApartments(runtime);
  
    if (requestedId && runtime.catalogApartmentIds.indexOf(requestedId) !== -1) return requestedId;
  
    if (query) {
      // Берём лучший матч по скору, а не первый по порядку каталога: на запрос
      // «Тест ул. Кальварийская 25» первым в списке матчился чужой адрес по
      // мусорным токенам «тест»+«ул» (звонок 4847484196 — бот путал квартиры).
      const scored = known
        .map(function (apartment) {
          const match = matchApartmentByRequirements(apartment, query);
          if (!match.matched) return null;
          const addressText = normalizeSearchText(apartment.address || "");
          let score = 0;
          match.reasons.forEach(function (reason) {
            score += reason.indexOf("address:") === 0 ? 2 : 1;
            const token = reason.split(":")[1] || "";
            if (/^\d+$/.test(token) && addressText.indexOf(token) !== -1) score += 2;
          });
          return { apartment: apartment, score: score, reasons: match.reasons };
        })
        .filter(Boolean)
        .sort(function (a, b) { return b.score - a.score; });
  
      if (scored.length) {
        const best = scored[0];
        if (scored.length === 1 || scored[1].score < best.score) {
          log("decision", "resolved apartment by query", {
            query: query,
            apartment_id: best.apartment.apartment_id,
            address: best.apartment.address,
            score: best.score,
            reasons: best.reasons,
          });
          return best.apartment.apartment_id;
        }
        log("decision", "ambiguous apartment query", {
          query: query,
          candidates: scored.slice(0, 3).map(function (item) {
            return { id: item.apartment.apartment_id, address: item.apartment.address, score: item.score };
          }),
        });
        throw new Error("Запрос подходит сразу к нескольким квартирам. Уточни у клиента точный адрес или передай apartment_id из найденных вариантов.");
      }
    }
  
    throw new Error("Не удалось сопоставить квартиру. Нужно выбрать apartment_id из найденных вариантов или передать query с адресом/улицей.");
  }
  
  function matchApartmentByRequirements(apartment, requirements) {
    const tokens = searchTokens(requirements);
    if (!tokens.length) return { matched: false, reasons: [] };
  
    const text = apartment._searchText || normalizeSearchText([
      apartment.apartment_id,
      apartment.title,
      apartment.address,
      apartment.sleeps,
    ].filter(Boolean).join(" "));
    const addressText = normalizeSearchText(apartment.address || "");
    const reasons = [];
  
    tokens.forEach(function (token) {
      if (addressText.indexOf(token) !== -1) reasons.push("address:" + token);
      else if (text.indexOf(token) !== -1) reasons.push("text:" + token);
    });
  
    const matchedTokens = reasons.length;
    const hasNumberToken = tokens.some(function (token) { return /^\d+$/.test(token); });
    const allTokensMatched = matchedTokens === tokens.length;
    const strongAddressMatch = hasNumberToken && reasons.some(function (reason) {
      return reason.indexOf("address:") === 0 && /\d/.test(reason);
    });
  
    return {
      matched: allTokensMatched || strongAddressMatch || matchedTokens >= Math.min(2, tokens.length),
      reasons: uniq(reasons),
    };
  }
  
  function chooseBest(apartments, args) {
    const totalGuests = Number(args.adults || 1) + normalizeChildren(args.children).length;
    const requirements = String(args.requirements || "").trim();
    // «с собакой» в тексте карточек не встречается: пожелание про животных
    // матчим на признак amenities.animals, а не на текст адреса/описания.
    const wantsPets = /собак|кошк|живот|питом|щенк|котен|котёнк/i.test(requirements);
    const filtered = apartments
      .filter(function (a) { return !a.capacity || a.capacity >= totalGuests; })
      .filter(function (a) { return !a.availability || a.availability === "available"; });
  
    if (!requirements) return { matched: [], rest: filtered };
  
    const matched = [];
    const rest = [];
  
    filtered.forEach(function (apartment) {
      const match = matchApartmentByRequirements(apartment, requirements);
      const petsMatch = wantsPets && Boolean(asRecord(apartment.amenities).animals);
      if (petsMatch) match.reasons = uniq(match.reasons.concat(["amenity:animals"]));
      Object.defineProperty(apartment, "_matchReasons", {
        value: match.reasons,
        enumerable: false,
        configurable: true,
      });
      if (match.matched || petsMatch) matched.push(apartment);
      else rest.push(apartment);
    });
  
    return { matched: matched, rest: rest };
  }
  
  function randomItem(items) {
    return items[Math.floor(Math.random() * items.length)];
  }
  
  function pickTieredOptions(sortedByPerNight, limit) {
    const tiers = ["budget", "middle", "comfort"];
    if (sortedByPerNight.length <= limit) {
      return sortedByPerNight.map(function (candidate, index) {
        return { candidate: candidate, tier: tiers[Math.min(index, tiers.length - 1)] };
      });
    }
  
    const third = sortedByPerNight.length / 3;
    const groups = [
      sortedByPerNight.slice(0, Math.ceil(third)),
      sortedByPerNight.slice(Math.ceil(third), Math.ceil(third * 2)),
      sortedByPerNight.slice(Math.ceil(third * 2)),
    ];
    return groups
      .filter(function (group) { return group.length; })
      .map(function (group, index) {
        return { candidate: randomItem(group), tier: tiers[index] };
      })
      .slice(0, limit);
  }
  
  function makeTalkTrack(option, price, calendar) {
    const exactAmount = firstNumber(asRecord(asRecord(price).details).amount);
    const amount = exactAmount || calendar.calendar_price_sum || option.price_hint;
    const perNight = roundPerNight(amount, calendar.nights);
    const facts = [
      option.address ? "Есть вариант: " + option.address : "Есть вариант " + option.apartment_id,
      asArray(option.metro).length ? "у метро " + formatRuList(option.metro) : undefined,
      option.rooms ? option.rooms + "-комнатная" : undefined,
      option.capacity ? "до " + option.capacity + " гостей" : undefined,
      perNight ? "в среднем около " + perNight + " рублей за сутки" : undefined,
      amount && calendar.nights
        ? (exactAmount ? "всего " : "всего примерно ") + amount + " " + rublesWord(amount)
          + " за " + calendar.nights + " " + nightsWord(calendar.nights)
          + " (заезд " + ruDate(calendar.begin_date) + ", выезд " + ruDate(calendar.end_date) + ")"
        : undefined,
      calendar.min_stay ? "минимум " + calendar.min_stay + " суток" : undefined,
    ].filter(Boolean).join(", ");
    return accentuate(facts + (option.amenities_summary ? ". " + option.amenities_summary : "."));
  }
  
  function makePreliminaryTalkTrack(option, perNight) {
    const facts = [
      option.address ? "Предварительно вижу вариант: " + option.address : "Предварительно вижу вариант " + option.apartment_id,
      asArray(option.metro).length ? "у метро " + formatRuList(option.metro) : undefined,
      option.rooms ? option.rooms + "-комнатная" : undefined,
      option.capacity ? "до " + option.capacity + " гостей" : undefined,
      perNight ? "в среднем около " + perNight + " рублей за сутки" : undefined,
      option.min_stay ? "минимум " + option.min_stay + " суток" : undefined,
    ].filter(Boolean).join(", ");
    return accentuate(facts + (option.amenities_summary ? ". " + option.amenities_summary : "."));
  }
  
  async function loadRuntimeConfig(pageUrl) {
    const pageOrigin = "https://kakdoma-sutochno.ru";
    log("startup", "loading page " + pageUrl);
  
    const html = await fetchText(pageUrl, [
      "User-Agent: Mozilla/5.0",
      "Accept: text/html,application/xhtml+xml",
    ]);
  
    const search = extractInitWidget(html, "Search");
    const list = extractInitWidget(html, "List");
    const token = list.token || search.token || ((html.match(/token\s*:\s*["']([^"']+)["']/) || [])[1]);
  
    if (!token) throw new Error("Cannot find HomeReserve token");
    const pageFacts = extractPageFacts(html);
  
    const runtime = {
      pageUrl: pageUrl,
      pageOrigin: pageOrigin,
      token: token,
      cityOrArea: "город",
      phone: pageFacts.phone,
      telegram: pageFacts.telegram,
      email: undefined,
      searchApartmentIds: search.apartmentIds,
      catalogApartmentIds: list.apartmentIds.length ? list.apartmentIds : search.apartmentIds,
      rules: normalizeRules({}),
      catalogSnapshot: [],
      knownApartments: [],
      lastExactCheck: null,
      callerPhone: null,
      loadedAt: new Date().toISOString(),
    };
  
    log("startup", "parsed page config", {
      token: runtime.token,
      search_ids: runtime.searchApartmentIds.length,
      catalog_ids: runtime.catalogApartmentIds.length,
    });
  
    try {
      const info = await fetchJson(runtime, widgetUrl(runtime, "/info.json"));
      runtime.cityOrArea = inferCityOrArea(pageUrl, html, info);
      runtime.phone = info.phone || runtime.phone;
      runtime.telegram = info.telegram || runtime.telegram;
      runtime.email = info.email || undefined;
      runtime.rules = normalizeRules(info);
    } catch (e) {
      log("startup", "/info.json failed", String(e && e.message ? e.message : e));
      runtime.cityOrArea = inferCityOrArea(pageUrl, html, {});
    }
  
    try {
      await loadInitialCatalogSnapshot(runtime);
    } catch (e) {
      log("startup", "/apartments snapshot failed", String(e && e.message ? e.message : e));
    }
  
    return runtime;
  }
  
  function buildSystemInstruction(runtime) {
    const today = todayInUtcOffset(DATE_UTC_OFFSET);
    // Цен в catalog_preview сознательно нет: снапшот без дат устаревает, и
    // модель озвучивала его вместо свежих цен из инструментов (звонок 4845174268).
    const catalogPreview = runtime.catalogSnapshot.slice(0, 8).map(function (a) {
      return {
        apartment_id: a.apartment_id,
        address: a.address ? accentuate(a.address) : a.address,
        metro: asArray(a.metro).map(accentuate),
        rooms: a.rooms,
        capacity: a.capacity,
        sleeps: a.sleeps,
        amenities_summary: a.amenities_summary,
      };
    });
  
    return `
  Ты голосовой консультант сервиса "Как Дома" по посуточным квартирам. Ты женского рода (девушка).
  
  Это входящий звонок.
  
  После соединения сразу начни разговор словами:
  
  "Здравствуйте! Сервис «Как Дома», посуточная аренда квартир. Чем могу помочь?"
  
  Если клиент начал говорить одновременно с твоим приветствием, не повторяй приветствие повторно. Сразу ответь по смыслу его реплики и продолжи диалог.
  
  Твоя задача — помочь клиенту: ответить на вопросы, подобрать квартиру, проверить стоимость и доступность, помочь оформить бронирование или оставить заявку.
  
  Стиль речи:
  - Говори по-русски, коротко и естественно, как живой администратор. Жёсткий лимит: не больше двух коротких предложений за реплику — это примерно десять секунд речи. Длинные монологи запрещены: клиент не может тебя перебить вежливо и ощущает разговор вязким.
  - Задавай только один вопрос за раз. Сначала получи ответ, потом задавай следующий. Неправильно: "На какие даты и сколько человек?" Правильно: сначала "На какие даты?", после ответа — "Сколько гостей?"
  - Если клиент задал вопрос, не игнорируй его: сначала коротко ответь по сути, потом задай свой вопрос.
  - Проси недостающее полной вежливой фразой: "Подскажите, пожалуйста, ещё фамилию" — не телеграфно ("Фамилия нужна тоже").
  - Используй лёгкие живые связки: "так", "хорошо", "отлично", "секунду" — но не в каждой реплике.
  - Подтверждай услышанное своими словами: "Значит, столько-то взрослых с пятнадцатого по восемнадцатое — сейчас посмотрю."
  - Никогда не заканчивай реплику голым подтверждением («Хорошо, поняла.»). В той же реплике продолжай: задай следующий вопрос или скажи, что именно проверяешь, и сразу вызови инструмент. Реплика без продолжения — это зависание разговора, клиент слышит тишину.
  - Не зачитывай все удобства списком. Назови 2–3 самых важных для клиента, остальное — по запросу.
  - Не повторяй одну и ту же формулировку два раза подряд, варьируй фразы.
  - Без канцелярита: не говори "данный вариант", "осуществить бронирование", "предоставить информацию".
  
  Контекст страницы:
  ${JSON.stringify({
    today: today,
    date_utc_offset: DATE_UTC_OFFSET,
    page_url: runtime.pageUrl,
    city_or_area: runtime.cityOrArea,
    phone: runtime.phone,
    telegram: runtime.telegram,
    email: runtime.email,
    caller_phone: runtime.callerPhone,
    catalog_count: runtime.catalogApartmentIds.length,
    rules: runtime.rules,
    catalog_preview: catalogPreview,
  }, null, 2)}
  
  catalog_preview — только первые несколько квартир для ориентира. Полный каталог больше (см. catalog_count), актуальные варианты и цены получай через инструменты.
  
  Гибкий чеклист разговора:
  - Не веди клиента по фиксированным фазам. Клиент может начать с любого места: "хочу квартиру", "видел вариант на сайте", "хочу забронировать", "можно с собакой", "сколько стоит".
  - Сначала распознай все данные, которые клиент уже сказал, и не спрашивай их повторно.
  - Всегда спрашивай только один самый важный недостающий параметр.
  - Если клиент назвал конкретную квартиру, адрес, улицу или вариант с сайта, используй это как пожелание в requirements.
  - Если клиент назвал адрес, улицу или номер квартиры с сайта, не угадывай apartment_id. Для деталей передавай этот текст в get_apartment_detail как query.
  - Если клиент сразу хочет бронировать конкретную квартиру, не начинай общий подбор заново. Проверь недостающие данные, затем доступность и цену.
  
  Перед вызовом инструмента говори одну живую фразу-заполнитель с деталями того, что проверяешь: "Смотрю, что есть у метро Молодёжная с двадцать второго по двадцать шестое, секунду..." Пока фраза звучит, проверка уже идёт — так пауза не слышна. Подтверждение услышанного и фраза-заполнитель — это одно короткое предложение, не два отдельных.
  Не говори две фразы ожидания подряд ("сейчас посмотрю... сейчас посмотрю, секунду"). Одна фраза — потом результат.
  
  Данные для поиска:
  - дата заезда;
  - дата выезда;
  - количество взрослых;
  - дети и возраст каждого ребенка, если дети есть.
  
  Срок проживания и расчёт:
  - Срок проживания всегда считай в ночах. «С 18 по 21 июля» = заезд 18-го, выезд 21-го = 3 ночи.
  - «По 21-е» или «до 21-го» — это дата выезда: последняя ночь с 20-го на 21-е, утром 21-го клиент уезжает.
  - «На N ночей» или «на N суток» = N ночей: дата выезда = дата заезда плюс N дней.
  - «На N дней» = N минус одна ночь: дата выезда = дата заезда плюс N−1 день. Пример: «с 18 июля на 3 дня» — заезд 18-го, выезд 20-го, две ночи.
  - Если по этим правилам выходит 0 ночей (например «на один день»), не решай сама — уточни у клиента дату выезда.
  - Если клиент назвал обе даты явно, назови количество ночей в подтверждении и продолжай: «С восемнадцатого по двадцать первое, три ночи — сейчас посмотрю».
  - Если дату выезда ты вычислила сама из «на N дней», сначала проговори: «Заезд восемнадцатого, выезд двадцатого июля, две ночи — верно?» — и дождись подтверждения клиента, только потом вызывай поиск.
  - Говоря о сроке и цене, не используй слово «день» или «дней». Только «ночь», «ночи», «сутки»: «за сутки», «три ночи» — не «в день» и не «четыре дня».
  
  Пожелания:
  - конкретная квартира, адрес, улица, район, метро или ориентир;
  - бюджет;
  - животные;
  - отдельные спальные места;
  - поздний или ранний заезд;
  - отчетные документы;
  - парковка, кондиционер, лифт, балкон, кухня, стиральная машина.
  
  Данные для бронирования:
  - выбранная квартира;
  - подтвержденные даты;
  - подтвержденные гости;
  - подтвержденная цена;
  - имя и фамилия клиента;
  - настоящий номер телефона клиента;
  - явное согласие клиента на бронь или заявку.
  
  Строгое правило бронирования:
  - Фраза клиента "звучит хорошо", "интересно", "нормально", "подходит", "давайте посмотрим" не является согласием на бронирование.
  - Перед бронированием обязательно спроси: "Хотите забронировать этот вариант?"
  - Только если клиент явно ответил "да", "давайте", "бронируем", "оформляйте", переходи к сбору имени и телефона.
  - Не спрашивай телефон до явного согласия на бронирование.
  - Если caller_phone известен и после удаления всех нецифровых символов содержит 10–15 цифр, спроси выбор: "Бронь зафиксировать на номер, с которого вы сейчас звоните, или продиктуете другой?"
  - Если клиент выбрал номер, с которого звонит, используй caller_phone как phone.
  - Если клиент выбрал другой номер, попроси продиктовать его и используй продиктованный.
  - Если caller_phone отсутствует или не похож на настоящий номер телефона, не упоминай номер звонящего и попроси клиента назвать номер телефона.
  - create_booking_request вызывай только когда клиент явно подтвердил бронь или заявку И у тебя есть настоящий номер телефона.
  - Настоящий номер телефона должен быть похож на телефон: 10–15 цифр после удаления пробелов, плюса, скобок и дефисов.
  - Если клиент согласился бронировать, но номер телефона неизвестен, сначала спроси номер телефона для бронирования.
  - Для брони нужны имя и фамилия. Спрашивай одним вопросом: "Подскажите имя и фамилию для брони." Если клиент назвал только имя, мягко уточни фамилию. Фамилию не выдумывай.
  - Не проси имя и телефон в одной реплике. Сначала имя и фамилию, после ответа — отдельно телефон.
  - Если не хватает имени, фамилии или телефона, не вызывай create_booking_request — сначала спроси недостающее.
  - Если номер телефона звучит как "не указан", "нет", "не знаю", "потом", пусто или не похож на телефон, не вызывай create_booking_request.
  - Не подставляй телефон самостоятельно и не используй заглушки.
  - После получения телефона подтверди все данные одной фразой по шаблону: "Проверяю: [имя фамилия], телефон [номер], квартира на [адрес], с [дата заезда] по [дата выезда], [сколько] ночи/ночей, всего [полная сумма за весь период] рублей. Всё верно?" Адрес квартиры, даты, количество ночей и полная сумма в этой фразе обязательны. Сумму бери из price.details.amount, количество ночей — из nights последней точной проверки.
  - Номер телефона в своей речи всегда записывай группами цифр через пробелы: «7 901 147 87 08». Никогда не пиши номер слитно («79011478708») — слитная запись звучит как одно огромное число, клиент не разберёт цифры. После подтверждения вызывай create_booking_request.
  - Если клиент упоминал животных, ранний или поздний заезд, другие особые пожелания или просьбы — обязательно передай их текстом в create_booking_request.wish.
  - wish формулируй как просьбу клиента полным предложением, однозначно для администратора. Клиент просил фен → wish: "Клиенту обязательно нужен фен в квартире". Не пиши сокращённо — "без фена" читается наоборот, так нельзя.
  - Не обещай "администратор свяжется по этому вопросу", если пожелание не передано в wish. Если передала — говори: "Я указала это в заявке, администратор увидит."
  
  Правила:
  - Не выдумывай доступность, цену, минимальный срок проживания и условия бронирования.
  - Если клиент назвал даты и гостей, используй search_apartments.
  - Если клиент назвал адрес/улицу/ориентир вместе с датами, передай это в search_apartments.requirements. Если среди options есть совпадение по адресу, обязательно озвучь его.
  - Если клиент назвал бюджет, передай его числом в search_apartments.budget. Бюджет считается за одни сутки. Если клиент назвал бюджет за весь период проживания ("десять тысяч на всё"), раздели его на количество ночей и передай бюджет за одни сутки.
  - Если не хватает даты заезда, даты выезда или количества взрослых, сначала задай короткий уточняющий вопрос.
  - Если клиент говорит "сегодня", "завтра", "на выходные" или относительные даты, нормализуй относительно today и date_utc_offset.
  - Если клиент называет дату без года, используй ближайшую будущую дату относительно today. Не уточняй год, если эта дата уже получается в будущем в текущем или следующем году.
  - Не спрашивай "это 2026 год?", если клиент говорит обычные ближайшие даты вроде "с 15 по 18 июля", "завтра", "на выходные", "на следующей неделе".
  - /apartments без дат - это только витрина, не гарантия доступности.
  - search_apartments делает быстрый предварительный поиск и возвращает не более трёх вариантов в options с полем tier: budget (подешевле), middle (средний), comfort (покомфортнее). Это предварительная доступность и цена, не называй её финальной.
  - Озвучь варианты коротко и живо, от дешёвого к дорогому: одна короткая фраза на вариант — улица или метро и цена за сутки, без перечисления удобств (они — по запросу). Например: "Есть вариант подешевле — в среднем около двух восьмисот за сутки, есть средний в районе трёх пятисот и покомфортнее около пяти двухсот." Потом спроси, какой посмотреть подробнее.
  - Если вариантов один или два — просто предложи их, не выдумывай третий.
  - Если requirements_match = "none", сначала честно скажи, что точного совпадения с пожеланием клиента (адрес, метро, ориентир) не нашлось, и только потом предложи альтернативы. Никогда не говори, что вариант рядом с местом клиента, если этого нет в данных варианта (поля metro, address, desc_facts).
  - Если у варианта есть match_reasons (совпадение с адресом или ориентиром клиента), озвучь этот вариант первым и скажи, что он как раз там, где просил клиент.
  - Если цены вариантов почти одинаковые, не дели их на "подешевле и покомфортнее" — различай по расположению, метро или удобствам.
  - Если в результате есть budget_note, честно передай его смысл клиенту.
  - Про ближайшее метро отвечай по полю metro квартиры. Если оно пустое, честно скажи, что данных о метро нет.
  - Для точной доступности и итоговой цены выбранной квартиры используй check_apartment_availability.
  
  Цены:
  - Никогда не называй цену, которой нет в результате последнего вызова инструмента. В catalog_preview цен нет намеренно: любые цены бери только из свежего результата search_apartments или check_apartment_availability.
  - Цену всегда называй сначала за одни сутки и только со словами «в среднем около»: price_per_night — это средняя цена за ночь, округлённая, потому что цена по ночам различается (выходные, состав гостей). Бери готовое поле price_per_night из результата инструмента, сам ничего не пересчитывай и не округляй.
  - Точная цифра без «около» — только итоговая сумма за весь период. Если клиент пересчитывает и у него «за сутки умножить на ночи» не сходится с итогом, объясни: цена за ночь по дням разная, точная — итоговая сумма.
  - Полную стоимость за весь период называй, если клиент спросил, и обязательно один раз при подтверждении данных перед бронированием. Используй точную сумму: price_total_estimate из поиска или price.details.amount из точной проверки, без округления.
  - Перед бронированием обязательно подтверди полную сумму за весь период вместе с остальными данными брони.
  - Шпаргалка полей: price_per_night — среднее за ночь, озвучивать по умолчанию со словами «в среднем около»; price_total_estimate / price.details.amount — полная сумма (озвучивается по запросу и обязательно при подтверждении перед бронированием); nights — количество ночей; begin_date / end_date — даты заезда и выезда; tier — уровень варианта; metro — станции метро рядом; talk_track — готовая основа фразы.
  - price_hint и "ориентир цены" в short_facts при поиске с датами — это ориентир полной суммы за весь запрошенный период, а не за сутки. Не называй price_hint ценой за сутки.
  - Не вызывай check_apartment_availability для всех вариантов подряд. Вызывай его только когда клиент выбрал конкретную квартиру, спросил точную цену/доступность конкретного варианта или перед бронированием.
  - search_apartments возвращает options. Отвечай клиенту только по options и их talk_track.
  - Когда говоришь "проверю", "сейчас посмотрю" или "уточню", сразу вызывай инструмент. Не говори эти слова, если вызывать инструмент не собираешься.
  - Если options пустой, не придумывай варианты. Предложи посмотреть соседние даты/район или принять заявку администратору.
  - Если check_apartment_availability вернул price.details.amount, это финальная цена. calendar_price_sum - только ориентир.
  - Если клиент спрашивает детали конкретной квартиры или конкретное удобство (фен, посуда, тапочки, сушилка, вид из окна), которого нет в amenities, сначала вызови get_apartment_detail и проверь поле description. Не отвечай "в описании не указано", пока не прочитала description.
  - Если клиент хочет бронь или заявку, сначала подтвердить даты, гостей, квартиру, полную сумму за весь период (price.details.amount), имя и настоящий телефон.
  - Перед create_booking_request обязательно должна быть точная проверка выбранной квартиры через check_apartment_availability, а не только предварительный search_apartments.
  - create_booking_request вызывай только после явного подтверждения клиента и только с настоящим телефоном.
  - Фразу "Оформляю бронь, это займёт несколько секунд" говори только непосредственно перед самим вызовом create_booking_request, когда имя, фамилия и телефон уже собраны и подтверждены. Не говори её в начале сбора данных.
  - Если create_booking_request вернул status=booking_confirmed, скажи: "Готово, бронь подтверждена." Затем назови общую сумму за весь период из поля amount результата брони. Если paid_amount больше нуля, коротко озвучь предоплату и остаток. Если в результате есть reminder, передай его смысл клиенту одной короткой фразой.
  - Если status=booking_request_sent, скажи, что заявка отправлена и администратор свяжется для подтверждения. Не говори, что бронь уже подтверждена.
  - Если status=booking_rejected или инструмент вернул ошибку, извинись и предложи другой вариант или связь с администратором.
  - Если есть конфликт по животным, курению, детям, раннему или позднему заезду - говори "по согласованию с администратором".
  - Курение и вечеринки не разрешай, если правила это запрещают.
  - С животными не обещай автоматически, даже если в карточке есть services.animals.
  - Паспорт и возрастное ограничение проговаривай перед бронированием, если это есть в rules.
  - Если rules.minAge задан, называй именно это число, а не 21 по умолчанию.
  - Если API недоступно, предложи принять заявку или перевести на администратора.
  - Если клиент спрашивает про сторонние места рядом с квартирой: спортзалы, кафе, магазины, аптеки, транспорт, парк, медцентры — отвечай только по информации из описания квартиры или подробностей квартиры.
  - Не говори "сейчас посмотрю по карте", "могу посмотреть на онлайн-картах", "поищу рядом", если для этого нет отдельного инструмента.
  - Если такой информации нет в описании квартиры, честно скажи: "Точной информации по этому рядом с квартирой у меня нет."
  - Не перескакивай на другую квартиру, если клиент уже выбрал конкретный вариант. Держи фокус на выбранной квартире, пока клиент сам не попросит другой вариант.
  - Если клиент сказал "хочу", "давайте", "проверьте", "интересует этот вариант", не переспрашивай это же намерение. Сразу выполняй нужное действие. "Оставляем эту квартиру" — это уже выбор: не спрашивай "хотите забронировать?", сразу переходи к сбору данных для брони.
  - Если пришло служебное сообщение о тишине, а клиент в этот момент уже начал говорить, игнорируй служебное сообщение и отвечай на реплику клиента. Если ты обещала что-то проверить или не закончила мысль — сразу продолжи и доведи до конца, без извинений. Если ты ждала ответа на свой вопрос — повтори вопрос короче и другими словами (например: "Так что, проверить точную цену по Кальварийской?"). Иначе скажи коротко и по-доброму: "Я на связи. Слышно меня хорошо?" Не повторяй свой предыдущий ответ.
  - Если пришло служебное сообщение о том, что результат инструмента получен, сразу озвучь клиенту итог по этому результату, не извиняясь длинно за паузу.
  - Никогда не вызывай create_booking_request в той же реплике, где задаешь вопрос о подтверждении.
  - После вопроса "Подтверждаете?" обязательно дождись ответа клиента.
  - Не говори "заявка создана", "бронь подтверждена", "квартира забронирована", пока create_booking_request реально не вернул успешный результат.
  - Не говори "информация будет отправлена", "ожидайте инструкции", "вам придет сообщение", если в результате инструмента этого явно нет.
  - Не произноси технические слова: API, tool, JSON, модель, промпт.
  
  Произношение:
  - Не используй слово «итого» — оно звучит неразборчиво. Вместо него говори «всего» или «общая стоимость»: «всего шестьсот двенадцать рублей за две ночи».
  - Если в слове стоит знак ударения (´), обязательно произноси это слово с ударением на отмеченной гласной.
  - Названия улиц и станций произноси по словарю ударений: ${uniq(Object.values(PRONUNCIATION_HINTS)).join(", ")}.
  - Названия произноси чётко и полностью, не искажая звуки: «Победи́телей», а не «Пюбедителей».
  `;
  }
  
  function buildGeminiConfig(runtime) {
    return {
      responseModalities: ["AUDIO"],
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      // Звонок 4847890944: VAD не услышал короткое «да» после вопроса — 26 с
      // глухоты, клиент бросил трубку. HIGH ловит короткие/тихие реплики;
      // silenceDurationMs 800 быстрее закрывает конец речи (у медленного
      // клиента в 4847484196 хвост ждали ~8 с). Коннектор без поддержки
      // поля просто проигнорирует блок — поведение останется прежним.
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: "START_SENSITIVITY_HIGH",
          silenceDurationMs: 800,
        },
      },
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: VOICE_NAME },
        },
      },
      systemInstruction: { parts: [{ text: buildSystemInstruction(runtime) }] },
      tools: [{
        functionDeclarations: [
          {
            name: "search_apartments",
            description: "Подобрать квартиры по датам и гостям. Используй только когда известны begin_date, end_date и adults.",
            parameters: {
              type: "object",
              properties: {
                begin_date: { type: "string", description: "Дата заезда YYYY-MM-DD." },
                end_date: { type: "string", description: "Дата выезда YYYY-MM-DD." },
                adults: { type: "number", description: "Количество взрослых гостей." },
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { age: { type: "string" } },
                    required: ["age"],
                    additionalProperties: false,
                  },
                },
                budget: { type: "number", description: "Бюджет клиента за одни сутки в рублях." },
                requirements: { type: "string", description: "Пожелания клиента: адрес, улица, район, ориентир, удобства." },
              },
              required: ["begin_date", "end_date", "adults"],
              additionalProperties: false,
            },
          },
          {
            name: "check_apartment_availability",
            description: "Точно проверить выбранную клиентом квартиру по календарю и финальной цене. Используй только для одной конкретной квартиры, после выбора клиентом или перед бронированием.",
            parameters: {
              type: "object",
              properties: {
                apartment_id: { type: "number" },
                query: { type: "string", description: "Адрес или текст выбранной квартиры, если apartment_id неизвестен." },
                begin_date: { type: "string", description: "Дата заезда YYYY-MM-DD." },
                end_date: { type: "string", description: "Дата выезда YYYY-MM-DD." },
                adults: { type: "number", description: "Количество взрослых гостей." },
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { age: { type: "string" } },
                    required: ["age"],
                    additionalProperties: false,
                  },
                },
                promo_code: { type: "string" },
              },
              required: ["begin_date", "end_date", "adults"],
              additionalProperties: false,
            },
          },
          {
            name: "get_apartment_detail",
            description: "Получить подробности по конкретной квартире. Если клиент назвал адрес, улицу или вариант с сайта, передай query с этим текстом. Не угадывай apartment_id.",
            parameters: {
              type: "object",
              properties: {
                apartment_id: { type: "number" },
                query: { type: "string", description: "Адрес, улица или текст варианта, например 'Жлобы 139 225'." },
              },
              additionalProperties: false,
            },
          },
          {
            name: "create_booking_request",
            description: "Подготовить заявку или создать бронь только после явного подтверждения клиентом. Перед вызовом обязательно должны быть: apartment_id, даты, гости, имя и настоящий телефон клиента минимум из 10 цифр. Не вызывай tool, если phone неизвестен или не похож на номер телефона.",
            parameters: {
              type: "object",
              properties: {
                apartment_id: { type: "number" },
                begin_date: { type: "string" },
                end_date: { type: "string" },
                adults: { type: "number" },
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { age: { type: "string" } },
                    required: ["age"],
                    additionalProperties: false,
                  },
                },
                first_name: { type: "string", description: "Имя клиента." },
                last_name: { type: "string", description: "Фамилия клиента. Обязательна, API отклоняет заявку без неё. Не выдумывать." },
                phone: {
                  type: "string",
                  description: "Настоящий номер телефона клиента, минимум 10 цифр. Не передавать 'не указан'.",
                },
                email: { type: "string" },
                wish: {
                  type: "string",
                  description: "Пожелания клиента для администратора: животные, ранний/поздний заезд, особые условия. Обязательно заполняй, если клиент что-то просил или спрашивал (например, про собаку).",
                },
              },
              required: ["apartment_id", "begin_date", "end_date", "adults", "first_name", "last_name", "phone"],
              additionalProperties: false,
            },
          },
        ],
      }],
    };
  }
  
  async function handleSearchApartments(runtime, args) {
    args = asRecord(args);
    setStage("searching");
    const beginDate = String(args.begin_date || "").trim();
    const endDate = String(args.end_date || "").trim();
    const guests = makeGuests(args);
  
    const dateError = validateStayDates(beginDate, endDate);
    if (dateError) return { error: dateError };
  
    const startedAt = Date.now();
    log("decision", "search_apartments input", {
      begin_date: beginDate,
      end_date: endDate,
      guests: guests,
      budget: args.budget,
      requirements: args.requirements,
      catalog_ids: runtime.catalogApartmentIds.length,
    });
  
    const requirements = String(args.requirements || "").trim();
    const cacheKey = beginDate + "|" + endDate + "|" + JSON.stringify(guests);
    // Ключ готового результата включает фильтры: тот же поиск в одном звонке
    // должен выдавать те же options (randomItem в pickTieredOptions иначе
    // подсунет клиенту другую тройку вариантов).
    const resultKey = String(firstNumber(args.budget) || "") + "|" + requirements;
    runtime.searchCache = runtime.searchCache || {};
    const cached = runtime.searchCache[cacheKey];
    let rawApartments;
    if (cached && Date.now() - cached.at < 90000) {
      rawApartments = cached.apartments;
      log("decision", "search cache hit", { key: cacheKey, age_ms: Date.now() - cached.at });
      const cachedResult = cached.results && cached.results[resultKey];
      if (cachedResult) {
        runtime.knownApartments = cachedResult.summaries;
        setStage(cachedResult.result.options.length ? "offered_options" : "no_options");
        log("decision", "search result cache hit", { key: cacheKey, filter: resultKey });
        return cachedResult.result;
      }
    } else {
      rawApartments = await fetchApartments(runtime, {
        apartment_ids: runtime.catalogApartmentIds,
        begin_date: beginDate,
        end_date: endDate,
        guests: guests,
        page: 1,
        widget_type: "search_form",
      });
      runtime.searchCache[cacheKey] = { at: Date.now(), apartments: rawApartments, results: {} };
    }
  
    const summaries = rawApartments.map(function (a) { return normalizeApartmentSummary(a, runtime.rules); });
    runtime.knownApartments = summaries;
    const nights = safeNights(beginDate, endDate);
    const split = chooseBest(summaries, args);
    const requirementsMatch = !requirements ? null : split.matched.length ? "exact" : "none";
    let pool = requirementsMatch === "exact" ? split.matched : split.matched.concat(split.rest);
  
    let candidates = pool.map(function (candidate) {
      return {
        apartment: candidate,
        per_night: roundPerNight(candidate.price_hint, nights),
        total: firstNumber(candidate.price_hint),
      };
    });
  
    const budget = firstNumber(args.budget);
    let budgetNote = null;
    if (budget) {
      const withinBudget = candidates.filter(function (item) {
        return item.per_night !== undefined && item.per_night <= budget;
      });
      if (withinBudget.length) {
        candidates = withinBudget;
      } else {
        const knownPrices = candidates
          .map(function (item) { return item.per_night; })
          .filter(function (x) { return x !== undefined; });
        if (knownPrices.length) {
          budgetNote = "Вариантов до " + budget + " рублей за сутки нет, минимальная цена — "
            + Math.min.apply(null, knownPrices) + " рублей за сутки.";
        }
      }
    }
  
    candidates.sort(function (a, b) {
      const left = a.per_night === undefined ? Infinity : a.per_night;
      const right = b.per_night === undefined ? Infinity : b.per_night;
      return left - right;
    });
  
    log("decision", "search_candidates", {
      matched_requirements: split.matched.length,
      requirements_match: requirementsMatch,
      pool: candidates.map(function (item) {
        return {
          id: item.apartment.apartment_id,
          address: item.apartment.address,
          price_per_night: item.per_night,
          match_reasons: item.apartment._matchReasons || [],
        };
      }),
    });
  
    const options = pickTieredOptions(candidates, SEARCH_OPTIONS_LIMIT).map(function (picked) {
      const item = picked.candidate;
      return {
        apartment: item.apartment,
        tier: picked.tier,
        preliminary: true,
        preliminary_availability: item.apartment.availability,
        nights: nights,
        price_per_night: item.per_night,
        price_total_estimate: item.total,
        match_reasons: item.apartment._matchReasons || [],
        talk_track: makePreliminaryTalkTrack(item.apartment, item.per_night),
      };
    });
    setStage(options.length ? "offered_options" : "no_options");
    log("decision", "search_apartments result", {
      options: options.map(function (item) {
        return {
          id: item.apartment.apartment_id,
          tier: item.tier,
          price_per_night: item.price_per_night,
          availability: item.preliminary_availability,
          match_reasons: item.match_reasons || [],
          talk_track: item.talk_track,
        };
      }),
      latency_ms: Date.now() - startedAt,
    });
  
    const result = {
      query: {
        begin_date: beginDate,
        end_date: endDate,
        nights: nights,
        guests: guests,
        budget: args.budget,
        requirements: args.requirements,
      },
      total_found_from_apartments: rawApartments.length,
      matched_requirements: split.matched.length,
      requirements_match: requirementsMatch,
      requirements_note: requirementsMatch === "none"
        ? "Точных совпадений с пожеланием клиента не нашлось. options — это альтернативы: честно скажи клиенту, что по его пожеланию совпадений нет, и не выдавай альтернативы за совпадение."
        : null,
      budget_note: budgetNote,
      options: options,
      no_options_reason: options.length ? null : "Не нашлось предварительно доступных вариантов в ответе /apartments.",
      latency_ms: Date.now() - startedAt,
    };
  
    const cacheEntry = runtime.searchCache[cacheKey];
    if (cacheEntry) {
      cacheEntry.results = cacheEntry.results || {};
      cacheEntry.results[resultKey] = { result: result, summaries: summaries };
    }
    return result;
  }
  
  async function handleCheckApartmentAvailability(runtime, args) {
    args = asRecord(args);
    setStage("checking_selected_apartment");
    const beginDate = String(args.begin_date || "").trim();
    const endDate = String(args.end_date || "").trim();
    const guests = makeGuests(args);
    const promoCode = String(args.promo_code || "").trim() || undefined;
  
    const dateError = validateStayDates(beginDate, endDate);
    if (dateError) return { error: dateError };
  
    const startedAt = Date.now();
    const apartmentId = await resolveApartmentId(runtime, args);
    const known = await ensureKnownApartments(runtime);
    const summary = known.filter(function (a) { return a.apartment_id === apartmentId; })[0] || {
      apartment_id: apartmentId,
    };
  
    log("decision", "check_apartment_availability input", {
      apartment_id: apartmentId,
      query: args.query,
      begin_date: beginDate,
      end_date: endDate,
      guests: guests,
    });
  
    const calendarPromise = fetchCalendar(runtime, apartmentId, beginDate, endDate, guests);
    const pricePromise = fetchPrice(runtime, apartmentId, beginDate, endDate, guests, promoCode)
      .catch(function (e) {
        log("api", "parallel price failed", String((e && e.message) || e));
        return null;
      });
    const calendar = await calendarPromise;
    if (!calendar.period_available) {
      setStage("selected_apartment_unavailable");
      log("decision", "selected apartment rejected by calendar", {
        id: apartmentId,
        reason: calendar.blocking_reason,
        min_stay: calendar.min_stay,
        latency_ms: Date.now() - startedAt,
      });
      return {
        apartment: summary,
        available: false,
        begin_date: beginDate,
        end_date: endDate,
        nights: calendar.nights,
        calendar: calendar,
        price: null,
        no_options_reason: calendar.blocking_reason,
        latency_ms: Date.now() - startedAt,
      };
    }
  
    let price = await pricePromise;
    if (!price) price = await fetchPrice(runtime, apartmentId, beginDate, endDate, guests, promoCode);
    const talkTrack = makeTalkTrack(summary, price, calendar);
    const exactAmount = firstNumber(asRecord(price.details).amount);
    const pricePerNight = roundPerNight(exactAmount || calendar.calendar_price_sum || summary.price_hint, calendar.nights);
    runtime.lastExactCheck = {
      apartment_id: apartmentId,
      begin_date: beginDate,
      end_date: endDate,
      guests_key: JSON.stringify(guests),
      amount: firstNumber(asRecord(price.details).amount),
      checked_at: new Date().toISOString(),
    };
    setStage("selected_apartment_checked");
    log("decision", "selected apartment accepted", {
      id: apartmentId,
      amount: firstNumber(asRecord(price.details).amount),
      min_stay: calendar.min_stay,
      latency_ms: Date.now() - startedAt,
    });
  
    return {
      apartment: summary,
      available: true,
      begin_date: beginDate,
      end_date: endDate,
      nights: calendar.nights,
      calendar: calendar,
      price: price,
      price_per_night: pricePerNight,
      price_total: exactAmount,
      talk_track: talkTrack,
      latency_ms: Date.now() - startedAt,
    };
  }
  
  function isValidPhone(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text === "не указан" || text === "нет" || text === "не знаю" || text === "потом") return false;
  
    const digits = text.replace(/\D/g, "");
  
    if (digits.length < 10 || digits.length > 15) return false;
  
    return true;
  }
  
  async function handleCreateBookingRequest(runtime, args) {
    args = asRecord(args);
    if (!isValidPhone(args.phone)) {
      setStage("booking_blocked_invalid_phone");
      log("booking", "blocked invalid phone", { phone: String(args.phone || "") });
      return {
        error: "Нужно сначала спросить номер телефона клиента. Не вызывай create_booking_request, пока клиент не назовет настоящий номер минимум из 10 цифр.",
      };
    }
  
    if (!String(args.last_name || "").trim()) {
      setStage("booking_blocked_no_last_name");
      log("booking", "blocked missing last_name", { first_name: String(args.first_name || "") });
      return {
        error: "Для брони нужна фамилия клиента: API отклоняет заявку без last_name. Спроси фамилию и вызови create_booking_request снова с first_name и last_name.",
      };
    }
  
    const guests = makeGuests(args);
    const exactCheck = asRecord(runtime.lastExactCheck);
    const exactCheckMatches = Number(args.apartment_id) === exactCheck.apartment_id
      && String(args.begin_date) === exactCheck.begin_date
      && String(args.end_date) === exactCheck.end_date
      && JSON.stringify(guests) === exactCheck.guests_key;
    if (!exactCheckMatches) {
      // Модель забыла точную проверку финально выбранной квартиры (звонок
      // 4847484196: после смены квартиры бронь упёрлась в guard, бот сказал
      // «произошла ошибка» и заставил клиента подтверждать второй раз).
      // Делаем проверку сами: защита остаётся, лишний круг исчезает.
      setStage("booking_autocheck");
      log("booking", "no fresh exact check, running it now", {
        apartment_id: args.apartment_id,
        begin_date: args.begin_date,
        end_date: args.end_date,
      });
      const freshCheck = await handleCheckApartmentAvailability(runtime, {
        apartment_id: args.apartment_id,
        begin_date: args.begin_date,
        end_date: args.end_date,
        adults: args.adults,
        children: args.children,
      });
      if (freshCheck.error) {
        setStage("booking_blocked_autocheck_failed");
        return { error: freshCheck.error };
      }
      if (!freshCheck.available) {
        setStage("booking_blocked_unavailable");
        return {
          error: "Квартира на эти даты недоступна (" + String(freshCheck.no_options_reason || "not_available")
            + "). Не говори клиенту про техническую ошибку: скажи, что вариант на эти даты занят, и предложи другой вариант или другие даты.",
          check: { available: false, no_options_reason: freshCheck.no_options_reason, calendar: freshCheck.calendar },
        };
      }
      // handleCheckApartmentAvailability обновил runtime.lastExactCheck — бронируем.
    }
  
    const known = await ensureKnownApartments(runtime);
    const apartmentSummary = known.filter(function (a) { return a.apartment_id === Number(args.apartment_id); })[0] || {};
    const apartmentAddress = apartmentSummary.address;
  
    const draft = {
      additional_phone: null,
      apartment_id: String(args.apartment_id),
      arrival_time: null,
      begin_date: String(args.begin_date),
      departure_time: null,
      end_date: String(args.end_date),
      email: args.email ? String(args.email) : null,
      first_name: String(args.first_name),
      last_name: args.last_name ? String(args.last_name) : "",
      phone: String(args.phone),
      redirect_url: "https://homereserve.ru/" + runtime.token,
      widget_type: "widget_page",
      wish: args.wish ? String(args.wish) : null,
      guests: guests,
    };
  
    if (!ALLOW_CONFIRM_BOOKING) {
      setStage("booking_dry_run");
      log("booking", "dry-run", {
        apartment_id: draft.apartment_id,
        begin_date: draft.begin_date,
        end_date: draft.end_date,
        guests: draft.guests,
        phone_last4: draft.phone.replace(/\D/g, "").slice(-4),
      });
      return {
        status: "test_mode_confirmed",
        user_message: "Готово, квартира забронирована в тестовом режиме.",
        internal_note: "Dry-run: реальный POST /confirm не вызывался.",
        apartment_address: apartmentAddress,
        draft: draft,
      };
    }
  
    setStage("booking_confirm");
    log("booking", "confirm request", {
      apartment_id: draft.apartment_id,
      begin_date: draft.begin_date,
      end_date: draft.end_date,
      guests: draft.guests,
      phone_last4: draft.phone.replace(/\D/g, "").slice(-4),
    });
    const result = asRecord(await fetchJson(runtime, widgetUrl(runtime, "/confirm"), draft));
    const bookingToken = extractBookingToken(result.url, runtime.token);
    log("booking", "confirm response", { url: result.url, booking_token: bookingToken });
  
    let bookingInfo = {};
    let bookingStatus;
    if (bookingToken) {
      const finalStatuses = { booked: true, special_price: true, canceled: true };
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          bookingInfo = asRecord(await fetchJson(runtime, widgetUrl(runtime, "/booking/" + bookingToken + "/info")));
          bookingStatus = bookingInfo.status;
          log("booking", "status poll", { attempt: attempt, status: bookingStatus });
          if (finalStatuses[bookingStatus]) break;
        } catch (e) {
          log("booking", "status poll failed", { attempt: attempt, message: String((e && e.message) || e) });
        }
        if (attempt < 3) await timeout(2500);
      }
    }
  
    if (bookingStatus === "booked" || bookingStatus === "special_price") {
      setStage("booking_confirmed");
      const totalAmount = firstNumber(bookingInfo.amount);
      const paidAmount = firstNumber(bookingInfo.paid_amount);
      const amountLeft = firstNumber(bookingInfo.amount_left);
      const bookingRules = asRecord(runtime.rules);
      const rulesSummary = [
        bookingRules.checkInFrom ? "заезд с " + bookingRules.checkInFrom : undefined,
        bookingRules.checkOutTo ? "выезд до " + bookingRules.checkOutTo : undefined,
        bookingRules.minAge ? "гость должен быть старше " + bookingRules.minAge + " лет" : undefined,
        bookingRules.passportRequired ? "при заселении нужен паспорт" : undefined,
      ].filter(Boolean).join(", ");
      const bookedNights = safeNights(draft.begin_date, draft.end_date);
      return {
        status: "booking_confirmed",
        user_message: accentuate("Готово, бронь подтверждена"
          + (apartmentAddress ? ": " + apartmentAddress : "")
          + ", заезд " + ruDate(draft.begin_date) + ", выезд " + ruDate(draft.end_date)
          + ", " + bookedNights + " " + nightsWord(bookedNights) + "."
          + (totalAmount ? " Общая стоимость за весь период — " + totalAmount + " " + rublesWord(totalAmount) + "." : "")
          + (paidAmount ? " Предоплата " + paidAmount + " " + rublesWord(paidAmount) + ", остаток " + (amountLeft !== undefined ? amountLeft + " " + rublesWord(amountLeft) + "." : "при заселении.") : "")),
        nights: bookedNights,
        reminder: rulesSummary ? "Коротко напомни клиенту условия заселения: " + rulesSummary + "." : undefined,
        booking_status: bookingStatus,
        apartment_address: apartmentAddress,
        amount: totalAmount,
        paid_amount: paidAmount,
        amount_left: amountLeft,
        draft: draft,
      };
    }
  
    if (bookingStatus === "canceled") {
      setStage("booking_rejected");
      return {
        status: "booking_rejected",
        user_message: "Бронь не прошла. Предложи другой вариант или связь с администратором.",
        booking_status: bookingStatus,
        apartment_address: apartmentAddress,
        draft: draft,
      };
    }
  
    setStage("booking_request_sent");
    return {
      status: "booking_request_sent",
      user_message: accentuate("Заявка на бронирование отправлена"
        + (apartmentAddress ? " по квартире " + apartmentAddress : "")
        + ", администратор свяжется для подтверждения."),
      booking_status: bookingStatus,
      apartment_address: apartmentAddress,
      draft: draft,
    };
  }
  
  function parseFunctionArgs(args) {
    if (!args) return {};
    if (typeof args === "string") {
      try { return JSON.parse(args); } catch (e) { return {}; }
    }
    return args;
  }
  
  async function handleToolCall(geminiClient, runtime, event) {
    const payload = event.data && event.data.payload ? event.data.payload : {};
    const calls = payload.functionCalls || [];
    const responses = [];
  
    if (runtime.voiceState) runtime.voiceState.toolInFlight = true;
    try {
    for (let i = 0; i < calls.length; i++) {
      const fc = calls[i];
      const name = fc.name || "unknown";
      const args = parseFunctionArgs(fc.args);
      const toolStartedAt = Date.now();
  
      setStage("tool_" + name);
      log("tool", name + " args", args);
  
      try {
        let output;
        if (name === "search_apartments") {
          output = await handleSearchApartments(runtime, args);
        } else if (name === "check_apartment_availability") {
          output = await handleCheckApartmentAvailability(runtime, args);
        } else if (name === "get_apartment_detail") {
          const apartmentId = await resolveApartmentId(runtime, args);
          output = await fetchApartmentDetail(runtime, apartmentId);
        } else if (name === "create_booking_request") {
          output = await handleCreateBookingRequest(runtime, args);
        } else {
          output = { error: "Unknown function: " + name };
        }
  
        responses.push({ id: fc.id, name: name, response: { output: output } });
        recordToolMetric(true);
        log("tool", name + " ok", { latency_ms: Date.now() - toolStartedAt });
      } catch (e) {
        const message = String((e && e.message) || e);
        responses.push({ id: fc.id, name: name, response: { error: message } });
        recordToolMetric(false);
        log("tool", name + " error", { message: message, latency_ms: Date.now() - toolStartedAt });
      }
    }
  
    if (responses.length) {
      geminiClient.sendToolResponse({ functionResponses: responses });
      // Коннектор 0.56.0: модель может не продолжить генерацию после
      // functionResponse — turn зависает, пока клиент сам не заговорит.
      // Если через 2.5 с нет ни речи бота, ни речи клиента — пинаем модель.
      const sentAt = Date.now();
      setTimeout(function () {
        const state = runtime.voiceState;
        if (!state || SESSION_SHUTTING_DOWN) return;
        if (state.toolInFlight) return;
        if ((state.lastOutputAt || 0) > sentAt) return;
        if ((state.lastInputAt || 0) > sentAt) return;
        log("tool", "model stalled after tool response, nudging");
        try {
          geminiClient.sendRealtimeInput({
            text: "Служебное сообщение: результат инструмента уже получен. Немедленно озвучь клиенту итог по нему.",
          });
        } catch (e) {
          log("tool", "stall nudge failed", String((e && e.message) || e));
        }
      }, 2500);
    }
    } finally {
      if (runtime.voiceState) {
        runtime.voiceState.toolInFlight = false;
        runtime.voiceState.lastActivityAt = Date.now();
      }
    }
  }

  function timeout(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  ACTIVE_CALL_METRICS = createCallMetrics();
  SESSION_SHUTTING_DOWN = false;
  let runtime = null;
  let watchdogTimer = null;
  let maxDurationTimer = null;

  async function initialize({ callerPhone } = {}) {
    setStage("preloading");
    runtime = await loadRuntimeConfig(PAGE_URL);
    const rawCallerPhone = String(callerPhone || "");
    runtime.callerPhone = isValidPhone(rawCallerPhone) ? rawCallerPhone : null;
    runtime.voiceState = {
      lastActivityAt: Date.now(),
      lastInputAt: 0,
      lastOutputAt: 0,
      playbackEndEstimate: 0,
      nudgeCount: 0,
      farewellAt: 0,
      toolInFlight: false,
    };
    setStage("gemini_ready");
    return {
      model: GEMINI_MODEL,
      config: buildGeminiConfig(runtime),
    };
  }

  function createClient(sendPacket, clearMediaBuffer) {
    return {
      sendRealtimeInput(input) {
        sendPacket({ customEvent: "gemini", realtimeInput: input || {} });
      },
      sendToolResponse(input) {
        sendPacket({
          customEvent: "gemini",
          toolResponse: input || { functionResponses: [] },
        });
      },
      clearMediaBuffer() {
        if (typeof clearMediaBuffer === "function") clearMediaBuffer();
      },
    };
  }

  function handleServerMessage(serverMessage, client) {
    if (!runtime) return;
    const content = serverMessage.serverContent || {};

    if (content.inputTranscription) {
      const payload = content.inputTranscription;
      runtime.voiceState.lastActivityAt = Date.now();
      runtime.voiceState.lastInputAt = Date.now();
      runtime.voiceState.nudgeCount = 0;
      runtime.voiceState.farewellAt = 0;
      if (payload.text) log("input", payload.text, { finished: !!payload.finished });
    }

    if (content.outputTranscription) {
      const payload = content.outputTranscription;
      const text = String(payload.text || "");
      runtime.voiceState.lastActivityAt = Date.now();
      runtime.voiceState.lastOutputAt = Date.now();
      runtime.voiceState.playbackEndEstimate =
        Math.max(runtime.voiceState.playbackEndEstimate, Date.now()) + text.length * 90;
      if (text) log("output", text, { finished: !!payload.finished });
    }

    if (content.interrupted) {
      runtime.voiceState.playbackEndEstimate = Date.now();
      client.clearMediaBuffer();
    }

    if (serverMessage.toolCall) {
      handleToolCall(client, runtime, {
        data: { payload: serverMessage.toolCall },
      }).catch(function (error) {
        log("tool", "handler error", String((error && error.message) || error));
      });
    }

    if (serverMessage.toolCallCancellation) {
      log("tool", "cancel requested", serverMessage.toolCallCancellation);
    }
    if (serverMessage.usageMetadata) handleUsagePayload(serverMessage.usageMetadata);
    if (content.turnComplete) {
      log("gemini", "turn complete", { reason: content.turnCompleteReason });
    }
    if (serverMessage.goAway) {
      log("proxy", "gemini goAway", serverMessage.goAway);
      client.sendRealtimeInput({
        text: "Служебное сообщение: сессия скоро завершится. Вежливо заверши разговор одной короткой фразой.",
      });
    }
  }

  function startWatchdogs(client, onMaxDuration) {
    watchdogTimer = setInterval(function () {
      const state = runtime && runtime.voiceState;
      if (!state || state.toolInFlight || SESSION_SHUTTING_DOWN) return;
      const now = Date.now();
      const idleSince = Math.max(state.lastActivityAt, state.playbackEndEstimate || 0);
      const idleMs = now - idleSince;
      if (state.nudgeCount >= 2) {
        if (idleMs > 40000 && !state.farewellAt) {
          state.farewellAt = now;
          client.sendRealtimeInput({
            text: "Служебное сообщение: клиент не ответил. Коротко попрощайся.",
          });
          const hangupTimer = setTimeout(function () {
            if (!SESSION_SHUTTING_DOWN && runtime.voiceState.nudgeCount >= 2) {
              onMaxDuration("silence_timeout");
            }
          }, 8000);
          hangupTimer.unref?.();
        }
        return;
      }
      if (idleMs <= 12000) return;
      state.nudgeCount += 1;
      state.lastActivityAt = now;
      client.sendRealtimeInput({
        text: "Служебное сообщение: в разговоре тишина. Если ждёшь ответа — коротко повтори вопрос; иначе мягко спроси, слышно ли тебя.",
      });
    }, 5000);
    watchdogTimer.unref?.();

    const maxDurationMs = Number(options.maxCallDurationMs || MAX_CALL_DURATION_MS);
    if (maxDurationMs > 0) {
      maxDurationTimer = setTimeout(function () {
        if (SESSION_SHUTTING_DOWN) return;
        client.sendRealtimeInput({
          text: "Служебное сообщение: достигнут лимит звонка. Коротко подведи итог и попрощайся.",
        });
        const hangupTimer = setTimeout(function () {
          if (!SESSION_SHUTTING_DOWN) onMaxDuration("bot_max_duration");
        }, 15000);
        hangupTimer.unref?.();
      }, maxDurationMs);
      maxDurationTimer.unref?.();
    }
  }

  function shutdown(reason) {
    if (SESSION_SHUTTING_DOWN) return;
    SESSION_SHUTTING_DOWN = true;
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (maxDurationTimer) clearTimeout(maxDurationTimer);
    logCallSummary(reason);
  }

  return {
    initialize,
    createClient,
    handleServerMessage,
    startWatchdogs,
    shutdown,
    bookingMode: ALLOW_CONFIRM_BOOKING ? "live" : "dry-run",
    initialText:
      'Начни разговор сейчас ровно этой фразой: "Здравствуйте! Сервис «Как Дома», посуточная аренда квартир. Чем могу помочь?"',
    get runtime() {
      return runtime;
    },
  };
}

function createHttpRequestAdapter(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch API implementation is required");
  }
  return async function httpRequestAsync(url, request = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    timer.unref?.();
    try {
      const headers = {};
      for (const rawHeader of request.headers || []) {
        const separator = rawHeader.indexOf(":");
        if (separator === -1) continue;
        headers[rawHeader.slice(0, separator).trim()] = rawHeader.slice(separator + 1).trim();
      }
      const response = await fetchImpl(url, {
        method: request.method || "GET",
        headers,
        body: request.postData,
        signal: controller.signal,
      });
      return {
        code: response.status,
        text: await response.text(),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
