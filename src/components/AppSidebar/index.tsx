import { useState } from 'react';
import { SidebarPFNav } from './SidebarPFNav';
import type { SidebarNavProps } from './types';
import './AppSidebar.css';

export { SIDEBAR_VARIANT, SIDEBAR_RAIL_WIDTH } from './types';
export type { SidebarNavProps } from './types';

/** Props the wrapper needs on top of the nav props. */
type AppSidebarProps = Omit<SidebarNavProps, 'expanded'> & {
  /** When pinned, the sidebar stays expanded regardless of hover. */
  pinned: boolean;
};

/**
 * AppSidebar — fixed-position overlay sidebar wrapper.
 *
 * Owns the collapse/expand behaviour (expand on hover, or stay expanded when
 * pinned) and delegates the menu chrome to the PatternFly Nav variant. Rendered
 * as a fixed overlay so expanding floats over content instead of compressing it.
 */
export function AppSidebar({ pinned, ...navProps }: AppSidebarProps) {
  const [hovered, setHovered] = useState(false);
  const expanded = pinned || hovered;

  return (
    <div
      className={`app-sidebar ${expanded ? 'app-sidebar--expanded' : 'app-sidebar--collapsed'}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="app-sidebar__inner">
        <SidebarPFNav {...navProps} expanded={expanded} />
      </div>
    </div>
  );
}
