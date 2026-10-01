import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScenarioConfigStep } from './ScenarioConfigStep';
import { operatorApi } from '../../services/operatorApi';
import { elasticsearchApi } from '../../services/elasticsearchApi';
import { cloudCredentialsApi } from '../../services/cloudCredentialsApi';
import type { ScenarioDetail, ScenarioFormValues, TouchedFields } from '../../types/api';

vi.mock('../../services/operatorApi');
vi.mock('../../services/elasticsearchApi');
vi.mock('../../services/cloudCredentialsApi');
vi.mock('../DynamicFormBuilder', () => ({ DynamicFormBuilder: () => null }));
vi.mock('../ScenarioParameterSections', () => ({ ScenarioParameterSections: () => null }));

const makeDetail = (name: string): ScenarioDetail => ({
  name,
  title: `${name} title`,
  description: 'desc',
  digest: 'sha256:abc',
  fields: [
    {
      name: 'namespace',
      variable: 'NAMESPACE',
      short_description: 'ns',
      title: 'Namespace',
      description: 'ns',
      type: 'string',
      required: true,
      default: 'default-ns',
    },
  ],
});

function renderStep(scenarioName: string, registryName = '', overrides: Partial<{
  onLoadStatusChange: (status: 'loading' | 'loaded' | 'error') => void;
  onDefaultValuesLoad: (defaults: ScenarioFormValues) => void;
}> = {}) {
  return render(
    <ScenarioConfigStep
      scenarioName={scenarioName}
      registryName={registryName}
      formValues={{}}
      globalFormValues={{}}
      globalTouchedFields={{} as TouchedFields}
      onFormChange={vi.fn()}
      onGlobalFormChange={vi.fn()}
      onDefaultValuesLoad={overrides.onDefaultValuesLoad ?? vi.fn()}
      onLoadStatusChange={overrides.onLoadStatusChange ?? vi.fn()}
    />,
  );
}

describe('ScenarioConfigStep caching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(elasticsearchApi.listConfigs).mockResolvedValue([]);
    vi.mocked(cloudCredentialsApi.listAvailable).mockResolvedValue([]);
    vi.mocked(operatorApi.getScenarioDetail).mockImplementation(
      async (name: string) => makeDetail(name),
    );
  });

  it('fetches scenario detail on first mount and reports loaded with defaults', async () => {
    const onLoadStatusChange = vi.fn();
    const onDefaultValuesLoad = vi.fn();
    renderStep('fetch-once', '', { onLoadStatusChange, onDefaultValuesLoad });

    await waitFor(() =>
      expect(screen.getByText('fetch-once title')).toBeInTheDocument(),
    );
    expect(operatorApi.getScenarioDetail).toHaveBeenCalledTimes(1);
    expect(onLoadStatusChange).toHaveBeenCalledWith('loaded');
    expect(onDefaultValuesLoad).toHaveBeenCalledWith({ NAMESPACE: 'default-ns' });
  });

  it('does not refetch when remounting with the same scenario and registry', async () => {
    const { unmount } = renderStep('cache-hit', 'corp-registry');
    await waitFor(() =>
      expect(screen.getByText('cache-hit title')).toBeInTheDocument(),
    );
    expect(operatorApi.getScenarioDetail).toHaveBeenCalledTimes(1);
    unmount();

    // Remount simulates returning to the configuration step via the wizard.
    const onLoadStatusChange = vi.fn();
    renderStep('cache-hit', 'corp-registry', { onLoadStatusChange });
    await waitFor(() =>
      expect(screen.getByText('cache-hit title')).toBeInTheDocument(),
    );

    // Still one call — restored from cache, no network.
    expect(operatorApi.getScenarioDetail).toHaveBeenCalledTimes(1);
    expect(onLoadStatusChange).toHaveBeenCalledWith('loaded');
  });

  it('refetches when the scenario changes', async () => {
    const { unmount } = renderStep('scenario-a');
    await waitFor(() =>
      expect(screen.getByText('scenario-a title')).toBeInTheDocument(),
    );
    unmount();

    renderStep('scenario-b');
    await waitFor(() =>
      expect(screen.getByText('scenario-b title')).toBeInTheDocument(),
    );

    expect(operatorApi.getScenarioDetail).toHaveBeenCalledTimes(2);
  });
});
