const { authed } = require('./_store');

// Название группы из таблицы -> id группы на сайте
const GROUPS = {
  'мкск251': 'ksk-25-1', 'мкск252': 'ksk-25-2',
  'мбу251': 'bu-25-1', 'мбуп251': 'bup-25-1',

  'миспр251': 'ispr-25-1', 'миспр252': 'ispr-25-2', 'миспр253': 'ispr-25-3',

  // мСПР 2 курс
  'мспр251': 'spr-25-1',
  'мспр252': 'spr-25-2',

  // Fallback для кривого OCR: МС门P, МСnP, МCПP и т.п.
  'мср251': 'spr-25-1',
  'мср252': 'spr-25-2',
  'мсп251': 'spr-25-1',
  'мсп252': 'spr-25-2',

  'ммтоэ251': 'mtoe-25-1', 'ммтоэ252': 'mtoe-25-2',

  // Fallback для OCR вида MMTO3-25-1
  'ммто3251': 'mtoe-25-1',
  'ммто3252': 'mtoe-25-2',

  // мТМТ 2 курс
  'мтмт251': 'tmt-25-1',
  'мтмт252': 'tmt-25-2',

  // Fallback, если потерялась одна буква Т
  'мтм251': 'tmt-25-1',
  'мтм252': 'tmt-25-2',

  'мруп261': 'rup-26-1', 'мруп262': 'rup-26-2',
  'мбу261': 'bu-26-1',
  'мбуп261': 'bup-26-1',
  'мкск261': 'ksk-26-1',
  'мкск262': 'ksk-26-2',
  'мтоап261': 'toap-26-1',
  'ммтоэ261': 'mtoe-26-1',
  'ммтоэ262': 'mtoe-26-2',
  'мспр261': 'spr-26-1',
  'мспр262': 'spr-26-2',
  'мтмт261': 'tmt-26-1',
  'мтмт262': 'tmt-26-2',
  'мтмт263': 'tmt-26-3',
};

// латиница, похожая на кириллицу (ошибки распознавания) -> кириллица
const LAT = {
  k: 'к',
  c: 'с',
  m: 'м',
  p: 'р',
  t: 'т',
  o: 'о',
  e: 'е',
  a: 'а',
  y: 'у',
  x: 'х',
  h: 'н',
  b: 'в',
  n: 'п',
  s: 'с'
};

const norm = (s) => String(s || '').toLowerCase()
  .replace(/[kcmptoeayxhbsn]/g, (ch) => LAT[ch])
  .replace(/[^а-яё0-9]/g, '');

const PROMPT = `На изображении таблица замен в расписании. Каждая строка содержит: день, группу, номер пары, подгруппу (0 = вся группа), затем СТАРОЕ занятие (предмет, преподаватель, аудитория), затем подгруппу и НОВОЕ занятие (предмет, преподаватель, аудитория). Верни ТОЛЬКО JSON-массив без пояснений и без markdown. Элемент: {"group":"мКСК-25-2","pair":5,"sub":0,"from":{"subject":"","teacher":"","room":""},"to":{"subject":"","teacher":"","room":""}} Если в новой части написано «Пары нет», то "to": null. Текст переносить точно как в таблице. Аудитории вида 21-49: если номер разбит переносом строки ("22-" и "214"), склей в "22-214". Ничего не выдумывай, пустые ячейки — пустая строка.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  if (!authed(req)) return res.status(401).json({ error: 'Неверный пароль' });

  const { image, media_type } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Нет изображения' });

  const mt = media_type || 'image/jpeg';
  let text;

  if (process.env.OPENAI_API_KEY) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        max_completion_tokens: 6000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mt};base64,${image}` } },
          ],
        }],
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Ошибка OpenAI API' });
    text = data.choices?.[0]?.message?.content || '';
  } else if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: mt, data: image } },
            { text: PROMPT },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0,
        },
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Ошибка Gemini API' });
    text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
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
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mt, data: image } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data.error?.message || 'Ошибка API' });
    text = (data.content || []).map((b) => b.text || '').join('');
  }

  text = text.replace(/```json|```/g, '').trim();

  let all;
  try {
    all = JSON.parse(text);
  } catch {
    return res.status(502).json({ error: 'Не удалось разобрать ответ', raw: text });
  }

  const rows = all
    .filter((x) => GROUPS[norm(x.group)])
    .map((x) => ({
      group: GROUPS[norm(x.group)],
      pair: Number(x.pair),
      sub: Number(x.sub) || 0,
      from: x.from,
      to: x.to || null,
    }));

  res.status(200).json({ rows, total: all.length });
};
