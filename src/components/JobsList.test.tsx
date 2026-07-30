import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { JobsList } from './JobsList';
import type { ScenarioRunState } from '../types/api';

vi.mock('../hooks/useRole', () => ({
  useRole: () => ({ isAdmin: false }),
}));

vi.mock('../hooks/useActiveRunsPoller', () => ({
  useActiveRunsPoller: () => ({ activeRuns: null, loading: false, error: null }),
}));

const noopSet = new Set<string>();
const noop = () => {};
const noopAsync = async () => {};

const defaultProps = {
  scenarioRuns: [] as ScenarioRunState[],
  expandedRunIds: noopSet,
  expandedJobIds: noopSet,
  pausedPollingRunIds: noopSet,
  onToggleRunAccordion: noop,
  onToggleJobAccordion: noop,
  onDeleteScenarioRun: noopAsync,
  onDeleteJob: noopAsync,
  onCreateJob: noop,
  onRefreshScenarioRun: noop,
  onNavigateToStudio: noop,
  graphRuns: [],
  expandedGraphRunIds: noopSet,
  pausedGraphPollingIds: noopSet,
  onToggleGraphRunAccordion: noop,
  onDeleteGraphRun: noopAsync,
};

function makeScenarioRun(
  name: string,
  phase: string,
  jobs: { total: number; succeeded: number; failed: number } = { total: 1, succeeded: 0, failed: 0 },
): ScenarioRunState {
  return {
    scenarioRunName: name,
    phase,
    totalTargets: jobs.total,
    successfulJobs: jobs.succeeded,
    failedJobs: jobs.failed,
    runningJobs: 0,
    clusterJobs: [],
    scenarios: [],
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as ScenarioRunState;
}

describe('JobsList', () => {
  it('does not render JobStatsSummary when there are no runs', () => {
    render(<JobsList {...defaultProps} />);
    expect(screen.getByText('No Scenario Runs')).toBeInTheDocument();
    expect(screen.queryByText('Total Jobs')).not.toBeInTheDocument();
  });

  it('renders JobStatsSummary when scenarioRuns are present', () => {
    const runs = [
      makeScenarioRun('run-1', 'Succeeded', { total: 3, succeeded: 3, failed: 0 }),
      makeScenarioRun('run-2', 'Failed', { total: 2, succeeded: 0, failed: 2 }),
    ];
    render(<JobsList {...defaultProps} scenarioRuns={runs} />);
    expect(screen.getByText('Total Jobs')).toBeInTheDocument();
    expect(screen.getByText('Pass Rate')).toBeInTheDocument();
    expect(screen.getByText('60.0%')).toBeInTheDocument();
  });
});
