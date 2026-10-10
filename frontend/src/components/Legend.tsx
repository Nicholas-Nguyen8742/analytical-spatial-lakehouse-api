import { RAMP, bucketLabels } from '../lib/colorScale';

export interface LegendProps {
  readonly breaks: readonly number[];
  readonly metric: string;
}

/**
 * Quantile legend.
 *
 * Labels are derived from the same `breaks` array the colour accessor uses, so the
 * legend cannot drift from what is actually rendered.
 */
export function Legend({ breaks, metric }: LegendProps) {
  const labels = bucketLabels(breaks);

  return (
    <section className="legend" aria-label={`${metric} legend`}>
      <h3 className="legend__title">{metric}</h3>
      <ul className="legend__list">
        {RAMP.map((color, index) => (
          <li className="legend__row" key={`${color.join('-')}-${index}`}>
            <span
              className="legend__swatch"
              style={{ backgroundColor: `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${color[3] / 255})` }}
              aria-hidden="true"
            />
            <span className="legend__label">{labels[index] ?? '—'}</span>
          </li>
        ))}
      </ul>
      <p className="legend__note">Quantile bins — each holds a similar number of tracts.</p>
    </section>
  );
}
