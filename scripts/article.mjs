/**
 * article.mjs - turn a PDF of an article into a page on this site.
 *
 * Drop a PDF in inbox/. This OCRs it, works out its shape, and writes
 * articles/<slug>.html plus a rebuilt articles/index.html. The PDF itself
 * moves to articles/pdf/ so the page can link back to the original.
 *
 * Two outside programs do the reading, both free and offline:
 *   pdftoppm (poppler-utils)    - renders each page to a 300dpi image
 *   tesseract                   - reads the images
 * pdftotext, from the same package, is the --text-layer shortcut only.
 *
 * Everything after that is heuristics in this file. OCR returns a wall of
 * text; it has no idea what a headline is. The rules below guess, and they
 * guess wrong sometimes - which is what the filename convention is for:
 *
 *   The Bridge That Ate a Town's Budget -- Ada Marsh -- Islands Sounder -- March 4, 1987.pdf
 *
 * Anything in the filename, split on " -- ", beats the guess. The order is
 * title, byline, publication, date, and you can stop after any of them.
 *
 *   node scripts/article.mjs                 process every PDF in inbox/
 *   node scripts/article.mjs some/file.pdf   process one file, anywhere
 *   node scripts/article.mjs --text-layer    trust a digital PDF's own text, skip OCR
 *   node scripts/article.mjs --index         rebuild the list page only
 *
 * Local setup: brew install tesseract poppler          (macOS)
 *              apt-get install tesseract-ocr poppler-utils
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = path.join(ROOT, "inbox");
const OUT = path.join(ROOT, "articles");
const PDFS = path.join(OUT, "pdf");
const INDEX = path.join(OUT, "articles.json");

/** 300 is where tesseract reads printed text best. Below 200 it degrades fast. */
const DPI = 300;
/** Fewer words than this from the text layer means the PDF is a scan. */
const TEXT_LAYER_MIN_WORDS = 30;

/* ------------------------------------------------------------------ *
 * reading the pdf
 * ------------------------------------------------------------------ */

function run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function have(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const words = (s) => (String(s).match(/[A-Za-z]{2,}/g) || []).length;

/**
 * Returns { text, how }. Pages are separated by a form feed, which is what
 * the running-head rule below keys off.
 *
 * OCR is the default even when the PDF carries a text layer, because a text
 * layer records the order the typesetter WROTE the text, not the order a
 * person READS it. On a two-column journal page those differ: pdftotext can
 * hand back section headings pages away from their sections. Tesseract works
 * from the image, so it sees two columns and reads down one then the other.
 * On a clean single-column PDF the two agree word for word, which is what
 * --text-layer is for when you want the seconds back.
 */
function readPdf(file, useTextLayer) {
  if (useTextLayer) {
    const direct = run("pdftotext", ["-q", "-eol", "unix", file, "-"]);
    if (words(direct) >= TEXT_LAYER_MIN_WORDS) return { text: direct, how: "text layer" };
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "article-"));
  try {
    run("pdftoppm", ["-r", String(DPI), "-gray", "-png", file, path.join(dir, "p")]);
    const pages = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    if (!pages.length) throw new Error("pdftoppm produced no pages");
    const text = pages
      .map((p) => run("tesseract", [path.join(dir, p), "-", "-l", "eng"]))
      .join("\n\f\n");
    return { text, how: `ocr, ${pages.length} page${pages.length === 1 ? "" : "s"}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * turning a wall of text into an article
 * ------------------------------------------------------------------ */

const MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december" +
  "|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec";

const looksLikeDate = (s) =>
  new RegExp(`\\b(${MONTHS})\\b[^\\n]{0,12}\\b(1[6-9]|20)\\d{2}\\b`, "i").test(s) ||
  /^\s*(1[6-9]|20)\d{2}\s*$/.test(s) ||
  /^\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\s*$/.test(s);

/** A page number, a rule of dashes, a jump line - not the article. */
const isFurniture = (line) =>
  /^\s*[-–—|]*\s*(page\s*)?\d{1,4}\s*[-–—|]*\s*$/i.test(line) ||
  /^[-–—_=•·.\s]+$/.test(line) ||
  /^\s*\(?(continued|cont'd|see)\b.{0,40}\b(page|next)\b.{0,12}$/i.test(line);

/**
 * Lines that repeat on two or more pages are the masthead or the running
 * head, wherever they sit on the page. One pass over the pages finds them.
 */
function repeatedLines(pages) {
  if (pages.length < 2) return new Set();
  const seen = new Map();
  for (const page of pages) {
    const unique = new Set(
      page
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && l.length < 60),
    );
    for (const l of unique) seen.set(l, (seen.get(l) || 0) + 1);
  }
  const out = new Set();
  for (const [line, n] of seen) if (n >= 2) out.add(line);
  return out;
}

/**
 * Both readers de-wrap as they go, so a "line" here is a run of text, not a
 * typeset line, and a blank line between paragraphs is not something either
 * one reliably emits. These four signals find the breaks instead:
 *
 *   a closed sentence followed by a capital   - one paragraph ends, one starts
 *   a short run with no punctuation, then a
 *     full-width run                          - a subhead above its section
 *   a line starting "By "                     - the byline
 *   caps giving way to mixed case             - the headline ending
 *
 * A false break costs a paragraph mark. A missed one welds a subhead into the
 * body, so where the two are close this leans towards breaking.
 */
const DEWRAPPED = 100;
function chunk(lines) {
  const groups = [[]];
  for (const line of lines) {
    const g = groups[groups.length - 1];
    const prev = g[g.length - 1];
    const breaks =
      prev &&
      ((/[.!?]["'”’)]?$/.test(prev) && /^["'“‘]?[A-Z]/.test(line)) ||
        (prev.length < 70 &&
          !/[.!?,;:]$/.test(prev) &&
          line.length >= 60 &&
          line.length > prev.length * 1.5) ||
        /^\d{1,2}[.)]\s+\S/.test(line) ||
        /^by[\s:]/i.test(line) ||
        (allCaps(prev) && !allCaps(line)));
    if (breaks) groups.push([line]);
    else g.push(line);
  }
  return groups.filter((g) => g.length);
}

/** Blocks of lines, blank-line separated, with page furniture already gone. */
function blocksOf(text) {
  const pages = text.split(/\f/);
  const repeated = repeatedLines(pages);
  const blocks = [];

  for (const page of pages) {
    let current = [];
    const flush = () => {
      if (current.length) for (const run of chunk(current)) blocks.push(run);
      current = [];
    };
    for (const raw of page.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      if (isFurniture(trimmed) || repeated.has(trimmed)) continue;
      current.push(trimmed);
    }
    flush();
  }

  /* Join each block's lines into one string, healing words the typesetter
     broke across a line: "bud-" + "get" is one word, "well-" + "known" two. */
  return blocks
    .map((lines) =>
      lines
        .reduce((acc, line) => {
          if (!acc) return line;
          /* A word the typesetter broke over a line rejoins with no space.
             "bud-" + "get" loses the hyphen; "trial-" + "and-error" keeps it,
             because a hyphen already inside the incoming word means the first
             one was the author's, not the line break's. */
          if (/[a-z]-$/.test(acc) && /^[a-z]/.test(line)) {
            const compound = /-/.test(line.split(" ")[0]);
            return compound ? acc + line : acc.slice(0, -1) + line;
          }
          return acc + " " + line;
        }, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

/** A paragraph cut in half by a page break, rejoined with its other half. */
function mergeSplitParagraphs(blocks) {
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    const numberedHeading = /^\d{1,2}[.)]\s+[A-Z]/.test(b);
    const runsOn =
      prev &&
      !numberedHeading &&
      prev.length > 60 &&
      !/[.!?"'”’)]$/.test(prev) &&
      /^[a-z0-9,;]/.test(b);
    if (runsOn) out[out.length - 1] = prev + " " + b;
    else out.push(b);
  }
  return out;
}

/** OCR scrapes stray marks off the page edge. A short block carrying a
 *  character no printed sentence uses is one of those, not a sentence. */
const isJunk = (b) =>
  b.length < 20 && (/[^\w\s.,'"‘’“”:;!?()\[\]&%$#@/-]/.test(b) || (b.match(/[A-Za-z]/g) || []).length < 3);

/** A journal's citation line: shouted, or carrying a year and a page range. */
const isCitationLine = (b) =>
  b.length < 90 &&
  ((allCaps(b) && /\d/.test(b)) ||
    (/\b(19|20)\d{2}\b/.test(b) && /\d+\s*[–—-]\s*\d+/.test(b)));

/** Two to four capitalised words, no sentence in sight - somebody's name. */
const isName = (b) =>
  b.length < 60 && /^[A-Z][\p{L}.'’-]*(\s+[A-Z][\p{L}.'’-]*\.?){1,3}$/u.test(b);

const isShort = (s, n) => s.length <= n;
const ends = (s) => /[.!?:;,]$/.test(s);
const allCaps = (s) => s === s.toUpperCase() && /[A-Z]{3}/.test(s);

const SMALL = /\s(a|an|the|and|or|but|of|in|on|at|to|for|from|by|with|as)\b/gi;
const titleCase = (s) =>
  s
    .toLowerCase()
    .replace(/(^|[\s(“"-])([a-z])/g, (m, pre, ch) => pre + ch.toUpperCase())
    .replace(SMALL, (w) => w.toLowerCase());

/**
 * Reads the blocks and decides what each one is. Deliberately conservative:
 * a wrong heading is easy to skim past, but body text misfiled as a caption
 * disappears into grey. Anything it cannot place stays a paragraph.
 */
function parseArticle(text, fromName) {
  const blocks = mergeSplitParagraphs(blocksOf(text));
  const article = { title: "", subtitle: "", byline: "", publication: "", published: "", body: [] };

  /* The head of an article - title, byline, date - sits in the first few
     short blocks, before the first real paragraph. */
  let i = 0;
  for (const HEAD = 6; i < blocks.length && i < HEAD; i++) {
    const b = blocks[i];
    if (b.length > 200) break;

    /* "BEHAVIORAL AND BRAIN SCIENCES (2008) 31, 241-260" is the journal's
       own citation line, not the article's title. */
    if (!article.title && isCitationLine(b)) continue;

    const by = b.match(/^by[\s:]+(.{2,80})$/i);
    if (by && !article.byline) {
      /* OCR often runs the byline and the date together on one line. */
      let who = by[1].trim();
      const tail = who.match(new RegExp(`\\s+((?:${MONTHS})\\b.*)$`, "i"));
      if (tail && looksLikeDate(tail[1])) {
        article.published = tail[1].replace(/[,.]$/, "").trim();
        who = who.slice(0, tail.index).trim();
      }
      article.byline = who.replace(/[,.]$/, "").trim();
      continue;
    }
    if (!article.title && isShort(b, 140) && !ends(b)) {
      article.title = b;
      continue;
    }
    if (!article.published && isShort(b, 60) && looksLikeDate(b)) {
      article.published = b.replace(/^[-–—|\s]+|[-–—|\s]+$/g, "");
      continue;
    }
    /* An academic paper prints its author's name with no "By" in front. */
    if (article.title && !article.byline && isName(b)) {
      article.byline = b;
      continue;
    }
    break;
  }

  for (const b of blocks.slice(i)) {
    if (isJunk(b)) continue;
    const wordsIn = b.split(" ").length;
    /* "3. Method" and "References" are headings as much as "The vote" is. */
    const heading =
      isShort(b, 70) && !ends(b) && /^(\d{1,2}[.)]\s+)?[A-Z]/.test(b) && wordsIn >= 1 && wordsIn <= 9;
    article.body.push({
      type: heading ? "heading" : "paragraph",
      text: heading && allCaps(b) ? titleCase(b) : b,
      items: [],
    });
  }

  /* A headline set in caps reads as shouting once it is off the page. */
  if (allCaps(article.title)) article.title = titleCase(article.title);
  if (allCaps(article.byline)) article.byline = titleCase(article.byline);

  /* The filename is the one thing a person controls, so it wins. */
  const named = fromName.split(" -- ").map((s) => s.trim());
  if (named.length > 1 || !article.title) {
    const [title, byline, publication, published] = named;
    if (title) article.title = title;
    if (byline) article.byline = byline;
    if (publication) article.publication = publication;
    if (published) article.published = published;
  }

  return article;
}

/* ------------------------------------------------------------------ *
 * rendering
 * ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function slugify(title) {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return s || "article";
}

/** A slug is a URL. Once one is published it never moves, so new ones give way. */
function uniqueSlug(base, taken) {
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** The quiet dot-separated line under a headline: byline, where, when. */
function metaLine(a) {
  return [a.byline, a.publication, a.published].filter(Boolean).join(" · ");
}

function renderBody(body) {
  const out = [];
  for (const b of body) {
    if (b.type === "list") {
      const items = (b.items || []).filter(Boolean);
      if (!items.length) continue;
      out.push("<ul>" + items.map((i) => `<li>${esc(i)}</li>`).join("") + "</ul>");
      continue;
    }
    const text = (b.text || "").trim();
    if (!text) continue;
    if (b.type === "heading") out.push(`<h2>${esc(text)}</h2>`);
    else if (b.type === "quote") out.push(`<blockquote>${esc(text)}</blockquote>`);
    else if (b.type === "caption") out.push(`<p class="cap">${esc(text)}</p>`);
    else out.push(`<p>${esc(text)}</p>`);
  }
  return out.join("\n  ");
}

/* The page's look is this-old-house/index.html: Arial at weight 200, four grey
   tokens, hairlines, no chrome. Body copy goes left-aligned at a reading width;
   everything else keeps the site's centred masthead. */
const CSS = `:root{
  --ink:#000000d9;      /* body text      */
  --mid:#00000075;      /* secondary text */
  --faint:#00000038;    /* quietest       */
  --line:#0000001a;     /* hairlines      */
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:Arial, Helvetica, sans-serif;
  font-weight:200;font-style:normal;font-size:15px;line-height:1.6;
  color:var(--ink);background-color:rgb(255,255,255);text-align:center;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:940px;margin:0 auto;padding:0 5vw 12vh}
a{color:inherit;text-decoration:none}

.mast{padding:6vh 0 0}
.mast .up{font-size:13px;letter-spacing:2px;color:var(--faint);transition:color .3s linear}
.mast .up:hover{color:var(--mid)}
h1{font-size:3vw;font-weight:200;letter-spacing:2px;margin:.4em 0 .1em;color:var(--ink)}
.tagline{font-size:1.5vw;font-weight:lighter;letter-spacing:2px;color:var(--mid)}
.rule{height:1px;background:var(--line);margin:5vh 0 0}

/* the article itself - the one left-aligned column on the site */
article{
  max-width:34em;margin:0 auto;text-align:left;padding-top:5vh;
  /* the rest of the site is weight 200; a full article is too long to read at it */
  font-weight:400;font-size:16px;line-height:1.75;
}
article p{margin:0 0 1.5em}
article h2{  /* the article's own subhead, set as printed */
  font-size:15px;font-weight:400;letter-spacing:1px;
  color:var(--ink);margin:3.2em 0 1.1em;
}
article blockquote{
  margin:2em 0;padding-left:1.4em;border-left:1px solid var(--line);
  color:var(--mid);
}
article ul{margin:0 0 1.5em;padding-left:1.2em}
article li{list-style:disc;height:auto;font-size:inherit}
article .cap{font-size:13px;letter-spacing:.3px;color:var(--mid);margin:2em 0}

footer{
  max-width:34em;margin:9vh auto 0;padding-top:3vh;border-top:1px solid var(--line);
  font-size:11px;letter-spacing:1px;line-height:2.2;color:var(--faint);text-align:left;
}
footer a{color:var(--mid);transition:color .3s linear}
footer a:hover{color:var(--ink)}

/* the list page */
.list{max-width:34em;margin:0 auto;text-align:left;padding-top:5vh}
.item{display:block;padding:2.2vh 0;border-bottom:1px solid var(--line)}
.item .t{font-size:16px;letter-spacing:.5px;color:var(--mid);transition:color .3s linear}
.item:hover .t{color:var(--ink)}
.item .m{font-size:12px;letter-spacing:1px;color:var(--faint);margin-top:3px}
.empty{color:var(--faint);font-size:13px;letter-spacing:2px;padding-top:6vh}

@media (max-width:700px){
  h1{font-size:6.5vw}
  .tagline{font-size:3.4vw}
}`;

function page({ title, tagline, main, footer }) {
  return `<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="icon" href="../favicon.png">
<style>
${CSS}
</style>
</head>

<body>
<div class="wrap">

  <div class="mast">
    <a class="up" href="../index.html">keillor witt</a>
    <h1>${esc(title)}</h1>
    ${tagline ? `<div class="tagline">${esc(tagline)}</div>` : ""}
  </div>

  <div class="rule"></div>

${main}

${footer}
</div>
</body>
</html>
`;
}

function renderArticle(a, entry) {
  return page({
    title: a.title,
    tagline: a.subtitle || metaLine(a),
    main: `  <article>
  ${renderBody(a.body)}
  </article>`,
    footer: `  <footer>
    ${a.subtitle && metaLine(a) ? esc(metaLine(a)) + " &middot; " : ""}<a href="pdf/${esc(entry.pdf)}">original pdf</a> &middot; <a href="index.html">all articles</a>
  </footer>`,
  });
}

function renderIndex(entries) {
  const list = entries.length
    ? entries
        .map((e) => {
          const meta = [e.byline, e.publication, e.published].filter(Boolean).join(" · ");
          return `    <a class="item" href="${esc(e.slug)}.html">
      <div class="t">${esc(e.title)}</div>
      ${meta ? `<div class="m">${esc(meta)}</div>` : ""}
    </a>`;
        })
        .join("\n")
    : `    <div class="empty">nothing here yet</div>`;

  return page({
    title: "articles",
    tagline: entries.length ? `${entries.length} ${entries.length === 1 ? "piece" : "pieces"}` : "",
    main: `  <div class="list">
${list}
  </div>`,
    footer: `  <footer>
    scanned, read and filed &middot; <a href="../index.html">home</a>
  </footer>`,
  });
}

/* ------------------------------------------------------------------ *
 * the index file
 * ------------------------------------------------------------------ */

function readIndex() {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Newest first, by when it was added here - print dates are unreliable. */
function writeIndex(entries) {
  const sorted = [...entries].sort((a, b) => String(b.added).localeCompare(String(a.added)));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(INDEX, JSON.stringify(sorted, null, 2) + "\n");
  fs.writeFileSync(path.join(OUT, "index.html"), renderIndex(sorted));
  return sorted;
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */

function inboxPdfs() {
  if (!fs.existsSync(INBOX)) return [];
  return fs
    .readdirSync(INBOX)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort()
    .map((f) => path.join(INBOX, f));
}

function main() {
  const args = process.argv.slice(2);
  const useTextLayer = args.includes("--text-layer");

  if (args.includes("--index")) {
    const entries = writeIndex(readIndex());
    console.log(`index: ${entries.length} article${entries.length === 1 ? "" : "s"}`);
    return;
  }

  const named = args.filter((a) => !a.startsWith("--"));
  const files = named.length ? named.map((f) => path.resolve(f)) : inboxPdfs();
  if (!files.length) {
    console.log("inbox is empty - nothing to do");
    return;
  }

  for (const tool of ["pdftotext", "pdftoppm", "tesseract"]) {
    if (!have(tool)) {
      console.error(
        `${tool} is not installed.\n` +
          "  macOS: brew install tesseract poppler\n" +
          "  linux: apt-get install tesseract-ocr poppler-utils",
      );
      process.exit(1);
    }
  }

  const entries = readIndex();
  const taken = new Set(entries.map((e) => e.slug));
  let made = 0;
  const failed = [];

  for (const file of files) {
    const name = path.basename(file);
    if (!fs.existsSync(file)) {
      failed.push(`${name}: no such file`);
      continue;
    }
    console.log(`reading ${name} ...`);

    let article, how;
    try {
      const read = readPdf(file, useTextLayer);
      how = read.how;
      article = parseArticle(read.text, name.replace(/\.pdf$/i, ""));
      if (!article.title || !article.body.length) throw new Error("no article text came out");
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
      console.error(`  failed - ${err.message}`);
      continue;
    }

    const slug = uniqueSlug(slugify(article.title), taken);
    taken.add(slug);

    const wordCount = article.body.reduce((n, b) => n + words(b.text), 0);
    const entry = {
      slug,
      title: article.title,
      subtitle: article.subtitle || "",
      byline: article.byline || "",
      publication: article.publication || "",
      published: article.published || "",
      added: new Date().toISOString().slice(0, 10),
      words: wordCount,
      pdf: `${slug}.pdf`,
      source: name,
    };

    fs.mkdirSync(PDFS, { recursive: true });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${slug}.html`), renderArticle(article, entry));
    fs.copyFileSync(file, path.join(PDFS, entry.pdf));
    /* Only clear the inbox once the page and the pdf are both on disk. */
    if (path.dirname(file) === INBOX) fs.unlinkSync(file);

    entries.push(entry);
    made++;
    console.log(`  -> articles/${slug}.html (${how}, ${wordCount} words)`);
  }

  writeIndex(entries);

  if (failed.length) {
    console.error(`\n${failed.length} failed:`);
    for (const f of failed) console.error(`  ${f}`);
    /* A failure must not look like a success in the Actions log, but the
       articles that did work are already written and get committed. */
    if (!made) process.exit(1);
  }
}

main();
