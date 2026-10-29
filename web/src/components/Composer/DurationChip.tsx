import type { VideoDurationFrames } from '@atelier/shared';
import { useMemo } from 'react';
import { durationDefinitions, durationTitle } from '../../lib/durations';
import ChipSelect, { type ChipSelectOption } from './ChipSelect';

interface DurationChipProps {
  supportedDurations: readonly VideoDurationFrames[];
  value: VideoDurationFrames;
  disabled?: boolean;
  onChange: (frames: VideoDurationFrames) => void;
}

export default function DurationChip({ supportedDurations, value, disabled = false, onChange }: DurationChipProps) {
  const options = useMemo<readonly ChipSelectOption<VideoDurationFrames>[]>(
    () => durationDefinitions
      .filter((duration) => supportedDurations.includes(duration.id))
      .map((duration) => ({
        value: duration.id,
        label: duration.label,
        // The label rounds; the hint carries the length H3's frame grid
        // actually produces, which is what the sampler node receives.
        hint: `${String(duration.id)} frames`,
      })),
    [supportedDurations],
  );

  return (
    <ChipSelect<VideoDurationFrames>
      ariaLabel="Clip length"
      // Degrade, never throw: a server that adds a grid point this bundle has
      // no definition for must not take out the whole composer. Mirrors
      // RatioChip's `?? value` fallback.
      valueDisplay={durationDefinitions.find((duration) => duration.id === value)?.label ?? `${String(value)}f`}
      valueTitle={durationTitle(value)}
      options={options}
      value={value}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
