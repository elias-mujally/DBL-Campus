export function csvCell(value: string): string {
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function parseRosterCsv(source: string): string[][] | null {
  const text = source.replace(/^\uFEFF/, '').trimEnd();
  const rows: string[][] = [];
  let row: string[] = [];
  let index = 0;
  while (index < text.length) {
    let value = '';
    if (text[index] === '"') {
      index++;
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote < 0) return null;
        value += text.slice(index, quote);
        index = quote + 1;
        if (text[index] !== '"') break;
        value += '"';
        index++;
      }
    } else {
      const match = /^[^,"\r\n]*/.exec(text.slice(index))!;
      value = match[0];
      index += value.length;
    }
    row.push(value.trim());
    if (text[index] === ',') {
      index++;
      if (index === text.length) row.push('');
      else continue;
    } else if (text[index] === '\r' || text[index] === '\n') {
      if (text[index++] === '\r' && text[index] === '\n') index++;
    } else if (index < text.length) {
      return null;
    }
    if (row.some(Boolean)) rows.push(row);
    row = [];
  }
  if (['university_id', 'الرقم الجامعي'].includes(rows[0]?.[0]?.toLowerCase())) rows.shift();
  return rows.every(row => row.length >= 3 && row.length <= 6) ? rows : null;
}
