/**
 * studioImport - Parse and reconstruct Chaos Studio workflows from uploaded JSON.
 *
 * The studio can export a workflow to a JSON file. This module implements the
 * reverse: turning an uploaded file back into a `StudioWorkflow` that renders on
 * the canvas.
 *
 * Two file shapes are supported:
 *
 * 1. **Enriched export** `{ graph, studioLayout, metadata }` (current export
 *    format) or a raw `StudioWorkflow`. The `studioLayout` carries full canvas
 *    fidelity (positions, node status, per-node config, edges), so it is used
 *    directly for a lossless round-trip.
 * 2. **Legacy flat graph** `{ [nodeId]: GraphScenarioNode }` (older export files
 *    that stored only the executable krknctl graph). These are reconstructed on
 *    a best-effort basis: positions are auto-laid-out and node config is derived
 *    from the graph. This is lossy — the scenario/global env split, private
 *    registry details, and file mounts cannot be recovered, so reconstructed
 *    nodes may need to be reconfigured before saving.
 */

import type {
  StudioNode,
  StudioEdge,
  StudioWorkflow,
  GraphScenarioNode,
} from '../../types/api';
import { graphRunsApi } from '../../services/graphRunsApi';

/** Node ID pattern enforced by the studio (mirrors validateNodeId in StudioContext). */
const NODE_ID_PATTERN = /^[a-z0-9-]{5,25}$/;

/** Horizontal spacing between dependency layers on the reconstructed canvas. */
const LAYER_X_SPACING = 300;
/** Vertical spacing between sibling nodes within a layer. */
const LAYER_Y_SPACING = 150;
/** Canvas origin for reconstructed layouts (mirrors addNode defaults). */
const ORIGIN_X = 100;
const ORIGIN_Y = 100;

/**
 * Result of parsing an uploaded workflow file.
 *
 * `lossy` is true when the file was a legacy flat graph and had to be
 * reconstructed, so callers can warn the user that some config may be missing.
 */
export interface ParsedImport {
  workflow: StudioWorkflow;
  lossy: boolean;
}

/**
 * Type guard: does an object have the shape of a `StudioWorkflow`?
 * Matches the inline shape check used when loading cluster templates.
 */
function isStudioWorkflowShape(value: unknown): value is StudioWorkflow {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges) &&
    typeof candidate.nextNodeNumber === 'number'
  );
}

/**
 * Type guard: does an object look like a flat krknctl graph map
 * (`{ [nodeId]: GraphScenarioNode }`)?
 */
function isGraphMapShape(value: unknown): value is { [nodeId: string]: GraphScenarioNode } {
  if (!value || typeof value !== 'object') return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  // Every value must be a plain object (a scenario node). Reject arrays/primitives.
  return entries.every(
    entry => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  );
}

/**
 * Compute the dependency depth of each node (distance from a root node with no
 * `depends_on`). Used to lay out reconstructed nodes into horizontal layers.
 * Nodes whose dependency chain cannot be resolved fall back to depth 0.
 */
function computeDepths(graph: { [nodeId: string]: GraphScenarioNode }): Map<string, number> {
  const depths = new Map<string, number>();

  const depthOf = (nodeId: string, seen: Set<string>): number => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) return cached;

    const node = graph[nodeId];
    // Root, missing dependency, or a cycle guard: treat as depth 0.
    if (!node || !node.depends_on || !graph[node.depends_on] || seen.has(nodeId)) {
      return 0;
    }

    seen.add(nodeId);
    const depth = depthOf(node.depends_on, seen) + 1;
    depths.set(nodeId, depth);
    return depth;
  };

  for (const nodeId of Object.keys(graph)) {
    depths.set(nodeId, depthOf(nodeId, new Set()));
  }

  return depths;
}

/**
 * Reconstruct a `StudioWorkflow` from a flat krknctl graph map (best-effort).
 *
 * Positions are auto-laid-out by dependency depth. A node is marked
 * `'configured'` only when it has both a `name` and an `image`; otherwise it is
 * `'unconfigured'` so the user is prompted to complete it.
 *
 * @throws Error if any node ID violates the studio node-ID pattern, or the
 *   resulting graph fails validation (empty, dangling/self dependency, cycle).
 */
export function reconstructWorkflowFromGraph(
  graph: { [nodeId: string]: GraphScenarioNode }
): StudioWorkflow {
  const nodeIds = Object.keys(graph);

  for (const nodeId of nodeIds) {
    if (!NODE_ID_PATTERN.test(nodeId)) {
      throw new Error(
        `Invalid node ID "${nodeId}": must be 5-25 characters, lowercase letters, numbers, and hyphens only`
      );
    }
  }

  // Validate the executable graph up front (empty, bad refs, cycles).
  const validationErrors = graphRunsApi.validateGraph(graph);
  if (validationErrors.length > 0) {
    throw new Error(`Invalid workflow graph: ${validationErrors.join('; ')}`);
  }

  const depths = computeDepths(graph);
  // Track how many nodes already placed in each layer for vertical stacking.
  const layerCounts = new Map<number, number>();

  const nodes: StudioNode[] = nodeIds.map(nodeId => {
    const scenario = graph[nodeId];
    const depth = depths.get(nodeId) ?? 0;
    const indexInLayer = layerCounts.get(depth) ?? 0;
    layerCounts.set(depth, indexInLayer + 1);

    const isConfigured = Boolean(scenario.name && scenario.image);

    const node: StudioNode = {
      nodeId,
      status: isConfigured ? 'configured' : 'unconfigured',
      position: {
        x: ORIGIN_X + depth * LAYER_X_SPACING,
        y: ORIGIN_Y + indexInLayer * LAYER_Y_SPACING,
      },
    };

    if (isConfigured) {
      node.config = {
        registryType: 'public',
        registryConfig: {},
        scenarioName: scenario.name as string,
        scenarioImage: scenario.image as string,
        scenarioFormValues: { ...(scenario.env ?? {}) },
        volumes: scenario.volumes,
      };
    }

    return node;
  });

  const edges: StudioEdge[] = nodeIds
    .filter(nodeId => graph[nodeId].depends_on)
    .map(nodeId => {
      const source = graph[nodeId].depends_on as string;
      return { id: `${source}-${nodeId}`, source, target: nodeId };
    });

  return {
    nodes,
    edges,
    nextNodeNumber: nodes.length + 1,
  };
}

/**
 * The enriched workflow export payload written to a `.json` file.
 *
 * `graph` is the executable krknctl form; `studioLayout` carries full canvas
 * fidelity for lossless re-import; `metadata` records provenance.
 */
export interface StudioExport {
  graph: { [nodeId: string]: GraphScenarioNode };
  studioLayout: StudioWorkflow;
  metadata: {
    exportedAt: string;
    nodeCount: number;
    [key: string]: unknown;
  };
}

/**
 * Build a re-importable export payload from a flat krknctl graph map.
 *
 * Used by the Job page to export a graph run: the run response carries only the
 * executable `spec.graph` (no canvas positions), so a `studioLayout` is
 * synthesized via {@link reconstructWorkflowFromGraph} (auto-layout positions).
 * The resulting object round-trips through {@link parseImportedWorkflow}.
 *
 * The `_comment` key (a krknctl graph annotation, not a real node) is stripped
 * before reconstruction so it does not fail the node-ID validation.
 *
 * @throws Error if the graph fails validation (see reconstructWorkflowFromGraph).
 */
export function buildStudioExport(
  graph: { [nodeId: string]: GraphScenarioNode },
  meta?: { [key: string]: unknown }
): StudioExport {
  const cleanGraph: { [nodeId: string]: GraphScenarioNode } = {};
  for (const [nodeId, node] of Object.entries(graph ?? {})) {
    if (nodeId === '_comment') continue;
    cleanGraph[nodeId] = node;
  }

  const studioLayout = reconstructWorkflowFromGraph(cleanGraph);

  return {
    graph: cleanGraph,
    studioLayout,
    metadata: {
      exportedAt: new Date().toISOString(),
      nodeCount: studioLayout.nodes.length,
      ...meta,
    },
  };
}

/**
 * Parse the text of an uploaded workflow file into a `StudioWorkflow`.
 *
 * Detection order:
 *   1. Enriched export with a valid `studioLayout` -> used directly (lossless).
 *   2. A raw `StudioWorkflow` -> used directly (lossless).
 *   3. A flat graph map -> reconstructed (lossy).
 *
 * @throws Error on invalid JSON, unrecognized shape, or failed graph validation.
 */
export function parseImportedWorkflow(text: string): ParsedImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Unrecognized workflow file format');
  }

  // 1. Enriched export: { graph, studioLayout, metadata }
  const studioLayout = (parsed as Record<string, unknown>).studioLayout;
  if (studioLayout !== undefined) {
    if (!isStudioWorkflowShape(studioLayout)) {
      throw new Error('Invalid workflow format: studioLayout is malformed');
    }
    return { workflow: studioLayout, lossy: false };
  }

  // 2. Raw StudioWorkflow
  if (isStudioWorkflowShape(parsed)) {
    return { workflow: parsed, lossy: false };
  }

  // 3. Legacy flat graph map
  if (isGraphMapShape(parsed)) {
    return {
      workflow: reconstructWorkflowFromGraph(parsed),
      lossy: true,
    };
  }

  throw new Error('Unrecognized workflow file format');
}
