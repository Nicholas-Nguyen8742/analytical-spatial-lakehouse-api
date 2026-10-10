import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('attributes a viewport miss to the viewport, and offers to reset it', async () => {
    const onReset = vi.fn();
    render(<EmptyState onReset={onReset} filteredOut={false} />);

    expect(screen.getByText('No tracts in this view')).toBeInTheDocument();
    expect(screen.getByText(/outside the generated dataset/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /reset the view/i }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('attributes a density miss to the filter, and offers to clear it', async () => {
    const onReset = vi.fn();
    render(<EmptyState onReset={onReset} filteredOut />);

    expect(screen.getByText('No tracts above that density')).toBeInTheDocument();
    expect(screen.getByText(/fewer buildings than the filter allows/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /clear the filter/i }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it('is not announced as an error, because a zero-match query is a valid answer', () => {
    render(<EmptyState onReset={vi.fn()} filteredOut={false} />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
