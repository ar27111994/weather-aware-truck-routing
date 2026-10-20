# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue, pull request or discussion.

1. Open <https://github.com/ar27111994/weather-aware-truck-routing/security/advisories/new>
   (GitHub private vulnerability reporting; only the maintainer can read it).
2. Describe the impact, the affected endpoint or page, and the steps to reproduce. A proof of concept
   against your own local instance is ideal. Never test against data or accounts that are not yours.

You can expect an acknowledgement within 3 working days and a fix or a mitigation plan within 14 days
for confirmed issues. Credit is given in the release notes unless you prefer to stay anonymous.

## Scope

In scope: the Haulcast web app, its `/api/v1` backend, the build and deployment pipeline in this
repository, and its configuration (headers, CSP, rate limits, database grants).

Out of scope: findings in third-party services we call (Open-Meteo, Valhalla, OSRM, Photon,
OpenFreeMap, Vercel, Supabase), volumetric denial of service, and social engineering.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## What the project already enforces

See `docs/SECURITY.md` for the threat model and `docs/CI-CD.md` for the automated checks (CodeQL,
gitleaks over the full history, dependency review, pip-audit, pnpm audit, bandit, OSV-Scanner).
