import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { LogViewer } from './LogViewer';

vi.mock('../services/authService', () => ({
  authService: {
    getToken: vi.fn(() => 'mock-token'),
  },
}));

// Use Pending status so the component sets a known log line without needing WebSocket
const defaultProps = {
  scenarioRunName: 'test-run',
  jobId: `job-${Date.now()}`,
  clusterName: 'test-cluster',
  podName: 'test-pod-abc',
  status: 'Pending',
};

beforeEach(() => {
  vi.restoreAllMocks();
  defaultProps.jobId = `job-${Date.now()}-${Math.random()}`;
});

async function clickDropdownItem(user: ReturnType<typeof userEvent.setup>, option: string) {
  const menuToggle = screen.getAllByRole('button').find(btn => btn.classList.contains('pf-v5-c-menu-toggle'));
  expect(menuToggle).toBeDefined();
  await user.click(menuToggle!);
  await user.click(screen.getByText(option));
}

describe('LogViewer download', () => {
  describe('dropdown UI', () => {
    it('renders the download menu toggle', () => {
      render(<LogViewer {...defaultProps} />);
      const menuToggle = screen.getAllByRole('button').find(btn => btn.classList.contains('pf-v5-c-menu-toggle'));
      expect(menuToggle).toBeDefined();
    });

    it('shows HTML, JSON, PDF options when opened', async () => {
      const user = userEvent.setup();
      render(<LogViewer {...defaultProps} />);

      const menuToggle = screen.getAllByRole('button').find(btn => btn.classList.contains('pf-v5-c-menu-toggle'));
      await user.click(menuToggle!);

      expect(screen.getByText('HTML')).toBeInTheDocument();
      expect(screen.getByText('JSON')).toBeInTheDocument();
      expect(screen.getByText('PDF')).toBeInTheDocument();
    });

    it('closes dropdown after selecting an option', async () => {
      const user = userEvent.setup();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:url');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'HTML');

      expect(screen.queryByText('JSON')).not.toBeInTheDocument();
    });
  });

  describe('HTML download', () => {
    it('creates a blob with valid HTML containing podName title and monospace styling', async () => {
      const user = userEvent.setup();
      let capturedBlob: Blob | null = null;

      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:mock-url';
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'HTML');

      expect(capturedBlob).not.toBeNull();
      const html = await capturedBlob!.text();
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<title>Logs - test-pod-abc</title>');
      expect(html).toContain('font-family: monospace');
      expect(html).toContain('background-color: #000000');
      expect(html).not.toContain('background-color: #ffffff !important');
    });

    it('revokes the blob URL after triggering download', async () => {
      const user = userEvent.setup();
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:html-url');
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'HTML');

      expect(revokeSpy).toHaveBeenCalledWith('blob:html-url');
    });
  });

  describe('JSON download', () => {
    it('produces JSON with podName, logs array, totalLines, and exportedAt', async () => {
      const user = userEvent.setup();
      let capturedBlob: Blob | null = null;

      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => {
        capturedBlob = blob;
        return 'blob:mock-url';
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'JSON');

      expect(capturedBlob).not.toBeNull();
      const parsed = JSON.parse(await capturedBlob!.text());

      expect(parsed.podName).toBe('test-pod-abc');
      expect(Array.isArray(parsed.logs)).toBe(true);
      expect(parsed.totalLines).toBe(parsed.logs.length);
      expect(parsed.exportedAt).toBeDefined();
      expect(new Date(parsed.exportedAt).getTime()).not.toBeNaN();
    });
  });

  describe('PDF download', () => {
    it('opens a new window with the blob URL', async () => {
      const user = userEvent.setup();
      const mockPrintWindow = { onload: null as (() => void) | null, focus: vi.fn(), print: vi.fn() };
      const openSpy = vi.fn(() => mockPrintWindow);
      vi.stubGlobal('open', openSpy);

      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:pdf-url');
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'PDF');

      expect(openSpy).toHaveBeenCalledWith('blob:pdf-url', '_blank');
    });

    it('generates print-friendly CSS with black text on white background', async () => {
      const user = userEvent.setup();
      let capturedBlob: Blob | null = null;

      vi.stubGlobal('open', vi.fn(() => ({ onload: null, focus: vi.fn(), print: vi.fn() })));
      vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => { capturedBlob = blob; return 'blob:pdf-url'; });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'PDF');

      const html = await capturedBlob!.text();
      expect(html).toContain('background-color: #ffffff !important');
      expect(html).toContain('color: #000000 !important');
      expect(html).toContain('@media print');
      expect(html).toContain('font-size: 10px');
    });

    it('cleans up blob URL when popup is blocked', async () => {
      const user = userEvent.setup();
      vi.stubGlobal('open', vi.fn(() => null));
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:blocked-url');
      const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

      render(<LogViewer {...defaultProps} />);
      await clickDropdownItem(user, 'PDF');

      expect(revokeSpy).toHaveBeenCalledWith('blob:blocked-url');
    });
  });
});
