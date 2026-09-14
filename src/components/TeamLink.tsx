import type { ReactNode } from 'react';
import { isTeamPageId, linkClick, pathFor, type Route } from '../app/router';

/** A link to a team's page, or the plain content when the provider's team id has no page. */
export function TeamLink({ teamKey, className = '', label, children }: { teamKey: string; className?: string; label?: string; children: ReactNode }) {
  if (!isTeamPageId(teamKey)) return <>{children}</>;
  const route: Route = { name: 'team', id: teamKey };
  return (
    <a className={`team-link ${className}`} href={pathFor(route)} onClick={linkClick(route)} aria-label={label}>
      {children}
    </a>
  );
}
