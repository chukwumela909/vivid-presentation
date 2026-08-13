# vivid-presentation

Landing page for **Vivid**, a voice AI agent.

No build step and no dependencies — three files, opened directly or served statically.

```
index.html    markup, all sections
styles.css    design tokens + components, mapped 1:1 to DESIGN.md
main.js       waveforms, call simulation, pricing toggle, reveals
```

## Run it

```bash
node .claude/serve.mjs
```

Then open http://localhost:4173. (`open index.html` also works, though the
browser may block the Google Fonts request on `file://`.)

## Design system

Everything follows [DESIGN.md](DESIGN.md) — the Framer-derived guide added with
`npx getdesign@latest add framer`. The tokens in the `:root` block of
`styles.css` are a direct transcription of its front matter, so changing a token
there propagates through the page.

A few notes on how the guide was applied:

- **Display type** uses Geist (a documented GT Walsheim substitute) with
  letter-spacing expressed as `em` rather than `px`, so the −5 % tracking on
  display sizes survives the responsive `clamp()`.
- **Gradient spotlight cards** appear exactly twice — violet in the capability
  grid, sunset in the demo band — per the guide's "one or two per long page".
- **Accent blue** is used only for tool-call traces, focus rings and selection.
  Never as a fill.
- **Hierarchy on dark** is carried by surface lift (canvas → surface-1 →
  surface-2), not by opacity on white type.

## Placeholders

The copy is written for a fictional product; the metrics (312 ms, 94 %,
99.99 %), pricing and customer names are illustrative and need replacing before
this goes anywhere public. Voice previews animate a waveform but ship no audio —
wire real clips into the `.voice` buttons in `main.js` when assets exist.
