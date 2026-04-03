function parseOzonBank(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  let account = 'Ozon Bank';
  let dataStart = -1;

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const b = String(row[0] || row[1] || '').trim();
    const f = String(row[4] || row[5] || '').trim();

    // Строка со счётом
    if (b === 'Счет:' || b === 'Счёт:') {
      account = f || 'Ozon Bank';
    }
    // Строка заголовков: "Дата" в col A или B
    if ((String(row[0]).trim() === 'Дата' || String(row[1]).trim() === 'Дата')) {
      dataStart = i + 2;
      break;
    }
  }

  // Fallback: первая строка с датой ДД.ММ.ГГГГ
  if (dataStart < 0) {
    for (let i = 0; i < data.length; i++) {
      const v = String(data[i][0] || data[i][1] || '');
      if (v.match(/^\d{2}\.\d{2}\.\d{4}$/) || (data[i][0] instanceof Date) || (data[i][1] instanceof Date)) {
        dataStart = i;
        break;
      }
    }
  }

  if (dataStart < 0) throw new Error('Не удалось найти данные в файле Ozon Bank');

  // Определяем смещение колонок (0 или 1) по строке заголовка
  const headerRow = data[dataStart - 2] || [];
  const colOffset = String(headerRow[0]).trim() === 'Дата' ? 0 : 1;

  const ops = [];
  for (let i = dataStart; i < data.length; i++) {
    const row = data[i];

    // Дата
    let dt = null;
    const dateVal = row[colOffset];
    if (dateVal instanceof Date) {
      dt = `${dateVal.getFullYear()}-${String(dateVal.getMonth()+1).padStart(2,'0')}-${String(dateVal.getDate()).padStart(2,'0')}`;
    } else if (dateVal) {
      dt = parseDMY(String(dateVal));
    }
    if (!dt) continue;

    const parseNum = v => {
      if (typeof v === 'number') return v;
      return parseFloat(String(v||'0').replace(/\s/g,'').replace(',','.')) || 0;
    };

    const debit  = parseNum(row[colOffset + 2]);
    const credit = parseNum(row[colOffset + 3]);
    if (debit === 0 && credit === 0) continue;

    const cp   = String(row[colOffset + 4] || '').split('\n')[0].trim();
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

    ops.push({ dt, mo, src: 'Ozon Bank', account, cp, desc,
               amount, currency: 'RUB', amount_rub: amount, amount_usd: amount > 0 ? amtUsd : -amtUsd, sig });
  }

  return ops;
}
