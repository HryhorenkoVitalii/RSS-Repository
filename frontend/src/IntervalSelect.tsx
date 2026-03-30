import { useId } from 'react';

const PRESETS: { sec: number; label: string }[] = [
  { sec: 300, label: '5 min' },
  { sec: 600, label: '10 min' },
  { sec: 900, label: '15 min' },
  { sec: 1800, label: '30 min' },
  { sec: 3600, label: '1 h' },
  { sec: 7200, label: '2 h' },
  { sec: 21600, label: '6 h' },
  { sec: 86400, label: '24 h' },
];

/** Map a DB interval to the closest preset (UI only allows presets). */
export function snapToNearestPreset(sec: number): number {
  if (!Number.isFinite(sec)) return PRESETS[0].sec;
  const exact = PRESETS.find((p) => p.sec === sec);
  if (exact) return sec;
  return PRESETS.reduce((best, p) =>
    Math.abs(p.sec - sec) < Math.abs(best.sec - sec) ? p : best,
  ).sec;
}

type Props = {
  value: number;
  onChange: (seconds: number) => void;
  id?: string;
};

export function IntervalSelect({ value, onChange, id: idProp }: Props) {
  const genId = useId();
  const id = idProp ?? genId;
  const selectValue = snapToNearestPreset(value);

  return (
    <select
      id={id}
      value={selectValue}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {PRESETS.map((p) => (
        <option key={p.sec} value={p.sec}>
          {p.label} ({p.sec}s)
        </option>
      ))}
    </select>
  );
}
