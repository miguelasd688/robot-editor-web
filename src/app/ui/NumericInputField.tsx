import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FocusEventHandler,
  type KeyboardEventHandler,
} from "react";

type NumericInputFieldProps = {
  value: number | null | undefined;
  onChange: (value: number) => void;
  onEmpty?: () => void;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  style?: CSSProperties;
  containerStyle?: CSSProperties;
  ariaLabel?: string;
  title?: string;
  warningText?: string;
  warningStyle?: CSSProperties;
  roundTo?: number;
  validationId?: string;
  onValidationChange?: (id: string, valid: boolean) => void;
  autoFocus?: boolean;
  onBlur?: FocusEventHandler<HTMLInputElement>;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  onFocus?: FocusEventHandler<HTMLInputElement>;
};

type NumericValidation =
  | { valid: true; kind: "number"; parsed: number; message: null }
  | { valid: true; kind: "empty"; parsed: null; message: null }
  | { valid: false; kind: "invalid"; parsed: null; message: string };

const PARTIAL_NUMBER_RE = /^-?\d*(?:\.\d*)?$/;
const INCOMPLETE_NUMBER_TOKENS = new Set(["-", ".", "-."]);

export function NumericInputField(props: NumericInputFieldProps) {
  const {
    value,
    onChange,
    onEmpty,
    required = true,
    min,
    max,
    step,
    disabled = false,
    placeholder,
    style,
    containerStyle,
    ariaLabel,
    title,
    warningText,
    warningStyle,
    roundTo = 3,
    validationId,
    onValidationChange,
    autoFocus,
    onBlur,
    onKeyDown,
    onFocus,
  } = props;

  const [text, setText] = useState<string>(() => formatRawValue(value, roundTo));
  const [focused, setFocused] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (focused) return;
    setText(formatRawValue(value, roundTo));
  }, [focused, roundTo, value]);

  const validation = useMemo(
    () => validateNumericText(text, { required, min, max }),
    [max, min, required, text]
  );

  useEffect(() => {
    if (!validationId || !onValidationChange) return;
    onValidationChange(validationId, validation.valid);
  }, [onValidationChange, validation.valid, validationId]);

  useEffect(() => {
    return () => {
      if (!validationId || !onValidationChange) return;
      onValidationChange(validationId, true);
    };
  }, [onValidationChange, validationId]);

  const showWarning = touched && !validation.valid;
  const mergedInputStyle: CSSProperties = showWarning
    ? {
        ...style,
        border: "1px solid rgba(255,120,120,0.64)",
      }
    : { ...style };

  return (
    <div style={{ display: "grid", gap: 4, ...containerStyle }}>
      <input
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        title={title}
        aria-invalid={showWarning}
        autoFocus={autoFocus}
        onFocus={(event) => {
          setFocused(true);
          setTouched(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          setTouched(true);
          const nextValidation = validateNumericText(text, { required, min, max });
          if (nextValidation.valid && nextValidation.kind === "number") {
            setText(formatCompactNumber(nextValidation.parsed, roundTo));
          } else if (nextValidation.valid && nextValidation.kind === "empty") {
            setText("");
          }
          onBlur?.(event);
        }}
        onKeyDown={onKeyDown}
        onChange={(event) => {
          const nextText = event.target.value;
          setText(nextText);
          setTouched(true);
          const nextValidation = validateNumericText(nextText, { required, min, max });
          if (nextValidation.valid && nextValidation.kind === "number") {
            onChange(nextValidation.parsed);
            return;
          }
          if (nextValidation.valid && nextValidation.kind === "empty") {
            onEmpty?.();
          }
        }}
        style={mergedInputStyle}
      />
      {showWarning && (
        <div style={{ fontSize: 10, color: "rgba(255,160,160,0.95)", ...warningStyle }}>
          {warningText || validation.message || "A numeric value is required."}
        </div>
      )}
    </div>
  );
}

export function formatCompactNumber(value: number, roundTo = 3): string {
  if (!Number.isFinite(value)) return "";
  const factor = 10 ** roundTo;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return rounded.toFixed(roundTo).replace(/\.?0+$/, "");
}

function formatRawValue(value: number | null | undefined, roundTo: number): string {
  if (!Number.isFinite(value)) return "";
  return formatCompactNumber(value as number, roundTo);
}

function validateNumericText(
  rawValue: string,
  options: { required: boolean; min?: number; max?: number }
): NumericValidation {
  const min = Number.isFinite(options.min) ? Number(options.min) : null;
  const max = Number.isFinite(options.max) ? Number(options.max) : null;
  const text = String(rawValue ?? "").trim();

  if (!text) {
    if (!options.required) {
      return { valid: true, kind: "empty", parsed: null, message: null };
    }
    return {
      valid: false,
      kind: "invalid",
      parsed: null,
      message: "This field must contain a number.",
    };
  }

  if (!PARTIAL_NUMBER_RE.test(text) || INCOMPLETE_NUMBER_TOKENS.has(text)) {
    return {
      valid: false,
      kind: "invalid",
      parsed: null,
      message: "This field must contain a valid number.",
    };
  }

  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    return {
      valid: false,
      kind: "invalid",
      parsed: null,
      message: "This field must contain a valid number.",
    };
  }

  if (min !== null && parsed < min) {
    return {
      valid: false,
      kind: "invalid",
      parsed: null,
      message: `Value must be at least ${formatCompactNumber(min)}.`,
    };
  }

  if (max !== null && parsed > max) {
    return {
      valid: false,
      kind: "invalid",
      parsed: null,
      message: `Value must be at most ${formatCompactNumber(max)}.`,
    };
  }

  return {
    valid: true,
    kind: "number",
    parsed,
    message: null,
  };
}
