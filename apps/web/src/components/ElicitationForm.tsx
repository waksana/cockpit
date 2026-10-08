import { useId, useState, type ReactNode } from 'react';
import { elicitationOptions, validateElicitationContent, type ElicitationContent, type ElicitationField,
  type ElicitationSchema } from '@cockpit/protocol';
import { Button } from './Button';

export type ElicitationDraft = Record<string, string | string[] | null>;

function initialValue(field: ElicitationField): string | string[] | undefined {
  return field.default === undefined ? undefined : Array.isArray(field.default) ? field.default : String(field.default);
}

function formContent(schema: ElicitationSchema, draft: ElicitationDraft): ElicitationContent {
  const entries = Object.entries(schema.properties).flatMap<[string, ElicitationContent[string]]>(([name, field]) => {
    const value = Object.hasOwn(draft, name) ? draft[name] : initialValue(field);
    if (value === undefined || value === null) {
      if (!schema.required?.includes(name)) return [];
      if (field.type === 'string' && !elicitationOptions(field)) return [[name, '']];
      if (field.type === 'array') return [[name, []]];
      return [];
    }
    if (field.type === 'number' || field.type === 'integer') return value === '' ? [] : [[name, Number(value)]];
    if (field.type === 'boolean') return value === '' ? [] : [[name, value === 'true']];
    return [[name, value]];
  });
  return Object.fromEntries(entries);
}

export function ElicitationForm({ schema, draft, onChange, disabled, onAccept, children }: {
  schema: ElicitationSchema; draft: ElicitationDraft; onChange: (draft: ElicitationDraft) => void;
  disabled: boolean; onAccept: (content: ElicitationContent) => void; children: ReactNode;
}) {
  const id = useId();
  const [error, setError] = useState('');
  return <form className="chat-elicitation-form" noValidate onSubmit={event => {
    event.preventDefault();
    if (disabled) return;
    const content = formContent(schema, draft);
    const result = validateElicitationContent(schema, content);
    if (!result.success) {
      setError(result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      return;
    }
    setError('');
    onAccept(content);
  }}>
    {Object.entries(schema.properties).map(([name, field], index) => {
      const options = elicitationOptions(field);
      const value = Object.hasOwn(draft, name) ? draft[name] : initialValue(field);
      const required = schema.required?.includes(name);
      const descriptionId = `${id}-${index}-description`;
      const props = {
        id: `${id}-${index}`, className: 'ck-input', disabled, 'aria-required': required || undefined,
        'aria-describedby': field.description ? descriptionId : undefined,
      };
      const change = (value: string | string[] | null) => { setError(''); onChange({ ...draft, [name]: value }); };
      return <div className="ui-field" key={name}>
        <label className="ui-field-label" htmlFor={props.id}>{field.title ?? name}{required ? ' *' : ''}</label>
        {field.description && <span className="chat-pending-hint" id={descriptionId}>{field.description}</span>}
        {field.type === 'boolean'
          ? <select {...props} value={value ?? ''} onChange={event => change(event.target.value)}>
            <option value="">请选择</option><option value="true">是</option><option value="false">否</option>
          </select>
          : options
            ? <select {...props} multiple={field.type === 'array'}
              value={field.type === 'array'
                ? options.flatMap((option, index) => Array.isArray(value) && value.includes(option.value) ? [String(index)] : [])
                : value == null ? '' : String(options.findIndex(option => option.value === value))}
              onChange={event => change(field.type === 'array'
                ? Array.from(event.target.options).filter(option => option.selected).map(option => options[Number(option.value)].value)
                : event.target.value === '' ? null : options[Number(event.target.value)].value)}>
              {field.type !== 'array' && <option value="">请选择</option>}
              {options.map((option, index) => <option key={option.value} value={index}>{option.label}</option>)}
            </select>
            : <input {...props} type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
              step={field.type === 'integer' ? 1 : 'any'} value={value ?? ''}
              onChange={event => change(event.target.value)} />}
        {!required && <Button disabled={disabled || value == null} onClick={() => change(null)}
          aria-label={`不提供 ${field.title ?? name}`}>不提供此项</Button>}
      </div>;
    })}
    {error && <div role="alert">{error}</div>}
    <div className="chat-ask-choices">
      <Button type="submit" className="chat-ask-choice" disabled={disabled}>同意</Button>
      {children}
    </div>
  </form>;
}
