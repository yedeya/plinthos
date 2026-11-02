/**
 * `assets/catalogue.css`: the public catalogue's own stylesheet, standalone, since the public site
 * never loads the admin's (`docs/design/catalogue.md`). It carries the admin's tokens
 * (`docs/design/ui.md`, `src/app/admin.css`), light and dark from the device's setting, a visible
 * focus ring on everything interactive, and the grid at two columns on a phone.
 */
export const CATALOGUE_CSS = `/* Plinthos public catalogue */
:root {
  color-scheme: light dark;
  --bg: #f5f6f8;
  --surface: #ffffff;
  --ink: #1a1d23;
  --muted: #5d6573;
  --line: #dde1e7;
  --accent: #c8102e;
  --accent-ink: #ffffff;
  --ok: #1f7a3d;
  --warn: #a35a00;
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --text-sm: 14px;
  --text-md: 16px;
  --text-lg: 20px;
  --text-xl: 24px;
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s5: 24px;
  --s6: 32px;
  --gutter: 16px;
  --radius: 8px;
  --pill: 999px;
  --tap: 44px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121418;
    --surface: #1c1f25;
    --ink: #e8eaee;
    --muted: #9aa3b2;
    --line: #2e333c;
    --accent: #ff5a6e;
    --accent-ink: #121418;
    --ok: #4cc27a;
    --warn: #f0a640;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font); font-size: var(--text-md); line-height: 1.4; }
h1, h2, p, dl, dd, ul, ol, fieldset { margin: 0; }
h1 { font-size: var(--text-xl); }
h2 { font-size: var(--text-lg); }
a { color: var(--accent); }
img { display: block; max-width: 100%; }
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.muted { color: var(--muted); font-size: var(--text-sm); }
.prose { white-space: pre-line; overflow-wrap: anywhere; }

.masthead { padding: var(--s4) var(--gutter); border-bottom: 1px solid var(--line); background: var(--surface); }
.masthead__wordmark { font-weight: 700; font-size: var(--text-lg); color: var(--accent); }
.masthead__tagline { color: var(--muted); font-size: var(--text-sm); }
.page { max-width: 1200px; margin: 0 auto; padding: var(--s4) var(--gutter) var(--s6); display: flex; flex-direction: column; gap: var(--s5); }
.section { display: flex; flex-direction: column; gap: var(--s3); }
.foot { max-width: 1200px; margin: 0 auto; padding: var(--s4) var(--gutter) calc(var(--s6) + env(safe-area-inset-bottom)); border-top: 1px solid var(--line); }

.summary { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s3) var(--s4); display: flex; flex-direction: column; gap: var(--s1); }
.summary__totals { font-weight: 700; }
.summary__conditions, .summary__parts { color: var(--muted); }

.filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3); align-items: end; }
@media (min-width: 720px) { .filters { display: flex; flex-wrap: wrap; } .field select { min-width: 12rem; } }
.choices { grid-column: 1 / -1; min-inline-size: 0; min-width: 0; border: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--s2); }
.choices legend { font-size: var(--text-sm); color: var(--muted); margin-bottom: var(--s1); padding: 0; }
.choice { position: relative; display: inline-flex; align-items: center; min-height: var(--tap); padding: 0 var(--s4); border: 1px solid var(--line); border-radius: var(--pill); background: var(--surface); cursor: pointer; }
.choice input { position: absolute; opacity: 0; inset: 0; margin: 0; cursor: pointer; }
.choice:has(input:checked) { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.choice:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
.field { display: flex; flex-direction: column; gap: var(--s1); }
.field__label { font-size: var(--text-sm); color: var(--muted); }
.field { min-width: 0; }
.field select { width: 100%; min-height: var(--tap); min-width: 0; padding: 0 var(--s3); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }

.grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s3); }
@media (min-width: 720px) { .grid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--s4); } }
.card__link { display: flex; flex-direction: column; gap: var(--s1); height: 100%; padding: var(--s2); border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); color: var(--ink); text-decoration: none; }
.card__link:hover .card__name { text-decoration: underline; }
.card__media { display: block; aspect-ratio: 1; border-radius: calc(var(--radius) - 2px); overflow: hidden; background: var(--bg); }
.card__media img { width: 100%; height: 100%; object-fit: cover; }
.card__none { display: flex; height: 100%; align-items: center; justify-content: center; color: var(--muted); font-size: var(--text-sm); }
.card__num { font-size: var(--text-sm); font-weight: 700; }
.card__name { font-size: var(--text-sm); }
.card__meta { font-size: var(--text-sm); color: var(--muted); }
.chip { align-self: flex-start; padding: 2px var(--s2); border: 1px solid var(--line); border-radius: var(--pill); font-size: var(--text-sm); }
.chip--sealed { border-color: var(--ok); color: var(--ok); }
.empty { padding: var(--s5) 0; color: var(--muted); text-align: center; }

.parts-link { display: flex; align-items: center; gap: var(--s3); min-height: var(--tap); color: var(--ink); }
.parts-link__thumbs { display: flex; gap: var(--s2); }
.parts-link__thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: var(--radius); background: var(--surface); }

.back { display: inline-flex; align-items: center; min-height: var(--tap); }
.set-head { display: flex; flex-direction: column; gap: var(--s1); }
.set-head__num { color: var(--muted); }

.gallery { position: relative; display: flex; flex-direction: column; gap: var(--s2); max-width: 720px; }
.gallery__track { list-style: none; padding: 0; display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scroll-behavior: smooth; gap: var(--s2); border-radius: var(--radius); }
.gallery__slide { flex: 0 0 100%; scroll-snap-align: center; background: var(--surface); }
.gallery__slide a { display: block; }
.gallery__slide img { width: 100%; aspect-ratio: 4 / 3; object-fit: contain; }
.gallery__thumbs { list-style: none; padding: 0; display: flex; gap: var(--s2); overflow-x: auto; }
.gallery__thumbs a { display: block; width: var(--tap); height: var(--tap); min-width: 64px; min-height: 64px; }
.gallery__thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--line); }
.gallery__arrows { display: none; }
@media (min-width: 720px) {
  .gallery__arrows:not([hidden]) { display: flex; justify-content: space-between; position: absolute; top: 40%; left: var(--s2); right: var(--s2); pointer-events: none; }
}
.gallery__arrow { pointer-events: auto; width: var(--tap); height: var(--tap); border: 1px solid var(--line); border-radius: var(--pill); background: var(--surface); font-size: var(--text-lg); cursor: pointer; }

.facts { display: grid; gap: var(--s2); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s3) var(--s4); max-width: 720px; }
.facts div { display: grid; grid-template-columns: 9rem 1fr; gap: var(--s3); }
.facts dt { color: var(--muted); }
`;
