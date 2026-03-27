// ============================================================
// ДДС Сервер — Node.js + SQLite
// ============================================================
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const AdmZip  = require('adm-zip');
const Database = require('better-sqlite3');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---- Папки ----
const DATA_DIR    = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
[DATA_DIR, UPLOADS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, {recursive: true}); });

// ---- База данных ----
const db = new Database(path.join(DATA_DIR, 'dds.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS operations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dt         TEXT NOT NULL,
    month      TEXT NOT NULL,
    source     TEXT,
    account    TEXT,
    counterpart TEXT,
    description TEXT,
    amount     REAL,
    currency   TEXT,
    op_type    TEXT,
    category   TEXT,
    biz_personal TEXT,
    who        TEXT DEFAULT 'Я',
    owner_wd   TEXT DEFAULT 'N',
    transfer   TEXT DEFAULT 'N',
    amount_rub REAL,
    amount_usd REAL,
    signature  TEXT UNIQUE,
    file_name  TEXT,
    imported_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS import_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at   TEXT DEFAULT (datetime('now')),
    month       TEXT,
    source      TEXT,
    file_name   TEXT,
    md5         TEXT,
    total_rows  INTEGER DEFAULT 0,
    imported    INTEGER DEFAULT 0,
    duplicates  INTEGER DEFAULT 0,
    status      TEXT,
    message     TEXT
  );

  CREATE TABLE IF NOT EXISTS rates (
    month    TEXT,
    currency TEXT,
    cur_rub  REAL,
    usd_rub  REAL,
    PRIMARY KEY (month, currency)
  );

  INSERT OR IGNORE INTO rates VALUES ('2026-01','USD',90.0,90.0);
  INSERT OR IGNORE INTO rates VALUES ('2026-01','EUR',97.0,90.0);
  INSERT OR IGNORE INTO rates VALUES ('2026-01','GBP',114.0,90.0);
  INSERT OR IGNORE INTO rates VALUES ('2026-01','JPY',0.59,90.0);
  INSERT OR IGNORE INTO rates VALUES ('2026-02','USD',88.5,88.5);
  INSERT OR IGNORE INTO rates VALUES ('2026-02','EUR',93.0,88.5);
  INSERT OR IGNORE INTO rates VALUES ('2026-02','GBP',112.0,88.5);
  INSERT OR IGNORE INTO rates VALUES ('2026-02','JPY',0.59,88.5);
`);

// ---- Мидлвары ----
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: UPLOADS_DIR, limits: { fileSize: 20 * 1024 * 1024 } });

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================
function getRates(month, currency) {
  if (currency === 'RUB') return { curRub: 1, usdRub: 88.5 };
  const r = db.prepare('SELECT cur_rub, usd_rub FROM rates WHERE month=? AND currency=?').get(month, currency)
           || db.prepare('SELECT cur_rub, usd_rub FROM rates WHERE currency=? ORDER BY month DESC LIMIT 1').get(currency)
           || { cur_rub: 88.5, usd_rub: 88.5 };
  return { curRub: r.cur_rub, usdRub: r.usd_rub };
}

function makeSig(dt, amount, currency, counterpart, description) {
  const s = `${dt}|${amount}|${currency}|${(counterpart||'').toLowerCase().substring(0,40)}|${(description||'').toLowerCase().substring(0,40)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(16) + '_' + s.substring(0, 20).replace(/[^a-z0-9а-яё]/gi, '_');
}

function fmtDate(d) {
  if (!(d instanceof Date)) return String(d).substring(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function fmtMonth(d) {
  if (!(d instanceof Date)) return '';
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function parseDMY(s) {
  const m = String(s).match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})/);
  return m ? new Date(+m[3], +m[2]-1, +m[1]) : new Date();
}

function parsePayoneerDate(s) {
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const m = s.match(/(\d+)\s+(\w+),?\s+(\d{4})/);
  return m ? new Date(+m[3], months[m[2]]||0, +m[1]) : new Date();
}

function parseRuNum(v) {
  return parseFloat(String(v||0).replace(/\s/g,'').replace(',','.')) || 0;
}

function parseCSVLine(line) {
  const result = []; let cur = '', inQ = false;
  for (const c of line) {
    if (c === '"') inQ = !inQ;
    else if (c === ',' && !inQ) { result.push(cur); cur = ''; }
    else cur += c;
  }
  result.push(cur);
  return result;
}

function extractCounterpart(desc) {
  const m = desc.match(/Card charge \((.+?)\)/);
  if (m) return m[1];
  const m2 = desc.match(/Payment (?:from|to) (.+)/i);
  if (m2) return m2[1].substring(0, 80);
  return desc.substring(0, 80);
}

// ============================================================
// КЛАССИФИКАЦИЯ
// ============================================================
const CP_RULES = {
  'ООО Яндекс Маркет':             ['Выручка Ozon/Маркет','Доход','Бизнес','Я','N','N'],
  'ООО "ОЗОН Банк"':               ['Проценты по счёту','Доход','Бизнес','Я','N','N'],
  'АО БАНК "ПСКБ"':                ['Банковские комиссии','Расход','Бизнес','Я','N','N'],
  'ИП Щербаков Роман Сергеевич':   ['Трансфер между счетами','Трансфер','','Я','N','Y'],
  'АО «ТИНЬКОФФ БАНК»':            ['Вывод владельцу (ИП)','Расход','Личное','Я','Y','N'],
};

const TEXT_RULES = [
  [10, /Выплата процентов/i,                    null,         'Проценты по счёту','Доход','Бизнес','Я','N','N'],
  [20, /Комиссия за ведение|Комиссия за проведение|Комиссия за постановку/i, null, 'Банковские комиссии','Расход','Бизнес','Я','N','N'],
  [30, /Пополнение накопительного|Перевод собственных средств/i, null, 'Трансфер между счетами','Трансфер','','Я','N','Y'],
  [40, /Payment from Amazon/i,                  'income',     'Выручка Amazon','Доход','Бизнес','Я','N','N'],
  [50, /AMZ\*|Amazon Marketing|Amzn Adv/i,      'expense',    'Реклама Amazon','Расход','Бизнес','Я','N','N'],
  [55, /GOOGLE\*WORKSPACE/i,                    null,         'ПО и сервисы','Расход','Бизнес','Я','N','N'],
  [60, /CHATGPT|MIDJOURNEY|OPENAI/i,             null,         'ПО и сервисы','Расход','Бизнес','Я','N','N'],
  [65, /SIMPLY BUSINESS/i,                      null,         'Прочие расходы бизнес','Расход','Бизнес','Я','N','N'],
  [70, /складские|логистических|хранение товаров|отгрузк/i, 'expense', 'Логистика / склад','Расход','Бизнес','Я','N','N'],
  [75, /Payment to/i,                           'expense',    'Зарплата / подрядчики','Расход','Бизнес','Я','N','N'],
  [80, /Withdrawal/i,                           'expense',    'Вывод владельцу (ИП)','Расход','Личное','Я','Y','N'],
  [85, /SHEIN|YAKKYO|Shopee|SPEEPAY/i,           null,         'Личные расходы (жена, F)','Расход','Личное','F','N','N'],
  [90, /Grab\*|E-VISA|AMAZON\.CO\.JP/i,          'expense',    'Личные расходы','Расход','Личное','Я','N','N'],
  [95, /Card charge/i,                          'expense',    'Личные расходы','Расход','Личное','Я','N','N'],
  [100,/Оплата по договору/i,                   'income',     'Выручка Ozon/Маркет','Доход','Бизнес','Я','N','N'],
  [105,/Оплата по счет/i,                       'income',     'Выручка прочая','Доход','Бизнес','Я','N','N'],
];

function classify(counterpart, description, amount) {
  // Уровень A: контрагент
  const cpL = (counterpart || '').toLowerCase();
  for (const [key, vals] of Object.entries(CP_RULES)) {
    if (cpL.includes(key.toLowerCase()) || key.toLowerCase().includes(cpL)) {
      return { category: vals[0], opType: vals[1], bizPersonal: vals[2],
               who: vals[3], ownerWd: vals[4], transfer: vals[5] };
    }
  }
  // Уровень B: правила
  const text = `${description} ${counterpart}`;
  for (const [, pattern, amtType, category, opType, bizPersonal, who, ownerWd, transfer] of TEXT_RULES.sort((a,b)=>a[0]-b[0])) {
    if (amtType === 'income'  && amount <= 0) continue;
    if (amtType === 'expense' && amount >= 0) continue;
    if (pattern.test(text)) {
      return { category, opType, bizPersonal, who, ownerWd, transfer };
    }
  }
  return { category: '', opType: amount > 0 ? 'Доход' : 'Расход',
           bizPersonal: '', who: 'Я', ownerWd: 'N', transfer: 'N' };
}

// ============================================================
// ПАРСЕРЫ
// ============================================================
function parsePayoneer(content, filename) {
  const lines = content.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const ops = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    const cols = parseCSVLine(ln);
    if (cols.length < 5) continue;
    const dateStr = cols[0].replace(/"/g,'').trim();
    const desc    = cols[1].replace(/"/g,'').trim();
    const amtStr  = cols[2].replace(/[",]/g,'');
    const currency = (cols[3]||'USD').trim();
    const status  = (cols[4]||'').trim();
    if (status === 'Canceled') continue;
    const amount = parseFloat(amtStr) || 0;
    if (amount === 0) continue;
    const date = parsePayoneerDate(dateStr);
    const dt = fmtDate(date);
    const month = fmtMonth(date);
    const counterpart = extractCounterpart(desc);
    const rates = getRates(month, currency);
    const absAmt = Math.abs(amount);
    const amtRub = currency === 'RUB' ? absAmt : Math.round(absAmt * rates.curRub * 100) / 100;
    const amtUsd = currency === 'USD' ? absAmt : Math.round(amtRub / rates.usdRub * 100) / 100;
    const cl = classify(counterpart, desc, amount);
    const sig = makeSig(dt, amount, currency, counterpart, desc);
    ops.push({ dt, month, source: 'Payoneer', account: 'Payoneer', counterpart, description: desc,
               amount, currency, ...cl,
               amtRub: amount > 0 ? amtRub : -amtRub,
               amtUsd: amount > 0 ? amtUsd : -amtUsd,
               sig, fileName: filename });
  }
  return ops;
}

function parsePSKBXml(xmlContent, filename) {
  const ops = [];
  try {
    // Простой regex-парсер XML SpreadsheetML
    const rowRegex = /<Row[^>]*>([\s\S]*?)<\/Row>/gi;
    const cellRegex = /<Data[^>]*>([\s\S]*?)<\/Data>/gi;
    let accountMatch = xmlContent.match(/408028\d{14}/);
    const account = accountMatch ? accountMatch[0] : 'ПСКБ';
    let dataStarted = false;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(xmlContent)) !== null) {
      const rowContent = rowMatch[1];
      const cells = [];
      let cellMatch;
      const cellRe = /<Data[^>]*>([\s\S]*?)<\/Data>/gi;
      while ((cellMatch = cellRe.exec(rowContent)) !== null) {
        cells.push(cellMatch[1].trim());
      }
      if (!cells[0]) continue;
      if (cells[0] === 'Документ' || cells[0].includes('Банк.ор') || cells[0].includes('Плат.пор')) {
        dataStarted = true;
        if (cells[0] === 'Документ') continue;
      }
      if (!dataStarted) continue;
      if (cells[0].startsWith('ИТОГО') || cells[0] === 'Наименование') continue;
      const dateStr = cells[1] || '';
      if (!dateStr.match(/\d{2}\.\d{2}\.\d{4}/)) continue;
      const date = parseDMY(dateStr);
      const dt = fmtDate(date);
      const month = fmtMonth(date);
      const counterpart = (cells[2] || '').trim();
      const debit  = parseRuNum(cells[8]);
      const credit = parseRuNum(cells[9]);
      const description = (cells[10] || '').trim();
      let amount = 0;
      if (credit > 0) amount = credit;
      else if (debit > 0) amount = -debit;
      else continue;
      const rates = getRates(month, 'RUB');
      const absAmt = Math.abs(amount);
      const amtUsd = Math.round(absAmt / rates.usdRub * 100) / 100;
      const cl = classify(counterpart, description, amount);
      const sig = makeSig(dt, amount, 'RUB', counterpart, description);
      ops.push({ dt, month, source: 'ПСКБ', account, counterpart, description,
                 amount, currency: 'RUB', ...cl,
                 amtRub: amount,
                 amtUsd: amount > 0 ? amtUsd : -amtUsd,
                 sig, fileName: filename });
    }
  } catch(e) {
    console.error('PSKB parse error:', e.message);
  }
  return ops;
}

// ============================================================
// СОХРАНЕНИЕ ОПЕРАЦИЙ В БД
// ============================================================
const insertOp = db.prepare(`
  INSERT OR IGNORE INTO operations
    (dt, month, source, account, counterpart, description, amount, currency,
     op_type, category, biz_personal, who, owner_wd, transfer,
     amount_rub, amount_usd, signature, file_name)
  VALUES
    (@dt, @month, @source, @account, @counterpart, @description, @amount, @currency,
     @opType, @category, @bizPersonal, @who, @ownerWd, @transfer,
     @amtRub, @amtUsd, @sig, @fileName)
`);

function saveOps(ops) {
  let imported = 0, dups = 0;
  const insertMany = db.transaction((list) => {
    for (const op of list) {
      const result = insertOp.run({
        dt: op.dt, month: op.month, source: op.source, account: op.account||'',
        counterpart: op.counterpart||'', description: op.description||'',
        amount: op.amount, currency: op.currency,
        opType: op.opType||'', category: op.category||'', bizPersonal: op.bizPersonal||'',
        who: op.who||'Я', ownerWd: op.ownerWd||'N', transfer: op.transfer||'N',
        amtRub: op.amtRub||0, amtUsd: op.amtUsd||0, sig: op.sig, fileName: op.fileName||''
      });
      if (result.changes > 0) imported++;
      else dups++;
    }
  });
  insertMany(ops);
  return { imported, dups };
}

// ============================================================
// API ROUTES
// ============================================================

// GET /api/ops — все операции
app.get('/api/ops', (req, res) => {
  const { month, type, source, search } = req.query;
  let sql = 'SELECT * FROM operations WHERE 1=1';
  const params = [];
  if (month)  { sql += ' AND month=?';  params.push(month); }
  if (type)   { sql += ' AND op_type=?'; params.push(type); }
  if (source) { sql += ' AND source=?'; params.push(source); }
  if (search) { sql += ' AND (counterpart LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY dt DESC';
  try {
    const ops = db.prepare(sql).all(...params);
    res.json({ ok: true, ops });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/summary — сводка по месяцам
app.get('/api/summary', (req, res) => {
  try {
    const months = db.prepare("SELECT DISTINCT month FROM operations ORDER BY month").all().map(r => r.month);
    const result = {};
    for (const month of months) {
      const ops = db.prepare("SELECT * FROM operations WHERE month=?").all(month);
      const inc    = ops.filter(o => o.op_type==='Доход' && o.transfer!=='Y');
      const expBiz = ops.filter(o => o.op_type==='Расход' && o.biz_personal==='Бизнес' && o.owner_wd!=='Y' && o.transfer!=='Y');
      const expMe  = ops.filter(o => o.op_type==='Расход' && o.biz_personal==='Личное' && o.owner_wd!=='Y' && o.who!=='F' && o.transfer!=='Y');
      const expF   = ops.filter(o => o.op_type==='Расход' && o.who==='F' && o.transfer!=='Y');
      const ownerWd= ops.filter(o => o.owner_wd==='Y');
      const sum = arr => arr.reduce((s,o) => s + Math.abs(o.amount_rub||0), 0);
      const sumUsd = arr => arr.reduce((s,o) => s + Math.abs(o.amount_usd||0), 0);
      const byCat = {};
      expBiz.forEach(o => { byCat[o.category||'—'] = (byCat[o.category||'—']||0) + Math.abs(o.amount_rub||0); });
      result[month] = {
        income: sum(inc), incomeUsd: sumUsd(inc),
        expBiz: sum(expBiz), expBizUsd: sumUsd(expBiz),
        expMe: sum(expMe), expF: sum(expF),
        ownerWd: sum(ownerWd),
        net: sum(inc) - sum(expBiz) - sum(expMe) - sum(expF) - sum(ownerWd),
        byCat,
        incomeBySource: (() => { const r={}; inc.forEach(o=>{r[o.source]=(r[o.source]||0)+Math.abs(o.amount_rub||0);}); return r; })(),
        total: ops.length
      };
    }
    res.json({ ok: true, months, summary: result });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/log — лог импорта
app.get('/api/log', (req, res) => {
  try {
    const logs = db.prepare('SELECT * FROM import_log ORDER BY id DESC LIMIT 50').all();
    res.json({ ok: true, logs });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/rates — курсы валют
app.get('/api/rates', (req, res) => {
  try {
    const rates = db.prepare('SELECT * FROM rates ORDER BY month').all();
    res.json({ ok: true, rates });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/rates — добавить/обновить курс
app.post('/api/rates', (req, res) => {
  try {
    const { month, currency, curRub, usdRub } = req.body;
    db.prepare('INSERT OR REPLACE INTO rates VALUES (?,?,?,?)').run(month, currency, curRub, usdRub);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/ops — ручная операция
app.post('/api/ops', (req, res) => {
  try {
    const o = req.body;
    const date = new Date(o.dt);
    const month = fmtMonth(date);
    const rates = getRates(month, o.currency||'RUB');
    const absAmt = Math.abs(o.amount||0);
    const amtRub = o.currency==='RUB' ? absAmt : Math.round(absAmt * rates.curRub * 100) / 100;
    const amtUsd = o.currency==='USD' ? absAmt : Math.round(amtRub / rates.usdRub * 100) / 100;
    const sig = makeSig(o.dt, o.amount, o.currency||'RUB', o.counterpart||'', o.description||'');
    const result = insertOp.run({
      dt: o.dt, month, source: 'Ручная', account: '',
      counterpart: o.counterpart||'', description: o.description||'',
      amount: o.amount, currency: o.currency||'RUB',
      opType: o.opType||'Расход', category: o.category||'',
      bizPersonal: o.bizPersonal||'', who: o.who||'Я',
      ownerWd: o.ownerWd||'N', transfer: 'N',
      amtRub: o.amount > 0 ? amtRub : -amtRub,
      amtUsd: o.amount > 0 ? amtUsd : -amtUsd,
      sig, fileName: 'manual'
    });
    res.json({ ok: true, inserted: result.changes });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/ops/:id
app.delete('/api/ops/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM operations WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/import — загрузка файлов
app.post('/api/import', upload.array('files', 10), async (req, res) => {
  const results = [];
  for (const file of req.files || []) {
    const filename = file.originalname;
    const fn = filename.toLowerCase();
    let ops = [], source = '?', parseError = null;
    try {
      if (fn.endsWith('.csv')) {
        source = 'Payoneer';
        const content = fs.readFileSync(file.path, 'utf-8');
        ops = parsePayoneer(content, filename);
      } else if (fn.endsWith('.zip')) {
        source = 'ПСКБ';
        const zip = new AdmZip(file.path);
        const entries = zip.getEntries();
        if (entries.length > 0) {
          const xmlContent = entries[0].getData().toString('utf-8');
          ops = parsePSKBXml(xmlContent, filename);
        }
      } else {
        parseError = 'Формат не поддерживается. Загружайте CSV (Payoneer) или ZIP (ПСКБ).';
      }
    } catch(e) {
      parseError = `Ошибка разбора: ${e.message}`;
    }

    // Удалить временный файл
    try { fs.unlinkSync(file.path); } catch(e) {}

    if (parseError) {
      db.prepare('INSERT INTO import_log (month,source,file_name,md5,total_rows,imported,duplicates,status,message) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('', source, filename, '', 0, 0, 0, '❌ ОШИБКА', parseError);
      results.push({ file: filename, ok: false, message: parseError });
      continue;
    }

    if (ops.length === 0) {
      db.prepare('INSERT INTO import_log (month,source,file_name,md5,total_rows,imported,duplicates,status,message) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('', source, filename, '', 0, 0, 0, '⚠️ ПУСТО', 'Операций не найдено');
      results.push({ file: filename, ok: false, message: 'Операций не найдено' });
      continue;
    }

    const { imported, dups } = saveOps(ops);
    const month = ops[0]?.month || '';
    const msg = `Загружено: ${imported}, дублей: ${dups}`;
    db.prepare('INSERT INTO import_log (month,source,file_name,md5,total_rows,imported,duplicates,status,message) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(month, source, filename, '', ops.length, imported, dups, imported > 0 ? '✅ OK' : '⚠️ ДУБЛИ', msg);
    results.push({ file: filename, ok: true, message: msg, source, imported, dups, total: ops.length, month });
  }
  res.json({ ok: true, results });
});

// ============================================================
// СТАРТ
// ============================================================
app.listen(PORT, () => {
  console.log(`✅ ДДС Сервер запущен: http://localhost:${PORT}`);
});
