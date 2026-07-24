import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JobStatsSummary } from './JobStatsSummary';
import type { UnifiedRunItem } from './JobsList';
import type { ScenarioRunPhase } from '../types/api';

function makeScenarioItem(phase: ScenarioRunPhase): UnifiedRunItem {
  return {
    type: 'scenario',
    run: { phase } as import('../types/api').ScenarioRunState,
  };
}

function makeGraphItem(phase: ScenarioRunPhase): UnifiedRunItem {
  return {
    type: 'graph',
    graphRunName: `graph-${phase}`,
    nodes: [],
    phase,
    createdAt: '2026-01-01T00:00:00Z',
    summary: { totalNodes: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0, pendingNodes: 0 },
  };
}

describe('JobStatsSummary', () => {
  it('renders all 4 stat cards with labels', () => {
    render(<JobStatsSummary unifiedRuns={[]} />);
    expect(screen.getByText('Total Jobs')).toBeInTheDocument();
    expect(screen.getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Pass Rate')).toBeInTheDocument();
  });

  it('renders sub-text descriptions in card footers', () => {
    render(<JobStatsSummary unifiedRuns={[]} />);
    expect(screen.getByText('Total number of jobs across all scenario runs')).toBeInTheDocument();
    expect(screen.getByText('Exit code 0')).toBeInTheDocument();
    expect(screen.getByText('Non-zero or unknown exit')).toBeInTheDocument();
    expect(screen.getByText('Percentage of jobs that succeeded')).toBeInTheDocument();
  });

  it('shows all zeros and N/A when empty', () => {
    render(<JobStatsSummary unifiedRuns={[]} />);
    const zeros = screen.getAllByText('0');
    expect(zeros).toHaveLength(3);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('counts succeeded correctly', () => {
    const runs = [
      makeScenarioItem('Succeeded'),
      makeScenarioItem('Succeeded'),
      makeScenarioItem('Failed'),
    ];
    render(<JobStatsSummary unifiedRuns={runs} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('66.7%')).toBeInTheDocument();
  });

  it('counts PartiallyFailed as failed', () => {
    const runs = [
      makeScenarioItem('Succeeded'),
      makeScenarioItem('PartiallyFailed'),
    ];
    render(<JobStatsSummary unifiedRuns={runs} />);
    const ones = screen.getAllByText('1');
    expect(ones).toHaveLength(2);
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('handles mixed graph and scenario items', () => {
    const runs = [
      makeGraphItem('Succeeded'),
      makeScenarioItem('Failed'),
      makeGraphItem('Running'),
    ];
    render(<JobStatsSummary unifiedRuns={runs} />);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('33.3%')).toBeInTheDocument();
  });

  it('shows 100% pass rate when all succeeded', () => {
    const runs = [makeScenarioItem('Succeeded'), makeGraphItem('Succeeded')];
    render(<JobStatsSummary unifiedRuns={runs} />);
    expect(screen.getByText('100.0%')).toBeInTheDocument();
  });
});
