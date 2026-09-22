import type { ActivityIndicator } from '../lib/sessionActivity';
import { Icon } from './Icon';

export function SessionActivity({ items }: { items: readonly ActivityIndicator[] }) {
  return <span className="session-activity">
    {items.map(item => <span key={item.key} className="session-activity-item"
      data-activity={item.key} role="img" aria-label={item.label} title={item.label}>
      <Icon name={item.icon} size={16} />
      {(item.count !== undefined || item.text) && <span aria-hidden="true">{item.count ?? item.text}</span>}
    </span>)}
  </span>;
}
