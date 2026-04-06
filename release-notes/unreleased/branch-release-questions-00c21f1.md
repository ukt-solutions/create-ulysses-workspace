---
branch: chore/go-public-docs
author: myron
date: 2026-04-06
---

## Open Questions

- **Word counts below spec target.** Chapters average ~1,200 words against a 1,500-2,000 target. Guides average ~715 words against 800-1,200. Content is substantively complete — code blocks and diagrams add weight not captured in word count — but a review pass could expand thin sections.

- **Docusaurus wrapper not included.** The docs are markdown files ready for a static site generator but no build tooling is configured. A follow-up task to add Docusaurus config would make `npm run docs` produce the HTML site.

- **Product name placeholder.** The docs use the working name `create-claude-workspace`. When the product naming decision (#38) is made, a search-and-replace pass across all doc files will be needed.
