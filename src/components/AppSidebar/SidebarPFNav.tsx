import { Nav, NavItem, NavList, NavExpandable } from '@patternfly/react-core';
import { CogIcon, TerminalIcon, PlayIcon, FolderIcon, EditIcon, KeyIcon, MoonIcon, SunIcon, PowerOffIcon, UserIcon } from '@patternfly/react-icons';
import { MdWork } from 'react-icons/md';
import { PiFlaskFill } from 'react-icons/pi';
import type { ReactNode } from 'react';
import type { SidebarNavProps } from './types';
import './SidebarPFNav.css';

/**
 * SidebarPFNav — sidebar variant built with PatternFly's native Nav.
 *
 * No extra dependency; inherits PatternFly theming/dark-mode. When collapsed,
 * CSS hides the labels leaving an icon rail; expanding reveals the labels.
 */
export function SidebarPFNav({
  activePhase,
  expanded,
  isAdmin,
  userName,
  isDarkTheme,
  onNavigateJobs,
  onRunScenario,
  onNavigateStudio,
  onOpenFiles,
  onNavigateTerminal,
  onNavigateSettings,
  onEditProfile,
  onChangePassword,
  onToggleTheme,
  onLogout,
}: SidebarNavProps) {
  const item = (icon: ReactNode, label: string) => (
    <span className="pf-sidebar__item">
      <span className="pf-sidebar__icon">{icon}</span>
      <span className="pf-sidebar__label">{label}</span>
    </span>
  );

  return (
    <div className={`pf-sidebar ${expanded ? 'pf-sidebar--expanded' : 'pf-sidebar--collapsed'}`}>
      <Nav aria-label="Primary navigation">
        <NavList>
          <NavItem isActive={activePhase === 'jobs_list'} onClick={onNavigateJobs}>
            {item(<MdWork />, 'Jobs')}
          </NavItem>
          <NavItem onClick={onRunScenario}>{item(<PlayIcon />, 'Run Scenario')}</NavItem>
          <NavItem isActive={activePhase === 'studio'} onClick={onNavigateStudio}>
            {item(<PiFlaskFill />, 'Chaos Studio')}
          </NavItem>
          <NavItem onClick={onOpenFiles}>{item(<FolderIcon />, 'Files')}</NavItem>
          <NavItem isActive={activePhase === 'terminal'} onClick={onNavigateTerminal}>
            {item(<TerminalIcon />, 'Terminal')}
          </NavItem>
          {isAdmin && (
            <NavItem isActive={activePhase === 'settings'} onClick={onNavigateSettings}>
              {item(<CogIcon />, 'Settings')}
            </NavItem>
          )}
        </NavList>
      </Nav>

      <div className="app-sidebar__spacer" />

      <Nav aria-label="Account">
        <NavList>
          <NavExpandable title={userName || 'Account'} srText="Account menu">
            <NavItem onClick={onEditProfile}>{item(<EditIcon />, 'Edit Profile')}</NavItem>
            <NavItem onClick={onChangePassword}>{item(<KeyIcon />, 'Change Password')}</NavItem>
            <NavItem onClick={onToggleTheme}>
              {item(isDarkTheme ? <SunIcon /> : <MoonIcon />, isDarkTheme ? 'Light Theme' : 'Dark Theme')}
            </NavItem>
            <NavItem onClick={onLogout}>{item(<PowerOffIcon />, 'Logout')}</NavItem>
          </NavExpandable>
        </NavList>
      </Nav>

      {/* Collapsed rail shows a user glyph in place of the expandable account menu */}
      <div className="pf-sidebar__collapsed-user">
        <UserIcon />
      </div>
    </div>
  );
}
