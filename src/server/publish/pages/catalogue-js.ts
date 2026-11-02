/**
 * `assets/catalogue.js`: the catalogue's one small script, no dependencies and no network call
 * (`docs/design/catalogue.md`). It is an enhancement: the pages work without it ([PUB-11]).
 *
 * On the landing it shows the filter and sort controls and applies them in place to the grid's
 * cards, from their `data-*` attributes: condition, theme, kind (#202), and sorting by set number
 * (natural order, as the HTML already is, every item that is not a set after the sets, by name),
 * year (an item with none after those with one) or name. On a page with a gallery it shows the arrow
 * buttons, which scroll the track one slide. It is held as a string, because the publish step
 * writes it as a file; `tests/server/publish/pages/catalogue-js.test.ts` runs it in happy-dom.
 */
export const CATALOGUE_JS = `(function () {
  'use strict';
  function text(card, name) { return card.getAttribute('data-' + name) || ''; }
  function byIndex(a, b) { return Number(text(a, 'index')) - Number(text(b, 'index')); }
  function bySetNum(a, b) {
    var x = text(a, 'set-num'), y = text(b, 'set-num');
    if ((x === '') !== (y === '')) return x === '' ? 1 : -1;
    if (x === '') return text(a, 'name').localeCompare(text(b, 'name'), 'en', { numeric: true }) || byIndex(a, b);
    return x.localeCompare(y, 'en', { numeric: true }) || byIndex(a, b);
  }
  function byYear(a, b) {
    var x = text(a, 'year'), y = text(b, 'year');
    if ((x === '') !== (y === '')) return x === '' ? 1 : -1;
    return Number(x) - Number(y);
  }
  var compare = {
    setNum: bySetNum,
    year: function (a, b) { return byYear(a, b) || bySetNum(a, b); },
    name: function (a, b) { return text(a, 'name').localeCompare(text(b, 'name'), 'en', { sensitivity: 'base' }) || bySetNum(a, b); }
  };

  function enhanceGrid() {
    var form = document.querySelector('[data-catalogue-filters]');
    var grid = document.querySelector('[data-catalogue-grid]');
    if (!form || !grid) return;
    var empty = document.querySelector('[data-catalogue-empty]');
    var cards = Array.prototype.slice.call(grid.children);
    var checked = form.querySelector('input[name="condition"]:checked');
    var condition = checked ? checked.value : '';
    function apply() {
      var theme = form.elements.namedItem('theme') ? form.elements.namedItem('theme').value : '';
      var kind = form.elements.namedItem('kind') ? form.elements.namedItem('kind').value : '';
      var sort = form.elements.namedItem('sort') ? form.elements.namedItem('sort').value : 'setNum';
      var order = cards.slice().sort(compare[sort] || bySetNum);
      var shown = 0;
      order.forEach(function (card) {
        var match = (condition === '' || text(card, 'condition') === condition) && (theme === '' || text(card, 'theme') === theme) && (kind === '' || text(card, 'kind') === kind);
        card.hidden = !match;
        if (match) shown += 1;
        grid.appendChild(card);
      });
      if (empty) empty.hidden = shown !== 0;
    }
    form.addEventListener('change', function (event) {
      // The radio just chosen, from the event itself: some browsers update the group after it fires.
      var target = event.target;
      if (target && target.name === 'condition' && target.checked) condition = target.value;
      apply();
    });
    form.addEventListener('submit', function (event) { event.preventDefault(); });
    form.hidden = false;
    apply();
  }

  function enhanceGalleries() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-gallery]'), function (gallery) {
      var track = gallery.querySelector('[data-gallery-track]');
      var arrows = gallery.querySelector('[data-gallery-arrows]');
      if (!track || !arrows) return;
      function step(direction) {
        var width = track.clientWidth || 1;
        var count = track.children.length;
        var current = Math.round(track.scrollLeft / width);
        var next = Math.max(0, Math.min(count - 1, current + direction));
        if (typeof track.scrollTo === 'function') track.scrollTo({ left: next * width });
        else track.scrollLeft = next * width;
      }
      gallery.querySelector('[data-gallery-prev]').addEventListener('click', function () { step(-1); });
      gallery.querySelector('[data-gallery-next]').addEventListener('click', function () { step(1); });
      arrows.hidden = false;
    });
  }

  function start() { enhanceGrid(); enhanceGalleries(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;
