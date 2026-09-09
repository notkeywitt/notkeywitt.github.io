/**
 * article.mjs - turn a PDF of an article into a page on this site.
 *
 * Drop a PDF in inbox/. This reads it, hands it to Claude, and writes
 * articles/<slug>.html plus a rebuilt articles/index.html. The PDF itself
 * moves to articles/pdf/ so the page can link back to the original.
 *
 * There is no separate OCR step. Claude reads the PDF directly as a
 * `document` block, scanned or not, and returns the article as structured
 * blocks. This file renders those blocks to HTML - the model never emits
 * markup, so nothing it returns can inject anything into the page.
 *
 *   node scripts/article.mjs                 process every PDF in inbox/
 *   node scripts/article.mjs some/file.pdf   process one file, anywhere
 *   node scripts/article.mjs --index         rebuild the list page only
 *
 * Needs ANTHROPIC_API_KEY in the environment (a repo secret in CI).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INBOX = path.join(ROOT, "inbox");
const OUT = path.join(ROOT, "articles");
const PDFS = path.join(OUT, "pdf");
const INDEX = path.join(OUT, "articles.json");

/** Override to trade cost for depth. Opus 5 reads faint scans best. */
const MODEL = process.env.ARTICLE_MODEL?.trim() || "claude-opus-5";

/** The API caps a request at 32MB, and base64 adds a third. */
const MAX_PDF_BYTES = 22 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * the one model call
 * ------------------------------------------------------------------ */

/** Every field is required so the model must decide; absent means "" or []. */
const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "The article's headline." },
    subtitle: { type: "string", description: "Standfirst or deck. Empty string if none." },
    byline: { type: "string", description: "Author, as printed, without 'By'. Empty string if none." },
    publication: { type: "string", description: "Where it ran. Empty string if not printed." },
    published: { type: "string", description: "Publication date as printed. Empty string if none." },
    body: {
      type: "array",
      description: "The article text in reading order.",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["paragraph", "heading", "quote", "list", "caption"],
          },
          text: {
            type: "string",
            description: "The block's text. Empty string for a list.",
          },
          items: {
            type: "array",
            items: { type: "string" },
            description: "The entries of a list block. Empty array otherwise.",
          },
        },
        required: ["type", "text", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "subtitle", "byline", "publication", "published", "body"],
  additionalProperties: false,
};

const SYSTEM = `You transcribe scanned articles into structured text.

You are reading a PDF of a printed article. Return the article's own text and
nothing else.

Rules:
- Transcribe. Do not summarize, shorten, paraphrase or rewrite. Every sentence
  the article prints belongs in the body.
- Do not invent. If a byline, date or publication is not printed, return an
  empty string for it. Never guess one.
- Correct only unambiguous scanning errors: a broken ligature, a word split
  across a line break, an "rn" read as "m". Keep the author's spelling,
  punctuation, capitalisation and paragraph breaks.
- Drop page furniture: page numbers, running heads, mastheads, advertisements,
  subscription boxes, and any neighbouring article that is not this one.
- A pull quote that repeats body text is furniture. Drop it. A block quotation
  the article sets apart is a "quote" block.
- Photo and figure captions are "caption" blocks, placed where they appear.
- A section subhead within the article is a "heading" block. The article's own
  headline is the title, not a heading block.
- If the PDF holds several articles, transcribe the longest one.`;

async function extract(client, pdfPath) {
  const bytes = fs.readFileSync(pdfPath);
  if (bytes.length > MAX_PDF_BYTES) {
    throw new Error(
      `${path.basename(pdfPath)} is ${(bytes.length / 1e6).toFixed(1)}MB. ` +
        `The API takes about ${(MAX_PDF_BYTES / 1e6).toFixed(0)}MB - split it first.`,
    );
  }

  /* Streaming, because a long article can run past the SDK's HTTP timeout at
     this max_tokens. finalMessage() waits for the whole thing anyway. */
  const res = await client.beta.messages
    .stream({
      model: MODEL,
      max_tokens: 64000,
      /* Route around a safety refusal instead of failing the run. */
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: bytes.toString("base64"),
              },
            },
            { type: "text", text: "Transcribe this article." },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    })
    .finalMessage();

  if (res.stop_reason === "refusal") {
    throw new Error(`the model declined this document (${res.stop_details?.category ?? "no category"})`);
  }
  if (res.stop_reason === "max_tokens") {
    throw new Error("the article ran past max_tokens - it came back truncated");
  }

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const article = JSON.parse(text);
  if (!article.title || !Array.isArray(article.body) || !article.body.length) {
    throw new Error("the model found no article in this PDF");
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

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--index")) {
    const entries = writeIndex(readIndex());
    console.log(`index: ${entries.length} article${entries.length === 1 ? "" : "s"}`);
    return;
  }

  const files = args.length ? args.map((f) => path.resolve(f)) : inboxPdfs();
  if (!files.length) {
    console.log("inbox is empty - nothing to do");
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set");
    process.exit(1);
  }
  /* Imported here, not at the top, so --index runs with nothing installed. */
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

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
    let article;
    try {
      article = await extract(client, file);
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
      console.error(`  failed - ${err.message}`);
      continue;
    }

    const slug = uniqueSlug(slugify(article.title), taken);
    taken.add(slug);

    const words = article.body.reduce(
      (n, b) => n + String(b.text || (b.items || []).join(" ")).split(/\s+/).filter(Boolean).length,
      0,
    );
    const entry = {
      slug,
      title: article.title,
      subtitle: article.subtitle || "",
      byline: article.byline || "",
      publication: article.publication || "",
      published: article.published || "",
      added: new Date().toISOString().slice(0, 10),
      words,
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
    console.log(`  -> articles/${slug}.html (${words} words)`);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
