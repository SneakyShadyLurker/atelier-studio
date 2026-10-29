import type { Ratio } from '@atelier/shared';
import { useMemo } from 'react';
import { ratioDefinitions } from '../../lib/ratios';
import ChipSelect, { type ChipSelectOption } from './ChipSelect';

interface RatioChipProps {
  supportedRatios: readonly Ratio[];
  value: Ratio;
  disabled?: boolean;
  tip?: string;
  onChange: (ratio: Ratio) => void;
}

const IG_RATIOS: ReadonlySet<Ratio> = new Set(['4:5', '9:16']);

export default function RatioChip({ supportedRatios, value, disabled = false, tip, onChange }: RatioChipProps) {
  const options = useMemo<readonly ChipSelectOption<Ratio>[]>(() => {
    const supported = ratioDefinitions.filter((ratio) => supportedRatios.includes(ratio.id));
    const ig: ChipSelectOption<Ratio>[] = supported
      .filter((ratio) => IG_RATIOS.has(ratio.id))
      .map((ratio) => ({
        value: ratio.id,
        label: ratio.id,
        hint: ratio.label,
        group: 'ig',
        groupLabel: '',
      }));
    const rest: ChipSelectOption<Ratio>[] = supported
      .filter((ratio) => !IG_RATIOS.has(ratio.id))
      .map((ratio) => ({
        value: ratio.id,
        label: ratio.id,
        hint: ratio.label,
      }));
    return [...ig, ...rest];
  }, [supportedRatios]);

  return (
    <ChipSelect<Ratio>
      ariaLabel="Ratio"
      valueDisplay={value}
      valueTitle={ratioDefinitions.find((ratio) => ratio.id === value)?.label ?? value}
      options={options}
      value={value}
      disabled={disabled}
      {...(tip !== undefined ? { tip } : {})}
      onChange={onChange}
    />
  );
}
