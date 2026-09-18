import type { DraftSchemaRegistration, DraftSchemaScope, NativeAttachment } from '@cockpit/module-api';

export interface FixtureItem { readonly id: string; readonly value: NativeAttachment }
export interface FixtureData { readonly items: readonly FixtureItem[] }
export const fixtureItem = (id: string, path = id): FixtureItem => ({ id, value: { type: 'file', path: `/fixture/${path}`, displayName: id } });

// Test module-owned data: production drafts do not know this shape.
export function fixtureSchema(overrides: Partial<DraftSchemaRegistration<FixtureData>> = {}): DraftSchemaRegistration<FixtureData> {
  return {
    id: 'fixture-data', purposes: ['prompt'],
    create: () => ({ items: [] }),
    validate(value) {
      if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items)) throw new Error('Invalid fixture schema data');
      return value as FixtureData;
    },
    hasContent: value => value.items.length > 0,
    project: value => value.items.length ? { attachments: value.items.map(item => item.value) } : undefined,
    acknowledge: (current, captured) => ({ items: current.items.filter(item => !captured.items.includes(item)) }),
    persistence: {
      serialize: value => JSON.stringify(value),
      restore(input) {
        if (input.stored.present) {
          if (typeof input.stored.value !== 'string') throw new Error('Invalid fixture serialization');
          return JSON.parse(input.stored.value) as FixtureData;
        }
        const legacy = input.legacyRecord;
        return { items: legacy && typeof legacy === 'object' && 'attachments' in legacy
          ? legacy.attachments as FixtureItem[] : [] };
      },
    },
    ...overrides,
  };
}
export function appendFixture(scope: DraftSchemaScope<FixtureData>, ...items: FixtureItem[]): void {
  scope.update(current => ({ items: [...current.items.filter(item => !items.some(next => next.id === item.id)), ...items] }));
}
export function memoryDraftStorage() {
  const values = new Map<string, string>();
  return { values, storage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } };
}
