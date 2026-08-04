import { useMemo } from 'react';
import {
  Card,
  CardBody,
  CardFooter,
  CardTitle,
} from '@patternfly/react-core';
import {
  CubesIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  TachometerAltIcon,
} from '@patternfly/react-icons';
import type { UnifiedRunItem } from './JobsList';
import type { ClusterJob } from '../types/api';

interface JobStatsSummaryProps {
  unifiedRuns: UnifiedRunItem[];
}

function collectClusterJobs(items: UnifiedRunItem[]): ClusterJob[] {
  return items.flatMap(item =>
    item.type === 'scenario'
      ? item.run.clusterJobs
      : item.nodes.flatMap(node => node.clusterJobs)
  );
}

const statCards = [
  {
    label: 'Total Jobs',
    icon: CubesIcon,
    color: 'var(--pf-v5-global--primary-color--100)',
    subText: 'Total cluster jobs across all runs',
    getValue: (stats: { total: number; succeeded: number; failed: number; passRate: string }) => stats.total,
  },
  {
    label: 'Succeeded',
    icon: CheckCircleIcon,
    color: 'var(--pf-v5-global--success-color--100)',
    subText: "Exit code 0",
    getValue: (stats: { total: number; succeeded: number; failed: number; passRate: string }) => stats.succeeded,
  },
  {
    label: 'Failed',
    icon: ExclamationCircleIcon,
    color: 'var(--pf-v5-global--danger-color--100)',
    subText: "Non-zero or unknown exit",
    getValue: (stats: { total: number; succeeded: number; failed: number; passRate: string }) => stats.failed,
  },
  {
    label: 'Pass Rate',
    icon: TachometerAltIcon,
    color: 'var(--pf-v5-global--primary-color--100)',
    subText: 'Percentage of jobs that succeeded',
    getValue: (stats: { total: number; succeeded: number; failed: number; passRate: string }) => stats.passRate,
  },
] as const;

export function JobStatsSummary({ unifiedRuns }: JobStatsSummaryProps) {
  const stats = useMemo(() => {
    const jobs = collectClusterJobs(unifiedRuns);
    const total = jobs.length;
    const succeeded = jobs.filter(j => j.phase === 'Succeeded').length;
    const failed = jobs.filter(j => j.phase === 'Failed').length;
    const passRate = total > 0 ? ((succeeded / total) * 100).toFixed(1) + '%' : 'N/A';
    return { total, succeeded, failed, passRate };
  }, [unifiedRuns]);

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {statCards.map(card => {
          const Icon = card.icon;
          const value = card.getValue(stats);
          return (
            <Card isCompact isFlat key={card.label} style={{ flex: '1 1 0', minWidth: '140px',}}>
              <CardTitle>
                 <Icon style={{ fontSize: '1.5rem', color: card.color, marginRight: '0.5rem' }} />
                {card.label}</CardTitle>
              <CardBody>
               
                <div style={{ fontSize: '2rem', fontWeight: 'bold' }}>{value}</div>
              </CardBody>
              <CardFooter>{card.subText}</CardFooter>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
