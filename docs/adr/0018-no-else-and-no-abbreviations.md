# 0018 — No `else`, and no abbreviated identifiers

Status: Accepted

## Context

Two conventions in this codebase are unusual enough to need a reason, and both
are the kind of thing that decays immediately if it depends on reviewers
remembering it.

## Decision

Both are lint rules, not guidance.

```js
'no-restricted-syntax': [{ selector: 'IfStatement > .alternate',
  message: 'No else. Use guard clauses, early returns, or a strategy object.' }]
'unicorn/prevent-abbreviations': [{ replacements: { req: {request}, res: {response},
  cfg: {configuration}, repo: {repository}, db: {database}, tx: {transaction}, … } }]
```

`IfStatement > .alternate` bans `else` and `else if`, which `no-else-return`
does not.

## Consequences

- Functions read as a list of refusals followed by the real work. The happy path
  is never indented inside a branch.
- Branching that genuinely has many arms becomes a lookup table or a strategy
  object, which is usually what it wanted to be.
- Names are longer. `request` rather than `req` costs four characters and removes
  a question that has no interesting answer.
- Occasionally a guard clause is a slightly awkward fit. That cost is real and
  accepted; the rule is uniform precisely so it is never argued about per case.
