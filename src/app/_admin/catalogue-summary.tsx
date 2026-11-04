/**
 * The printable catalogue's content (`/admin/summary`, #236, #255, [EXP-5]): a pure presentational
 * component of the catalogue's data alone, `PublicCatalogueData` as the projection makes it, so
 * `[PUB-4]`'s canary test renders it to a string under every combination of the settings.
 *
 * First the summary: the two texts, the items per segment, the loose parts' lots and parts, and
 * the values, totals and asking prices only where the data holds them; when it was made, and that
 * it shows the catalogue as a publish would make it now. Then every item the data holds, grouped
 * by segment as the catalogue groups them, each with its public facts and its value only where the
 * data holds one. The loose parts are a count line, never rows.
 *
 * An item with a photo shows its cover thumbnail through the admin's cover route, which names only
 * the item's id (`coverPath`): never a stored key, never one of the data's photo paths (random
 * names no file is written under), never the token, which the data does not hold. An item without
 * a photo shows no image at all. The images load eagerly, so a print never catches one unloaded.
 */
import type { PublicCatalogueData, PublicItem } from '../../server/publish/catalogue-data';
import { catalogueSections, fileSafe, fileStamp, summaryFigures } from '../../server/export/summary';
import { en } from '../messages/en';

/** The admin route that answers an item's cover thumbnail (`src/app/admin/api/photos/covers/[itemId]/route.ts`). */
export function coverPath(itemId: string): string {
  return `/admin/api/photos/covers/${encodeURIComponent(itemId)}`;
}

/**
 * The page's document title, which browsers name a saved PDF after (#255): such as
 * `Plinthos – catalogue – 2026-11-03 22.09`, with the time in UTC. The catalogue's title falls back
 * to the app's name; the settings hold no title yet.
 */
export function printDocumentTitle(madeAt: string, title: string = en.app.name): string {
  return en.summary.documentTitle(fileSafe(title, en.app.name), fileStamp(madeAt));
}

/** The item's name as the catalogue writes it: a set's number and name, or a non-set's own name. */
function itemName(item: PublicItem): string {
  return item.setNum === null ? item.name : `${item.setNum} ${item.name}`;
}

/** The item's facts, each left out when the data has none: kind, reference, year, condition, complete, instructions, quantity. */
function itemFacts(item: PublicItem): string[] {
  const m = en.summary;
  return [
    item.kind === 'SET' ? null : en.items.kind[item.kind],
    item.refNo,
    item.year === null ? null : String(item.year),
    en.condition[item.condition],
    item.complete === null ? null : item.complete ? m.complete : item.missingNotes === null ? m.incomplete : m.missing(item.missingNotes),
    item.hasInstructions === null ? null : item.hasInstructions ? m.instructions : m.noInstructions,
    item.quantity === 1 ? null : m.quantity(item.quantity),
  ].filter((fact): fact is string => fact !== null && fact !== '');
}

function ItemRow({ item, amount }: { readonly item: PublicItem; readonly amount: (value: number | undefined) => string }) {
  const name = itemName(item);
  return (
    <li className="print-item">
      {item.photos.length === 0 ? null : (
        // A plain img, never the image optimizer, and eager, so it is loaded before the page prints.
        <img className="print-item__photo" src={coverPath(item.id)} alt={en.summary.coverAlt(name)} width={48} height={48} loading="eager" decoding="sync" referrerPolicy="no-referrer" />
      )}
      <div className="print-item__text">
        <span className="print-item__name">{name}</span>
        <span className="print-item__facts">{itemFacts(item).join(' · ')}</span>
      </div>
      {item.value === undefined ? null : <span className="print-item__value">{amount(item.value)}</span>}
    </li>
  );
}

export function CatalogueSummary({ data }: { readonly data: PublicCatalogueData }) {
  const m = en.summary;
  const figures = summaryFigures(data);
  const sections = catalogueSections(data);
  const currency = figures.currency;
  const amount = (value: number | undefined) => (value === undefined || currency === undefined ? '' : m.money(value, currency));
  const valued = currency !== undefined && (figures.total !== undefined || figures.segments.some((segment) => segment.value !== undefined));
  const asked = currency !== undefined && (figures.askingTotal !== undefined || figures.segments.some((segment) => segment.asking !== undefined));
  return (
    <article className="summary" aria-label={m.title}>
      <div className="summary__part">
        <h2 className="summary__title print-only">{en.app.name}</h2>
        <p className="muted">
          {m.madeAt(data.publishedAt)} {m.asPublished}
        </p>
        {data.introText.trim() === '' ? null : (
          <section className="summary__text" aria-label={m.intro}>
            <h3>{m.intro}</h3>
            <p>{data.introText}</p>
          </section>
        )}
        <section aria-label={m.contents}>
          <h3>{m.contents}</h3>
          {figures.segments.length === 0 ? (
            <p>{m.empty}</p>
          ) : (
            <table className="summary__table">
              <thead>
                <tr>
                  <th scope="col">{m.segmentHeader}</th>
                  <th scope="col">{m.itemsHeader}</th>
                  {valued ? <th scope="col">{m.valueHeader}</th> : null}
                  {asked ? <th scope="col">{m.askingHeader}</th> : null}
                </tr>
              </thead>
              <tbody>
                {figures.segments.map((segment) => (
                  <tr key={segment.segment}>
                    <th scope="row">{m.segment[segment.segment]}</th>
                    <td>
                      {segment.items > 0 || segment.segment !== 'parts' ? <span className="summary__line">{m.items(segment.items, segment.units)}</span> : null}
                      {segment.segment === 'parts' && figures.parts !== null ? <span className="summary__line">{m.parts(figures.parts.lots, figures.parts.quantity)}</span> : null}
                    </td>
                    {valued ? <td className="summary__number">{amount(segment.value)}</td> : null}
                    {asked ? <td className="summary__number">{amount(segment.asking)}</td> : null}
                  </tr>
                ))}
                {valued || asked ? (
                  <tr className="summary__total">
                    <th scope="row">{m.all}</th>
                    <td />
                    {valued ? <td className="summary__number">{amount(figures.total)}</td> : null}
                    {asked ? <td className="summary__number">{amount(figures.askingTotal)}</td> : null}
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </section>
        {data.contactText.trim() === '' ? null : (
          <section className="summary__text" aria-label={m.contact}>
            <h3>{m.contact}</h3>
            <p>{data.contactText}</p>
          </section>
        )}
      </div>
      {sections.length === 0 ? null : (
        <section className="print-list" aria-label={m.list}>
          <h3 className="print-list__heading">{m.list}</h3>
          {sections.map((section) => (
            <section key={section.segment} className="print-list__segment" aria-label={m.segment[section.segment]}>
              <h4>{m.segment[section.segment]}</h4>
              {section.items.length === 0 ? null : (
                <ul className="print-list__items">
                  {section.items.map((item) => (
                    <ItemRow key={item.id} item={item} amount={amount} />
                  ))}
                </ul>
              )}
              {section.parts === null ? null : <p className="print-list__parts">{m.parts(section.parts.lots, section.parts.quantity)}</p>}
            </section>
          ))}
        </section>
      )}
    </article>
  );
}
