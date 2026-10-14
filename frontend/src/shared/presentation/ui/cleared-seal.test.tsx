// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ClearedSeal } from './cleared-seal';

describe('ClearedSeal', () => {
  it('is one accessible image labelled with the seal wording, mark drawn as paths only', () => {
    const { container } = render(<ClearedSeal />);
    const seal = screen.getByRole('img', { name: 'Cleared · on the ledger' });
    expect(seal.querySelector('svg path')).not.toBeNull();
    expect(container.querySelector('text')).toBeNull();
    expect(seal).not.toHaveClass('animate-stamp');
  });

  it('stamps on mount only when asked, keeping its tilt', () => {
    render(<ClearedSeal animate tilt="-4deg" />);
    const seal = screen.getByRole('img', { name: 'Cleared · on the ledger' });
    expect(seal).toHaveClass('animate-stamp');
    expect(seal.style.getPropertyValue('--stamp-tilt')).toBe('-4deg');
  });
});
