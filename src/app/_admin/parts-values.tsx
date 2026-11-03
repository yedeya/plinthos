/**
 * The loose parts' values on `/admin/parts` (#229, [VAL-6], [VAL-11]), private to the admin and
 * rendered on the server: the parts' value by source (BrickLink, the file, none), and the lots,
 * `PARTS_PAGE_SIZE` to a page, each with its item type, item number, colour id, condition,
 * quantity, unit price, value, source and, for a BrickLink price, its date. A plain module, not a
 * client one: the page calls nothing of it but the component.
 */
import { en } from '../messages/en';
import type { PartsLotRow, PartsLotsPage } from './value-data';

/** The parts page's path, which the page links carry their `?page=` on. */
const PARTS_PATH = '/admin/parts';

function unitPriceText(lot: PartsLotRow, currency: string, fileCurrency: string | null): string {
  const m = en.parts;
  if (lot.value !== null) return m.unitPrice(lot.value.unitPrice, currency);
  // A file price in another currency values nothing, but the owner sees it is there.
  if (lot.unitPrice !== null && fileCurrency !== null) return m.fileOnly(lot.unitPrice, fileCurrency);
  return m.noPrice;
}

function sourceText(lot: PartsLotRow): string {
  const m = en.parts;
  if (lot.value === null) return m.source.none;
  if (lot.value.source === 'bricklink' && lot.value.asOf !== null) return m.source.bricklink(lot.value.asOf);
  return m.source.file;
}

/** The parts' value by source and one page of the lots ([VAL-11]). */
export function PartsValues({ values }: { readonly values: PartsLotsPage }) {
  const m = en.parts;
  const { value, lots, page, pages, fileCurrency } = values;
  return (
    <section className="section" aria-label={m.valueLabel}>
      <h2>{m.valueLabel}</h2>
      <p>
        <strong>{m.valueTotal(value.amount, value.currency)}</strong>
      </p>
      <p>{m.bySource(value.fromBrickLink, value.fromFile, value.none)}</p>
      <p className="muted">{m.valueHint}</p>
      <h3>{m.lotsLabel}</h3>
      {lots.length === 0 ? (
        <p className="muted">{m.lotsEmpty}</p>
      ) : (
        <div className="lot-table">
          <table>
            <thead>
              <tr>
                <th scope="col">{m.column.type}</th>
                <th scope="col">{m.column.number}</th>
                <th scope="col">{m.column.color}</th>
                <th scope="col">{m.column.condition}</th>
                <th scope="col" className="lot-table__number">
                  {m.column.quantity}
                </th>
                <th scope="col" className="lot-table__number">
                  {m.column.unitPrice}
                </th>
                <th scope="col" className="lot-table__number">
                  {m.column.value}
                </th>
                <th scope="col">{m.column.source}</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <tr key={lot.id} data-source={lot.value?.source ?? 'none'}>
                  <td>{lot.itemType}</td>
                  <td>{lot.itemNo}</td>
                  <td>{lot.colorId}</td>
                  <td>{m.lotCondition[lot.lotCondition]}</td>
                  <td className="lot-table__number">{lot.lotQuantity.toLocaleString('en')}</td>
                  <td className="lot-table__number">{unitPriceText(lot, value.currency, fileCurrency)}</td>
                  <td className="lot-table__number">{lot.value === null ? m.noPrice : m.lotValue(lot.value.amount, value.currency)}</td>
                  <td>{sourceText(lot)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages <= 1 ? null : (
        <nav className="footer__actions" aria-label={m.pagesLabel}>
          {page > 1 ? (
            <a className="button button--link" href={`${PARTS_PATH}?page=${page - 1}`} rel="prev">
              {m.previous}
            </a>
          ) : null}
          <span className="muted">{m.page(page, pages)}</span>
          {page < pages ? (
            <a className="button button--link" href={`${PARTS_PATH}?page=${page + 1}`} rel="next">
              {m.next}
            </a>
          ) : null}
        </nav>
      )}
    </section>
  );
}
