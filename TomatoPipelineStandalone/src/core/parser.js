import * as cheerio from 'cheerio';

function toInt(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function parseChapterNumberFromTitle(title) {
  if (typeof title !== 'string') return null;
  const m = title.match(/第\s*(\d+)\s*章/);
  return m ? toInt(m[1]) : null;
}

function normalizeLineText(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

export function parseRawFullPayload(payload, { itemIdHint } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload must be an object');
  }

  const data = payload.data;
  if (!data || typeof data !== 'object') {
    throw new Error('payload.data missing');
  }

  const content = data.content;
  if (typeof content !== 'string') {
    throw new Error('payload.data.content must be a string');
  }

  const novelData = data.novel_data && typeof data.novel_data === 'object' ? data.novel_data : {};

  const itemId = String(
    novelData.item_id ??
      novelData.group_id ??
      data.item_id ??
      itemIdHint ??
      ''
  );

  const title = typeof data.title === 'string' ? data.title : (typeof novelData.title === 'string' ? novelData.title : '');
  const chapterNumberFromTitle = parseChapterNumberFromTitle(title);

  const contentChapterNumber = toInt(novelData.content_chapter_number);
  const realChapterOrder = toInt(novelData.real_chapter_order);

  const bookId = novelData.book_id != null ? String(novelData.book_id) : '';
  const bookName = typeof novelData.book_name === 'string' ? novelData.book_name : '';

  const $ = cheerio.load(content, { decodeEntities: true });

  const lines = [];
  $('p[idx]').each((_, el) => {
    const idxAttr = $(el).attr('idx');
    const idx = toInt(idxAttr);
    if (idx == null) return;

    const text = normalizeLineText($(el).text());
    lines.push({ idx, text });
  });

  if (lines.length === 0) {
    const re = /<p\s+idx="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const idx = toInt(m[1]);
      if (idx == null) continue;
      const innerHtml = m[2];
      const inner$ = cheerio.load(innerHtml, { decodeEntities: true });
      const text = normalizeLineText(inner$.text());
      lines.push({ idx, text });
    }
  }

  lines.sort((a, b) => a.idx - b.idx);

  const paragraphsNum = toInt(data.paragraphs_num) ?? toInt(data.free_para_nums) ?? lines.length;

  return {
    schemaVersion: 1,
    fetchedAt: new Date().toISOString(),
    itemId,
    book: {
      bookId,
      bookName,
      author: typeof novelData.author === 'string' ? novelData.author : '',
      sourcePlatform: typeof novelData.platform === 'string' ? novelData.platform : String(novelData.platform ?? '')
    },
    chapter: {
      title,
      chapterNumber: chapterNumberFromTitle,
      contentChapterNumber,
      realChapterOrder
    },
    paragraphsNum,
    lines
  };
}
