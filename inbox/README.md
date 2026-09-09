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
- **By hand, no Action** — `ANTHROPIC_API_KEY=… node scripts/article.mjs` from
  the repo root does the same work locally.

What it will and will not do:

- It transcribes. It does not summarize, and it does not invent a byline or a
  date that is not printed.
- Text only. Photographs in the PDF are not pulled out; the original PDF is
  linked from the bottom of every page.
- Roughly 20MB per PDF. Split anything bigger.
- Article pages carry `noindex`, so search engines skip them.

The whole job is `scripts/article.mjs`. The trigger is
`.github/workflows/article.yml`.
