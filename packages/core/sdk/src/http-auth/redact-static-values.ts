export const REDACTED_STATIC_VALUE = "[redacted]";

export const redactStaticValues = (
  values: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined =>
  values === undefined
    ? undefined
    : Object.fromEntries(Object.keys(values).map((key) => [key, REDACTED_STATIC_VALUE]));
