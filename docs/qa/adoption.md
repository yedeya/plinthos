# Adoption record

`yedeya/plinthos` adopts Kanon. This is its adoption record (`K-LAYOUT-10`), started by `kanon init` on 2026-11-01. A section or choice it leaves out means its documented default.

## People

| Role | Who |
|---|---|
| Owner | `@yedeya` |
| Maintainer | `@yedeya` |
| Stakeholder | `@yedeya` |

On a personal account a collaborator has write access, with no Triage role, so a Stakeholder who is a collaborator holds more than chapter 03's Triage (`K-ADOPT-2`).

## Plan

`yedeya/plinthos` is a **public repository on a personal account** (`K-ADOPT-2`). Of the platform features of `K-ADOPT-3`:

- **Rulesets:** available.
- **Merge queue:** not on this plan, so "require branches to be up to date" stays off and the release commit's full CI run catches a stale base (`K-MERGE-7`).
- **Environments:** no Kanon lane needs one.

## Bootstrap

`ended 2026-11-01`

## Choices

- **Review trigger:** `labelled`
- **Overseer:** `installed`
- **Upstream findings:** `sent with evidence`

## Data

Whether this repository holds private or sensitive material, as declared at install. The lanes read the files and diffs their work needs either way.

- **Private or sensitive material:** `no`

## Deploy

- **Environments:** `production`
- **Reference environment:** `production`
- **Reference deploy workflow:** `deploy.yml`
- **Reference deploy job:** `production / deploy`
