/**
 * The printable summary's content (`/admin/summary`, #236, [EXP-5]): a pure presentational
 * component of the catalogue's data alone, `PublicCatalogueData` as the projection makes it, so
 * `[PUB-4]`'s canary test renders it to a string under every combination of the settings. It
 * shows the two texts, the items per segment, the loose parts' lots and parts, and the values,
 * totals and asking prices only where the data holds them; when it was made, and that it shows
 * the catalogue as a publish would make it now. Never a photo, a link or the token: the data holds
 * no token, and this names none of its photo paths.
 */
import type { PublicCatalogueData } from '../../server/publish/catalogue-data';
import { summaryFigures } from '../../server/export/summary';
import { en } from '../messages/en';

export function CatalogueSummary({ data }: { readonly data: PublicCatalogueData }) {
  const m = en.summary;
  const figures = summaryFigures(data);
  const currency = figures.currency;
  const amount = (value: number | undefined) => (value === undefined || currency === undefined ? '' : m.money(value, currency));
  const valued = currency !== undefined && (figures.total !== undefined || figures.segments.some((segment) => segment.value !== undefined));
  const asked = currency !== undefined && (figures.askingTotal !== undefined || figures.segments.some((segment) => segment.asking !== undefined));
  return (
    <article className="summary" aria-label={m.title}>
      <h2 className="summary__title print-only">{m.title}</h2>
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
    </article>
  );
}
