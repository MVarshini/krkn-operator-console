import { describe, it, expect } from 'vitest';
import { parseImportedWorkflow, reconstructWorkflowFromGraph, buildStudioExport } from './studioImport';
import type { StudioWorkflow, GraphScenarioNode } from '../../types/api';

/** A small, fully-configured studio workflow used across the lossless tests. */
const sampleWorkflow: StudioWorkflow = {
  nodes: [
    {
      nodeId: 'node-alpha',
      status: 'configured',
      position: { x: 100, y: 200 },
      config: {
        registryType: 'public',
        registryConfig: {},
        scenarioName: 'pod-scenarios',
        scenarioImage: 'quay.io/krkn/pod-scenarios:latest',
        scenarioFormValues: { NAMESPACE: 'default' },
      },
    },
    {
      nodeId: 'node-beta',
      status: 'configured',
      position: { x: 400, y: 200 },
      config: {
        registryType: 'public',
        registryConfig: {},
        scenarioName: 'node-cpu-hog',
        scenarioImage: 'quay.io/krkn/node-cpu-hog:latest',
        scenarioFormValues: { DURATION: '60' },
      },
    },
  ],
  edges: [{ id: 'node-alpha-node-beta', source: 'node-alpha', target: 'node-beta' }],
  nextNodeNumber: 3,
};

/** Legacy flat krknctl graph (older export format, no studio layout). */
const sampleGraph: { [nodeId: string]: GraphScenarioNode } = {
  'node-alpha': {
    name: 'pod-scenarios',
    image: 'quay.io/krkn/pod-scenarios:latest',
    env: { NAMESPACE: 'default' },
  },
  'node-beta': {
    name: 'node-cpu-hog',
    image: 'quay.io/krkn/node-cpu-hog:latest',
    env: { DURATION: '60' },
    depends_on: 'node-alpha',
  },
};

describe('parseImportedWorkflow', () => {
  it('returns studioLayout unchanged from an enriched export (lossless)', () => {
    const file = JSON.stringify({
      graph: sampleGraph,
      studioLayout: sampleWorkflow,
      metadata: { exportedAt: '2026-01-01T00:00:00Z', nodeCount: 2 },
    });

    const result = parseImportedWorkflow(file);

    expect(result.lossy).toBe(false);
    expect(result.workflow).toEqual(sampleWorkflow);
  });

  it('accepts a raw StudioWorkflow file (lossless)', () => {
    const result = parseImportedWorkflow(JSON.stringify(sampleWorkflow));

    expect(result.lossy).toBe(false);
    expect(result.workflow).toEqual(sampleWorkflow);
  });

  it('reconstructs a workflow from a legacy flat graph map (lossy)', () => {
    const result = parseImportedWorkflow(JSON.stringify(sampleGraph));

    expect(result.lossy).toBe(true);
    expect(result.workflow.nodes).toHaveLength(2);
    expect(result.workflow.edges).toEqual([
      { id: 'node-alpha-node-beta', source: 'node-alpha', target: 'node-beta' },
    ]);
    expect(result.workflow.nextNodeNumber).toBe(3);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseImportedWorkflow('{not json')).toThrow(/not valid JSON/);
  });

  it('throws on an unrecognized shape', () => {
    expect(() => parseImportedWorkflow(JSON.stringify([1, 2, 3]))).toThrow(/Unrecognized/);
  });

  it('throws when studioLayout is malformed', () => {
    const file = JSON.stringify({ studioLayout: { nodes: 'nope' } });
    expect(() => parseImportedWorkflow(file)).toThrow(/malformed/);
  });
});

describe('reconstructWorkflowFromGraph', () => {
  it('marks nodes configured only when name and image are present', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      'node-full': { name: 'pod-scenarios', image: 'img:1', env: { A: '1' } },
      'node-partial': { name: 'node-cpu-hog' }, // no image -> unconfigured
    };

    const wf = reconstructWorkflowFromGraph(graph);
    const full = wf.nodes.find(n => n.nodeId === 'node-full');
    const partial = wf.nodes.find(n => n.nodeId === 'node-partial');

    expect(full?.status).toBe('configured');
    expect(full?.config?.scenarioName).toBe('pod-scenarios');
    expect(full?.config?.scenarioFormValues).toEqual({ A: '1' });
    expect(partial?.status).toBe('unconfigured');
    expect(partial?.config).toBeUndefined();
  });

  it('assigns positions by dependency depth', () => {
    const wf = reconstructWorkflowFromGraph(sampleGraph);
    const alpha = wf.nodes.find(n => n.nodeId === 'node-alpha');
    const beta = wf.nodes.find(n => n.nodeId === 'node-beta');

    // beta depends on alpha, so it lands in a deeper (further right) layer.
    expect(beta!.position.x).toBeGreaterThan(alpha!.position.x);
  });

  it('throws on an invalid node ID', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      Bad_ID: { name: 'x', image: 'y' },
    };
    expect(() => reconstructWorkflowFromGraph(graph)).toThrow(/Invalid node ID/);
  });

  it('throws on a circular dependency', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      'node-one': { name: 'a', image: 'i', depends_on: 'node-two' },
      'node-two': { name: 'b', image: 'i', depends_on: 'node-one' },
    };
    expect(() => reconstructWorkflowFromGraph(graph)).toThrow(/Invalid workflow graph/);
  });

  it('throws on a dangling dependency reference', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      'node-one': { name: 'a', image: 'i', depends_on: 'missing-node' },
    };
    expect(() => reconstructWorkflowFromGraph(graph)).toThrow(/Invalid workflow graph/);
  });
});

describe('buildStudioExport', () => {
  it('strips the _comment key and produces a studioLayout', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      _comment: { name: 'annotation' },
      'node-alpha': { name: 'pod-scenarios', image: 'img:1', env: { A: '1' } },
    };

    const exportPayload = buildStudioExport(graph, { graphRunName: 'run-123' });

    expect(exportPayload.graph._comment).toBeUndefined();
    expect(Object.keys(exportPayload.graph)).toEqual(['node-alpha']);
    expect(exportPayload.studioLayout.nodes).toHaveLength(1);
    expect(exportPayload.metadata.nodeCount).toBe(1);
    expect(exportPayload.metadata.graphRunName).toBe('run-123');
    expect(exportPayload.metadata.exportedAt).toBeTruthy();
  });

  it('round-trips through parseImportedWorkflow losslessly', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      'node-alpha': { name: 'pod-scenarios', image: 'img:1', env: { A: '1' } },
      'node-beta': { name: 'node-cpu-hog', image: 'img:2', depends_on: 'node-alpha' },
    };

    const exportPayload = buildStudioExport(graph);
    const parsed = parseImportedWorkflow(JSON.stringify(exportPayload));

    expect(parsed.lossy).toBe(false);
    expect(parsed.workflow).toEqual(exportPayload.studioLayout);
  });

  it('throws when the underlying graph is invalid (cycle)', () => {
    const graph: { [nodeId: string]: GraphScenarioNode } = {
      'node-one': { name: 'a', image: 'i', depends_on: 'node-two' },
      'node-two': { name: 'b', image: 'i', depends_on: 'node-one' },
    };
    expect(() => buildStudioExport(graph)).toThrow(/Invalid workflow graph/);
  });
});
