import { z } from 'zod';
import { fullFormats } from 'ajv-formats/dist/formats.js';

const labels = { title: z.string().optional(), description: z.string().optional() };
const choices = z.array(z.string()).min(1);
const titledChoices = z.array(z.object({ const: z.string(), title: z.string() }).strict()).min(1)
  .refine(options => new Set(options.map(option => option.const)).size === options.length, 'Duplicate options');
const count = z.number().int().nonnegative();
const fieldName = z.string().refine(name => !['__proto__', 'constructor', 'prototype'].includes(name), 'Unsupported field name');

// Mirror the pinned SDK's flat elicitation schema, never drop unknown constraints.
export const ElicitationField = z.union([
  z.object({ ...labels, type: z.literal('string'), enum: choices,
    enumNames: z.array(z.string()).optional(), default: z.string().optional() }).strict(),
  z.object({ ...labels, type: z.literal('string'), oneOf: titledChoices, default: z.string().optional() }).strict(),
  z.object({ ...labels, type: z.literal('string'), minLength: count.optional(), maxLength: count.optional(),
    format: z.enum(['email', 'uri', 'date', 'date-time']).optional(), default: z.string().optional() }).strict(),
  z.object({ ...labels, type: z.enum(['number', 'integer']), minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(), default: z.number().finite().optional() }).strict(),
  z.object({ ...labels, type: z.literal('boolean'), default: z.boolean().optional() }).strict(),
  z.object({ ...labels, type: z.literal('array'), minItems: count.optional(), maxItems: count.optional(),
    items: z.union([
      z.object({ type: z.literal('string'), enum: choices }).strict(),
      z.object({ anyOf: titledChoices }).strict(),
    ]), default: z.array(z.string()).optional() }).strict(),
]);
export type ElicitationField = z.infer<typeof ElicitationField>;
export const ElicitationSchema = z.object({
  type: z.literal('object'),
  properties: z.record(fieldName, ElicitationField),
  required: z.array(z.string()).optional(),
  additionalProperties: z.literal(false).optional(),
  $schema: z.enum(['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#']).optional(),
}).strict().superRefine((schema, ctx) => {
  for (const key of [...Object.keys(schema.properties), ...schema.required ?? []]) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(schema.properties, key)) {
      ctx.addIssue({ code: 'custom', message: 'Unsupported or unknown field name', path: ['properties', key] });
    }
  }
});
export type ElicitationSchema = z.infer<typeof ElicitationSchema>;
export const ElicitationContent = z.record(z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]));
export type ElicitationContent = z.infer<typeof ElicitationContent>;

export function elicitationOptions(field: ElicitationField): { value: string; label: string }[] | undefined {
  if (field.type === 'array') {
    return 'enum' in field.items
      ? field.items.enum.map(value => ({ value, label: value }))
      : field.items.anyOf.map(option => ({ value: option.const, label: option.title }));
  }
  if ('enum' in field) return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  if ('oneOf' in field) return field.oneOf.map(option => ({ value: option.const, label: option.title }));
  return undefined;
}

function isStringFormat(format: typeof fullFormats.email): format is {
  type?: 'string'; async?: false; validate: (value: string) => boolean;
} {
  return typeof format === 'object' && 'validate' in format && format.type !== 'number'
    && !format.async && typeof format.validate === 'function';
}

function fieldValidator(field: ElicitationField): z.ZodTypeAny {
  const options = elicitationOptions(field);
  if (field.type === 'array') {
    let validator = z.array(z.string().refine(value => !!options?.some(option => option.value === value), 'Not an offered option'));
    if (field.minItems !== undefined) validator = validator.min(field.minItems);
    if (field.maxItems !== undefined) validator = validator.max(field.maxItems);
    return validator.refine(values => new Set(values).size === values.length, 'Duplicate selections');
  }
  if (field.type === 'boolean') return z.boolean();
  if (field.type === 'number' || field.type === 'integer') {
    let validator = z.number().finite();
    if (field.type === 'integer') validator = validator.int();
    if (field.minimum !== undefined) validator = validator.min(field.minimum);
    if (field.maximum !== undefined) validator = validator.max(field.maximum);
    return validator;
  }
  if (options) return z.string().refine(value => options.some(option => option.value === value), 'Not an offered option');
  // JSON Schema lengths count Unicode code points, not UTF-16 code units.
  const validator = z.string().superRefine((value, ctx) => {
    const length = [...value].length;
    if ('minLength' in field && field.minLength !== undefined && length < field.minLength) {
      ctx.addIssue({ code: 'custom', message: `Must have at least ${field.minLength} characters` });
    }
    if ('maxLength' in field && field.maxLength !== undefined && length > field.maxLength) {
      ctx.addIssue({ code: 'custom', message: `Must have at most ${field.maxLength} characters` });
    }
  });
  if ('format' in field && field.format) {
    const name = field.format;
    return validator.refine(value => {
      // Use MCP's format rules directly, without runtime schema compilation in the browser.
      const format = fullFormats[name];
      if (format instanceof RegExp) return format.test(value);
      if (typeof format === 'function') return format(value);
      if (isStringFormat(format)) return format.validate(value);
      throw new Error(`Unsupported string format validator: ${name}`);
    }, `Invalid ${name}`);
  }
  return validator;
}

export function validateElicitationContent(schema: ElicitationSchema, content: unknown) {
  const required = new Set(schema.required);
  const shape = Object.fromEntries(Object.entries(schema.properties).map(([name, field]) => {
    const validator = fieldValidator(field);
    return [name, required.has(name) ? validator : validator.optional()];
  }));
  return z.object(shape).strict().safeParse(content);
}
