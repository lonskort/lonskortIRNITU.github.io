const { authed } = require('./_store');

// Название группы из таблицы -> id группы на сайте
const GROUPS = {
  'мкск251': 'ksk-25-1', 'мкск252': 'ksk-25-2',
  'мбу251': 'bu-25-1', 'мбуп251': 'bup-25-1',
  'миспр251': 'ispr-25-1', 'миспр252': 'ispr-25-2', 'миспр253': 'ispr-25-3',
  'ммтоэ251': 'mtoe-25-1', 'ммтоэ252': 'mtoe-25-2',
  'мтмт251': 'tmt-25-1', 'мтмт252': 'tmt-25-2',
  'мруп261': 'rup-26-1', 'мруп262': 'rup-26-2',
};
// латиница, похожая на кириллицу (ошибки распознавания) -> кириллица
const LAT = { k: 'к', c: 'с', m: 'м', p: 'р', t: 'т', o: 'о', e: 'е', a: 'а', y: 'у', x: 'х', h: 'н', b: 'в' };
const norm = (s) => String(s || '').toLowerCase()
  .replace(/[kcmptoeayxhb]/g, (ch) => LAT[ch])
  .replace(/[^а-яё0-9]/g, '');

const PROMPT = `На изображении таблица замен в расписании. Каждая строка содержит:
день, группу, номер пары, подгруппу (0 = вся группа), затем СТАРОЕ занятие (предмет, преподаватель, аудитория), затем подгруппу и НОВОЕ занятие (предмет, преподаватель, аудитория).
Верни ТОЛЬКО JSON-массив без пояснений и без markdown. Элемент:
{"group":"мКСК-25-2","pair":5,"sub":0,"from":{"subject":"","teacher":"","room":""},"to":{"subject":"","teacher":"","room":""}}
Если в новой части написано «Пары нет», то "to": null.
Текст переносить точно как в таблице. Аудитории вида 21-49: если номер разбит переносом строки ("22-" и "214"), склей в "22-214". Ничего не выдумывай, пустые ячейки — пустая строка.`;

// Модели по умолчанию (по приоритету). Перегрузка (503/429) -> повтор -> следующая модель.
const DEFAULT_GEMINI_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!authed(req)) return res.status(401).json({ error: 'Неверный пароль' });
  const { image, media_type } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Нет изображения' });

  const mt = media_type || 'image/jpeg';
  let text;
  if (process.env.GEMINI_API_KEY) {
    // GEMINI_MODEL может содержать несколько моделей через запятую: порядок = приоритет.
    const models = (process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODELS.join(','))
      .split(',').map((m) => m.trim()).filter(Boolean);
    const body = JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: mt, data: image } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    let lastErr = '';
    let overloaded = false;
    outer:
    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let r, data;
        try {
          r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
            body,
          });
          data = await r.json();
        } catch (e) {
          lastErr = String(e.message || e);
          overloaded = true;
          await sleep(1000);
          continue;
        }
        if (r.ok) {
          text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
          if (text) break outer;
          lastErr = 'Пустой ответ модели ' + model;
          break; // пробуем следующую модель
        }
        lastErr = data.error?.message || `Ошибка Gemini API (${r.status})`;
        if (RETRYABLE.has(r.status)) {
          overloaded = true;
          if (attempt === 0) { await sleep(1500); continue; } // один повтор той же модели
          break; // затем следующая модель
        }
        break; // 400/403/404 и т.п.: эта модель недоступна, пробуем следующую
      }
    }
    if (!text) {
      return res.status(502).json({
        error: overloaded
          ? 'Модели Gemini сейчас перегружены. Подождите минуту и нажмите «Распознать» ещё раз.'
          : lastErr || 'Ошибка Gemini API',
      });
    }
  } else {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 6000,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mt, data: image } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Ошибка API' });
    text = (data.content || []).map((b) => b.text || '').join('');
  }
  text = text.replace(/```json|```/g, '').trim();
  let all;
  try { all = JSON.parse(text); } catch { return res.status(502).json({ error: 'Не удалось разобрать ответ', raw: text }); }

  const rows = all
    .filter((x) => GROUPS[norm(x.group)])
    .map((x) => ({ group: GROUPS[norm(x.group)], pair: Number(x.pair), sub: Number(x.sub) || 0, from: x.from, to: x.to || null }));
  res.status(200).json({ rows, total: all.length });
};
