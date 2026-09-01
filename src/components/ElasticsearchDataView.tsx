import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  CardTitle,
  CardBody,
  Button,
  EmptyState,
  EmptyStateIcon,
  EmptyStateBody,
  Title,
  Spinner,
  Flex,
  FlexItem,
  FormGroup,
  FormSelect,
  FormSelectOption,
  TextInput,
  Modal,
  ModalVariant,
  Alert,
  Label,
  DatePicker
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { DatabaseIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { elasticsearchApi } from '../services/elasticsearchApi';
import { useNotifications } from '../hooks';
import { ElasticsearchConfigForm } from './ElasticsearchConfigsCard';
import type {
  ElasticsearchConfig,
  TelemetryDocument,
  CreateElasticsearchConfigRequest,
  UpdateElasticsearchConfigRequest,
} from '../types/api';

/**
 * Formats an epoch-seconds timestamp as "MMM DD, YYYY, h:mm:ss AM/PM".
 * Returns an em dash when the timestamp is missing or zero.
 */
/** Returns a "yyyy-MM-dd" date string for `daysAgo` days before now. */
function isoDate(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

function formatTimestamp(epochSeconds: number): string {
  if (!epochSeconds) {
    return '—';
  }
  const date = new Date(epochSeconds * 1000);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * ElasticsearchDataView — top-level page that queries telemetry documents from a
 * saved Elasticsearch configuration and renders them in a table.
 *
 * Users pick a saved config from a dropdown (or add a new one via the same form
 * used in Settings), then run a query. Connection credentials never reach the
 * browser — the backend resolves them from the named config and performs the
 * search server-side.
 */
export function ElasticsearchDataView() {
  const { showError } = useNotifications();
  const [configs, setConfigs] = useState<ElasticsearchConfig[]>([]);
  const [selectedConfig, setSelectedConfig] = useState('');
  const [size, setSize] = useState('50');
  const [startDate, setStartDate] = useState(isoDate(10));
  const [endDate, setEndDate] = useState(isoDate(0));
  const [documents, setDocuments] = useState<TelemetryDocument[]>([]);
  const [loadingConfigs, setLoadingConfigs] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  const fetchConfigs = useCallback(async () => {
    try {
      const data = await elasticsearchApi.listConfigs();
      setConfigs(data);
    } catch {
      showError('Failed to load Elasticsearch configs', 'Could not retrieve configs from the server');
    } finally {
      setLoadingConfigs(false);
    }
  }, [showError]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // Date bounds are compared as "yyyy-MM-dd" strings, which are
  // lexicographically ordered by date.
  const today = isoDate(0);
  const startAfterEnd = !!startDate && !!endDate && startDate > endDate;
  const endInFuture = !!endDate && endDate > today;
  const invalidDateRange = startAfterEnd || endInFuture;

  const handleRunQuery = async () => {
    if (!selectedConfig) {
      showError('No config selected', 'Please select an Elasticsearch config to query');
      return;
    }
    if (startAfterEnd) {
      showError('Invalid date range', 'Start date must not be after end date');
      return;
    }
    if (endInFuture) {
      showError('Invalid date range', 'End date must not be in the future');
      return;
    }
    setQuerying(true);
    try {
      const sizeNum = parseInt(size, 10) || undefined;
      const result = await elasticsearchApi.queryTelemetry(
        selectedConfig,
        sizeNum,
        startDate || undefined,
        endDate || undefined,
      );
      setDocuments(result.documents || []);
      setHasQueried(true);
    } catch (err) {
      showError('Query failed', err instanceof Error ? err.message : 'Could not query Elasticsearch');
    } finally {
      setQuerying(false);
    }
  };

  const handleCreateConfig = async (
    data: CreateElasticsearchConfigRequest | UpdateElasticsearchConfigRequest,
  ) => {
    const createReq = data as CreateElasticsearchConfigRequest;
    await elasticsearchApi.createConfig(createReq);
    setShowCreateModal(false);
    await fetchConfigs();
    setSelectedConfig(createReq.name);
  };

  return (
    <>
      <Card>
        <CardTitle>
          <Title headingLevel="h2" size="lg">Elasticsearch Telemetry Data</Title>
        </CardTitle>
        <CardBody>
          {loadingConfigs ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}>
              <Spinner size="xl" />
            </div>
          ) : configs.length === 0 ? (
            <EmptyState>
              <EmptyStateIcon icon={DatabaseIcon} />
              <Title headingLevel="h3" size="lg">No Elasticsearch Configs</Title>
              <EmptyStateBody>
                Add an Elasticsearch configuration to query telemetry data.
              </EmptyStateBody>
              <Button variant="primary" icon={<PlusCircleIcon />} onClick={() => setShowCreateModal(true)}>
                Add Config
              </Button>
            </EmptyState>
          ) : (
            <>
              <Flex alignItems={{ default: 'alignItemsFlexEnd' }}
              spaceItems={{ default: 'spaceItemsMd' }}>
                <FlexItem >
                  <FormGroup label="Elasticsearch Config" fieldId="es-data-config"  style={{ width: '30em' }}>
                    <FormSelect
                      id="es-data-config"
                      value={selectedConfig}
                      onChange={(_e, v) => setSelectedConfig(v)}
                      aria-label="Select an Elasticsearch config"
                    >
                      <FormSelectOption value="" label="Select a saved Elasticsearch config…" isDisabled />
                      {configs.map((cfg) => (
                        <FormSelectOption key={cfg.name} value={cfg.name} label={cfg.name} />
                      ))}
                    </FormSelect>
                  </FormGroup>
                </FlexItem>
                <FlexItem>
                  <FormGroup label="Start Date" fieldId="es-data-start-date">
                    <DatePicker
                      id="es-data-start-date"
                      value={startDate}
                      onChange={(_event, str) => setStartDate(str)}
                      aria-label="Start date"
                    />
                  </FormGroup>
                </FlexItem>
                <FlexItem>to</FlexItem>
                <FlexItem>
                  <FormGroup label="End Date" fieldId="es-data-end-date">
                    <DatePicker
                      id="es-data-end-date"
                      value={endDate}
                      onChange={(_event, str) => setEndDate(str)}
                      // validators={[
                      //   (date: Date) =>
                      //     startDate && date < new Date(startDate)
                      //       ? 'End date must not be before start date'
                      //       : '',
                      //   (date: Date) =>
                      //     date > new Date(today)
                      //       ? 'End date must not be in the future'
                      //       : '',
                      // ]}
                      aria-label="End date"
                    />
                  </FormGroup>
                </FlexItem>
                <FlexItem>
                  <FormGroup label="Max results" fieldId="es-data-size">
                    <TextInput
                      id="es-data-size"
                      type="number"
                      value={size}
                      onChange={(_e, v) => setSize(v)}
                      style={{ width: '7rem' }}
                    />
                  </FormGroup>
                </FlexItem>
                
               
                <FlexItem>
                    <FormGroup label="" fieldId="run-query-btn">
                  <Button
                    variant="primary"
                    onClick={handleRunQuery}
                    isDisabled={querying || !selectedConfig || invalidDateRange}
                    isLoading={querying}
                  >
                    Run Query
                  </Button>
                  </FormGroup>
                </FlexItem>
                <FlexItem>
                  <Button variant="link" icon={<PlusCircleIcon />} onClick={() => setShowCreateModal(true)}>
                    Add new config
                  </Button>
                </FlexItem>
              </Flex>

              <div style={{ marginTop: '1.5rem' }}>
                {querying ? (
                  <div style={{ textAlign: 'center', padding: '2rem' }}>
                    <Spinner size="lg" />
                  </div>
                ) : !hasQueried ? (
                  <Alert
                    variant="info"
                    isInline
                    title="Select a config and run a query to view telemetry data."
                  />
                ) : documents.length === 0 ? (
                  <EmptyState>
                    <EmptyStateIcon icon={DatabaseIcon} />
                    <Title headingLevel="h3" size="md">No telemetry documents found</Title>
                    <EmptyStateBody>
                      The telemetry index for this config returned no results.
                    </EmptyStateBody>
                  </EmptyState>
                ) : (
                  <Table isStriped={true} aria-label="Telemetry documents">
                    <Thead>
                      <Tr>
                        <Th>UUID</Th>
                        <Th>Scenario Type</Th>
                        <Th>Start Time</Th>
                        <Th>End Time</Th>
                        <Th>Namespace</Th>
                        <Th>Status</Th>
                      </Tr>
                    </Thead>
                    <Tbody>
                      {documents.map((doc, idx) => (
                        <Tr key={doc.run_uuid || idx}>
                          <Td dataLabel="UUID">
                            <code>{doc.run_uuid ? doc.run_uuid.slice(0, 7) : '—'}</code>
                          </Td>
                          <Td dataLabel="Scenario Type">{doc.scenario_type || '—'}</Td>
                          <Td dataLabel="Start Time">{formatTimestamp(doc.start_timestamp)}</Td>
                          <Td dataLabel="End Time">{formatTimestamp(doc.end_timestamp)}</Td>
                          <Td dataLabel="Namespace">{doc.namespace || '—'}</Td>
                          <Td dataLabel="Status">
                            <Label color={doc.status ? 'green' : 'red'}>
                              {doc.status ? 'Pass' : 'Fail'}
                            </Label>
                          </Td>
                        </Tr>
                      ))}
                    </Tbody>
                  </Table>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      <Modal
        variant={ModalVariant.medium}
        title="Add Elasticsearch Config"
        isOpen={showCreateModal}
        onClose={() => setShowCreateModal(false)}
      >
        <ElasticsearchConfigForm
          onSubmit={handleCreateConfig}
          onCancel={() => setShowCreateModal(false)}
        />
      </Modal>
    </>
  );
}
