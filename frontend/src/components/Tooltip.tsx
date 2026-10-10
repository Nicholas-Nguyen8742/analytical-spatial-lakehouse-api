import type { HoverInfo } from '../map/layers';

export interface TooltipProps {
  readonly hover: HoverInfo;
}

const numberFormat = new Intl.NumberFormat('en-US');
const metresFormat = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

/**
 * Hover readout for the picked tract.
 *
 * Offset from the pointer and flipped near the viewport edges so it never slides under
 * the cursor or off-screen.
 */
export function Tooltip({ hover }: TooltipProps) {
  const { properties } = hover.feature;
  const flipX = hover.x > window.innerWidth - 260;
  const flipY = hover.y > window.innerHeight - 160;

  return (
    <div
      className="tooltip"
      role="tooltip"
      style={{
        left: hover.x,
        top: hover.y,
        transform: `translate(${flipX ? 'calc(-100% - 14px)' : '14px'}, ${flipY ? 'calc(-100% - 14px)' : '14px'})`,
      }}
    >
      <p className="tooltip__id">{properties.geoid}</p>
      <dl className="tooltip__stats">
        <div>
          <dt>Buildings</dt>
          <dd>{numberFormat.format(properties.building_count)}</dd>
        </div>
        <div>
          <dt>Mean height</dt>
          <dd>{metresFormat.format(properties.avg_height_m)} m</dd>
        </div>
        <div>
          <dt>p95 height</dt>
          <dd>{metresFormat.format(properties.p95_height_m)} m</dd>
        </div>
      </dl>
    </div>
  );
}
