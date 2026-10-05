import { Typography } from 'antd';

const { Text } = Typography;

// The Momentum grade's letter badge (services/momentum-grade.ts), shared by the
// Momentum table and the 📐 setups sidebar. Fitted on August, validated on
// September: the chance of a +10% move within 30 min runs ~27% at A+, ~18% A,
// ~11% A−, ~7% B+ and falls to ~0.1% at D. A+ is also where −10% comes first
// most often — it marks where the action is, not which way it breaks.
export const GRADE_STYLE: Record<string, { color: string; bg: string }> = {
  'A+': { color: '#d9f7be', bg: '#237804' },
  'A':  { color: '#b7eb8f', bg: '#135200' },
  'A-': { color: '#95de64', bg: '#162312' },
  'B+': { color: '#fff1b8', bg: '#614700' },
  'B':  { color: '#ffe58f', bg: '#3d2f00' },
  'B-': { color: '#d4b106', bg: '#2b2111' },
  'C':  { color: '#8c8c8c', bg: 'transparent' },
  'D':  { color: '#595959', bg: 'transparent' },
};

// A capped (faded) grade gets a red ▼ with how far the name sits below its
// 10-minute high — "this was A-tier, but it is dumping" (the LONA case).
export function GradeCell({ grade, faded, offHigh }: { grade: string | null | undefined; faded?: boolean; offHigh?: number | null }) {
  if (!grade) return <Text type="secondary">—</Text>;
  const s = GRADE_STYLE[grade] ?? GRADE_STYLE.D;
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <span
        style={{
          display: 'inline-block', minWidth: 28, padding: '0 5px', borderRadius: 3,
          textAlign: 'center', fontWeight: 700, fontSize: 12, lineHeight: '18px',
          color: s.color, background: s.bg,
        }}
      >
        {grade.replace('-', '\u2212')}
      </span>
      {faded && (
        <span style={{ color: '#ff4d4f', fontSize: 10, fontWeight: 700, marginLeft: 3 }}>
          ▼{offHigh != null ? Math.round(Math.abs(offHigh)) : ''}
        </span>
      )}
    </span>
  );
}
