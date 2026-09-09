import type { ComponentProps } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';

export function InternalLink({ href, ...props }: ComponentProps<'a'> & { href: string }) {
  const routed = useInRouterContext();
  return routed ? <Link to={href} {...props} /> : <a href={href} {...props} />;
}
