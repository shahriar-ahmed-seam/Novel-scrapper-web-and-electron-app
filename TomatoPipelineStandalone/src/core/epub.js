import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function textToXhtml(title, text) {
  const paras = String(text || '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeXml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');

  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n` +
    `<head><meta charset="utf-8" /><title>${escapeXml(title)}</title></head>\n` +
    `<body><h1>${escapeXml(title)}</h1>\n${paras}\n</body></html>`
  );
}

function coverXhtml(title, imgHref) {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<!DOCTYPE html>\n` +
    `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n` +
    `<head><meta charset="utf-8" /><title>${escapeXml(title)}</title></head>\n` +
    `<body style="margin:0;padding:0;text-align:center;">` +
    `<img src="${escapeXml(imgHref)}" alt="Cover" style="max-width:100%;height:auto;"/>` +
    `</body></html>`
  );
}

export async function buildEpub({ outPath, novelTitle, novelDescription, cover, chapters }) {
  const zip = new JSZip();
  const uuid = `tomato-${Date.now()}`;

  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.folder('META-INF').file(
    'container.xml',
    `<?xml version="1.0"?>\n` +
      `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>` +
      `</container>`
  );

  const oebps = zip.folder('OEBPS');
  oebps.folder('Styles').file('style.css', 'body{font-family:serif;}');

  const manifestItems = [
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
    `<item id="style" href="Styles/style.css" media-type="text/css"/>`
  ];

  const spineItems = [];

  // Metadata page
  oebps.folder('Text').file(
    'meta.xhtml',
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" lang="en">\n` +
      `<head><meta charset="utf-8" /><title>Metadata</title></head>\n` +
      `<body><h1>${escapeXml(novelTitle)}</h1>` +
      (novelDescription ? `<p>${escapeXml(novelDescription).replace(/\n/g, '<br/>')}</p>` : '') +
      `</body></html>`
  );
  manifestItems.push(`<item id="meta" href="Text/meta.xhtml" media-type="application/xhtml+xml"/>`);
  spineItems.push(`<itemref idref="meta"/>`);

  // Cover
  let coverHref = '';
  if (cover?.bytes && cover?.mediaType && cover?.fileName) {
    const imgPath = `Images/${cover.fileName}`;
    coverHref = imgPath;
    oebps.folder('Images').file(cover.fileName, cover.bytes);
    manifestItems.push(`<item id="cover-image" href="${escapeXml(imgPath)}" media-type="${escapeXml(cover.mediaType)}"/>`);

    oebps.folder('Text').file('cover.xhtml', coverXhtml(novelTitle, `../${imgPath}`));
    manifestItems.push(`<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>`);
    spineItems.unshift(`<itemref idref="cover"/>`);
  }

  // Chapters
  const chapterItems = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    const cNum = c.number || (i + 1);
    const file = `Text/chapter${String(cNum).padStart(4, '0')}.xhtml`;
    oebps.file(file, textToXhtml(c.title, c.content));
    const id = `chap${cNum}`;
    chapterItems.push({ id, href: file, title: c.title });
    manifestItems.push(`<item id="${escapeXml(id)}" href="${escapeXml(file)}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`<itemref idref="${escapeXml(id)}"/>`);
  }

  // toc.ncx
  oebps.file(
    'toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
      `<head>` +
      `<meta name="dtb:uid" content="${escapeXml(uuid)}"/>` +
      `<meta name="dtb:depth" content="1"/>` +
      `<meta name="dtb:totalPageCount" content="0"/>` +
      `<meta name="dtb:maxPageNumber" content="0"/>` +
      `</head>` +
      `<docTitle><text>${escapeXml(novelTitle)}</text></docTitle>` +
      `<navMap>` +
      chapterItems
        .map((it, idx) => {
          const order = idx + 1;
          return `<navPoint id="navPoint-${order}" playOrder="${order}">` +
            `<navLabel><text>${escapeXml(it.title)}</text></navLabel>` +
            `<content src="${escapeXml(it.href)}"/>` +
            `</navPoint>`;
        })
        .join('') +
      `</navMap>` +
      `</ncx>`
  );

  // content.opf
  const metadata =
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
    `<dc:identifier id="BookId">${escapeXml(uuid)}</dc:identifier>` +
    `<dc:title>${escapeXml(novelTitle)}</dc:title>` +
    `<dc:language>en</dc:language>` +
    (coverHref ? `<meta name="cover" content="cover-image"/>` : '') +
    `</metadata>`;

  oebps.file(
    'content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookId" version="2.0">` +
      metadata +
      `<manifest>${manifestItems.join('')}</manifest>` +
      `<spine toc="ncx">${spineItems.join('')}</spine>` +
      `</package>`
  );

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outPath, buf);
}

async function addDirToZip(zip, absDirPath, relPrefix, { excludeAbsPaths = new Set() } = {}) {
  const entries = await fs.readdir(absDirPath, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(absDirPath, ent.name);
    if (excludeAbsPaths.has(abs)) continue;
    const rel = relPrefix ? path.posix.join(relPrefix, ent.name) : ent.name;

    if (ent.isDirectory()) {
      await addDirToZip(zip, abs, rel, { excludeAbsPaths });
    } else if (ent.isFile()) {
      const data = await fs.readFile(abs);
      zip.file(rel, data);
    }
  }
}

export async function buildBundleZip({ outPath, rootDir }) {
  const zip = new JSZip();
  await addDirToZip(zip, rootDir, '', { excludeAbsPaths: new Set([outPath]) });
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(outPath, buf);
}
