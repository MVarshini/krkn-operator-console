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
  Modal,
  ModalVariant,
  Alert,
  Label,
  DatePicker,
  FormHelperText,
  HelperText,
  HelperTextItem,
  Select,
  SelectList,
  SelectOption,
  MenuToggle,
  Badge
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { DatabaseIcon, PlusCircleIcon } from '@patternfly/react-icons';
import { elasticsearchApi } from '../services/elasticsearchApi';
import { useNotifications } from '../hooks';
import { ElasticsearchConfigForm } from './ElasticsearchConfigsCard';
import { JobStatsSummary } from './JobStatsSummary';
import type {
  ElasticsearchConfig,
  TelemetryDocument,
  TelemetryStats,
  FacetOption,
  CreateElasticsearchConfigRequest,
  UpdateElasticsearchConfigRequest,
} from '../types/api';

// Filter categories shown in the single-select category dropdown. Each key must
// match a facet key returned by the backend (see facetFields in the operator's
// pkg/elasticsearch/client.go); the value multi-select is populated from the
// response facets for the selected key.
const FILTER_CATEGORIES: { key: string; label: string }[] = [
  { key: 'scenario_type', label: 'Scenario Type' },
  { key: 'job_status', label: 'Job Status' },
  { key: 'cloud_infrastructure', label: 'Cloud Infrastructure' },
  { key: 'cloud_type', label: 'Cloud Type' },
  { key: 'major_version', label: 'Major Version' },
  { key: 'network_plugins', label: 'Network Plugins' },
];

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
  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [loadingConfigs, setLoadingConfigs] = useState(true);
  const [querying, setQuerying] = useState(false);
  const [hasQueried, setHasQueried] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);

  // Faceted filtering: `filterCategory` is the category currently being edited in
  // the value dropdown; `activeFilters` accumulates the selected values across
  // every category (category key → values), so multiple categories can be
  // filtered at once. `facets` are the available values from the most recent
  // response. Selecting values re-queries automatically (see handleRunQuery);
  // facets narrow with filters because the backend applies them in the query.
  const [filterCategory, setFilterCategory] = useState('');
  const [activeFilters, setActiveFilters] = useState<Record<string, string[]>>({});
  const [facets, setFacets] = useState<Record<string, FacetOption[]>>({});
  const [isValueSelectOpen, setIsValueSelectOpen] = useState(false);

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
    // Filters and facets are derived from a query response, so they must not
    // outlive a change to the config, date range, or result limit.
    setFilterCategory('');
    setActiveFilters({});
    setFacets({});
    setIsValueSelectOpen(false);
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

  // handleRunQuery runs a query with the current criteria. filtersArg lets the
  // caller pass the filters explicitly (avoiding a stale read of filter state
  // right after a set) — the category/value handlers use it to auto re-query.
  const handleRunQuery = async (filtersArg?: Record<string, string[]>) => {
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
    if (sizeError) {
      showError('Invalid max results', sizeError);
      return;
    }
    // Snapshot this run's id; only the latest run may commit its response.
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    setQuerying(true);
    try {
      // An empty input intentionally omits the limit; a validated value is a
      // bounded positive integer.
      const trimmedSize = size.trim();
      const sizeNum = trimmedSize === '' ? undefined : Number(trimmedSize);
      const result = await elasticsearchApi.queryTelemetry(
        selectedConfig,
        sizeNum,
        startDate || undefined,
        endDate || undefined,
        filtersArg,
      );
      // Ignore responses superseded by a newer run or by a criteria change.
      if (latestRequestId.current !== requestId) return;
      setDocuments(result.documents || []);
      setStats(result.stats ?? null);
      setFacets(result.facets ?? {});
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

  // buildFilters drops empty value slices so an empty filter set is sent as
  // undefined (unfiltered query).
  const buildFilters = (
    map: Record<string, string[]>,
  ): Record<string, string[]> | undefined => {
    const entries = Object.entries(map).filter(([, values]) => values.length > 0);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  };

  // Switching category only changes which category the value dropdown edits.
  // Existing selections in other categories are kept (multiple categories can be
  // filtered at once), so no re-query is needed here.
  const handleCategoryChange = (category: string) => {
    setFilterCategory(category);
    setIsValueSelectOpen(false);
  };

  // Toggling a value updates the current category's selection within
  // activeFilters and immediately re-queries with the full filter set across all
  // categories (auto re-query), keeping the multi-select open.
  const handleValueToggle = (value: string) => {
    if (!filterCategory) return;
    const current = activeFilters[filterCategory] ?? [];
    const nextValues = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    const next = { ...activeFilters, [filterCategory]: nextValues };
    setActiveFilters(next);
    void handleRunQuery(buildFilters(next));
  };

  const selectedValues = filterCategory ? activeFilters[filterCategory] ?? [] : [];
  const valueOptions = filterCategory ? facets[filterCategory] ?? [] : [];
  const activeFilterCount = Object.values(activeFilters).reduce(
    (sum, values) => sum + values.length,
    0,
  );

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
                <FlexItem>
                  <FormGroup label="Start Date" fieldId="es-data-start-date">
                    <DatePicker
                      id="es-data-start-date"
                      value={startDate}
                      onChange={(_event, str) => { setStartDate(str); invalidateResults(); }}
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
                      onChange={(_event, str) => { setEndDate(str); invalidateResults(); }}
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
                
               
                <FlexItem>
                    <FormGroup label="" fieldId="run-query-btn">
                  <Button
                    variant="primary"
                    onClick={() => {
                      void handleRunQuery(buildFilters(activeFilters));
                    }}
                    isDisabled={querying || !selectedConfig || invalidDateRange || !!sizeError}
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

              {/* Faceted filters. Values come from the last response's facets, so
                  they appear only after a query has run. Selecting a category
                  populates the value multi-select; toggling values auto re-queries. */}
              {hasQueried && (
                <Flex
                  alignItems={{ default: 'alignItemsFlexEnd' }}
                  spaceItems={{ default: 'spaceItemsMd' }}
                  style={{ marginTop: '1rem' }}
                >
                  <FlexItem>
                    <FormGroup label="Filter category" fieldId="es-filter-category" style={{ width: '18em' }}>
                      <FormSelect
                        id="es-filter-category"
                        value={filterCategory}
                        onChange={(_e, v) => handleCategoryChange(v)}
                        aria-label="Select a filter category"
                      >
                        <FormSelectOption value="" label="Select a category…" />
                        {FILTER_CATEGORIES.map((c) => (
                          <FormSelectOption key={c.key} value={c.key} label={c.label} />
                        ))}
                      </FormSelect>
                    </FormGroup>
                  </FlexItem>
                  <FlexItem>
                    <FormGroup label="Filter values" fieldId="es-filter-values">
                      <Select
                        id="es-filter-values"
                        role="menu"
                        isOpen={isValueSelectOpen}
                        onOpenChange={(isOpen) => setIsValueSelectOpen(isOpen)}
                        selected={selectedValues}
                        onSelect={(_e, value) => handleValueToggle(value as string)}
                        toggle={(toggleRef) => (
                          <MenuToggle
                            ref={toggleRef}
                            onClick={() => setIsValueSelectOpen(!isValueSelectOpen)}
                            isExpanded={isValueSelectOpen}
                            isDisabled={!filterCategory || valueOptions.length === 0}
                            style={{ width: '22em' }}
                          >
                            {selectedValues.length > 0 ? 'Values' : 'Select values…'}
                            {selectedValues.length > 0 && (
                              <Badge isRead style={{ marginLeft: '0.5rem' }}>
                                {selectedValues.length}
                              </Badge>
                            )}
                          </MenuToggle>
                        )}
                      >
                        <SelectList>
                          {valueOptions.map((opt) => (
                            <SelectOption
                              key={opt.value}
                              value={opt.value}
                              hasCheckbox
                              isSelected={selectedValues.includes(opt.value)}
                            >
                              {opt.value} ({opt.count})
                            </SelectOption>
                          ))}
                        </SelectList>
                      </Select>
                    </FormGroup>
                  </FlexItem>
                  {activeFilterCount > 0 && (
                    <FlexItem>
                      <Button
                        variant="link"
                        isInline
                        onClick={() => {
                          setFilterCategory('');
                          setActiveFilters({});
                          setIsValueSelectOpen(false);
                          void handleRunQuery(undefined);
                        }}
                      >
                        Clear all filters
                      </Button>
                    </FlexItem>
                  )}
                </Flex>
              )}

              {/* Active filter chips across all categories, so applied filters
                  from categories other than the one currently being edited stay
                  visible. Removing a value re-queries with the updated set. */}
              {hasQueried && activeFilterCount > 0 && (
                <Flex
                  spaceItems={{ default: 'spaceItemsSm' }}
                  style={{ marginTop: '0.75rem' }}
                >
                  {Object.entries(activeFilters).flatMap(([category, values]) =>
                    values.map((value) => {
                      const label =
                        FILTER_CATEGORIES.find((c) => c.key === category)?.label ?? category;
                      return (
                        <FlexItem key={`${category}:${value}`}>
                          <Label
                            color="blue"
                            onClose={() => {
                              const nextValues = (activeFilters[category] ?? []).filter(
                                (v) => v !== value,
                              );
                              const next = { ...activeFilters, [category]: nextValues };
                              setActiveFilters(next);
                              void handleRunQuery(buildFilters(next));
                            }}
                          >
                            {label}: {value}
                          </Label>
                        </FlexItem>
                      );
                    }),
                  )}
                </Flex>
              )}

              {hasQueried && !querying && stats && (
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
              )}

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
