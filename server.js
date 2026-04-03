const express = require('express');
const initSqlJs = require('sql.js');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// БАЗА ДАННЫХ (sql.js — чистый JavaScript)
// ============================================================
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db', 'dds.db');
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

let db;
let SQL;

async function initDB() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      display_name TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER,
      username TEXT,
      role TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dt TEXT NOT NULL,
      mo TEXT NOT NULL,
      src TEXT,
      account TEXT,
      cp TEXT,
      ds TEXT,
      amount REAL,
      currency TEXT,
      op_type TEXT,
      category TEXT,
      biz_personal TEXT,
      who TEXT DEFAULT 'Я',
      owner_wd TEXT DEFAULT 'N',
      transfer TEXT DEFAULT 'N',
      amount_rub REAL,
      amount_usd REAL,
      sig TEXT UNIQUE,
      file_name TEXT,
      imported_at TEXT DEFAULT (datetime('now')),
      uploaded_by TEXT DEFAULT 'anonymous'
    );
    CREATE TABLE IF NOT EXISTS import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT DEFAULT (datetime('now')),
      month TEXT,
      source TEXT,
      file_name TEXT,
      total INTEGER,
      imported INTEGER,
      dups INTEGER,
      status TEXT,
      message TEXT,
      uploaded_by TEXT
    );
    CREATE TABLE IF NOT EXISTS rates (
      month TEXT,
      currency TEXT,
      cur_to_rub REAL,
      usd_to_rub REAL,
      PRIMARY KEY (month, currency)
    );
    CREATE TABLE IF NOT EXISTS counterparts (
      name TEXT PRIMARY KEY,
      category TEXT,
      op_type TEXT,
      biz_personal TEXT,
      who TEXT DEFAULT 'Я',
      owner_wd TEXT DEFAULT 'N',
      transfer TEXT DEFAULT 'N'
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      priority INTEGER,
      field TEXT,
      match_type TEXT,
      pattern TEXT,
      amt_type TEXT DEFAULT 'любой',
      category TEXT,
      op_type TEXT,
      biz_personal TEXT,
      who TEXT DEFAULT 'Я'
    );
  `);

  saveDB();
  seedDefaults();
  console.log('✅ База данных инициализирована');
}

function saveDB() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('Ошибка сохранения БД:', e.message); }
}

function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) { return []; }
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

function dbRun(sql, params = []) {
  try {
    db.run(sql, params);
    saveDB();
    return true;
  } catch(e) { console.error('dbRun error:', e.message, sql); return false; }
}

function seedDefaults() {
  const users = [
    ['roman', 'dds2026roman', 'admin', 'Роман'],
    ['elina', 'dds2026elina', 'user', 'Элина'],
  ];
  users.forEach(u => dbRun(`INSERT OR IGNORE INTO users (username,password,role,display_name) VALUES (?,?,?,?)`, u));

  const rates = [
    ['2026-01','USD',90,90],['2026-01','EUR',97,90],['2026-01','GBP',114,90],['2026-01','JPY',0.59,90],
    ['2026-02','USD',88.5,88.5],['2026-02','EUR',93,88.5],['2026-02','GBP',112,88.5],['2026-02','JPY',0.59,88.5],
    ['2026-03','USD',87,87],['2026-03','EUR',95,87],['2026-03','GBP',110,87],['2026-03','JPY',0.58,87],
    ['2026-04','USD',86,86],['2026-04','EUR',94,86],['2026-04','GBP',109,86],['2026-04','JPY',0.57,86],
  ];
  rates.forEach(r => dbRun(`INSERT OR IGNORE INTO rates VALUES (?,?,?,?)`, r));

  const cps = [
    ['ООО Яндекс Маркет','Выручка Ozon/Маркет','Доход','Бизнес','Я','N','N'],
    ['ООО "ОЗОН Банк"','Проценты по счёту','Доход','Бизнес','Я','N','N'],
    ['АО БАНК "ПСКБ"','Банковские комиссии','Расход','Бизнес','Я','N','N'],
    ['ИП Щербаков Роман Сергеевич','Трансфер между счетами','Трансфер','','Я','N','Y'],
    ['АО «ТИНЬКОФФ БАНК»','Вывод владельцу (ИП)','Расход','Личное','Я','Y','N'],
  ];
  cps.forEach(c => dbRun(`INSERT OR IGNORE INTO counterparts VALUES (?,?,?,?,?,?,?)`, c));

  const rules = [
    [10,'Описание','contains','Выплата процентов','любой','Проценты по счёту','Доход','Бизнес','Я'],
    [20,'Описание','contains','Комиссия за ведение','любой','Банковские комиссии','Расход','Бизнес','Я'],
    [25,'Описание','contains','Комиссия за постановку','любой','Банковские комиссии','Расход','Бизнес','Я'],
    [27,'Описание','contains','Комиссия за обслуживание','любой','Банковские комиссии','Расход','Бизнес','Я'],
    [30,'Описание','contains','Пополнение накопительного','любой','Трансфер между счетами','Трансфер','','Я'],
    [35,'Описание','contains','Перевод собственных средств','любой','Трансфер между счетами','Трансфер','','Я'],
    [40,'Описание','regex','Payment from Amazon','доход','Выручка Amazon','Доход','Бизнес','Я'],
    [50,'Описание','regex','AMZ|Amazon Marketing|Amzn Adv','расход','Реклама Amazon','Расход','Бизнес','Я'],
    [60,'Описание','contains','Card charge','расход','Личные расходы','Расход','Личное','Я'],
    [70,'Описание','contains','Payment to','расход','Зарплата / подрядчики','Расход','Бизнес','Я'],
    [75,'Описание','contains','Withdrawal','расход','Вывод владельцу (ИП)','Расход','Личное','Я'],
    [80,'Описание','regex','CHATGPT|MIDJOURNEY|OPENAI|GOOGLE.WORKSPACE','любой','ПО и сервисы','Расход','Бизнес','Я'],
    [90,'Описание','regex','SHEIN|YAKKYO|Shopee|SPEEPAY','любой','Личные расходы (жена, F)','Расход','Личное','F'],
    [100,'Описание','regex','Grab|E-VISA|AMAZON.CO.JP','расход','Личные расходы','Расход','Личное','Я'],
    [110,'Описание','contains','SIMPLY BUSINESS','любой','Прочие расходы бизнес','Расход','Бизнес','Я'],
    [120,'Описание','regex','складские|логистических|хранение товаров','любой','Логистика / склад','Расход','Бизнес','Я'],
  ];
  rules.forEach(r => dbRun(`INSERT OR IGNORE INTO rules (priority,field,match_type,pattern,amt_type,category,op_type,biz_personal,who) VALUES (?,?,?,?,?,?,?,?,?)`, r));
}

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function auth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Не авторизован' });
  const session = dbGet('SELECT * FROM sessions WHERE token=?', [token]);
  if (!session) return res.status(401).json({ error: 'Сессия истекла' });
  req.user = session;
  next();
}
function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Только для администратора' });
  next();
}

// ============================================================
// УТИЛИТЫ
// ============================================================
function makeToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
}
function md5Simple(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}
function makeSig(dt, amount, currency, cp, desc) {
  const raw = `${dt}|${amount}|${currency}|${(cp||'').toLowerCase().substring(0,40)}|${(desc||'').toLowerCase().substring(0,40)}`;
  return md5Simple(raw) + '_' + raw.substring(0,20).replace(/[^a-z0-9а-яё]/gi,'_');
}
function getRates(month, currency) {
  if (currency === 'RUB' || currency === 'RUR') return { curRub: 1, usdRub: 87 };
  const r = dbGet('SELECT * FROM rates WHERE month=? AND currency=?', [month, currency])
    || dbGet('SELECT * FROM rates WHERE currency=? ORDER BY month DESC', [currency])
    || { cur_to_rub: 87, usd_to_rub: 87 };
  return { curRub: r.cur_to_rub || 87, usdRub: r.usd_to_rub || 87 };
}
function classify(cp, desc, amount) {
  const cpLower = (cp || '').toLowerCase();
  const cps = dbAll('SELECT * FROM counterparts');
  for (const c of cps) {
    const n = c.name.toLowerCase();
    if (cpLower.includes(n) || n.includes(cpLower)) {
      return { category: c.category, op_type: c.op_type, biz_personal: c.biz_personal,
               who: c.who, owner_wd: c.owner_wd, transfer: c.transfer };
    }
  }
  const rules = dbAll('SELECT * FROM rules ORDER BY priority');
  for (const rule of rules) {
    const fv = rule.field === 'Описание' ? (desc || '') : (cp || '');
    if (rule.amt_type === 'доход' && amount <= 0) continue;
    if (rule.amt_type === 'расход' && amount >= 0) continue;
    let matched = false;
    if (rule.match_type === 'contains') matched = fv.toLowerCase().includes(rule.pattern.toLowerCase());
    else if (rule.match_type === 'exact') matched = fv.toLowerCase() === rule.pattern.toLowerCase();
    else if (rule.match_type === 'regex') {
      try { matched = new RegExp(rule.pattern, 'i').test(fv); } catch(e) {}
    }
    if (matched) {
      return { category: rule.category, op_type: rule.op_type, biz_personal: rule.biz_personal,
               who: rule.who || 'Я', owner_wd: rule.category && rule.category.includes('Вывод') ? 'Y' : 'N',
               transfer: rule.op_type === 'Трансфер' ? 'Y' : 'N' };
    }
  }
  return { category: '', op_type: amount > 0 ? 'Доход' : 'Расход', biz_personal: '', who: 'Я', owner_wd: 'N', transfer: 'N' };
}
function parseDMY(s) {
  const m = String(s).match(/(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : null;
}
function parsePayoneerDate(s) {
  const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
  const m = s.match(/(\d+)\s+(\w+),?\s+(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(months[m[2]]||1).padStart(2,'0')}-${m[1].padStart(2,'0')}`;
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

// ============================================================
// ПАРСЕРЫ
// ============================================================
function parsePayoneer(text) {
  const lines = text.replace(/^\uFEFF/,'').replace(/\r/g,'').split('\n');
  const ops = [];
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i].trim(); if (!ln) continue;
    const cols = parseCSVLine(ln); if (cols.length < 5) continue;
    const dateStr = cols[0].replace(/"/g,'').trim();
    const desc = cols[1].replace(/"/g,'').trim();
    const amtStr = cols[2].replace(/[",]/g,'');
    const curr = (cols[3]||'USD').trim();
    const status = (cols[4]||'').trim();
    if (status === 'Canceled') continue;
    const amount = parseFloat(amtStr) || 0; if (amount === 0) continue;
    const dt = parsePayoneerDate(dateStr); if (!dt) continue;
    const mo = dt.substring(0,7);
    const cp = (() => {
      const m = desc.match(/Card charge \((.+?)\)/); if (m) return m[1];
      const m2 = desc.match(/Payment (?:from|to) (.+)/i); if (m2) return m2[1].substring(0,80);
      return desc.substring(0,80);
    })();
    const rates = getRates(mo, curr);
    const absAmt = Math.abs(amount);
    const amtRub = curr==='RUB'?absAmt:Math.round(absAmt*rates.curRub*100)/100;
    const amtUsd = curr==='USD'?absAmt:Math.round(amtRub/rates.usdRub*100)/100;
    const sig = makeSig(dt, amount, curr, cp, desc);
    ops.push({dt,mo,src:'Payoneer',account:'Payoneer',cp,desc,amount,currency:curr,
              amount_rub:amount>0?amtRub:-amtRub,amount_usd:amount>0?amtUsd:-amtUsd,sig});
  }
  return ops;
}

async function parsePSKB(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const fileNames = Object.keys(zip.files); if (!fileNames.length) throw new Error('ZIP пуст');
  const xmlContent = await zip.files[fileNames[0]].async('text');
  const ops = [];
  const rowRegex = /<Row[^>]*>([\s\S]*?)<\/Row>/gi;
  const cellRegex = /<Data[^>]*>([\s\S]*?)<\/Data>/gi;
  const extractCells = rowHtml => { const cells=[]; let m; cellRegex.lastIndex=0; while((m=cellRegex.exec(rowHtml))!==null) cells.push(m[1].trim()); return cells; };
  let dataStart = false, match;
  while ((match = rowRegex.exec(xmlContent)) !== null) {
    const cells = extractCells(match[1]); if (!cells[0]) continue;
    if (cells[0]==='Документ'||cells[0].includes('Банк.ор')||cells[0].includes('Плат.пор')) dataStart=true;
    if (!dataStart) continue;
    if (cells[0].startsWith('ИТОГО')||cells[0]==='Наименование'||cells[0]==='Документ') continue;
    const dateStr = cells[1]||''; if (!dateStr.match(/\d{2}\.\d{2}\.\d{4}/)) continue;
    const dt = parseDMY(dateStr); if (!dt) continue;
    const mo = dt.substring(0,7); const cp = (cells[2]||'').trim();
    const parseNum = v => parseFloat((v||'0').replace(/\s/g,'').replace(',','.')) || 0;
    const debit = parseNum(cells[8]), credit = parseNum(cells[9]);
    const desc = (cells[10]||'').trim();
    let amount = 0;
    if (credit>0) amount=credit; else if (debit>0) amount=-debit; else continue;
    const rates = getRates(mo,'RUB');
    const amtRub = Math.abs(amount), amtUsd = Math.round(amtRub/rates.usdRub*100)/100;
    const sig = makeSig(dt,amount,'RUB',cp,desc);
    ops.push({dt,mo,src:'ПСКБ',account:'ПСКБ',cp,desc,amount,currency:'RUB',amount_rub:amount,amount_usd:amount>0?amtUsd:-amtUsd,sig});
  }
  return ops;
}

// ============================================================
// ПАРСЕР OZON BANK (XLSX) — исправленная версия
// ============================================================
function parseOzonBank(buffer, filename) {
  const workbook = XLSX.read(buffer, {type:'buffer', cellDates:true});
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, {header:1, defval:''});

  let account = 'Ozon Bank';
  let dataStart = -1;
  let colOffset = 0; // смещение колонок (0 если данные с col A, 1 если с col B)

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const r0 = String(row[0] || '').trim();
    const r1 = String(row[1] || '').trim();

    // Строка со счётом — может быть в col A или col B
    if (r0 === 'Счет:' || r0 === 'Счёт:') {
      account = String(row[4] || row[5] || 'Ozon Bank').trim();
    } else if (r1 === 'Счет:' || r1 === 'Счёт:') {
      account = String(row[5] || row[6] || 'Ozon Bank').trim();
    }

    // Строка заголовков: ищем "Дата" в col A или col B
    if (r0 === 'Дата') {
      colOffset = 0;
      dataStart = i + 2;
      break;
    } else if (r1 === 'Дата') {
      colOffset = 1;
      dataStart = i + 2;
      break;
    }
  }

  // Fallback: первая строка с датой ДД.ММ.ГГГГ
  if (dataStart < 0) {
    for (let i = 0; i < data.length; i++) {
      const v0 = String(data[i][0] || '');
      const v1 = String(data[i][1] || '');
      if (v0.match(/^\d{2}\.\d{2}\.\d{4}$/) || data[i][0] instanceof Date) { colOffset = 0; dataStart = i; break; }
      if (v1.match(/^\d{2}\.\d{2}\.\d{4}$/) || data[i][1] instanceof Date) { colOffset = 1; dataStart = i; break; }
    }
  }

  if (dataStart < 0) throw new Error('Не удалось найти данные в файле Ozon Bank');

  const ops = [];
  for (let i = dataStart; i < data.length; i++) {
    const row = data[i];

    // Дата — col A или B в зависимости от colOffset
    let dt = null;
    const dateVal = row[colOffset];
    if (dateVal instanceof Date) {
      const d = dateVal;
      dt = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    } else if (dateVal) {
      dt = parseDMY(String(dateVal));
    }
    if (!dt) continue;

    const parseNum = v => {
      if (typeof v === 'number') return v;
      return parseFloat(String(v||'0').replace(/\s/g,'').replace(',','.')) || 0;
    };

    // Структура: Дата | Номер | Дебет | Кредит | Контрагент | ... | Назначение
    const debit  = parseNum(row[colOffset + 2]);
    const credit = parseNum(row[colOffset + 3]);
    if (debit === 0 && credit === 0) continue;

    const cp   = String(row[colOffset + 4] || '').split('\r\n')[0].split('\n')[0].trim();
    const desc = String(row[colOffset + 7] || '').trim();
    if (!cp && !desc) continue;

    let amount = 0;
    if (credit > 0) amount = credit;
    else if (debit > 0) amount = -debit;
    else continue;

    const mo = dt.substring(0, 7);
    const rates = getRates(mo, 'RUB');
    const amtRub = Math.abs(amount);
    const amtUsd = Math.round(amtRub / rates.usdRub * 100) / 100;
    const sig = makeSig(dt, amount, 'RUB', cp, desc);

    ops.push({dt, mo, src:'Ozon Bank', account, cp, desc, amount, currency:'RUB',
              amount_rub: amount, amount_usd: amount > 0 ? amtUsd : -amtUsd, sig});
  }
  return ops;
}

function detectSource(filename) {
  const fn = filename.toLowerCase();
  if (fn.endsWith('.xlsx') || fn.endsWith('.xls')) return 'Ozon Bank';
  if (fn.endsWith('.zip') || fn.startsWith('statement')) return 'ПСКБ';
  if (fn.endsWith('.csv')) return 'Payoneer';
  return '?';
}

// ============================================================
// AUTH ROUTES
// ============================================================
app.post('/api/login', (req, res) => {
  const {username, password} = req.body;
  if (!username||!password) return res.status(400).json({error:'Введите логин и пароль'});
  const user = dbGet('SELECT * FROM users WHERE username=? AND password=?', [username.toLowerCase().trim(), password]);
  if (!user) return res.status(401).json({error:'Неверный логин или пароль'});
  const token = makeToken();
  dbRun('INSERT INTO sessions (token,user_id,username,role) VALUES (?,?,?,?)', [token,user.id,user.username,user.role]);
  res.json({token, username:user.username, display_name:user.display_name, role:user.role});
});
app.post('/api/logout', auth, (req, res) => { dbRun('DELETE FROM sessions WHERE token=?',[req.headers['x-token']]); res.json({ok:true}); });
app.get('/api/me', auth, (req, res) => res.json({username:req.user.username, role:req.user.role}));

// ============================================================
// API ROUTES
// ============================================================
app.get('/api/operations', auth, (req, res) => {
  const {month,type,src,search,limit=1000,offset=0} = req.query;
  let query = 'SELECT * FROM operations WHERE 1=1', params = [];
  if (month) { query+=' AND mo=?'; params.push(month); }
  if (type) { query+=' AND op_type=?'; params.push(type); }
  if (src) { query+=' AND src=?'; params.push(src); }
  if (search) { query+=' AND (cp LIKE ? OR ds LIKE ?)'; params.push(`%${search}%`,`%${search}%`); }
  query+=` ORDER BY dt DESC LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}`;
  const ops = dbAll(query, params);
  const total = (dbGet('SELECT COUNT(*) as cnt FROM operations') || {cnt:0}).cnt;
  res.json({ops, total});
});

app.get('/api/summary/:month', auth, (req, res) => {
  const {month} = req.params;
  const ops = dbAll('SELECT * FROM operations WHERE mo=?', [month]);
  const sum = (arr, f='amount_rub') => arr.reduce((s,o)=>s+Math.abs(parseFloat(o[f])||0),0);
  const income  = ops.filter(o=>o.op_type==='Доход'&&o.transfer!=='Y');
  const expBiz  = ops.filter(o=>o.op_type==='Расход'&&o.biz_personal==='Бизнес'&&o.owner_wd!=='Y'&&o.transfer!=='Y');
  const expPers = ops.filter(o=>o.op_type==='Расход'&&o.biz_personal==='Личное'&&o.owner_wd!=='Y'&&o.who!=='F'&&o.transfer!=='Y');
  const expWife = ops.filter(o=>o.op_type==='Расход'&&o.who==='F'&&o.transfer!=='Y');
  const ownerWd = ops.filter(o=>o.owner_wd==='Y');
  const byCat = {};
  expBiz.forEach(o=>{const c=o.category||'—';byCat[c]=(byCat[c]||0)+Math.abs(parseFloat(o.amount_rub)||0);});
  res.json({month,income_rub:sum(income),income_usd:sum(income,'amount_usd'),exp_biz_rub:sum(expBiz),exp_biz_usd:sum(expBiz,'amount_usd'),exp_pers_rub:sum(expPers),exp_pers_usd:sum(expPers,'amount_usd'),exp_wife_rub:sum(expWife),exp_wife_usd:sum(expWife,'amount_usd'),owner_wd_rub:sum(ownerWd),owner_wd_usd:sum(ownerWd,'amount_usd'),by_category:byCat,ops_count:ops.length});
});

app.get('/api/months', auth, (req, res) => {
  res.json(dbAll('SELECT DISTINCT mo FROM operations ORDER BY mo').map(r=>r.mo));
});

app.post('/api/import', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({error:'Файл не найден'});
  const filename = req.file.originalname;
  const uploader = req.user.display_name || req.user.username;
  const source = detectSource(filename);
  let rawOps = [];
  try {
    if (source==='Payoneer') rawOps = parsePayoneer(req.file.buffer.toString('utf-8'));
    else if (source==='ПСКБ') rawOps = await parsePSKB(req.file.buffer);
    else if (source==='Ozon Bank') rawOps = parseOzonBank(req.file.buffer, filename);
    else return res.status(400).json({error:'Формат не поддерживается. CSV (Payoneer), ZIP (ПСКБ), XLSX (Ozon Bank).'});
  } catch(e) { return res.status(500).json({error:`Ошибка разбора: ${e.message}`}); }
  if (!rawOps.length) return res.json({imported:0,dups:0,total:0,message:'Операций не найдено'});

  let imported = 0;
  for (const op of rawOps) {
    const cls = classify(op.cp, op.desc, op.amount);
    const ok = dbRun(`INSERT OR IGNORE INTO operations (dt,mo,src,account,cp,ds,amount,currency,op_type,category,biz_personal,who,owner_wd,transfer,amount_rub,amount_usd,sig,file_name,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [op.dt,op.mo,op.src,op.account||op.src,op.cp,op.desc,op.amount,op.currency,
       cls.op_type||(op.amount>0?'Доход':'Расход'),cls.category||'',cls.biz_personal||'',
       cls.who||'Я',cls.owner_wd||'N',cls.transfer||'N',op.amount_rub,op.amount_usd,op.sig,filename,uploader]);
    if (ok) imported++;
  }
  const dups = rawOps.length - imported;
  dbRun(`INSERT INTO import_log (month,source,file_name,total,imported,dups,status,message,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    [rawOps[0]?.mo||'',source,filename,rawOps.length,imported,dups,imported>0?'ok':'дубль',`Загружено ${imported}, дублей ${dups}`,uploader]);
  res.json({imported,dups,total:rawOps.length,source,message:`Загружено ${imported} операций, дублей ${dups}`});
});

app.post('/api/operations/manual', auth, (req, res) => {
  const {dt,amount,currency,desc,category,op_type,biz_personal,who,owner_wd} = req.body;
  if (!dt||!amount) return res.status(400).json({error:'Нужны дата и сумма'});
  const mo=dt.substring(0,7), rates=getRates(mo,currency||'RUB');
  const absAmt=Math.abs(amount);
  const amtRub=(currency==='RUB'||currency==='RUR')?absAmt:Math.round(absAmt*rates.curRub*100)/100;
  const amtUsd=currency==='USD'?absAmt:Math.round(amtRub/rates.usdRub*100)/100;
  const sig=makeSig(dt,amount,currency||'RUB',desc,desc);
  dbRun(`INSERT OR IGNORE INTO operations (dt,mo,src,cp,ds,amount,currency,op_type,category,biz_personal,who,owner_wd,transfer,amount_rub,amount_usd,sig,file_name,uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [dt,mo,'Ручная',desc,desc,amount,currency||'RUB',op_type||'Расход',category||'',biz_personal||'',who||'Я',owner_wd||'N','N',op_type==='Доход'?amtRub:-amtRub,op_type==='Доход'?amtUsd:-amtUsd,sig,'manual',req.user.display_name||req.user.username]);
  res.json({ok:true});
});

app.get('/api/rates', auth, (req, res) => res.json(dbAll('SELECT * FROM rates ORDER BY month,currency')));
app.post('/api/rates', auth, adminOnly, (req, res) => {
  const {month,currency,cur_to_rub,usd_to_rub}=req.body;
  dbRun('INSERT OR REPLACE INTO rates VALUES (?,?,?,?)',[month,currency,cur_to_rub,usd_to_rub]);
  res.json({ok:true});
});

app.get('/api/counterparts', auth, (req, res) => res.json(dbAll('SELECT * FROM counterparts')));
app.post('/api/counterparts', auth, adminOnly, (req, res) => {
  const {name,category,op_type,biz_personal,who,owner_wd,transfer}=req.body;
  dbRun('INSERT OR REPLACE INTO counterparts VALUES (?,?,?,?,?,?,?)',[name,category,op_type,biz_personal||'',who||'Я',owner_wd||'N',transfer||'N']);
  res.json({ok:true});
});
app.delete('/api/counterparts/:name', auth, adminOnly, (req, res) => { dbRun('DELETE FROM counterparts WHERE name=?',[decodeURIComponent(req.params.name)]); res.json({ok:true}); });

app.get('/api/rules', auth, (req, res) => res.json(dbAll('SELECT * FROM rules ORDER BY priority')));
app.post('/api/rules', auth, adminOnly, (req, res) => {
  const {priority,field,match_type,pattern,amt_type,category,op_type,biz_personal,who}=req.body;
  dbRun('INSERT INTO rules (priority,field,match_type,pattern,amt_type,category,op_type,biz_personal,who) VALUES (?,?,?,?,?,?,?,?,?)',[priority,field,match_type,pattern,amt_type||'любой',category,op_type,biz_personal||'',who||'Я']);
  res.json({ok:true});
});
app.delete('/api/rules/:id', auth, adminOnly, (req, res) => { dbRun('DELETE FROM rules WHERE id=?',[req.params.id]); res.json({ok:true}); });

app.get('/api/import-log', auth, (req, res) => res.json(dbAll('SELECT * FROM import_log ORDER BY time DESC LIMIT 50')));

app.get('/api/stats', auth, (req, res) => {
  const total = (dbGet('SELECT COUNT(*) as cnt FROM operations')||{cnt:0}).cnt;
  const months = dbAll('SELECT DISTINCT mo FROM operations ORDER BY mo').map(r=>r.mo);
  const lastImport = dbGet('SELECT time,file_name,uploaded_by FROM import_log ORDER BY time DESC LIMIT 1');
  res.json({total_ops:total, months, last_import:lastImport});
});

app.post('/api/reclassify', auth, adminOnly, (req, res) => {
  const ops = dbAll('SELECT id,cp,ds,amount FROM operations');
  let updated = 0;
  for (const op of ops) {
    const cls = classify(op.cp, op.ds, parseFloat(op.amount));
    dbRun('UPDATE operations SET op_type=?,category=?,biz_personal=?,who=?,owner_wd=?,transfer=? WHERE id=?',
      [cls.op_type||(op.amount>0?'Доход':'Расход'),cls.category||'',cls.biz_personal||'',cls.who||'Я',cls.owner_wd||'N',cls.transfer||'N',op.id]);
    updated++;
  }
  res.json({ok:true, updated});
});

app.get('/api/users', auth, adminOnly, (req, res) => res.json(dbAll('SELECT id,username,role,display_name FROM users')));
app.post('/api/users', auth, adminOnly, (req, res) => {
  const {username,password,role,display_name}=req.body;
  if (!username||!password) return res.status(400).json({error:'Нужны логин и пароль'});
  dbRun('INSERT OR REPLACE INTO users (username,password,role,display_name) VALUES (?,?,?,?)',[username.toLowerCase().trim(),password,role||'user',display_name||username]);
  res.json({ok:true});
});
app.delete('/api/users/:username', auth, adminOnly, (req, res) => {
  if (req.params.username===req.user.username) return res.status(400).json({error:'Нельзя удалить себя'});
  dbRun('DELETE FROM users WHERE username=?',[req.params.username]);
  res.json({ok:true});
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Старт
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ ДДС Сервер запущен на порту ${PORT}`));
});
