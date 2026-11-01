/**
 * Every column of the database, classified public or private: the one registry `[PUB-3]` names.
 *
 * - **public**: the publish step may write its value into the snapshot (#18).
 * - **private**: its value never leaves the private side, in any snapshot, under any setting
 *   (`[PUB-4]`). Storage locations, purchase prices and internal notes are private (`AGENTS.md`
 *   §1), and so is every value and asking price: whether buyers see those is the settings'
 *   decision, which the publish step's projection applies, never a column's classification.
 *
 * A column missing here fails `tests/db/classification.test.ts`, and so does an entry for a
 * column that doesn't exist. When in doubt, classify a column private: making it public later is
 * a decision the Owner reviews, and leaking it is not reversible.
 */

export type Visibility = 'public' | 'private';

export interface Classification {
  readonly visibility: Visibility;
  /** Why, in a phrase, so a reviewer can check it against `AGENTS.md` §1. */
  readonly reason: string;
}

/** Table name → column name → classification, by the names the database uses. */
export const CLASSIFICATION: Readonly<Record<string, Readonly<Record<string, Classification>>>> = {
  catalogue_settings: {
    id: { visibility: 'private', reason: 'an internal key, which nothing public needs' },
    public_token: {
      visibility: 'private',
      reason: 'the capability that addresses the snapshot: it is the path, never content inside it',
    },
    show_values: { visibility: 'private', reason: 'a setting the projection applies, not catalogue content' },
    selling_mode: { visibility: 'private', reason: 'a setting the projection applies, not catalogue content' },
    selling_value_display: { visibility: 'private', reason: 'a setting the projection applies, not catalogue content' },
  },
};
