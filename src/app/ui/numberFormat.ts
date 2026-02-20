const formatterCache = new Map<number, Intl.NumberFormat>();

const getFormatter = (digits: number) => {
  const safeDigits = Math.max(1, Math.floor(digits));
  const existing = formatterCache.get(safeDigits);
  if (existing) return existing;
  const formatter = new Intl.NumberFormat("en-US", {
    useGrouping: false,
    minimumSignificantDigits: 1,
    maximumSignificantDigits: safeDigits,
  });
  formatterCache.set(safeDigits, formatter);
  return formatter;
};

export function formatSignificant(value: number, digits = 3) {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1e-12) return "0";
  return getFormatter(digits).format(value);
}
