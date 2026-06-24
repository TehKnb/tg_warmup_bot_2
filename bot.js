require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const cron = require('node-cron');
const { pool, initDb } = require('./db');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const LANDING_URL = process.env.LANDING_URL;
const CHANNEL_ID = process.env.CHANNEL_ID;
const CHANNEL_URL = process.env.CHANNEL_URL;
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL;
const GOOGLE_SHEET_WEBHOOK_URL = process.env.GOOGLE_SHEET_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}
function normalizeUtmSource(value) {
  if (!value) return null;

  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 50) || null;
}

async function telegram(method, payload) {
    console.log('TELEGRAM CALL:', method, payload);
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  console.log('TELEGRAM RESPONSE:', data);

  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getDisplayName(firstName) {
  return firstName ? escapeHtml(firstName) : 'друже';
}

async function getChatMember(chatId, userId) {
  return telegram('getChatMember', {
    chat_id: chatId,
    user_id: Number(userId)
  });
}

async function sendLeadToCrm({ leadToken, phone, name, utmSource }) {
  if (!CRM_WEBHOOK_URL) {
    throw new Error('CRM_WEBHOOK_URL is not set');
  }

  const payload = {
    Nameform: 'Заявка на безкоштовну консультацію: Персональний розбір бізнесу, тепла, ТГ-бот',
    Source: 'Заявка на безкоштовну консультацію (Персональний розбір бізнесу, тепла, ТГ-бот)',
    sitename: 'ТГ-бот @knb_bonus_bot',
    'Lead Token': leadToken,
    utm_source: utmSource || '',
    Phone: phone,
    Name: name
  };

  const res = await fetch(CRM_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`CRM webhook error: ${res.status} ${text}`);
  }

  console.log('CRM LEAD SENT:', payload);
}

async function sendMetaEvent(eventName, user = {}) {
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (!pixelId || !accessToken) {
    console.warn('META_PIXEL_ID or META_ACCESS_TOKEN is not set');
    return;
  }

  const externalId = user.lead_token || user.telegram_user_id || user.chat_id || '';

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'chat',
        user_data: {
          external_id: crypto
            .createHash('sha256')
            .update(String(externalId))
            .digest('hex')
        },
        custom_data: {
          telegram_user_id: user.telegram_user_id || '',
          username: user.username || '',
          utm_source: user.utm_source || ''
        }
      }
    ]
  };

  const metaController = new AbortController();
  const metaTimeout = setTimeout(() => metaController.abort(), 4000);

  let res;
  try {
    res = await fetch(
      `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: metaController.signal
      }
    );
  } finally {
    clearTimeout(metaTimeout);
  }

  const data = await res.json();

  if (!res.ok) {
    console.error('META EVENT ERROR:', data);
    return;
  }

  console.log('META EVENT SENT:', eventName, data);
}

async function askForContact(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: `Маєте питання і хочете дізнатись більше?
Залиште номер — менеджер зв’яжеться найближчим часом.`,
    reply_markup: {
      keyboard: [
        [
          {
            text: 'Надіслати контакт',
            request_contact: true
          }
        ]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    }
  });
}

async function isSubscribedToChannel(userId) {
  try {
    const response = await getChatMember(CHANNEL_ID, userId);
    const status = response?.result?.status;

    return ['creator', 'administrator', 'member'].includes(status);
  } catch (error) {
    console.error('SUBSCRIPTION CHECK ERROR:', error);
    return false;
  }
}

function getKyivNowParts() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });



  const parts = formatter.formatToParts(new Date());
  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function isWorkingTimeKyiv() {
  const now = new Date();

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(now);
  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  const hour = Number(map.hour);
  const minute = Number(map.minute);

  const totalMinutes = hour * 60 + minute;

  const start = 9 * 60;       // 09:00
  const end = 18 * 60 + 55;   // 18:55

  return totalMinutes >= start && totalMinutes <= end;
}

function getSlotLabel(hour) {
  if (hour === 10) return '10:00';
  if (hour === 14) return '14:00';
  if (hour === 18) return '18:00';
  return null;
}

async function sendToGoogleSheet(payload) {
  if (!GOOGLE_SHEET_WEBHOOK_URL) {
    console.warn('GOOGLE_SHEET_WEBHOOK_URL is not set');
    return;
  }

  try {
    const sheetController = new AbortController();
    const sheetTimeout = setTimeout(() => sheetController.abort(), 4000);

    let res;
    try {
      res = await fetch(GOOGLE_SHEET_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: sheetController.signal
      });
    } finally {
      clearTimeout(sheetTimeout);
    }

    const text = await res.text();

    if (!res.ok) {
      console.error('GOOGLE SHEET ERROR:', res.status, text);
    } else {
      console.log('GOOGLE SHEET SENT:', payload);
    }
  } catch (error) {
    console.error('GOOGLE SHEET SEND ERROR:', error);
  }
}

async function sendAllPosts(chatId, telegramUserId) {
  const result = await pool.query(
    `SELECT lead_token, utm_source FROM users WHERE telegram_user_id = $1`,
    [telegramUserId]
  );

  const user = result.rows[0];

  if (!user) {
    await telegram('sendMessage', {
      chat_id: chatId,
      text: 'Спочатку натисніть /start'
    });
    return;
  }

  const posts = getWarmupPosts(user.lead_token, user.utm_source);

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    // 👇 затримка щоб Telegram не душив flood limit
    await new Promise(r => setTimeout(r, 1200));

    if (post.type === 'text') {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {})
      });
    }

    if (post.type === 'photo_with_text') {
      await telegram('sendPhoto', {
        chat_id: chatId,
        photo: post.photo,
        caption: post.text,
        parse_mode: post.parse_mode || undefined
      });
    }

    if (post.type === 'photo_then_button') {
      await telegram('sendPhoto', {
        chat_id: chatId,
        photo: post.photo,
        caption: post.text,
        parse_mode: post.parse_mode || undefined
      });

      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.button_text_label || '👇',
        reply_markup: {
          inline_keyboard: [
            [{ text: post.button_text, url: post.button_url }]
          ]
        }
      });
    }

    if (post.type === 'button_text') {
      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
        reply_markup: {
          inline_keyboard: [
            [{ text: post.button_text, url: post.button_url }]
          ]
        }
      });
    }

    if (post.type === 'media_group_then_button') {
      await telegram('sendMediaGroup', {
        chat_id: chatId,
        media: post.media
      });

      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.followup_text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
        reply_markup: {
          inline_keyboard: [
            [{ text: post.button_text, url: post.button_url }]
          ]
        }
      });
    }

    if (post.type === 'media_group_then_button_text') {
      await telegram('sendMediaGroup', {
        chat_id: chatId,
        media: post.media
      });

      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.followup_text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
        reply_markup: {
          inline_keyboard: [
            [{ text: post.button_text, url: post.button_url }]
          ]
        }
      });
    }

    if (post.type === 'videos_then_button') {
      for (const videoId of post.videos) {
        await telegram('sendVideo', {
          chat_id: chatId,
          video: videoId
        });

        await new Promise(r => setTimeout(r, 700));
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.followup_text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
        reply_markup: {
          inline_keyboard: [
            [{ text: post.button_text, url: post.button_url }]
          ]
        }
      });
    }

    if (post.type === 'video_then_button') {
      if (post.video) {
        await telegram('sendVideo', {
          chat_id: chatId,
          video: post.video
        });
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.followup_text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
        reply_markup: {
          inline_keyboard: [
            [{ text: post.button_text, url: post.button_url }]
          ]
        }
      });
    }

    if (post.type === 'video_then_text') {
      if (post.video) {
        await telegram('sendVideo', {
          chat_id: chatId,
          video: post.video
        });
      }

      await telegram('sendMessage', {
        chat_id: chatId,
        text: post.followup_text,
        ...(post.parse_mode ? { parse_mode: post.parse_mode } : {})
      });
    }
  }
}

function getCurrentKyivSlotKey() {
  const now = getKyivNowParts();
  const slot = getSlotLabel(now.hour);

  if (!slot) return null;

  const mm = String(now.month).padStart(2, '0');
  const dd = String(now.day).padStart(2, '0');

  return `${now.year}-${mm}-${dd} ${slot}`;
}

function getFirstSlotDateUtc(fromDate = new Date()) {
  const kyivFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  function getParts(date) {
    const parts = kyivFormatter.formatToParts(date);
    const map = {};

    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }

    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second)
    };
  }

  const now = getParts(fromDate);

  const today10 = kyivLocalToUtc(now.year, now.month, now.day, 10, 0, 0);

  if (today10 > fromDate) {
    return today10;
  }

  const tomorrow = new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  const t = getParts(tomorrow);

  return kyivLocalToUtc(t.year, t.month, t.day, 10, 0, 0);
}

function getNextSlotDateUtc(fromDate = new Date()) {
  const kyivFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  function getParts(date) {
    const parts = kyivFormatter.formatToParts(date);
    const map = {};

    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = part.value;
    }

    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
      second: Number(map.second)
    };
  }

  const now = getParts(fromDate);
  const slots = [10, 14, 18];

  for (const hour of slots) {
    const slotUtc = kyivLocalToUtc(now.year, now.month, now.day, hour, 0, 0);

    if (slotUtc > fromDate) {
      return slotUtc;
    }
  }

  const tomorrow = new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  const t = getParts(tomorrow);

  return kyivLocalToUtc(t.year, t.month, t.day, 10, 0, 0);
}

function kyivLocalToUtc(year, month, day, hour, minute, second) {
  const approxUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(approxUtc);
  const map = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }

  const kyivAsIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = kyivAsIfUtc - approxUtc.getTime();

  return new Date(targetAsUtc - offsetMs);
}

function buildLandingLink(leadToken, utmSource) {
  const url = new URL(LANDING_URL);

  url.searchParams.set('lead_token', leadToken);

  if (utmSource) {
    url.searchParams.set('utm_source', utmSource);
  }

  return url.toString();
}

async function sendWarmupIntro(chatId, firstName) {
  const name = getDisplayName(firstName);

  await telegram('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    text:
`${name}, ми підготували для вас <b>бонусний розбір "Контент-розпаковка вашого бізнесу"</b>, де ви дізнаєтесь, як позиціонувати свій бізнес в Instagram, щоб він приносив стабільні продажі 🔥

<i>Але спочатку перевіримо <b>вашу підписку на наш канал:</b></i>`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Підписатися на канал', url: CHANNEL_URL }],
        [{ text: 'Готово✅', callback_data: 'check_subscription' }]
      ]
    }
  });
}

async function sendNotSubscribed(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: 'Не бачимо вашої підписки, спробуйте ще раз 👇🏻',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Підписатися на канал', url: CHANNEL_URL }],
        [{ text: 'Готово✅', callback_data: 'check_subscription' }]
      ]
    }
  });
}

async function sendBonusLink(chatId, telegramUserId) {
  const result = await pool.query(
    `SELECT lead_token, utm_source FROM users WHERE telegram_user_id = $1`,
    [telegramUserId]
  );

  const user = result.rows[0];

  if (!user) {
    console.error('USER NOT FOUND FOR BONUS LINK');
    return;
  }

  const link = buildLandingLink(user.lead_token, user.utm_source);

  await telegram('sendMessage', {
    chat_id: chatId,
    text: '<i>Бонусні розбори вже чекають вас тут:</i>',
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Забрати бонус!', url: link }]
      ]
    }
  });
}

function getWarmupPosts(leadToken, utmSource) {
    const link = buildLandingLink(leadToken, utmSource);

  return [
    {
      type: 'photo_with_text',
      parse_mode: 'HTML',
      photo: 'https://i.ibb.co/KdbYMfv/photo-2026-05-01-13-16-27.jpg',
      text:
`<b>Що таке “Стратегія керованого зростання”?</b>

Це <u>7 тижнів</u> практичної роботи над вашим бізнесом із експертами в наймі, продажах та маркетингу, які мають <b>понад 10 років досвіду роботи з підприємцями!</b>

Наша програма націлена на те, щоб ви уже <b>під час навчання</b> навели порядок у процесах, побачили точки зросту та <i>почали рости в цифрах!</i>

<b>За ці 7 тижнів ви:</b>
• розберетеся з показниками бізнесу і побачите, <b>де втрачаєте гроші</b>;
• вибудуєте <b>системний найм</b> і перестанете тягнути все на собі;
• налагодите <b>стабільний потік заявок</b> в онлайні;
• вийдете з операційки та <b>почнете справді керувати</b> своїм бізнесом.

Якщо ви відчуваєте, що вперлись у “стелю” прибутку або хочете масштабуватися без постійного хаосу — <b>ця програма саме для вас!</b>`
    },

    {
      type: 'videos_then_button',
      parse_mode: 'HTML',
      videos: [
        'BAACAgIAAxkBAANOafnm6wVF7D53WmiTL13ITDUCtzMAAq2gAALhxNFLH27qlwTWAos7BA'
      ],
      followup_text:
`<i>Заповнюйте анкету для консультації щодо навчання <b>ТУТ</b>👇🏻</i>`,
      button_text: 'ХОЧУ В КЛУБ!',
      button_url: link
    },

    {
      type: 'photo_with_text',
      parse_mode: 'HTML',
      photo: 'https://i.ibb.co/FbCDznx2/image-2026-04-21-10-29-33.png',
      text:
`<b>ХТО Ж ТАКИЙ ОЛЕКСАНДР МОРОЗОВ?</b>

<i>Це людина, з якої починається Клуб «Конс на Бі$»!</i>

Уже 12+ років він допомагає підприємцям збільшувати прибуток, вибудовувати системність і масштабуватися!

<i><b>І за цей час:</b>
- 50 000 підприємців побувало на подіях Олександра;
- тисячі підприємців пройшли через 1000+ стратегічних сесій від нього;
- 7500 учасників пройшли його 7-тижневі програми та інтенсиви.</i>

Олександр не просто навчає — він створив середовище, яке не просто змінить ваше мислення, а й <b>викликатиме звичку ЗРОСТАТИ!</b>`
    },

    {
      type: 'media_group_then_button',
      parse_mode: 'HTML',
      media: [
        { type: 'photo', media: 'https://i.ibb.co/W4pbDKzB/Instagram-post-326.png' },
        { type: 'photo', media: 'https://i.ibb.co/Y7Zvk22y/Instagram-post-324.png' },
        { type: 'photo', media: 'https://i.ibb.co/whHrW9ty/Instagram-post-325.png' },
        { type: 'photo', media: 'https://i.ibb.co/0VQyzrDP/Instagram-post-323.png' }
      ],
      followup_text:
    `📱 Ось такі результати отримують наші підприємці, які пройшли 7-тижневу програму та впровадили Instagram у свій бізнес!

    На 4 модулі <i><b>«Instagram як система»</b></i> нашого 7-тижневого навчання підприємці вивчають, як:

    <i>• вибудувати керований потік клієнтів з Instagram

    • обрати стратегію просування під свою нішу

    • запустити рекламу, яка починає приносити заявки вже під час навчання!</i>

    <b>Хочете розібратись у продажах в Instagram і мати такі ж результати?</b>`,
      button_text: 'Заповнюйте анкету тут!',
      button_url: link
    },

    {
      type: 'photo_then_button',
      parse_mode: 'HTML',
      photo: 'https://i.ibb.co/zVBs87n5/IMG-5881.png',
      text:
`<b>А ХТО З ЕКСПЕРТІВ СУПРОВОДЖУЄ ПІДПРИЄМЦІВ НА НАВЧАННІ У <i>СФЕРІ МАРКЕТИНГУ?</i></b>

<u><b>АННА МОРОЗОВА</b></u>
співзасновниця нашого Бізнес-Клубу
маркетолог-практик

Анна <b>понад 15</b> років допомагає підприємцям масштабувати бізнес через системний маркетинг і продажі.

Анна — авторка та спікерка десятків навчальних програм для власників малого та середнього бізнесу. І зараз вона ділиться лише тими інструментами, які випробувала в реальних бізнесах!

<u><b>ЖАННА АНТОНОВА</b></u>
<i>спікерка нашого Клубу у напрямку маркетингу</i>

У маркетингу Жанна вже <b>понад 3 роки.</b>
І за цей час вона встигла попрацювати уже зі <b>100+ нішами</b>: від невеликих онлайн-магазинів до великих компаній!

Жанна — учениця Олександра Морозова.
І усе, що вона передає підприємцям сьогодні — це практичні поради, які є результатом довгої та складної роботи: аналізу, пошуку ідей та форматів та постійного тестування.

<u><b>Більше про інших спікерів ви зможете дізнатись тут:</b></u>`,
      button_text: 'ПРО СПІКЕРІВ КЛУБУ',
      button_url: 'https://t.me/c/3538911047/8'
    },


    {
      type: 'video_then_button',
      parse_mode: 'HTML',
      video: 'BAACAgIAAxkBAANPafnnXFPP2tzomRzLgy6LJhDZVJEAArqgAALhxNFLfcqeFAUcHYo7BA',
      followup_text:
`<b>Як бачите, Конс на Бі$ викликає довіру!</b>
І якщо ви хочете дізнатись, як ваш бізнес може змінитись завдяки нашому навчанню — <i><u>заповнюйте анкету тут</u></i>👇🏻`,
      button_text: 'ХОЧУ В КЛУБ!',
      button_url: link
    },

    {
      type: 'text',
      parse_mode: 'HTML',
      text:
`<i>Ми знаємо, що ви зберегли відео, але так і не проглянули його…</i>
В той час як ваші конкуренти уже долучаються до нашого Клубу та <b>роблять свої перші результати!</b>`
    },

    {
      type: 'video_then_text',
      parse_mode: 'HTML',
      video: 'BAACAgIAAxkBAANQafnnxmeUPKbBbNTuwwcpV7GtvaIAAr-gAALhxNFLbhiXAkvOnUw7BA',
      followup_text:
`<b>Все ще сумніваєтесь, що ваша ніша не підходить?</b>
Подивіться, скільки підприємців приходить до нас із нестандартними нішами ⬆️
Але завдяки отриманим знанням у Клубі вони знають, як можна <b>зростати в прибутку і масштабуватись!</b>`
    },

    {
      type: 'button_text',
      parse_mode: 'HTML',
      text:
`<i>Якщо ви навіть не можете переглянути відео від нас, то не дивуйтесь, що <b>ваші конкуренти виграють!</b></i>
Щоб бути на <i><b>крок попереду,</b></i> почніть діяти вже ЗАРАЗ! Це ваш останній шанс потрапити в наш Клуб!`,
      button_text: 'Заповнюйте анкету ТУТ!',
      button_url: link
    }
  ];
}

async function sendPostToUser(user) {
  const posts = getWarmupPosts(user.lead_token, user.utm_source);
  const post = posts[user.last_sent_step];

  if (!post) {
    await pool.query(
      `UPDATE users
       SET next_message_at = NULL
       WHERE id = $1`,
      [user.id]
    );
    return;
  }

  if (post.type === 'text') {
    await telegram('sendMessage', {
      chat_id: user.chat_id,
      text: post.text,
      ...(post.parse_mode ? { parse_mode: post.parse_mode } : {})
    });
  }

  if (post.type === 'photo_with_text') {
    await telegram('sendPhoto', {
      chat_id: user.chat_id,
      photo: post.photo,
      caption: post.text,
      parse_mode: post.parse_mode || undefined
    });
  }

  if (post.type === 'photo_then_button') {
  await telegram('sendPhoto', {
    chat_id: user.chat_id,
    photo: post.photo,
    caption: post.text,
    parse_mode: post.parse_mode || undefined
  });

  await telegram('sendMessage', {
    chat_id: user.chat_id,
    text: post.button_text_label || '👇',
    reply_markup: {
      inline_keyboard: [
        [{ text: post.button_text, url: post.button_url }]
      ]
    }
  });
}

  if (post.type === 'button_text') {
    await telegram('sendMessage', {
      chat_id: user.chat_id,
      text: post.text,
      ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
      reply_markup: {
        inline_keyboard: [
          [{ text: post.button_text, url: post.button_url }]
        ]
      }
    });
  }

  if (post.type === 'media_group_then_button') {
  await telegram('sendMediaGroup', {
    chat_id: user.chat_id,
    media: post.media
  });

  await telegram('sendMessage', {
    chat_id: user.chat_id,
    text: post.followup_text,
    ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
    reply_markup: {
      inline_keyboard: [
        [{ text: post.button_text, url: post.button_url }]
      ]
    }
  });
}

  if (post.type === 'media_group_then_button_text') {
    await telegram('sendMediaGroup', {
      chat_id: user.chat_id,
      media: post.media
    });

    await telegram('sendMessage', {
      chat_id: user.chat_id,
      text: post.followup_text,
      ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
      reply_markup: {
        inline_keyboard: [
          [{ text: post.button_text, url: post.button_url }]
        ]
      }
    });
  }

 if (post.type === 'videos_then_button') {

  for (const videoId of post.videos) {
    await telegram('sendVideo', {
      chat_id: user.chat_id,
      video: videoId
    });
    await new Promise(r => setTimeout(r, 700));
  }

  await telegram('sendMessage', {
    chat_id: user.chat_id,
    text: post.followup_text,
    ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
    reply_markup: {
      inline_keyboard: [
        [{ text: post.button_text, url: post.button_url }]
      ]
    }
  });
}

  if (post.type === 'video_then_button') {
    if (post.video) {
      await telegram('sendVideo', {
        chat_id: user.chat_id,
        video: post.video
      });
    }

    await telegram('sendMessage', {
      chat_id: user.chat_id,
      text: post.followup_text,
      ...(post.parse_mode ? { parse_mode: post.parse_mode } : {}),
      reply_markup: {
        inline_keyboard: [
          [{ text: post.button_text, url: post.button_url }]
        ]
      }
    });
  }

  if (post.type === 'video_then_text') {
    if (post.video) {
      await telegram('sendVideo', {
        chat_id: user.chat_id,
        video: post.video
      });
    }

    await telegram('sendMessage', {
      chat_id: user.chat_id,
      text: post.followup_text,
      ...(post.parse_mode ? { parse_mode: post.parse_mode } : {})
    });
  }

  await pool.query(
    `UPDATE users
     SET last_sent_step = last_sent_step + 1,
         next_message_at = $1
     WHERE id = $2`,
    [getNextSlotDateUtc(), user.id]
  );
}

async function sendSubscriptionReminder(user) {
  await telegram('sendMessage', {
    chat_id: user.chat_id,
    text:
`Бонусний розбір вже чекає вас!
Просто натисніть на кнопку нижче ⬇️`,
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Забрати бонус!', url: CHANNEL_URL }]
      ]
    }
  });

  await pool.query(
    `UPDATE users
     SET next_message_at = $1
     WHERE id = $2`,
    [getNextSlotDateUtc(), user.id]
  );
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}


app.get('/', (req, res) => {
  res.json({ ok: true, service: 'tg-warmup-bot' });
});


const processedUpdates = new Set();
app.post('/telegram/webhook', async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  const updateId = update?.update_id;

  if (!updateId || processedUpdates.has(updateId)) return;
  processedUpdates.add(updateId);

  if (processedUpdates.size > 1000) {
    const arr = [...processedUpdates];
    arr.slice(0, 500).forEach(id => processedUpdates.delete(id));
  }

  try {


    // 1. inline-кнопки
    if (update.callback_query) {
      const callback = update.callback_query;
      const data = callback.data;
      const chatId = String(callback.message.chat.id);
      const telegramUserId = String(callback.from.id);
      const username = callback.from.username || null;
      const firstName = callback.from.first_name || null;
      const callbackQueryId = callback.id;

      if (data === 'start_warmup') {
        let result = await pool.query(
          `SELECT * FROM users WHERE telegram_user_id = $1`,
          [telegramUserId]
        );

        let user = result.rows[0];

        if (!user) {
          const leadToken = generateToken();

          await pool.query(
            `INSERT INTO users (
              telegram_user_id,
              chat_id,
              username,
              first_name,
              lead_token,
              status,
              started_at,
              next_message_at,
              last_sent_step
            ) VALUES ($1, $2, $3, $4, $5, 'new', $6, NULL, 0)`,
            [
              telegramUserId,
              chatId,
              username,
              firstName,
              leadToken,
              new Date().toISOString()
            ]
          );
        } else {
          await pool.query(
            `UPDATE users
            SET chat_id = $1,
                username = $2,
                first_name = $3,
                status = 'new',
                next_message_at = NULL,
                last_sent_step = 0
            WHERE telegram_user_id = $4`,
            [
              chatId,
              username,
              firstName,
              telegramUserId
            ]
          );
        }

        await telegram('answerCallbackQuery', {
          callback_query_id: callbackQueryId
        });

        await sendWarmupIntro(chatId, firstName);

        return;
      }
      if (data === 'check_subscription') {
  const subscribed = await isSubscribedToChannel(telegramUserId);

  await telegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId
  });

  if (!subscribed) {
    await pool.query(
      `UPDATE users
      SET status = 'awaiting_subscription',
          next_message_at = $1
      WHERE telegram_user_id = $2`,
      [getFirstSlotDateUtc(), telegramUserId]
    );

    await sendNotSubscribed(chatId);
    return;
  }

  await pool.query(
    `UPDATE users
    SET status = 'warming',
        subscribed_at = NOW(),
        next_message_at = $1,
        last_sent_step = 0
    WHERE telegram_user_id = $2`,
    [getFirstSlotDateUtc(), telegramUserId]
  );

        await sendToGoogleSheet({
          event: 'subscription_confirmed',
          telegram_user_id: telegramUserId,
          status: 'warming'
        });

  await sendBonusLink(chatId, telegramUserId);

  return;
}

      return;
    }

    if (update.message && update.message.contact) {
      const message = update.message;
      const chatId = String(message.chat.id);
      const telegramUserId = String(message.from.id);
      const contact = message.contact;

      const result = await pool.query(
        `SELECT lead_token, first_name, utm_source
        FROM users
        WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      const user = result.rows[0];

      if (!user) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Спочатку натисніть /start',
          reply_markup: {
            remove_keyboard: true
          }
        });

        return;
      }

      const phone = contact.phone_number || '';
      const name =
        [contact.first_name, contact.last_name].filter(Boolean).join(' ') ||
        user.first_name ||
        'Без імені';

      try {
        await sendLeadToCrm({
          leadToken: user.lead_token,
          phone,
          name,
          utmSource: user.utm_source
        });

        await sendMetaEvent('Lead', {
            telegram_user_id: telegramUserId,
            chat_id: chatId,
            lead_token: user.lead_token,
            utm_source: user.utm_source
        });

      const isWorking = isWorkingTimeKyiv();

      const successText = isWorking
        ? '✅ Вашу заявку прийнято, очікуйте дзвінка!'
        : `✅Вашу заявку прийнято!
      Наші менеджери зараз не працюють, але ми обов’язково зв’яжемось з вами в робочий час.`;

      await telegram('sendMessage', {
        chat_id: chatId,
        text: successText,
        reply_markup: {
          remove_keyboard: true
        }
      });
      } catch (error) {
        console.error('CRM CONTACT SEND ERROR:', error);

        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Не вдалося передати контакт. Спробуйте ще раз трохи пізніше.',
          reply_markup: {
            remove_keyboard: true
          }
        });
      }
    

      return;
    }

    if (update.message && update.message.video) {
      console.log('VIDEO FILE_ID:', update.message.video.file_id);
    }

    // 2. звичайні повідомлення
    if (!update.message || !update.message.text) {
      return;
    }

    const message = update.message;
    const text = message.text.trim();
    const chatId = String(message.chat.id);
    const telegramUserId = String(message.from.id);
    const username = message.from.username || null;
    const firstName = message.from.first_name || null;

    if (text === '/start' || text.startsWith('/start ')) {
      const startPayload = text.startsWith('/start ')
  ? text.split(' ')[1]
  : null;

const utmSource = normalizeUtmSource(startPayload);

let result = await pool.query(
  `SELECT * FROM users WHERE telegram_user_id = $1`,
  [telegramUserId]
);

let user = result.rows[0];

if (!user) {
  const leadToken = generateToken();

  await pool.query(
    `INSERT INTO users (
      telegram_user_id,
      chat_id,
      username,
      first_name,
      lead_token,
      utm_source,
      status,
      started_at,
      next_message_at,
      last_sent_step
    ) VALUES ($1, $2, $3, $4, $5, $6, 'new', $7, NULL, 0)`,
    [
      telegramUserId,
      chatId,
      username,
      firstName,
      leadToken,
      utmSource,
      new Date().toISOString()
    ]
  );
} else {
  await pool.query(
    `UPDATE users
     SET chat_id = $1,
         username = $2,
         first_name = $3,
         utm_source = COALESCE($4, utm_source)
     WHERE telegram_user_id = $5`,
    [
      chatId,
      username,
      firstName,
      utmSource,
      telegramUserId
    ]
  );
}
      await sendToGoogleSheet({
        event: 'bot_start',
        telegram_user_id: telegramUserId,
        status: 'new',
        utm_source: utmSource || ''
      });

      const metaUserResult = await pool.query(
        `SELECT lead_token, utm_source
         FROM users
         WHERE telegram_user_id = $1`,
        [telegramUserId]
      );
      
      await sendMetaEvent('CompleteRegistration', {
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        username,
        first_name: firstName,
        lead_token: metaUserResult.rows[0]?.lead_token,
        utm_source: metaUserResult.rows[0]?.utm_source
      });

      await telegram('sendPhoto', {
        chat_id: chatId,
        photo: 'https://i.ibb.co/7h4WjNn/image.png',
        parse_mode: 'HTML',
        caption:
`Вас вітає український Бізнес-Клуб для підприємців <b>«Конс на Бі$»</b>!
Місце, яке викликає у підприємців звичку ПОСТІЙНО ЗРОСТАТИ🔥`,
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Старт', callback_data: 'start_warmup' }]
          ]
        }
      });

      return;
    }

      if (text === '/posts' || text.startsWith('/posts@')) {
        sendAllPosts(chatId, telegramUserId).catch(error => {
          console.error('SEND ALL POSTS ERROR:', error);
        });
      
        return;
      }

    if (text === '/forget') {
      await pool.query(
        `DELETE FROM users WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      await telegram('sendMessage', {
        chat_id: chatId,
        text: 'Ваші дані видалено. Тепер можете почати заново через /start'
      });

      return;
    }

    if (text === '/reset') {
      const result = await pool.query(
        `SELECT * FROM users WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      const user = result.rows[0];

      if (!user) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Користувача ще немає в базі. Спочатку натисніть /start'
        });
      } else {
        await pool.query(
          `UPDATE users
           SET status = 'warming',
               next_message_at = $1,
               last_sent_step = 0
           WHERE telegram_user_id = $2`,
          [getFirstSlotDateUtc(), telegramUserId]
        );

        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Прогрів скинуто. Перше повідомлення знову прийде за розкладом.'
        });
      }

      return;
    }

    if (text === '/me') {
      const result = await pool.query(
        `SELECT id, telegram_user_id, chat_id, username, first_name, lead_token, utm_source, status, started_at, next_message_at, last_sent_step
         FROM users
         WHERE telegram_user_id = $1`,
        [telegramUserId]
      );

      const user = result.rows[0];

      if (!user) {
        await telegram('sendMessage', {
          chat_id: chatId,
          text: 'Користувача ще немає в базі. Спочатку натисніть /start'
        });
      } else {
        await telegram('sendMessage', {
          chat_id: chatId,
          text:
            `ID: ${user.id}\n` +
            `telegram_user_id: ${user.telegram_user_id}\n` +
            `chat_id: ${user.chat_id}\n` +
            `username: ${user.username || '-'}\n` +
            `first_name: ${user.first_name || '-'}\n` +
            `utm_source: ${user.utm_source || '-'}\n` +
            `lead_token: ${user.lead_token}\n` +
            `status: ${user.status}\n` +
            `started_at: ${user.started_at}\n` +
            `next_message_at: ${user.next_message_at || '-'}\n` +
            `last_sent_step: ${user.last_sent_step}`
        });
      }

      return;
    }

    if (!text.startsWith('/')) {
      await askForContact(chatId);
      return;
    }

    return;
  } catch (error) {
    console.error('WEBHOOK ERROR:', error);
  }
});

app.post('/lead', async (req, res) => {
  try {
    const { lead_token } = req.body;

    if (!lead_token) {
      return res.status(400).json({ ok: false, error: 'No lead_token provided' });
    }

    const result = await pool.query(
      `UPDATE users
       SET status = 'converted',
           next_message_at = NULL
       WHERE lead_token = $1
       RETURNING id, telegram_user_id, lead_token, utm_source, status`,
      [lead_token]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: 'User not found by lead_token' });
    }

    await sendToGoogleSheet({
      event: 'lead_created',
      telegram_user_id: result.rows[0].telegram_user_id,
      status: result.rows[0].status,
      utm_source: result.rows[0].utm_source || ''
    });

    console.log('Lead converted:', result.rows[0]);

    await sendMetaEvent('Lead', result.rows[0]);

    return res.json({ ok: true, user: result.rows[0] });
  } catch (error) {
    console.error('LEAD ERROR:', error);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

cron.schedule('* * * * *', async () => {
  try {
    const slotKey = getCurrentKyivSlotKey();
    if (!slotKey) return;

    const result = await pool.query(
      `SELECT * FROM users
       WHERE status IN ('awaiting_subscription', 'warming')
         AND next_message_at IS NOT NULL
         AND next_message_at <= NOW()
         AND (last_slot_key IS NULL OR last_slot_key <> $1)
       ORDER BY id ASC`,
      [slotKey]
    );

    const users = result.rows;

    for (const user of users) {
  try {

    if (user.status === 'awaiting_subscription') {
      await sendSubscriptionReminder(user);

      await pool.query(
        `UPDATE users SET last_slot_key = $1 WHERE id = $2`,
        [slotKey, user.id]
      );
    }

    if (user.status === 'warming') {
      await sendPostToUser(user);

      await pool.query(
        `UPDATE users SET last_slot_key = $1 WHERE id = $2`,
        [slotKey, user.id]
      );
    }

  } catch (error) {

    const errorText = String(error.message || '');

    if (
      errorText.includes('bot was blocked by the user') ||
      errorText.includes('"error_code":403')
    ) {

      console.log(`USER BLOCKED BOT: ${user.telegram_user_id}`);

      await pool.query(
        `UPDATE users
         SET status = 'blocked',
             next_message_at = NULL
         WHERE id = $1`,
        [user.id]
      );

      continue;
    }

    console.error('USER SEND ERROR:', error);
  }
}
  } catch (error) {
    console.error('CRON ERROR:', error);
  }
});

async function start() {
  try {
    await initDb();

    app.listen(PORT, async () => {
      try {
        await telegram('setWebhook', {
          url: `${BASE_URL}/telegram/webhook`
        });

        console.log(`Server running on port ${PORT}`);
        console.log(`Webhook set to ${BASE_URL}/telegram/webhook`);
      } catch (error) {
        console.error('SET WEBHOOK ERROR:', error);
      }
    });
  } catch (error) {
    console.error('START ERROR:', error);
    process.exit(1);
  }
}

start();
