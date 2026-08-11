# Handoff: include ProForma form answers in Jira issue context

## Problem

When Impala creates a worktree for a Jira issue it writes `docs/issues/<KEY>.md`
(`backend/tauri/src/issue_context.rs`) from `JiraTracker::issue_detail`
(`backend/tauri/src/jira.rs`), which fetches `summary,description,comment,status`.

On projects like SQST, the issue description is empty and the real requirements
live in an attached ProForma form ("Feedback"). The regular issue REST API does
not return form contents, so the generated context file is nearly useless
(SQST-9 contained only a title and one comment).

## Fix

After fetching issue detail, also fetch attached forms via the Jira Forms REST
API and append their answers to the markdown. Verified working on 2026-08-11
against raccoons.atlassian.net with a plain API token (same basic auth Impala
already stores as `jiraEmail`/`jiraApiToken`).

### API recipe (verified)

Base URL is `https://api.atlassian.com`, NOT the site URL. All requests need:

- `Authorization: Basic base64(email:api_token)` — same credentials as jira.rs
- `X-ExperimentalApi: opt-in` — required, endpoints are marked experimental
- `Accept: application/json`

1. **Cloud ID** (once per site, cache it): `GET https://<site>/_edge/tenant_info`
   → `{"cloudId": "34041472-..."}`. No auth needed.

2. **List forms on an issue:**
   `GET https://api.atlassian.com/jira/forms/cloud/{cloudId}/issue/{KEY}/form`

   ```json
   [{"id":"964bedf4-f044-40ef-a410-a6eea6aeca11",
     "formTemplate":{"id":"547812ea-..."},
     "internal":false,"submitted":true,"lock":false,
     "name":"Feedback","updated":"2026-08-05T11:00:55.323Z"}]
   ```

3. **Get answers per form:**
   `GET .../issue/{KEY}/form/{formId}/format/answers`

   ```json
   [{"label":"Noodzakelijkheid","answer":"Must have","choice":"2"},
    {"label":"Wat gaat er precies mis?","answer":"Type: Nieuwe functionaliteit\nProbleem\n..."},
    {"label":"Voeg hier bijlagen toe","answer":""}]
   ```

### Suggested markdown output

Append per form, after the description and before comments:

```markdown
## Form: Feedback

**Wat gaat er precies mis?**
Type: Nieuwe functionaliteit
Probleem ...

**Wat zou volgens jou de oplossing zijn?**
...
```

Skip questions with an empty `answer`.

## Gotchas

- Forms fetch must be best-effort: a 4xx/5xx (Forms API not enabled on a site,
  permission gaps) must not fail issue-context generation. Log and continue.
- Do not use OAuth tokens for this: acli-style OAuth tokens lack the forms
  scopes and get 401. The stored API token with basic auth works.
- `internal: true` forms are internal-only (agent-facing in JSM); still fine to
  include for this use case, but `submitted` false means the form may be blank.
- Multiple forms per issue are possible; loop over the list.
- The `/format/answers` shape flattens multi-choice answers into a display
  string already — no need to resolve choice IDs.
- Linear (`linear.rs`) is unaffected; this is Jira-only. Keep it inside
  `JiraTracker` or behind the provider check, not in shared issue_context code.

## Acceptance check

Create a worktree for SQST-9 (raccoons.atlassian.net): the generated
`docs/issues/SQST-9.md` must contain the "Feedback" form with the
"Wat gaat er precies mis?" answer listing toegangscontrole, camerabewaking,
perimeterbeveiliging, procedures, bewaking.
