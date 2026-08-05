import { useEffect, useRef, useCallback } from 'react';
import { useAppContext } from '../context/AppContext';
import { graphRunsApi } from '../services';
import { useWebSocket } from './useWebSocket';
import { websocketService } from '../services/websocketService';
import type { ServerMessage } from '../types/websocket';
import type { GraphRunState, GraphClusterScore, ResiliencyScoreResponse } from '../types/api';

function aggregateResiliencyScores(scores: GraphClusterScore[]): ResiliencyScoreResponse {
  const avg = scores.reduce((sum, s) => sum + s.calculated, 0) / scores.length;
  const hasFail = scores.some(s => s.status === 'fail');
  return {
    calculated: avg,
    baseline: scores[0]?.baseline,
    status: hasFail ? 'fail' : 'pass',
    message: scores.map(s => `${s.clusterName}: ${s.calculated}`).join(', '),
  };
}

/**
 * Hook to receive real-time graph run updates via WebSocket.
 * WebSocket provides status updates (phase, summary counters);
 * initial full list is fetched once via REST on first connect.
 */
export function useGraphRunsPoller() {
  const { state, dispatch } = useAppContext();

  const graphRunsRef = useRef(state.graphRuns);

  graphRunsRef.current = state.graphRuns;

  const initialFetchDoneRef = useRef(false);

  const fetchInitialGraphRuns = useCallback(async () => {
    if (initialFetchDoneRef.current) return;
    initialFetchDoneRef.current = true;

    try {
      const graphRuns = await graphRunsApi.listGraphRuns();
      const graphRunStates: GraphRunState[] = graphRuns.map((run) => {
        const resiliencyScore = run.resiliencyScores?.length
          ? aggregateResiliencyScores(run.resiliencyScores)
          : run.resiliencyScore;

        return {
          name: run.name,
          namespace: run.namespace,
          creationTimestamp: run.creationTimestamp,
          phase: run.phase,
          ownerUserId: run.ownerUserId,
          targetRequestId: run.targetRequestId,
          summary: run.summary,
          startTime: run.startTime,
          completionTime: run.completionTime,
          resiliencyScoreEnabled: run.resiliencyScoreEnabled,
          resiliencyScoreBaseline: run.resiliencyScoreBaseline,
          resiliencyScores: run.resiliencyScores,
          resiliencyScore,
        };
      });

      dispatch({
        type: 'LOAD_GRAPH_RUNS_SUCCESS',
        payload: { runs: graphRunStates },
      });
    } catch {
      initialFetchDoneRef.current = false;
    }
  }, [dispatch]);

  const handleMessage = useCallback((message: ServerMessage) => {
    if (message.resource !== 'graphrun') return;

    const data = message.data as GraphRunState;
    const runName = message.id || data.name;

    if (message.event === 'updated' || message.event === 'created') {
      const existing = graphRunsRef.current.find(r => r.name === runName);

      const updatedState: GraphRunState = {
        name: runName,
        namespace: data.namespace || existing?.namespace || 'krkn-operator-system',
        creationTimestamp: data.creationTimestamp || existing?.creationTimestamp || '',
        phase: data.phase,
        ownerUserId: data.ownerUserId || existing?.ownerUserId || '',
        targetRequestId: data.targetRequestId || existing?.targetRequestId || '',
        summary: data.summary || existing?.summary || { totalNodes: 0, completedNodes: 0, runningNodes: 0, failedNodes: 0, pendingNodes: 0 },
        startTime: data.startTime || existing?.startTime,
        completionTime: data.completionTime || existing?.completionTime,
        resiliencyScoreEnabled: data.resiliencyScoreEnabled ?? existing?.resiliencyScoreEnabled,
        resiliencyScoreBaseline: data.resiliencyScoreBaseline ?? existing?.resiliencyScoreBaseline ?? data.resiliencyScores?.[0]?.baseline,
        resiliencyScores: data.resiliencyScores ?? existing?.resiliencyScores,
      };

      if (existing) {
        dispatch({ type: 'UPDATE_GRAPH_RUN', payload: { run: updatedState } });
      } else {
        dispatch({ type: 'ADD_GRAPH_RUN', payload: { run: updatedState } });
      }
    } else if (message.event === 'deleted') {
      dispatch({ type: 'DELETE_GRAPH_RUN', payload: { graphRunName: runName } });
    }
  }, [dispatch]);

  const wsUrl = websocketService.buildResourceUrl('graphruns');
  const { connectionState } = useWebSocket('graph-runs', wsUrl, handleMessage);

  useEffect(() => {
    if (connectionState === 'connected') {
      fetchInitialGraphRuns();
      websocketService.subscribe('graph-runs', 'graphrun');
    }
  }, [connectionState, fetchInitialGraphRuns]);
}
