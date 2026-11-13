---
title: Branching Strategy
sidebar_position: 1
---

# Branching Strategy

The default branch is `master`, which should always be stable and deployable. Changes to `master` can
only occur through PRs.

## Branch Naming
- `feature/new-feature` → corresponds with any new feature that did not exist previously
- `bugfix/bug-name` → a bugfix
- `experiment/experiment-name` → for code that won’t get merged in and is just testing out things
- `docs/specific-part` → for adding documentation for something
- `chore/update-route-names` → for routine tasks, maintenance or small changes such as updating naming
- `refactor/part-of-app` → for refactoring a specific part of the codebase
- `test/specific-functionality` → for adding or improving tests

If there is a bug which does not impact the development of the feature of a branch, do not fix it
in that branch. Keep all changes of a single branch for the purpose of the branch, i.e. every
single change in a branch should be intentional and purposeful. The purpose of this is to make
reviewing PRs easier, all the changes in a PR correspond with what the objective of the PR is.
