# inbox

Drop a PDF of an article here. A GitHub Action reads it and writes
`articles/<slug>.html`, then empties this folder and files the PDF under
`articles/pdf/`.

Three ways to drop one in:

- **On a computer** — drag the PDF onto this folder on github.com, or
  `git add inbox/thing.pdf && git commit && git push`.
- **On a phone** — the GitHub mobile app, or an Apple Shortcut that PUTs the
  file to `PUT /repos/notkeywitt/notkeywitt.github.io/contents/inbox/<name>.pdf`
  with a fine-grained token that has Contents: write on this repo.
- **By hand** — `node scripts/article.mjs` from the repo root does the same
  work locally. It needs `brew install tesseract poppler` once.

## Name the file and you get the details right

The reader guesses the headline, the byline and the date from the page. It is
usually right and sometimes not. Anything you put in the filename beats the
guess:

```
The Bridge That Ate a Town's Budget -- Ada Marsh -- Islands Sounder -- March 4, 1987.pdf
```

Split on ` -- `, in that order, and you can stop after any part. The
publication is never guessed — only the filename supplies it.

## What it will and will not do

- Tesseract does the reading. A clean 300dpi scan comes out near-perfect. Faint
  or skewed newsprint comes out with errors, and nothing downstream fixes them.
- A PDF that already has a text layer skips OCR entirely.
- It finds paragraphs and subheads. It does not find captions or pull quotes.
- Page numbers, running heads and jump lines are dropped.
- Text only. Photographs are not pulled out; every page links its original PDF.
- Article pages carry `noindex`, so search engines skip them.
- The output is a plain HTML file in this repo. If a heading came out wrong,
  edit the file.

The whole job is `scripts/article.mjs`. The trigger is
`.github/workflows/article.yml`.
