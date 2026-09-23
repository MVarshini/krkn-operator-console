import { useState, useEffect, useCallback, useRef } from 'react';
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
  Form,
  Modal,
  ModalVariant,
  Alert,
  Label,
  DatePicker,
  isValidDate,
  yyyyMMddFormat,
  FormHelperText,
  HelperText,
  HelperTextItem
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { DatabaseIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { elasticsearchApi } from '../services/elasticsearchApi';
import { useNotifications, useRole } from '../hooks';
import { ElasticsearchConfigForm } from './ElasticsearchConfigsCard';
import { JobStatsSummary } from './JobStatsSummary';
import type {
  ElasticsearchConfig,
  TelemetryDocument,
  TelemetryStats,
  CreateElasticsearchConfigRequest,
  UpdateElasticsearchConfigRequest,
  InlineElasticsearchConnection,
  QueryTelemetryResponse,
} from '../types/api';

/**
 * Formats an epoch-seconds timestamp as "MMM DD, YYYY, h:mm:ss AM/PM".
 * Returns an em dash when the timestamp is missing or zero.
 */
/**
 * Returns a "yyyy-MM-dd" date string for `daysAgo` days before today, using the
 * browser's local calendar date. Prior dates are computed with a calendar
 * operation (setDate) rather than subtracting fixed 24-hour intervals so that
 * daylight-saving transitions do not shift the result. Deriving the string from
 * local year/month/day (instead of toISOString(), which is UTC) keeps the picker
 * defaults, future-date validation, and query bounds on one timezone convention
 * that matches the locally formatted telemetry timestamps.
 */
function isoDate(daysAgo = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Bounds for the "Max results" limit. The query is capped server-side, so the
// UI enforces a sane positive-integer range rather than forwarding arbitrary
// input.
const MIN_SIZE = 1;
const MAX_SIZE = 10000;

/**
 * Validates the raw "Max results" input. An empty value is allowed and means
 * "no explicit limit" (the limit is omitted from the query). Any non-empty value
 * must be a whole number within [MIN_SIZE, MAX_SIZE]; otherwise an inline error
 * message is returned.
 */
function validateSize(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (!/^\d+$/.test(trimmed)) {
    return 'Max results must be a whole number';
  }
  const value = Number(trimmed);
  if (value < MIN_SIZE || value > MAX_SIZE) {
    return `Max results must be between ${MIN_SIZE} and ${MAX_SIZE}`;
  }
  return null;
}

/**
 * Normalizes a DatePicker change into a stored "yyyy-MM-dd" bound. PatternFly
 * supplies the parsed `date` alongside the raw input string; an empty input
 * clears the bound, and any string that does not parse to a valid date whose
 * canonical format matches the input is rejected (stored as '') so a malformed
 * value can never enable or reach the query.
 */
function parseDateInput(str: string, date: Date | undefined): string {
  if (str.trim() === '') return '';
  if (date && isValidDate(date) && str === yyyyMMddFormat(date)) return str;
  return '';
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
 * saved Elasticsearch configuration (or an ephemeral inline connection) and
 * renders them in a table.
 *
 * Users pick a saved config from a dropdown (or add a new one via the same form
 * used in Settings), then run a query. When no saved config exists, non-admins
 * (and admins who prefer not to persist credentials) can supply connection
 * details inline for the current session only — those values are never stored
 * server-side. For saved configs, connection credentials never reach the
 * browser: the backend resolves them from the named config and performs the
 * search server-side.
 *
 * Takes no props; all state is internal. Mount it directly for the
 * `elasticsearch_data` phase.
 *
 * @example
 * import { ElasticsearchDataView } from './components';
 *
 * case 'elasticsearch_data':
 *   return (
 *     <PageSection>
 *       <ElasticsearchDataView />
 *     </PageSection>
 *   );
 */
export function ElasticsearchDataView() {
  const { showError } = useNotifications();
  const [configs, setConfigs] = useState<ElasticsearchConfig[]>([]);
  const [selectedConfig, setSelectedConfig] = useState('');
  const [size, setSize] = useState('50');
  const [startDate, setStartDate] = useState(isoDate(10));
  const [endDate, setEndDate] = useState(isoDate(0));
  const [documents, setDocuments] = useState<TelemetryDocument[]>([]);
  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [loadingConfigs, setLoadingConfigs] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const {isAdmin} = useRole();

  // Ephemeral (not saved) connection fields, used when no saved config exists.
  // These values are held only in component state and are cleared on unmount;
  // they are never persisted server-side (no createConfig call, no storage).
  const [inlineHost, setInlineHost] = useState('');
  const [inlinePort, setInlinePort] = useState('');
  const [inlineUsername, setInlineUsername] = useState('');
  const [inlinePassword, setInlinePassword] = useState('');
  const [inlineIndex, setInlineIndex] = useState('');

  // Monotonic id identifying the most recent query. Each run captures the id it
  // started with; a response only updates the table if its id still matches, so
  // stale responses (from criteria that have since changed) are discarded.
  const latestRequestId = useRef(0);

  // Clears any displayed results and invalidates in-flight requests. Called
  // whenever the query criteria change so the table never shows telemetry that
  // no longer matches the current config, date range, or result limit.
  const invalidateResults = useCallback(() => {
    latestRequestId.current += 1;
    setDocuments([]);
    setStats(null);
    setHasQueried(false);
    setQuerying(false);
  }, []);

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
  const sizeError = validateSize(size);

  // Shared date/size validation for both the saved-config and inline query
  // paths. Returns the validated size (or undefined) when valid, or null after
  // surfacing an error so the caller can abort.
  const validatedQueryArgs = (): { sizeNum: number | undefined } | null => {
    if (startAfterEnd) {
      showError('Invalid date range', 'Start date must not be after end date');
      return null;
    }
    if (endInFuture) {
      showError('Invalid date range', 'End date must not be in the future');
      return null;
    }
    if (sizeError) {
      showError('Invalid max results', sizeError);
      return null;
    }
    // An empty input intentionally omits the limit; a validated value is a
    // bounded positive integer.
    const trimmedSize = size.trim();
    return { sizeNum: trimmedSize === '' ? undefined : Number(trimmedSize) };
  };

  // Runs a telemetry query via the supplied fetcher, applying the monotonic
  // request-id guard so stale responses are discarded. Shared by the saved
  // config and inline connection paths.
  const executeQuery = async (
    runner: (sizeNum: number | undefined) => Promise<QueryTelemetryResponse>,
  ) => {
    const args = validatedQueryArgs();
    if (!args) return;
    // Snapshot this run's id; only the latest run may commit its response.
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    setQuerying(true);
    try {
      const result = await runner(args.sizeNum);
      // Ignore responses superseded by a newer run or by a criteria change.
      if (latestRequestId.current !== requestId) return;
      setDocuments(result.documents || []);
      setStats(result.stats ?? null);
      setHasQueried(true);
    } catch (err) {
      if (latestRequestId.current !== requestId) return;
      showError('Query failed', err instanceof Error ? err.message : 'Could not query Elasticsearch');
    } finally {
      if (latestRequestId.current === requestId) {
        setQuerying(false);
      }
    }
  };

  const handleRunQuery = async () => {
    if (!selectedConfig) {
      showError('No config selected', 'Please select an Elasticsearch config to query');
      return;
    }
    await executeQuery((sizeNum) =>
      elasticsearchApi.queryTelemetry(
        selectedConfig,
        sizeNum,
        startDate || undefined,
        endDate || undefined,
      ),
    );
  };

  // Inline form validity: host and telemetry index are the required fields.
  const inlineComplete = inlineHost.trim() !== '' && inlineIndex.trim() !== '';

  const handleRunInlineQuery = async () => {
    if (!inlineComplete) {
      showError('Missing connection details', 'Host and telemetry index are required');
      return;
    }
    const trimmedPort = inlinePort.trim();
    if (trimmedPort !== '' && !/^\d+$/.test(trimmedPort)) {
      showError('Invalid port', 'Port must be a whole number');
      return;
    }
    const inline: InlineElasticsearchConnection = {
      host: inlineHost.trim(),
      telemetryIndex: inlineIndex.trim(),
      ...(trimmedPort !== '' ? { port: Number(trimmedPort) } : {}),
      ...(inlineUsername.trim() !== '' ? { username: inlineUsername.trim() } : {}),
      ...(inlinePassword !== '' ? { password: inlinePassword } : {}),
    };
    await executeQuery((sizeNum) =>
      elasticsearchApi.queryTelemetryInline(
        inline,
        sizeNum,
        startDate || undefined,
        endDate || undefined,
      ),
    );
  };

  const handleCreateConfig = async (
    data: CreateElasticsearchConfigRequest | UpdateElasticsearchConfigRequest,
  ) => {
    // Creating a shared saved config is an administrator-only operation, matching
    // the Settings > Elasticsearch tab boundary. Guard the submit path so the
    // role check cannot be bypassed even if a create control is reached.
    if (!isAdmin) {
      showError('Not authorized', 'Only administrators can add Elasticsearch configs');
      return;
    }
    const createReq = data as CreateElasticsearchConfigRequest;
    await elasticsearchApi.createConfig(createReq);
    setShowCreateModal(false);
    await fetchConfigs();
    setSelectedConfig(createReq.name);
    // Switching config must clear results from the prior config and invalidate
    // any in-flight request, matching the selector's onChange behavior.
    invalidateResults();
  };

  // Job stats summary shown once a query has committed results. Rendered above
  // the results table in both the saved-config and inline paths.
  const statsSection = hasQueried && !querying && stats && (
    <div style={{ marginTop: '1.5rem' }}>
      <JobStatsSummary
        stats={{
          // Whole matched window: response.total counts only the returned page.
          totalJobs: stats.pass + stats.fail,
          succeededJobs: stats.pass,
          failedJobs: stats.fail,
        }}
        labels={{ total: 'Total Runs', succeeded: 'Passed', failed: 'Failed', passRate: 'Pass Rate' }}
        subTexts={{
          total: 'Runs across matched window',
          succeeded: 'status = true',
          failed: 'status = false',
          passRate: 'Percentage of runs that passed',
        }}
      />
    </div>
  );

  // Shared results region: spinner while querying, an info prompt before the
  // first run, an empty state when a query returned nothing, or the table.
  const resultsSection = (
    <>
      {statsSection}
      <div style={{ marginTop: '1.5rem' }}>
        {querying ? (
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            <Spinner size="lg" />
          </div>
        ) : !hasQueried ? (
          <Alert
            variant="info"
            isInline
            title="Run a query to view telemetry data."
          />
        ) : documents.length === 0 ? (
          <EmptyState>
            <EmptyStateIcon icon={DatabaseIcon} />
            <Title headingLevel="h3" size="md">No telemetry documents found</Title>
            <EmptyStateBody>
              The telemetry index returned no results.
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
  );

  // Date-range and max-results controls shared by the saved-config and inline
  // query forms.
  const dateAndSizeControls = (
    <>
      <FlexItem>
        <FormGroup label="Start Date" fieldId="es-data-start-date">
          <DatePicker
            id="es-data-start-date"
            value={startDate}
            onChange={(_event, str, date) => { setStartDate(parseDateInput(str, date)); invalidateResults(); }}
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
            onChange={(_event, str, date) => { setEndDate(parseDateInput(str, date)); invalidateResults(); }}
            aria-label="End date"
          />
        </FormGroup>
      </FlexItem>
      <FlexItem>
        <FormGroup label="Max results" fieldId="es-data-size">
          <TextInput
            id="es-data-size"
            type="number"
            min={MIN_SIZE}
            max={MAX_SIZE}
            value={size}
            onChange={(_e, v) => { setSize(v); invalidateResults(); }}
            validated={sizeError ? 'error' : 'default'}
            aria-label="Max results"
            style={{ width: '7rem' }}
          />
          {sizeError && (
            <FormHelperText>
              <HelperText>
                <HelperTextItem variant="error">{sizeError}</HelperTextItem>
              </HelperText>
            </FormHelperText>
          )}
        </FormGroup>
      </FlexItem>
    </>
  );

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
            <>
              <EmptyState>
                <EmptyStateIcon icon={DatabaseIcon} />
                <Title headingLevel="h3" size="lg">No Saved Elasticsearch Configs</Title>
                <EmptyStateBody>
                  {isAdmin ? (
                    <p>Add a saved Elasticsearch configuration, or connect below without saving to query telemetry data.</p>
                  ) : (
                    <p>No saved configuration is available. Enter connection details below to connect without saving and query telemetry data.</p>
                  )}
                </EmptyStateBody>
                {isAdmin && (
                  <Button variant="primary" icon={<PlusCircleIcon />} onClick={() => setShowCreateModal(true)}>
                    Add Config
                  </Button>
                )}
              </EmptyState>

              <Title headingLevel="h3" size="md" style={{ marginTop: '1.5rem' }}>
                Connect without saving
              </Title>
              <FormHelperText>
                <HelperText>
                  <HelperTextItem>
                    These connection details are used only for this session and are not stored on the server.
                  </HelperTextItem>
                </HelperText>
              </FormHelperText>

              <Form style={{ marginTop: '1rem', maxWidth: '40em' }}>
                <FormGroup label="Host" fieldId="es-inline-host" isRequired>
                  <TextInput
                    id="es-inline-host"
                    value={inlineHost}
                    onChange={(_e, v) => { setInlineHost(v); invalidateResults(); }}
                    placeholder="https://elasticsearch.example.com"
                    aria-label="Elasticsearch host"
                  />
                </FormGroup>
                <FormGroup label="Port" fieldId="es-inline-port">
                  <TextInput
                    id="es-inline-port"
                    type="number"
                    value={inlinePort}
                    onChange={(_e, v) => { setInlinePort(v); invalidateResults(); }}
                    placeholder="9200"
                    aria-label="Elasticsearch port"
                  />
                </FormGroup>
                <FormGroup label="Username" fieldId="es-inline-username">
                  <TextInput
                    id="es-inline-username"
                    value={inlineUsername}
                    onChange={(_e, v) => { setInlineUsername(v); invalidateResults(); }}
                    aria-label="Elasticsearch username"
                  />
                </FormGroup>
                <FormGroup label="Password" fieldId="es-inline-password">
                  <TextInput
                    id="es-inline-password"
                    type="password"
                    value={inlinePassword}
                    onChange={(_e, v) => { setInlinePassword(v); invalidateResults(); }}
                    aria-label="Elasticsearch password"
                  />
                </FormGroup>
                <FormGroup label="Telemetry Index" fieldId="es-inline-index" isRequired>
                  <TextInput
                    id="es-inline-index"
                    value={inlineIndex}
                    onChange={(_e, v) => { setInlineIndex(v); invalidateResults(); }}
                    aria-label="Telemetry index"
                  />
                </FormGroup>
                <Flex alignItems={{ default: 'alignItemsFlexEnd' }} spaceItems={{ default: 'spaceItemsMd' }}>
                  {dateAndSizeControls}
                  <FlexItem>
                    <FormGroup label="" fieldId="run-inline-query-btn">
                      <Button
                        variant="primary"
                        onClick={handleRunInlineQuery}
                        isDisabled={querying || !inlineComplete || invalidDateRange || !!sizeError}
                        isLoading={querying}
                      >
                        Run Query
                      </Button>
                    </FormGroup>
                  </FlexItem>
                </Flex>
              </Form>

              {resultsSection}
            </>
          ) : (
            <>
              <Flex alignItems={{ default: 'alignItemsFlexEnd' }}
              spaceItems={{ default: 'spaceItemsMd' }}>
                <FlexItem >
                  <FormGroup label="Elasticsearch Config" fieldId="es-data-config"  style={{ width: '30em' }}>
                    <FormSelect
                      id="es-data-config"
                      value={selectedConfig}
                      onChange={(_e, v) => { setSelectedConfig(v); invalidateResults(); }}
                      aria-label="Select an Elasticsearch config"
                    >
                      <FormSelectOption value="" label="Select a saved Elasticsearch config…" isDisabled />
                      {configs.map((cfg) => (
                        <FormSelectOption key={cfg.name} value={cfg.name} label={cfg.name} />
                      ))}
                    </FormSelect>
                  </FormGroup>
                </FlexItem>
                {dateAndSizeControls}
                <FlexItem>
                    <FormGroup label="" fieldId="run-query-btn">
                  <Button
                    variant="primary"
                    onClick={handleRunQuery}
                    isDisabled={querying || !selectedConfig || invalidDateRange || !!sizeError}
                    isLoading={querying}
                  >
                    Run Query
                  </Button>
                  </FormGroup>
                </FlexItem>
                {isAdmin && (
                  <FlexItem>
                    <Button variant="link" icon={<PlusCircleIcon />} onClick={() => setShowCreateModal(true)}>
                      Add new config
                    </Button>
                  </FlexItem>
                )}
              </Flex>

              {resultsSection}
            </>
          )}
        </CardBody>
      </Card>

      {isAdmin && (
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
      )}
    </>
  );
}
