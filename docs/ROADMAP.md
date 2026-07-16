# MockupSwap Roadmap Index

This file is a scheduling index, not a second backlog. Each item has a stable
ID. Unscheduled rows link to the required GitHub roadmap issue form. When work
is scheduled, replace **Unscheduled** with **Scheduled** and replace the
**Schedule** link with the created issue URL. The issue—not this file—owns the
detailed scope, acceptance criteria, acceptance tests, and verification output.

A roadmap pull request must link its issue, satisfy the issue's acceptance
tests, and update this index. Completed items leave the open table and are
recorded in `PRODUCTION_READINESS.md` only when the result materially changes
the production posture.

| ID | Priority | Outcome | Status | Issue |
| --- | --- | --- | --- | --- |
| SEC-001 | P0 | Serve active previews from a dedicated origin. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BSEC-001%5D%20Dedicated%20preview%20origin) |
| SEC-002 | P0 | Enforce CSP and browser-hardening response headers at the host. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BSEC-002%5D%20Production%20security%20headers) |
| SCALE-001 | P1 | Split `App.tsx` orchestration into domain hooks. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BSCALE-001%5D%20Split%20App%20orchestration) |
| SCALE-002 | P1 | Separate IndexedDB list metadata from archive Blob payloads. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BSCALE-002%5D%20IndexedDB%20metadata%20stores) |
| SCALE-003 | P1 | Move source extraction and scanning off the UI thread. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BSCALE-003%5D%20Worker-backed%20source%20scanning) |
| QA-001 | P2 | Cover critical editor lifecycle integrations. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BQA-001%5D%20Editor%20lifecycle%20integration%20coverage) |
| QA-002 | P2 | Expand Playwright through editor, undo, checkpoint, and mobile workflows. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BQA-002%5D%20Expanded%20browser%20workflows) |
| QA-003 | P2 | Add ESLint with React Hooks and accessibility rules. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BQA-003%5D%20ESLint%20React%20and%20accessibility) |
| QA-004 | P2 | Raise fragile-core branch coverage. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BQA-004%5D%20Branch%20coverage) |
| UX-001 | P2 | Replace native project/checkpoint prompts with accessible dialogs. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BUX-001%5D%20Accessible%20project%20dialogs) |
| PROD-001 | P3 | Add AST-backed detection for static JavaScript asset references. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-001%5D%20AST-backed%20asset%20detection) |
| PROD-002 | P3 | Add a project-level diff and export manifest view. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-002%5D%20Project-level%20diff) |
| PROD-003 | P3 | Virtualize large image/detection lists. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-003%5D%20Virtualized%20image%20lists) |
| PROD-004 | P3 | Define privacy-preserving optional telemetry only if product policy changes. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-004%5D%20Optional%20telemetry%20policy) |
| PROD-005 | P3 | Add AVIF conversion and dimension-aware resizing with size budgets. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-005%5D%20AVIF%20and%20resizing) |
| PROD-006 | P3 | Extract Fit & Style values into editable CSS variables. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-006%5D%20Fit%20and%20Style%20CSS%20variables) |
| PROD-007 | P3 | Show before/after image previews in History. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-007%5D%20History%20image%20previews) |
| PROD-008 | P3 | Add a remembered File System Access project picker where supported. | Unscheduled | [Schedule](https://github.com/iannbuckles-rgb/SiteSmith/issues/new?template=roadmap.yml&title=%5BPROD-008%5D%20Remembered%20project%20picker) |

## Status rules

- **Unscheduled** requires a working prefilled **Schedule** link.
- **Scheduled** requires a concrete `https://github.com/.../issues/<number>` link.
- A completed item is removed from this open index only after its acceptance
  tests and repository verification pass.
