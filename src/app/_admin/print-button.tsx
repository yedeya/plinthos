'use client';

/**
 * The printable catalogue's **Print** button (#236, #255, [EXP-5]): it opens the browser's print dialog, which also
 * saves the page as a PDF. It calls no server function, and the page's print stylesheet hides it.
 */
import { en } from '../messages/en';

export function PrintButton() {
  return (
    <button type="button" className="button button--primary" onClick={() => window.print()}>
      {en.summary.print}
    </button>
  );
}
