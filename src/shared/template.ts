import type { DataField } from './state'

const FIELD = /\{([A-Za-z0-9_.-]+)\}/g

/** Replace `{field.name}` with the data field's current value. Unknown fields become empty. */
export function renderTemplate(template: string, data: Record<string, DataField>): string {
  return template.replace(FIELD, (_, key: string) => {
    const value = data[key]?.value
    return value === undefined || value === null ? '' : String(value)
  })
}

/** Data fields a template uses. */
export function templateFields(template: string): string[] {
  return [...template.matchAll(FIELD)].map((m) => m[1])
}

/** Field names: letters, digits, dot, dash, underscore; up to 64 characters. */
export function isValidFieldName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name)
}
