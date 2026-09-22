import type { ActivityIndicator } from '../lib/sessionActivity';
import { Icon } from './Icon';

export function SessionActivity({ items, names }: { items: readonly ActivityIndicator[]; names?: Readonly<Record<string, string>> }) {
  return <span className="session-activity">
    {items.map(item => <span key={item.key} className="session-activity-item"
      data-activity={item.key} role="img" aria-label={item.label} title={item.label}>
      <Icon name={item.icon} size={16} className={item.icon === 'loading' ? 'spinner' : undefined} />
      {names?.[item.key] && <span aria-hidden="true">{names[item.key]}</span>}
      {(item.count !== undefined || item.text) && <span aria-hidden="true">{item.count ?? item.text}</span>}
    </span>)}
  </span>;
}
