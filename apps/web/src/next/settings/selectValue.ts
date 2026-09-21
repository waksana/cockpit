// A native ID equal to the placeholder must still remain a distinct selection.
export const selectValue = (value: string | undefined) => value ? `value:${value}` : 'unspecified';
export const readSelectValue = (value: string) => value === 'unspecified' ? undefined : value.slice(6);
