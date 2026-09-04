# Vendored, on purpose

`pdf.min.js` and `pdf.worker.min.js` are Mozilla's pdf.js **3.11.174 legacy
build**, copied here rather than installed.

Three reasons, in order of how much they matter:

1. **This app has no build step.** A dependency would have to be bundled or
   resolved at runtime, and neither exists here. A file in `public/` is served
   by the `/static` mount that is already open to portal sessions.
2. **The employee portal must load it.** `/static/` is in `OPEN_PATHS`; almost
   nothing else is. A CDN would work until the restaurant's wifi or a content
   blocker decided otherwise, and an employee standing at the terminal cannot
   debug that.
3. **The legacy build, deliberately.** The modern build is ESM and drops older
   Safari. Staff phones are whatever they happen to own, and the legacy UMD
   bundle sets `window.pdfjsLib` with no module loader involved.

Upgrading: `npm pack pdfjs-dist@<version>`, copy `legacy/build/pdf.min.js` and
`legacy/build/pdf.worker.min.js` here, and check a multi-page PDF still renders
on a phone. The worker version must match the library exactly — pdf.js refuses
to run mismatched pairs, which is the failure you would hit first.

Licence: Apache 2.0 (Mozilla).
